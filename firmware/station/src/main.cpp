/**
 * ===================================================================================
 * NOME DO PROJETO: AGROSMART PRECISION SYSTEM (AgroSmart Precision IoT V5)
 * ARQUIVO: firmware/src/main.cpp
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Fase 3 / Parte B — v5.24.0)
 * ÚLTIMA ATUALIZAÇÃO: 2026-11-22 UTC
 * VERSÃO DO FIRMWARE: 5.24.0 (OTA Assinado ECDSA P-256 + Anti-Downgrade + Self-Test Robusto)
 * CHANGELOG 2026-11-24 (v5.27.0):
 * - `localControlsInit()` (botões GPIO27/GPIO25 + padrão do display) antes das tasks e
 *   task "Buttons" (prioridade 3, ciclo de 20 ms).
 * CHANGELOG 2026-11-23 (v5.25.0 (Fase 3B)):
 * - Inicialização segura da válvula via `valvePinInitSafe()` (GPIO26 + LED GPIO2).
 * - Cria a guarda independente da válvula (`valveGuardInit()`).
 * - Partição só é aprovada após 90s contínuos de MQTT (`otaObservationTick`).
 * CHANGELOG 2026-11-22 (v5.24.0):
 * - Define `verifyRollbackLater() = true` para manter a partição em PENDING_VERIFY
 *   até a aprovação local de 15s (`approveHardwarePartitionIfStable`).
 * ===================================================================================
 *
 * ARQUITETURA MODULAR (5 CAMADAS):
 * - Camada 1 (config/)  : board_pins.h, app_config.h, system_types.h
 * - Camada 2 (core/)    : durable_ack.h, ack_outbox, time_math, config_validator,
 *                         valve_controller, command_parser
 * - Camada 3 (hal/)     : sensor_drivers, rtc_time_service, nvs_store,
 *                         sd_telemetry_wal, oled_display
 * - Camada 4 (services/): logger, diagnostics_service, mqtt_link, ota_manager
 * - Camada 5 (tasks/)   : rtos_sync, task_valve_control (Prio 4), task_sensors (Prio 3),
 *                         task_network_storage (Prio 2), task_display (Prio 1)
 * ===================================================================================
 */

#include "config/board_pins.h"
#include "config/app_config.h"
#include "config/system_types.h"
#include "core/ack_outbox.h"
#include "core/time_math.h"
#include "core/valve_controller.h"
#include "hal/sensor_drivers.h"
#include "hal/rtc_time_service.h"
#include "hal/nvs_store.h"
#include "hal/sd_telemetry_wal.h"
#include "hal/oled_display.h"
#include "services/logger.h"
#include "services/diagnostics_service.h"
#include "services/local_controls.h"
#include "services/ota_manager.h"
#include "tasks/rtos_sync.h"
#include "tasks/task_valve_control.h"
#include "tasks/task_sensors.h"
#include "tasks/task_network_storage.h"
#include "tasks/task_display.h"

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <esp_task_wdt.h>

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "secrets.h não encontrado. Garanta que está em firmware/include/secrets.h"
#endif

// Core Arduino ESP32 2.0.17 (esp32-hal-misc.c L207-231) aprovaria a imagem antes
// do setup() se retornasse false. Retornando true, a partição permanece em
// ESP_OTA_IMG_PENDING_VERIFY e o bootloader volta sozinho se houver reset
// (crash/WDT/queda de energia) antes da observação de 90s contínuos de MQTT
// (otaObservationTick -> approveHardwarePartitionIfStable).
extern "C" bool verifyRollbackLater() {
  return true;
}

void setup() {
  // Fail-Safe físico imediato: grava nível FECHADO antes de configurar a saída
  valvePinInitSafe();

  Serial.begin(115200);
  delay(800);

#ifdef ESP32
  esp_task_wdt_init(WDT_TIMEOUT_SEC, true);
#endif

  initRtosSyncPrimitives();
  valveGuardInit();

  Serial.println();
  Serial.printf("=== AGROSMART V%s (AUTO-HEALING SUPERVISOR + FAST VALVE ACK + WAL SD) INICIANDO ===\n", FW_VERSION);

  buildMqttTopics();

  analogReadResolution(12);
  pinMode(PIN_SOLO, INPUT);
  pinMode(PIN_CHUVA, INPUT);
  pinMode(PIN_LUZ, INPUT);
  pinMode(PIN_UV, INPUT);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

#if ENABLE_OLED
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    LOGE("[OLED] Falhou iniciar");
  } else {
    display.clearDisplay();
    display.display();
  }
#endif

  g_rtcOk = rtc.begin();
  if (!g_rtcOk) {
    LOGE("[RTC] Falhou iniciar (usando fallback NTP POSIX quando Wi-Fi conectar)");
  } else {
    DateTime rtcNow = rtc.now();
    if (isValidEpoch(rtcNow.unixtime())) {
      g_timeSynced = true;
      LOGI("[RTC] Relógio físico DS3231 válido (%04d-%02d-%02d %02d:%02d:%02d UTC).",
           rtcNow.year(), rtcNow.month(), rtcNow.day(),
           rtcNow.hour(), rtcNow.minute(), rtcNow.second());
    }
  }

  g_ahtOk = aht.begin();
  if (!g_ahtOk) LOGE("[AHT] Falhou iniciar");

  inspectFlashPartitionsOnBoot();
  initBootDiagnostics();
  ackInitAndRecover();
  loadFromNVSAndCheckCrashRecovery();
  localControlsInit();  // v5.27.0: depois do boot_id (eventos loc-) e antes das tasks

  LOGI("[SD] Iniciando cartão...");
  if (sdInit()) {
    sdReconcilePendingState("boot");
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  BaseType_t rcDisplay = pdPASS;
#if ENABLE_OLED
  rcDisplay = xTaskCreate(taskDisplay, "Display", 4096, NULL, 1, NULL);
#endif
  BaseType_t rcNet     = xTaskCreate(taskNetworkStorage, "Net",     12288, NULL, 2, NULL);
  BaseType_t rcSensors = xTaskCreate(taskSensors,        "Sensors", 6144,  NULL, 3, NULL);
  BaseType_t rcValve   = xTaskCreate(taskValveControl,   "ValveRT", 6144,  NULL, 4, NULL);
  BaseType_t rcButtons = xTaskCreate(taskLocalControls,  "Buttons", 6144,  NULL, 3, NULL);  // v5.27.0

  configASSERT(rcDisplay == pdPASS);
  configASSERT(rcNet == pdPASS);
  configASSERT(rcSensors == pdPASS);
  configASSERT(rcValve == pdPASS);
  configASSERT(rcButtons == pdPASS);

  LOGI("[BOOT] Todas as tasks iniciadas com sucesso (FW v%s | Partição=%s).",
       FW_VERSION, g_runningPartition);
}

void loop() {
  vTaskDelete(NULL);
}
