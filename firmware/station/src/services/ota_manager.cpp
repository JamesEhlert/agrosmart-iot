/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/services/ota_manager.cpp
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Fase 3 / Parte B — v5.24.0)
 * REVISÃO: 2026-11-22 UTC
 * PROPÓSITO: Implementação do gerenciador de partições Flash, Self-Test pós-boot,
 *            Rollback de emergência com motivo persistido (`ota_rbwhy`), bloqueio
 *            de versão problemática (`ota_badver`) e download OTA HTTPS S3 com
 *            revalidação ECDSA P-256 + SHA-256 e CA bundle dedicado.
 * CHANGELOG 2026-11-23 (v5.25.0 (Fase 3B)):
 * - Observação pós-OTA: aprova a partição só após 90s CONTÍNUOS de MQTT e heap OK.
 * - Rollback causado por queda de energia/brownout (`power_loss_rollback`) não bloqueia a versão.
 * - IP rebaixado para DEBUG no log de reconexão.
 * CHANGELOG 2026-11-22 (v5.24.0):
 * - Revalida assinatura ECDSA P-256 sobre SHA-256 e bytes reais antes de `Update.end(true)`.
 * - Usa `OTA_S3_CA_BUNDLE` (Amazon Trust Services) no download S3 (MQTT mantém `AWS_CERT_CA`).
 * - Alerta no boot quando slot ativo tem tamanho < 0x1E0000 (mapa antigo).
 * - Garante válvula OFF antes de todo reboot/rollback, persiste `ota_rbwhy`,
 *   bloqueia versão em `ota_badver` para crash/bootloader rollback (nunca em
 *   `selftest_timeout`) e mantém `reason="ota_rollback"` com detalhe no `error`.
 * CHANGELOG 2026-11-21 (v5.23.1):
 * - Revalida allowlist estrita do bucket S3 antes de abrir a conexão HTTPS.
 * - Desativa redirecionamentos HTTP (`HTTPC_DISABLE_FOLLOW_REDIRECTS`) para bloquear
 *   redirecionamentos para hosts não autorizados durante o download do binário.
 * ===================================================================================
 */
#include "services/ota_manager.h"
#include "config/ota_ca_bundle.h"
#include "config/ota_signing_pubkey.h"
#include "core/ack_outbox.h"
#include "services/ota_signature.h"
#include "core/time_math.h"
#include "core/valve_controller.h"
#include "hal/nvs_store.h"
#include "hal/sd_telemetry_wal.h"
#include "services/diagnostics_service.h"
#include "services/logger.h"
#include "services/mqtt_link.h"
#include "tasks/rtos_sync.h"
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <mbedtls/sha256.h>

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "secrets.h não encontrado. Garanta que está em firmware/include/secrets.h"
#endif

volatile bool    g_otaInProgress     = false;
volatile uint8_t g_otaProgressPct    = 0;
volatile uint8_t g_otaCurrentAttempt = 1;
OtaJobRequest    g_otaJob{};

static bool isTrustedOtaUrlLocal(const char* url) {
  if (!url || url[0] == '\0') return false;
  if (strstr(url, "..") != nullptr) return false;
  if (strchr(url, '@') != nullptr || strchr(url, ' ') != nullptr ||
      strchr(url, '\r') != nullptr || strchr(url, '\n') != nullptr) {
    return false;
  }
  const size_t regLen = strlen(OTA_ALLOWED_URL_PREFIX_REGIONAL);
  const size_t glbLen = strlen(OTA_ALLOWED_URL_PREFIX_GLOBAL);
  return (strncmp(url, OTA_ALLOWED_URL_PREFIX_REGIONAL, regLen) == 0) ||
         (strncmp(url, OTA_ALLOWED_URL_PREFIX_GLOBAL, glbLen) == 0);
}

