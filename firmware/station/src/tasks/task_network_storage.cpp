/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/tasks/task_network_storage.cpp
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Fase 3 / Parte B — v5.24.0)
 * REVISÃO: 2026-11-22 UTC
 * PROPÓSITO: Implementação da taskNetworkStorage (dona exclusiva do PubSubClient e
 *            orquestradora de rede, persistência WAL no SD e ciclo OTA).
 * CHANGELOG 2026-11-22 (v5.24.0):
 * - Adiciona prazo absoluto de Self-Test OTA (OTA_SELF_TEST_ABSOLUTE_DEADLINE_MS = 10 min
 *   desde o boot, com ou sem Wi-Fi), acionando rollback com motivo "selftest_timeout".
 * CHANGELOG 2026-11-21 (v5.23.2):
 * - Supervisor de conectividade em 3 camadas:
 *   1) 180s sem MQTT: fecha válvula aberta por segurança física SEM reiniciar placa;
 *   2) A cada 5 min sem MQTT: reciclagem suave do rádio Wi-Fi (WIFI_OFF -> WIFI_STA)
 *      e socket TLS sem reiniciar o ESP32 nem desgastar a NVS;
 *   3) 6h sem MQTT: reboot limpo com drain para o SD apenas como último recurso.
 * ===================================================================================
 */
#include "tasks/task_network_storage.h"
#include "config/app_config.h"
#include "config/system_types.h"
#include "core/ack_outbox.h"
#include "core/command_parser.h"
#include "core/time_math.h"
#include "core/valve_controller.h"
#include "hal/rtc_time_service.h"
#include "hal/sd_telemetry_wal.h"
#include "services/diagnostics_service.h"
#include "services/logger.h"
#include "services/mqtt_link.h"
#include "services/ota_manager.h"
#include "tasks/rtos_sync.h"
#include <SD.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <esp_task_wdt.h>

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "secrets.h não encontrado. Garanta que está em firmware/include/secrets.h"
#endif

static void closeValveIfActiveByNetSupervisor() {
  bool isOn = false;
  uint32_t dummyOff = 0;
  valveReadStateAtomic(isOn, dummyOff);

  char interrupted[48] = {0};
  bool hadCmd = false;
  if (lockSem(valveMutex, 50)) {
    hadCmd = (g_activeCommandId[0] != '\0');
    if (isOn || hadCmd) {
      safeCopy(interrupted, sizeof(interrupted), g_activeCommandId);
      g_activeCommandId[0] = '\0';
      valveSetOffLocked();
    }
    unlockSem(valveMutex);
  } else if (isOn) {
    valveApplyCommand(false, 0);
  }

  if (isOn || hadCmd) {
    LOGE("[NET][SUPERVISOR] Válvula fechada por proteção offline (>%lus sem MQTT, cmd=%s) — sem reboot da placa.",
         static_cast<unsigned long>(VALVE_OFFLINE_FAILSAFE_MS / 1000UL),
         interrupted[0] ? interrupted : "-");
    if (interrupted[0]) {
      enqueueAck(interrupted, "failed", "off", 0, "network_supervisor_stop", "mqtt_offline_limit");
    }
  }
}

void taskNetworkStorage(void* pvParameters) {
  (void)pvParameters;
#ifdef ESP32
  esp_task_wdt_add(NULL);
#endif

  net.setCACert(AWS_CERT_CA);
  net.setCertificate(AWS_CERT_CRT);
  net.setPrivateKey(AWS_CERT_PRIVATE);
  net.setHandshakeTimeout(20);

  client.setServer(AWS_IOT_ENDPOINT, MQTT_PORT);
  client.setCallback(mqttCallback);
  client.setBufferSize(MQTT_BUFFER_SIZE);
  client.setKeepAlive(60);
  client.setSocketTimeout(10);

  BackoffState wifiB, mqttB;
  uint32_t lastWifiBeginMs = msNow();
  uint32_t netDisconnectedSinceMs = msNow();
  uint32_t lastSoftWifiResetMs = netDisconnectedSinceMs;
  bool     valveOfflineFailsafeApplied = false;
  uint32_t lastSupervisorLogMs = 0;
  uint32_t lastPresenceHeartbeatMs = 0;
  bool     birthConfirmed = false;

  uint32_t lastNtpRequestMs = 0;
  uint32_t lastNtpCheckMs = 0;
  uint32_t lastNtpSyncSuccessMs = 0;
  bool ntpSyncInFlight = false;

  TelemetryData received{};

  for (;;) {
#ifdef ESP32
    esp_task_wdt_reset();
#endif

    uint32_t nowLoopMs = msNow();

    // 1. v5.25.0 (Fase 3B): aprova a partição só após 90s CONTÍNUOS de MQTT (sem aprovação local de 15s)
    otaObservationTick(g_mqttConnected && client.connected());
    powerStabilityTick(nowLoopMs);
    ackHealthTick(nowLoopMs);  // v5.26.0 (Fase 4.0-E): autocura do outbox + estatística da NVS (a cada 60 s)

    // 2. Watchdog de Self-Test de Rede Pós-OTA (90s com Wi-Fi ativo OU 10 min absolutos desde o boot)
    if (g_appSelfTestPending) {
      bool wifiDeadlineHit = (!otaSelfTestMqttSeen() && g_wifiConnected && g_wifiConnectedSinceMs != 0 &&
                              timeReached(nowLoopMs, g_wifiConnectedSinceMs + OTA_SELF_TEST_DEADLINE_MS));
      bool absoluteDeadlineHit = timeReached(nowLoopMs, OTA_SELF_TEST_ABSOLUTE_DEADLINE_MS);
      if (wifiDeadlineHit || absoluteDeadlineHit) {
        LOGE("[OTA][SELF-TEST] Prazo de Self-Test expirou sem conexão AWS IoT Core (wifi_90s=%d abs_10m=%d).",
             static_cast<int>(wifiDeadlineHit), static_cast<int>(absoluteDeadlineHit));
        triggerEmergencyOtaRollbackAndReboot("selftest_timeout");
      }
    }

    // 3. Supervisor Autônomo de Conectividade em 3 Camadas (Campo / Longa Autonomia)
    if (g_mqttConnected && client.connected()) {
      netDisconnectedSinceMs = 0;
      lastSoftWifiResetMs = 0;
      valveOfflineFailsafeApplied = false;
    } else if (!g_otaInProgress) {
      if (netDisconnectedSinceMs == 0) {
        netDisconnectedSinceMs = nowLoopMs;
        lastSoftWifiResetMs = nowLoopMs;
        valveOfflineFailsafeApplied = false;
      } else {
        uint32_t offlineElapsedMs = nowLoopMs - netDisconnectedSinceMs;
        if (lastSupervisorLogMs == 0 || timeReached(nowLoopMs, lastSupervisorLogMs + NET_SUPERVISOR_LOG_EVERY_MS)) {
          lastSupervisorLogMs = nowLoopMs;
          LOGW("[NET][SUPERVISOR] Sem sessão MQTT há %lus (softReset=%lus | rebootFinal=%lus) | wifiStatus=%d freeHeap=%lu B maxBlock=%lu B",
               static_cast<unsigned long>(offlineElapsedMs / 1000UL),
               static_cast<unsigned long>(NET_WIFI_SOFT_RESET_EVERY_MS / 1000UL),
               static_cast<unsigned long>(NET_SUPERVISOR_MAX_OFFLINE_MS / 1000UL),
               static_cast<int>(WiFi.status()),
               static_cast<unsigned long>(esp_get_free_heap_size()),
               static_cast<unsigned long>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
        }

        // Camada 1 (180s): Fecha válvula aberta imediatamente por segurança, SEM reiniciar a placa
        if (!valveOfflineFailsafeApplied &&
            timeReached(nowLoopMs, netDisconnectedSinceMs + VALVE_OFFLINE_FAILSAFE_MS)) {
          closeValveIfActiveByNetSupervisor();
          valveOfflineFailsafeApplied = true;
        }

        // Camada 2 (5 min): Reciclagem suave apenas do rádio Wi-Fi e socket TLS (zero desgaste NVS)
        if (lastSoftWifiResetMs != 0 &&
            timeReached(nowLoopMs, lastSoftWifiResetMs + NET_WIFI_SOFT_RESET_EVERY_MS)) {
          lastSoftWifiResetMs = nowLoopMs;
          LOGW("[NET][SUPERVISOR] Reciclagem suave do rádio Wi-Fi/TLS (offline=%lus, sem reboot do MCU)...",
               static_cast<unsigned long>(offlineElapsedMs / 1000UL));
          client.disconnect();
          net.stop();
          WiFi.disconnect(true);
          WiFi.mode(WIFI_OFF);
          vTaskDelay(pdMS_TO_TICKS(200));
          WiFi.mode(WIFI_STA);
          WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
          g_wifiConnected = false;
          g_mqttConnected = false;
          birthConfirmed = false;
          g_wifiConnectedSinceMs = 0;
          lastWifiBeginMs = msNow();
          backoffReset(wifiB);
          backoffReset(mqttB);
        }

        // Camada 3 (6h): Reboot limpo como último recurso para recuperação profunda
        if (timeReached(nowLoopMs, netDisconnectedSinceMs + NET_SUPERVISOR_MAX_OFFLINE_MS)) {
          LOGE("====================================================================");
          LOGE("[NET][SUPERVISOR] Estação sem conectividade MQTT por >%lus! Executando Auto-Recovery (último recurso)...",
               static_cast<unsigned long>(NET_SUPERVISOR_MAX_OFFLINE_MS / 1000UL));
          LOGE("====================================================================");
          closeValveIfActiveByNetSupervisor();
          gracefulDrainBeforeOtaReboot("net_supervisor_auto_reboot");
          delay(300);
          ESP.restart();
        }
      }
    }

    // 4. Máquina de Reconexão Wi-Fi Respeitando a Janela de Associação WPA2/DHCP (10s)
    if (WiFi.status() != WL_CONNECTED) {
      if (g_wifiConnected) {
        LOGW("[NET] Wi-Fi desconectou (status=%d).", static_cast<int>(WiFi.status()));
        g_wifiDisconnects++;
        client.disconnect();
        net.stop();
      }
      g_wifiConnected = false;
      g_mqttConnected = false;
      birthConfirmed = false;
      g_wifiConnectedSinceMs = 0;

      bool graceElapsed = timeReached(msNow(), lastWifiBeginMs + WIFI_ASSOC_GRACE_MS);
      if (graceElapsed && backoffCanTry(wifiB)) {
        LOGW("[NET] Reiniciando rádio Wi-Fi STA (SSID=%.3s***)...", WIFI_SSID);
        WiFi.disconnect(true);
        vTaskDelay(pdMS_TO_TICKS(100));
        WiFi.mode(WIFI_STA);
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        lastWifiBeginMs = msNow();
        backoffOnFail(wifiB, 5000, 30000);
      }
    } else {
      if (!g_wifiConnected) {
        backoffReset(wifiB);
        g_wifiConnected = true;
        g_wifiConnectedSinceMs = msNow();
        LOGI("[NET] Wi-Fi conectado! RSSI=%d dBm", WiFi.RSSI());
        LOGD("[NET] IP local=%s", WiFi.localIP().toString().c_str());
        requestAsyncNTP();
        lastNtpRequestMs = msNow();
        ntpSyncInFlight = true;
      }

      if (ntpSyncInFlight && timeReached(msNow(), lastNtpCheckMs + 2000)) {
        lastNtpCheckMs = msNow();
        if (checkAsyncNTP()) {
          ntpSyncInFlight = false;
          lastNtpSyncSuccessMs = msNow();
        }
      }

      if (ntpSyncInFlight && timeReached(msNow(), lastNtpRequestMs + 60000)) {
        requestAsyncNTP();
        lastNtpRequestMs = msNow();
      } else if (!ntpSyncInFlight && timeReached(msNow(), lastNtpSyncSuccessMs + NTP_RESYNC_EVERY_MS)) {
        requestAsyncNTP();
        lastNtpRequestMs = msNow();
        ntpSyncInFlight = true;
      }
    }

    sdTryReinit();

    // 5. Máquina de Conexão mTLS MQTT com Limpeza de Socket e Heartbeat de Presença
    if (g_wifiConnected) {
      if (!client.connected()) {
        g_mqttConnected = false;
        birthConfirmed = false;
        if (backoffCanTry(mqttB)) {
          g_mqttReconnects++;
          uint32_t nextSess = ++g_mqttSessionSeq;

          client.disconnect();
          net.stop();
          net.setCACert(AWS_CERT_CA);
          net.setCertificate(AWS_CERT_CRT);
          net.setPrivateKey(AWS_CERT_PRIVATE);
          net.setHandshakeTimeout(20);

          char willPayload[320];
          uint32_t willLen = 0;
          if (!buildPresenceJson("offline", "lwt", nextSess, willPayload, sizeof(willPayload), willLen)) {
            safeCopy(willPayload, sizeof(willPayload), "offline");
          }

          LOGI("[AWS] Tentando handshake mTLS + MQTT connect (session_seq=%lu | heap=%lu B | maxBlock=%lu B)...",
               static_cast<unsigned long>(nextSess),
               static_cast<unsigned long>(esp_get_free_heap_size()),
               static_cast<unsigned long>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));

          bool ok = client.connect(THINGNAME, g_topicPresence, PRESENCE_QOS, PRESENCE_RETAIN, willPayload);
          if (ok) {
            bool subCmdOk = client.subscribe(g_topicCommand, 1);
            bool subRecOk = subCmdOk ? client.subscribe(g_topicAckReceipt, 1) : false;
            if (!subCmdOk || !subRecOk) {
              LOGE("[AWS] Falha ao assinar tópicos (cmd_ok=%d receipt_ok=%d)! Reiniciando sessão MQTT...",
                   static_cast<int>(subCmdOk), static_cast<int>(subRecOk));
              client.disconnect();
              net.stop();
              backoffOnFail(mqttB, 2000, 20000);
            } else {
              backoffReset(mqttB);
              g_mqttConnected = true;
              netDisconnectedSinceMs = 0;
              lastSoftWifiResetMs = 0;
              valveOfflineFailsafeApplied = false;
              LOGI("[AWS] MQTT conectado e inscrito em %s e %s! (session_seq=%lu | buffer=%u B | heap=%lu B)",
                   g_topicCommand,
                   g_topicAckReceipt,
                   static_cast<unsigned long>(nextSess),
                   static_cast<unsigned>(client.getBufferSize()),
                   static_cast<unsigned long>(esp_get_free_heap_size()));

              otaOnMqttConnected();
              birthConfirmed = publishPresenceOnline("birth");
              lastPresenceHeartbeatMs = msNow();
              flushAckQueueTick();
            }
          } else {
            LOGE("[AWS] MQTT connect falhou: state=%d(%s)", client.state(), mqttStateName(client.state()));
            logTlsLastError();
            net.stop();
            backoffOnFail(mqttB, 2000, 25000);
          }
        }
      } else {
        g_mqttConnected = true;
        client.loop();
        flushAckQueueTick();

        if (!birthConfirmed || timeReached(msNow(), lastPresenceHeartbeatMs + PRESENCE_HEARTBEAT_EVERY_MS)) {
          birthConfirmed = publishPresenceOnline(birthConfirmed ? "heartbeat" : "birth");
          lastPresenceHeartbeatMs = msNow();
        }
      }
    }

    executePendingOtaJobIfAny();

    pendingFlushTick(false);

    // Timeout curto de 5ms na fila de sensores para manter o loop MQTT ultra-responsivo
    if (xQueueReceive(sensorQueue, &received, pdMS_TO_TICKS(5)) == pdPASS) {
      uint32_t payloadLen = 0;
      bool jsonOk = buildTelemetryJson(received, g_netSharedJsonBuf, sizeof(g_netSharedJsonBuf), payloadLen);

      bool queuedOk = false;
      if (g_sdOk && jsonOk) {
        queuedOk = sdAppendPendingLine(g_netSharedJsonBuf, payloadLen);
      }

      if (g_mqttConnected && client.connected()) {
        client.loop();
        flushAckQueueTick();
      }

      bool sentCloud = false;
      if (jsonOk && g_mqttConnected) {
        if (queuedOk) {
          sentCloud = pendingFlushTick(true);
        } else {
          sentCloud = mqttPublish(g_topicTelemetry, reinterpret_cast<const uint8_t*>(g_netSharedJsonBuf), payloadLen, false);
        }
      }

      if (!sentCloud && !queuedOk) {
        g_telemetryDropped++;
      }

      if (g_sdOk) {
        if (lockSem(sdMutex, 1500)) {
          String dailyCsv = getDailyCsvFilename();
          File f = SD.open(dailyCsv.c_str(), FILE_APPEND);
          if (f) {
            char tid[80];
            makeTelemetryId(tid, sizeof(tid), received.timestamp, received.seq);
            f.printf("%lu,%.2f,%.2f,%d,%d,%d,%d,%d,%.2f,%s,%s,%lu\n",
                     static_cast<unsigned long>(received.timestamp),
                     received.air_temp, received.air_hum,
                     received.soil_moisture, received.light_level,
                     received.rain_raw, received.rain_pct, received.rain_detected ? 1 : 0,
                     received.uv_index,
                     sentCloud ? "SENT" : (queuedOk ? "QUEUED" : "DROP"),
                     tid,
                     static_cast<unsigned long>(received.seq));
            f.close();
          } else {
            unlockSem(sdMutex);
            sdMarkErrorAndTriggerReinit("open_daily_csv");
            continue;
          }
          unlockSem(sdMutex);
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}