void triggerEmergencyOtaRollbackAndReboot(const char* failReasonLog) {
  const char* rbCode = (failReasonLog && failReasonLog[0] != '\0') ? failReasonLog : "selftest_timeout";
  LOGE("====================================================================");
  LOGE("[OTA][EMERGENCY-ROLLBACK] motivo=%s", rbCode);
  LOGE("====================================================================");

  // Segurança física obrigatória: garante relé desenergizado antes de drenar/reiniciar
  valveApplyCommand(false, 0);

  persistOtaRollbackReasonNVS(rbCode);
  if (strcmp(rbCode, "crash_after_ota") == 0) {
    Preferences pt;
    if (pt.begin(NVS_NS, true)) {
      String badTarget = pt.isKey(K_OTA_TARGET) ? pt.getString(K_OTA_TARGET, "") : "";
      pt.end();
      if (badTarget.length() > 0) {
        persistOtaBlockedVersionNVS(badTarget.c_str());
      }
    }
  }

  gracefulDrainBeforeOtaReboot("emergency_rollback");

  Preferences p;
  if (p.begin(NVS_NS, false)) {
    if (p.isKey(K_OTA_SELFTEST)) p.remove(K_OTA_SELFTEST);
    p.end();
  }

  const esp_partition_t* otherPart = esp_ota_get_next_update_partition(NULL);
  if (otherPart != nullptr) {
    esp_app_desc_t appDesc{};
    esp_err_t descErr = esp_ota_get_partition_description(otherPart, &appDesc);
    if (descErr == ESP_OK) {
      esp_err_t err = esp_ota_set_boot_partition(otherPart);
      LOGE("[OTA][EMERGENCY-ROLLBACK] Revertendo partição de boot para '%s' (FW=%s, err=%d). Reiniciando...",
           otherPart->label, appDesc.version, static_cast<int>(err));
    } else {
      LOGE("[OTA][EMERGENCY-ROLLBACK] Partição secundária '%s' sem imagem válida (err=%d). Reiniciando partição atual...",
           otherPart->label, static_cast<int>(descErr));
    }
  } else {
    esp_ota_mark_app_invalid_rollback_and_reboot();
  }

  delay(300);
  ESP.restart();
}

void inspectFlashPartitionsOnBoot() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  const esp_partition_t* bootPart = esp_ota_get_boot_partition();
  const esp_partition_t* nextUpdate = esp_ota_get_next_update_partition(NULL);

  if (running) {
    safeCopy(g_runningPartition, sizeof(g_runningPartition), running->label);
    esp_ota_img_states_t otaState;
    esp_err_t err = esp_ota_get_state_partition(running, &otaState);
    if (err == ESP_OK && otaState == ESP_OTA_IMG_PENDING_VERIFY) {
      g_partitionNeedsVerify = true;
    }
    LOGI("[FLASH][PART] Rodando em '%s' (addr=0x%06lx size=%lu KB) | hw_pending_verify=%d | ota_key_id=%s",
         running->label,
         static_cast<unsigned long>(running->address),
         static_cast<unsigned long>(running->size / 1024UL),
         static_cast<int>(g_partitionNeedsVerify),
         OTA_SIGNING_KEY_ID);
    if (running->size < 0x1E0000UL) {
      LOGW("[FLASH][PART] Mapa de memória antigo detectado: regravar por USB com min_spiffs.csv");
    }
  }
  if (bootPart) {
    LOGD("[FLASH][PART] Boot partition configurada: '%s' (addr=0x%06lx)",
         bootPart->label, static_cast<unsigned long>(bootPart->address));
  }
  if (nextUpdate) {
    LOGD("[FLASH][PART] Próxima partição de destino OTA: '%s' (addr=0x%06lx max_size=%lu KB)",
         nextUpdate->label,
         static_cast<unsigned long>(nextUpdate->address),
         static_cast<unsigned long>(nextUpdate->size / 1024UL));
  }
}

void approveHardwarePartitionIfStable() {
  if (!g_partitionNeedsVerify) return;
  esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
  if (err == ESP_OK) {
    LOGI("[OTA][SELF-TEST] Estabilidade local comprovada! Partição '%s' (FW v%s) marcada como válida no Bootloader.",
         g_runningPartition, FW_VERSION);
  }
  g_partitionNeedsVerify = false;
}

void confirmOtaSelfTestAfterMqttConnected() {
  approveHardwarePartitionIfStable();

  if (g_appSelfTestPending) {
    g_appSelfTestPending = false;
    LOGI("[OTA][SELF-TEST] Conectividade mTLS AWS IoT comprovada na v%s (%s)! Self-Test concluído.",
         FW_VERSION, g_runningPartition);
  }

  Preferences p;
  if (!p.begin(NVS_NS, false)) return;

  if (p.isKey(K_OTA_SELFTEST)) {
    p.remove(K_OTA_SELFTEST);
  }

  String otaCmd    = p.isKey(K_OTA_CMD) ? p.getString(K_OTA_CMD, "") : "";
  String otaTarget = p.isKey(K_OTA_TARGET) ? p.getString(K_OTA_TARGET, "") : "";
  String otaRbWhy  = p.isKey(K_OTA_RBWHY) ? p.getString(K_OTA_RBWHY, "") : "";
  if (p.isKey(K_OTA_RBWHY)) {
    p.remove(K_OTA_RBWHY);
  }

  if (otaCmd.length() > 0) {
    p.remove(K_OTA_CMD);
    p.remove(K_OTA_TARGET);
    p.end();

    if (otaTarget.equalsIgnoreCase(FW_VERSION)) {
      LOGI("[OTA][VERIFY] Boot pós-OTA confirmado na versão alvo v%s (cmd=%s)!",
           FW_VERSION, otaCmd.c_str());
    } else {
      esp_reset_reason_t rr = esp_reset_reason();
      bool powerCaused = (rr == ESP_RST_POWERON || rr == ESP_RST_BROWNOUT);
      const char* detailWhy = (otaRbWhy.length() > 0) ? otaRbWhy.c_str()
                            : (powerCaused ? "power_loss_rollback" : "bootloader_rollback");
      LOGE("[OTA][ROLLBACK] Detectado Auto-Rollback! Esperado v%s, placa iniciou na v%s (cmd=%s why=%s).",
           otaTarget.c_str(), FW_VERSION, otaCmd.c_str(), detailWhy);
      if (otaTarget.length() > 0 &&
          (strcmp(detailWhy, "crash_after_ota") == 0 ||
           strcmp(detailWhy, "bootloader_rollback") == 0)) {
        persistOtaBlockedVersionNVS(otaTarget.c_str());
      }
      // Mantém reason="ota_rollback" (exigido pelo AckToFirestore para reabrir comando terminal)
      // e envia o detalhe específico no campo error.
      enqueueAck(otaCmd.c_str(), "failed", "ota", 0, "ota_rollback", detailWhy);
    }
  } else {
    p.end();
  }
}

// ---------------------------------------------------------------------------------
// Observação pós-OTA (v5.25.0 (Fase 3B))
// ---------------------------------------------------------------------------------
static bool     s_otaObsActive   = false;
static uint32_t s_otaObsStartMs  = 0;
static bool     s_otaObsMqttSeen = false;
static bool     s_otaObsHeapWarned = false;

bool otaSelfTestMqttSeen() {
  return s_otaObsMqttSeen;
}

void otaOnMqttConnected() {
  if (!g_partitionNeedsVerify && !g_appSelfTestPending) {
    confirmOtaSelfTestAfterMqttConnected();
    return;
  }
  s_otaObsMqttSeen = true;
  if (!s_otaObsActive) {
    s_otaObsActive = true;
    s_otaObsStartMs = msNow();
    LOGI("[OTA][OBSERVE] MQTT ok na v%s. Observando %lus continuos antes de aprovar a particao '%s'...",
         FW_VERSION, static_cast<unsigned long>(OTA_OBSERVATION_STABLE_MS / 1000UL), g_runningPartition);
  }
}

void otaObservationTick(bool mqttConnectedNow) {
  if (!s_otaObsActive) return;
  if (!mqttConnectedNow) {
    s_otaObsActive = false;
    LOGW("[OTA][OBSERVE] MQTT caiu durante a observacao; contagem reinicia na proxima conexao.");
    return;
  }
  if (!timeReached(msNow(), s_otaObsStartMs + OTA_OBSERVATION_STABLE_MS)) return;
  uint32_t freeHeap = esp_get_free_heap_size();
  if (freeHeap < OTA_OBSERVATION_MIN_HEAP_BYTES) {
    if (!s_otaObsHeapWarned) {
      s_otaObsHeapWarned = true;
      LOGW("[OTA][OBSERVE] Heap baixo (%lu B < %lu B); aprovacao adiada.",
           static_cast<unsigned long>(freeHeap),
           static_cast<unsigned long>(OTA_OBSERVATION_MIN_HEAP_BYTES));
    }
    return;  // o prazo absoluto de 10 min continua valendo
  }
  s_otaObsActive = false;
  LOGI("[OTA][OBSERVE] %lus continuos de MQTT (heap=%lu B). Aprovando particao.",
       static_cast<unsigned long>(OTA_OBSERVATION_STABLE_MS / 1000UL),
       static_cast<unsigned long>(freeHeap));
  confirmOtaSelfTestAfterMqttConnected();
  // v5.25.1 (Fase 3B): avisa a nuvem imediatamente que a particao foi aprovada
  // (presenca com ota_pending_verify=false), sem esperar o heartbeat de 5 min.
  publishPresenceOnline("heartbeat");
}

bool scheduleOtaJob(const char* cmdId, const char* version, const char* sha256,
                    const char* url, uint32_t fileSize,
                    const char* sigB64, const char* sigAlg) {
  if (!lockSem(otaMutex, 100)) return false;
  if (g_otaJob.pending || g_otaInProgress) {
    unlockSem(otaMutex);
    return false;
  }

  safeCopy(g_otaJob.commandId, sizeof(g_otaJob.commandId), cmdId);
  safeCopy(g_otaJob.targetVersion, sizeof(g_otaJob.targetVersion), version);
  safeCopy(g_otaJob.expectedSha256, sizeof(g_otaJob.expectedSha256), sha256);
  safeCopy(g_otaJob.otaUrl, sizeof(g_otaJob.otaUrl), url);
  safeCopy(g_otaJob.signatureB64, sizeof(g_otaJob.signatureB64), sigB64);
  safeCopy(g_otaJob.sigAlg, sizeof(g_otaJob.sigAlg), sigAlg);
  g_otaJob.expectedSize = fileSize;
  g_otaJob.pending = true;

  unlockSem(otaMutex);
  LOGI("[OTA][SCHED] Job OTA agendado: cmd=%s target=v%s expectedSize=%lu B sha256=%.12s sig_len=%u",
       cmdId, version, static_cast<unsigned long>(fileSize), sha256,
       static_cast<unsigned>(sigB64 ? strlen(sigB64) : 0));
  return true;
}

bool waitWifiForOtaRetry(uint32_t maxWaitMs) {
  if (WiFi.status() == WL_CONNECTED) return true;
  LOGW("[OTA][NET-RECOVERY] Wi-Fi desconectado! Tentando reconectar por até %lus...",
       static_cast<unsigned long>(maxWaitMs / 1000UL));
  WiFi.disconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t start = msNow();
  while (!timeReached(msNow(), start + maxWaitMs)) {
#ifdef ESP32
    esp_task_wdt_reset();
#endif
    if (WiFi.status() == WL_CONNECTED) {
      LOGD("[OTA][NET-RECOVERY] Wi-Fi restabelecido! IP=%s RSSI=%d dBm",
           WiFi.localIP().toString().c_str(), WiFi.RSSI());
      return true;
    }
    vTaskDelay(pdMS_TO_TICKS(250));
  }
  return (WiFi.status() == WL_CONNECTED);
}

void executePendingOtaJobIfAny() {
  if (!lockSem(otaMutex, 20)) return;
  if (!g_otaJob.pending) {
    unlockSem(otaMutex);
    return;
  }

  char cmdId[48];
  char targetVer[24];
  char expectedSha256[65];
  char localSigB64[104];
  char localSigAlg[24];
  static char localOtaUrl[1600];
  uint32_t expectedSize = g_otaJob.expectedSize;

  safeCopy(cmdId, sizeof(cmdId), g_otaJob.commandId);
  safeCopy(targetVer, sizeof(targetVer), g_otaJob.targetVersion);
  safeCopy(expectedSha256, sizeof(expectedSha256), g_otaJob.expectedSha256);
  safeCopy(localSigB64, sizeof(localSigB64), g_otaJob.signatureB64);
  safeCopy(localSigAlg, sizeof(localSigAlg), g_otaJob.sigAlg);
  safeCopy(localOtaUrl, sizeof(localOtaUrl), g_otaJob.otaUrl);
  g_otaJob.pending = false;
  unlockSem(otaMutex);

  LOGI("====================================================================");
  LOGI("[OTA][START] Iniciando procedimento OTA: cmd=%s | atual=v%s (%s) -> alvo=v%s",
       cmdId, FW_VERSION, g_runningPartition, targetVer);
  LOGI("====================================================================");

  if (!isTrustedOtaUrlLocal(localOtaUrl)) {
    LOGE("[OTA][SECURITY] URL OTA rejeitada na execução: host não pertence ao bucket S3 oficial!");
    publishOrQueueAck(cmdId, "failed", "ota", 0, "invalid_payload", "ota_url_untrusted_host");
    return;
  }

  bool valveCurrentlyOn = false;
  uint32_t dummyOff = 0;
  valveReadStateAtomic(valveCurrentlyOn, dummyOff);
  if (valveCurrentlyOn) {
    LOGE("[OTA][ABORT] Válvula aberta detectada antes do download! Abortando OTA por segurança física.");
    publishOrQueueAck(cmdId, "failed", "ota", 0, "ota_valve_busy", "valve_open_during_ota");
    return;
  }

  const esp_partition_t* nextPart = esp_ota_get_next_update_partition(NULL);
  if (!nextPart) {
    LOGE("[OTA][ABORT] Nenhuma partição OTA secundária encontrada na tabela de partições!");
    publishOrQueueAck(cmdId, "failed", "ota", 0, "ota_flash_error", "no_ota_partition");
    return;
  }
  if (expectedSize > 0 && expectedSize > nextPart->size) {
    LOGE("[OTA][ABORT] Binário (%lu B) excede o tamanho da partição '%s' (%lu B)!",
         static_cast<unsigned long>(expectedSize), nextPart->label, static_cast<unsigned long>(nextPart->size));
    publishOrQueueAck(cmdId, "failed", "ota", 0, "ota_flash_error", "firmware_exceeds_partition");
    return;
  }

  uint32_t heapBefore = esp_get_free_heap_size();
  LOGD("[OTA][MEM] Heap livre antes de liberar sessão MQTT: %lu bytes", static_cast<unsigned long>(heapBefore));
  if (heapBefore < OTA_MIN_FREE_HEAP_BYTES) {
    LOGE("[OTA][ABORT] Memória Heap insuficiente (%lu B < %lu B).",
         static_cast<unsigned long>(heapBefore), static_cast<unsigned long>(OTA_MIN_FREE_HEAP_BYTES));
    publishOrQueueAck(cmdId, "failed", "ota", 0, "ota_low_heap", "insufficient_ram");
    return;
  }

  publishOrQueueAck(cmdId, "started", "ota", 0, nullptr, nullptr);
  flushAckQueueTick();
  for (int i = 0; i < 5; i++) {
    if (client.connected()) client.loop();
    vTaskDelay(pdMS_TO_TICKS(40));
  }

  LOGD("[OTA][NET] Liberando conexão TLS do MQTT para alocar buffer TLS de download S3...");
  client.disconnect();
  net.stop();
  g_mqttConnected = false;
  vTaskDelay(pdMS_TO_TICKS(100));

  uint32_t heapForHttps = esp_get_free_heap_size();
  LOGI("[OTA][MEM] Heap livre após liberar MQTT TLS: %lu bytes (+%ld B liberados)",
       static_cast<unsigned long>(heapForHttps),
       static_cast<long>(heapForHttps) - static_cast<long>(heapBefore));

  persistOtaInProgressNVS(cmdId);
  g_otaInProgress = true;
  g_otaProgressPct = 0;

  const char* finalFailReason = "ota_http_failed";
  char finalFailError[48] = "download_failed";
  bool otaSuccess = false;
  uint32_t tGlobalOtaStart = msNow();

  for (uint32_t attempt = 1; attempt <= OTA_MAX_ATTEMPTS; attempt++) {
#ifdef ESP32
    esp_task_wdt_reset();
#endif
    g_otaCurrentAttempt = static_cast<uint8_t>(attempt);
    g_otaProgressPct = 0;

    if (attempt > 1) {
      uint32_t backoffMs = 2000UL * attempt;
      LOGW("[OTA][RETRY] Aguardando %lu ms antes da tentativa %lu/%lu...",
           static_cast<unsigned long>(backoffMs),
           static_cast<unsigned long>(attempt),
           static_cast<unsigned long>(OTA_MAX_ATTEMPTS));
      vTaskDelay(pdMS_TO_TICKS(backoffMs));
    }

    if (!waitWifiForOtaRetry(OTA_WIFI_WAIT_MS)) {
      safeCopy(finalFailError, sizeof(finalFailError), "wifi_lost_during_ota");
      finalFailReason = "ota_http_failed";
      continue;
    }

    WiFiClientSecure otaTlsClient;
    otaTlsClient.setCACert(OTA_S3_CA_BUNDLE);
    otaTlsClient.setHandshakeTimeout(30);

    HTTPClient http;
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    http.setTimeout(OTA_HTTP_TIMEOUT_MS);
    http.setReuse(false);

    LOGI("[OTA][HTTP] Tentativa %lu/%lu: abrindo conexão HTTPS direta com Amazon S3 (url_len=%u chars)...",
         static_cast<unsigned long>(attempt),
         static_cast<unsigned long>(OTA_MAX_ATTEMPTS),
         static_cast<unsigned>(strlen(localOtaUrl)));

    uint32_t tHttpStart = msNow();
    if (!http.begin(otaTlsClient, localOtaUrl)) {
      LOGE("[OTA][HTTP] Falha ao inicializar HTTPClient.begin() na tentativa %lu!",
           static_cast<unsigned long>(attempt));
      http.end();
      otaTlsClient.stop();
      safeCopy(finalFailError, sizeof(finalFailError), "http_begin_failed");
      finalFailReason = "ota_http_failed";
      continue;
    }

    int httpCode = http.GET();
    uint32_t httpConnMs = msNow() - tHttpStart;
    LOGI("[OTA][HTTP] Resposta GET HTTP=%d em %lu ms (heap=%lu B)",
         httpCode, static_cast<unsigned long>(httpConnMs),
         static_cast<unsigned long>(esp_get_free_heap_size()));

    if (httpCode != HTTP_CODE_OK) {
      snprintf(finalFailError, sizeof(finalFailError), "http_status_%d", httpCode);
      LOGE("[OTA][HTTP] Download recusado/falhou: %s", finalFailError);
      http.end();
      otaTlsClient.stop();
      finalFailReason = "ota_http_failed";
      if (httpCode == 403 || httpCode == 404 || (httpCode >= 300 && httpCode < 400)) break;
      continue;
    }

    int contentLength = http.getSize();
    LOGI("[OTA][HTTP] Content-Length reportado pelo S3: %d bytes (esperado=%lu bytes)",
         contentLength, static_cast<unsigned long>(expectedSize));

    if (contentLength > 0 && static_cast<uint32_t>(contentLength) > nextPart->size) {
      LOGE("[OTA][FLASH] Content-Length (%d B) maior que a partição '%s' (%lu B)!",
           contentLength, nextPart->label, static_cast<unsigned long>(nextPart->size));
      safeCopy(finalFailError, sizeof(finalFailError), "content_exceeds_partition");
      finalFailReason = "ota_flash_error";
      http.end();
      otaTlsClient.stop();
      break;
    }

    size_t updateSize = (contentLength > 0) ? static_cast<size_t>(contentLength) : UPDATE_SIZE_UNKNOWN;
    if (!Update.begin(updateSize, U_FLASH)) {
      LOGE("[OTA][FLASH] Update.begin() falhou! err=%u (%s)",
           static_cast<unsigned>(Update.getError()), Update.errorString());
      safeCopy(finalFailError, sizeof(finalFailError), Update.errorString());
      finalFailReason = "ota_flash_error";
      http.end();
      otaTlsClient.stop();
      break;
    }

    mbedtls_sha256_context shaCtx;
    mbedtls_sha256_init(&shaCtx);
    mbedtls_sha256_starts_ret(&shaCtx, 0);

    WiFiClient* stream = http.getStreamPtr();
    static uint8_t chunkBuf[OTA_CHUNK_SIZE];
    size_t totalWritten = 0;
    size_t totalTarget = (contentLength > 0) ? static_cast<size_t>(contentLength) : expectedSize;
    uint32_t dlStartMs = msNow();
    uint32_t lastByteMs = dlStartMs;
    int lastLoggedDecile = -1;
    bool attemptAborted = false;
    bool nonRetryableAbort = false;

    LOGI("[OTA][STREAM] Gravando em blocos de %u bytes na partição Flash secundária ('%s')...",
         static_cast<unsigned>(OTA_CHUNK_SIZE), nextPart->label);

    while (http.connected() && (contentLength > 0 || contentLength == -1)) {
#ifdef ESP32
      esp_task_wdt_reset();
#endif

      uint32_t now = msNow();
      if (timeReached(now, dlStartMs + OTA_MAX_ATTEMPT_TIME_MS)) {
        LOGE("[OTA][STREAM] Timeout da tentativa %lu (%lu ms) excedido!",
             static_cast<unsigned long>(attempt),
             static_cast<unsigned long>(OTA_MAX_ATTEMPT_TIME_MS));
        attemptAborted = true;
        finalFailReason = "ota_http_failed";
        safeCopy(finalFailError, sizeof(finalFailError), "ota_attempt_timeout");
        break;
      }

      valveReadStateAtomic(valveCurrentlyOn, dummyOff);
      if (valveCurrentlyOn) {
        LOGE("[OTA][INTERLOCK] Válvula acionada durante o download OTA! Abortando imediatamente.");
        attemptAborted = true;
        nonRetryableAbort = true;
        finalFailReason = "ota_valve_busy";
        safeCopy(finalFailError, sizeof(finalFailError), "valve_opened_mid_ota");
        break;
      }

      size_t avail = stream->available();
      if (avail > 0) {
        size_t toRead = (avail > OTA_CHUNK_SIZE) ? OTA_CHUNK_SIZE : avail;
        int bytesRead = stream->readBytes(chunkBuf, toRead);
        if (bytesRead > 0) {
          lastByteMs = msNow();

          mbedtls_sha256_update_ret(&shaCtx, chunkBuf, static_cast<size_t>(bytesRead));

          size_t written = Update.write(chunkBuf, static_cast<size_t>(bytesRead));
          if (written != static_cast<size_t>(bytesRead)) {
            LOGE("[OTA][FLASH] Falha de escrita na Flash! lido=%d escrito=%u err=%s",
                 bytesRead, static_cast<unsigned>(written), Update.errorString());
            attemptAborted = true;
            nonRetryableAbort = true;
            finalFailReason = "ota_flash_error";
            safeCopy(finalFailError, sizeof(finalFailError), "flash_write_short");
            break;
          }

          totalWritten += written;
          if (contentLength > 0) {
            contentLength -= bytesRead;
          }

          if (totalTarget > 0) {
            uint8_t pct = static_cast<uint8_t>((totalWritten * 100ULL) / totalTarget);
            if (pct > 100) pct = 100;
            g_otaProgressPct = pct;

            int decile = pct / 10;
            if (decile != lastLoggedDecile) {
              lastLoggedDecile = decile;
              uint32_t elapsedDlMs = msNow() - dlStartMs;
              float speedKbps = (elapsedDlMs > 0)
                ? (static_cast<float>(totalWritten) / 1024.0f) / (static_cast<float>(elapsedDlMs) / 1000.0f)
                : 0.0f;
              LOGI("[OTA][PROGRESS][T%lu] %3u%% (%lu / %lu bytes) | vel=%.1f KB/s | heap=%lu B",
                   static_cast<unsigned long>(attempt),
                   static_cast<unsigned>(pct),
                   static_cast<unsigned long>(totalWritten),
                   static_cast<unsigned long>(totalTarget),
                   speedKbps,
                   static_cast<unsigned long>(esp_get_free_heap_size()));
            }
          }
        }
      } else {
        if (contentLength == 0) break;
        if (timeReached(msNow(), lastByteMs + OTA_HTTP_TIMEOUT_MS)) {
          LOGE("[OTA][STREAM] Timeout sem receber bytes por %lu ms na tentativa %lu (recebidos=%lu B)!",
               static_cast<unsigned long>(OTA_HTTP_TIMEOUT_MS),
               static_cast<unsigned long>(attempt),
               static_cast<unsigned long>(totalWritten));
          attemptAborted = true;
          finalFailReason = "ota_http_failed";
          safeCopy(finalFailError, sizeof(finalFailError), "stream_read_timeout");
          break;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
      }
    }

    uint8_t shaResultBytes[32] = {0};
    mbedtls_sha256_finish_ret(&shaCtx, shaResultBytes);
    mbedtls_sha256_free(&shaCtx);

    http.end();
    otaTlsClient.stop();

    if (attemptAborted || totalWritten == 0) {
      Update.abort();
      LOGW("[OTA][ATTEMPT-FAIL] Tentativa %lu abortada após %lu bytes (reason=%s error=%s).",
           static_cast<unsigned long>(attempt),
           static_cast<unsigned long>(totalWritten),
           finalFailReason, finalFailError);
      if (nonRetryableAbort) break;
      continue;
    }

    if (expectedSize > 0 && totalWritten != expectedSize) {
      Update.abort();
      LOGW("[OTA][ATTEMPT-FAIL] Tamanho baixado (%lu B) difere do esperado (%lu B) na tentativa %lu!",
           static_cast<unsigned long>(totalWritten),
           static_cast<unsigned long>(expectedSize),
           static_cast<unsigned long>(attempt));
      finalFailReason = "ota_http_failed";
      safeCopy(finalFailError, sizeof(finalFailError), "incomplete_download_size");
      continue;
    }

    char computedSha256[65] = {0};
    bytesToHexLower(shaResultBytes, 32, computedSha256, sizeof(computedSha256));

    LOGI("[OTA][HASH] SHA-256 Esperado : %.12s...", expectedSha256);
    LOGI("[OTA][HASH] SHA-256 Calculado: %.12s...", computedSha256);

    if (strcasecmp(computedSha256, expectedSha256) != 0) {
      Update.abort();
      LOGE("[OTA][SECURITY] ALERTA CRÍTICO: Hash SHA-256 divergente! Imagem descartada.");
      finalFailReason = "ota_hash_mismatch";
      safeCopy(finalFailError, sizeof(finalFailError), "sha256_verification_failed");
      break;
    }

    // Defesa em profundidade: revalida assinatura ECDSA P-256 com o SHA-256 e
    // o total de bytes realmente gravados na Flash antes de finalizar a partição.
    const char* postSigReason = nullptr;
    if (!otaVerifyManifestSignature(
            targetVer,
            computedSha256,
            static_cast<uint32_t>(totalWritten),
            localSigB64,
            localSigAlg,
            &postSigReason)) {
      Update.abort();
      LOGE("[OTA][SECURITY] Revalidação ECDSA P-256 pós-download falhou! Imagem descartada.");
      finalFailReason = "ota_signature_invalid";
      safeCopy(finalFailError, sizeof(finalFailError), "post_download_sig_failed");
      break;
    }

    if (!Update.end(true)) {
      LOGE("[OTA][FLASH] Update.end(true) falhou! err=%u (%s)",
           static_cast<unsigned>(Update.getError()), Update.errorString());
      finalFailReason = "ota_flash_error";
      safeCopy(finalFailError, sizeof(finalFailError), Update.errorString());
      break;
    }

    otaSuccess = true;
    uint32_t totalOtaMs = msNow() - tGlobalOtaStart;
    LOGI("====================================================================");
    LOGI("[OTA][SUCCESS] Firmware v%s (%lu bytes) gravado e verificado em %lu ms (tentativa %lu)!",
         targetVer,
         static_cast<unsigned long>(totalWritten),
         static_cast<unsigned long>(totalOtaMs),
         static_cast<unsigned long>(attempt));
    LOGI("====================================================================");
    break;
  }

  persistOtaInProgressNVS(nullptr);

  if (!otaSuccess) {
    g_otaInProgress = false;
    LOGE("[OTA][FINAL-FAIL] Procedimento OTA encerrado com falha: reason=%s error=%s",
         finalFailReason, finalFailError);
    enqueueAck(cmdId, "failed", "ota", 0, finalFailReason, finalFailError);
    return;
  }

  persistPendingOtaVerificationNVS(cmdId, targetVer);
  enqueueAck(cmdId, "done", "ota", 0, "ota_rebooting", nullptr);

  if (waitWifiForOtaRetry(10000UL)) {
    LOGD("[OTA][NET] Reconectando ao AWS IoT Core para despachar ACK 'done' e presença antes do reboot...");
    net.stop();
    net.setCACert(AWS_CERT_CA);
    net.setCertificate(AWS_CERT_CRT);
    net.setPrivateKey(AWS_CERT_PRIVATE);
    net.setHandshakeTimeout(15);

    uint32_t nextSess = ++g_mqttSessionSeq;
    char willPayload[320];
    uint32_t willLen = 0;
    if (!buildPresenceJson("offline", "lwt", nextSess, willPayload, sizeof(willPayload), willLen)) {
      safeCopy(willPayload, sizeof(willPayload), "offline");
    }

    if (client.connect(THINGNAME, g_topicPresence, PRESENCE_QOS, PRESENCE_RETAIN, willPayload)) {
      g_mqttConnected = true;
      flushAckQueueTick();
      publishPresenceOtaRebooting();
      for (int i = 0; i < 10; i++) {
        client.loop();
        vTaskDelay(pdMS_TO_TICKS(50));
      }
      client.disconnect();
      net.stop();
    }
  }

  valveApplyCommand(false, 0);
  gracefulDrainBeforeOtaReboot("ota_success_reboot");

  LOGI("[OTA][REBOOT] Reiniciando microcontrolador ESP32 para carregar a nova partição...");
  delay(400);
  ESP.restart();
}
