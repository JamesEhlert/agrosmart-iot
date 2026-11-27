/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/core/command_parser.cpp
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Fase 3 / Parte B — v5.24.0)
 * REVISÃO: 2026-11-22 UTC
 * PROPÓSITO: Implementação da via expressa de recepção e validação de comandos MQTT,
 *            com isolamento do canal dedicado `ack_receipt`, verificação de assinatura
 *            ECDSA P-256 + anti-downgrade estrito + bloqueio `ota_badver` para OTA,
 *            allowlist S3, tombstone de cancelamento OFF e atomicidade RAM/NVS.
 * CHANGELOG 2026-11-24 (v5.27.0):
 * - `command_id` com prefixo `loc-` é recusado: o prefixo é exclusivo dos botões físicos.
 * - `config` aceita `display_mode`/`display_minutes`/`btn_irrig_min` (sem misturar com
 *   intervalo/calibração); ACK `display_updated`/`buttons_updated`/`local_config_updated`.
 * - LIGAR/DESLIGAR remoto passa pela mesma seção crítica do botão (ValveCommandSection).
 * CHANGELOG 2026-11-24 (v5.26.0 (Fase 4.0-E)):
 * - LIGAR passa pelo balde anti-rajada (6 seguidos, depois 1 a cada 30 s) e pelo
 *   intervalo mínimo de 2 s após fechar; recusa `rate_limited`/`valve_cooldown` com
 *   `retry_after_s=N` em `error`. DESLIGAR nunca é limitado.
 * - Idempotência também pelo livro durável (`ackLedgerSeen`): command_id já processado
 *   nunca é reexecutado, mesmo depois que a vaga do outbox foi reaproveitada.
 * - Reserva recusada distingue `ack_storage_unavailable` (memória com defeito) de
 *   `ack_outbox_busy` (vagas aguardando recibo).
 * - ACK do LIGAR interrompido é adiado ACK_SIBLING_DEFER_MS (DESLIGAR chega primeiro).
 * CHANGELOG 2026-11-22 (v5.24.0):
 * - Amplia StaticJsonDocument para 3072 e responde `invalid_payload`/`json_no_memory`
 *   em DeserializationError::NoMemory.
 * - Ação `ota` valida em ordem estrita: assinatura presente, SemVer estrito
 *   anti-downgrade, lista de bloqueio NVS (`ota_badver`), assinatura ECDSA P-256,
 *   allowlist S3 e interlock de válvula, sem logar `ota_url` nem assinatura.
 * CHANGELOG 2026-11-21 (v5.23.1):
 * - Separa o tópico `g_topicAckReceipt`: aceita somente `ack_receipt` (<= 512B),
 *   bloqueando qualquer ação operacional (`on`/`off`/`config`/`ota`) nesse canal.
 * - Restringe `ota_url` aos prefixos HTTPS oficiais do bucket privado S3 do projeto,
 *   rejeitando hosts arbitrários, caracteres de controle, `@` e path traversal `..`.
 * ===================================================================================
 */
#include "core/command_parser.h"
#include "config/app_config.h"
#include "config/system_types.h"
#include "core/ack_outbox.h"
#include "core/config_validator.h"
#include "core/durable_ack.h"
#include "core/local_input.h"
#include "core/time_math.h"
#include "core/valve_controller.h"
#include "hal/nvs_store.h"
#include "hal/rtc_time_service.h"
#include "hal/sensor_drivers.h"
#include "services/diagnostics_service.h"
#include "services/local_controls.h"
#include "services/logger.h"
#include "services/ota_manager.h"
#include "services/ota_signature.h"
#include "tasks/rtos_sync.h"
#include <ArduinoJson.h>
#include <esp_heap_caps.h>
#include <esp_system.h>

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "secrets.h não encontrado. Garanta que está em firmware/include/secrets.h"
#endif

static int64_t g_lastOffIssuedAt = 0;

static bool isTrustedOtaUrl(const char* url) {
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

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  uint32_t cbStartUs = static_cast<uint32_t>(micros());
  uint32_t freeHeap = esp_get_free_heap_size();
  uint32_t maxBlock = heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);

  LOGI("[MQTT] msg topic=%s len=%u freeHeap=%lu B maxBlock=%lu B",
       topic, length,
       static_cast<unsigned long>(freeHeap),
       static_cast<unsigned long>(maxBlock));

  bool isCommandTopic = (strcmp(topic, g_topicCommand) == 0);
  bool isReceiptTopic = (strcmp(topic, g_topicAckReceipt) == 0);
  if (!isCommandTopic && !isReceiptTopic) return;

  // Canal dedicado `ack_receipt`: aceita EXCLUSIVAMENTE recibos (<= 512B), nunca comandos físicos!
  if (isReceiptTopic) {
    if (length > MAX_STD_CMD_PAYLOAD_LEN) {
      g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
      LOGE("[MQTT][RECEIPT] Payload excede limite de %u bytes (%u B).",
           static_cast<unsigned>(MAX_STD_CMD_PAYLOAD_LEN), length);
      return;
    }
    static StaticJsonDocument<512> receiptDoc;
    receiptDoc.clear();
    DeserializationError rErr = deserializeJson(receiptDoc, reinterpret_cast<const char*>(payload), length);
    if (rErr || receiptDoc.overflowed()) {
      g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
      LOGE("[MQTT][RECEIPT] JSON inválido no tópico ack_receipt: %s", rErr ? rErr.c_str() : "overflow");
      return;
    }
    const char* targetDevice = receiptDoc["device_id"];
    if (!targetDevice || strcmp(targetDevice, THINGNAME) != 0) {
      g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
      LOGW("[MQTT][RECEIPT] Recibo recusado: device_id %s.", targetDevice ? "de outra estacao" : "ausente");
      return;
    }
    if (!ackHandleReceipt(receiptDoc)) {
      g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
      LOGW("[MQTT][RECEIPT] Mensagem não-recibo bloqueada no tópico dedicado ack_receipt.");
    }
    return;
  }

  bool looksLikeOta = false;
  if (length <= MAX_OTA_CMD_PAYLOAD_LEN && payload != nullptr) {
    const char* rawStart = reinterpret_cast<const char*>(payload);
    for (unsigned int i = 0; i + 5 < length; i++) {
      if (rawStart[i] == '"' && rawStart[i + 1] == 'o' && rawStart[i + 2] == 't' &&
          rawStart[i + 3] == 'a' && rawStart[i + 4] == '"') {
        looksLikeOta = true;
        break;
      }
    }
  }

  if (!looksLikeOta && length > MAX_STD_CMD_PAYLOAD_LEN) {
    g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
    LOGE("[MQTT] JSON inválido: NoMemory (payload len=%u excede limite padrão de %u bytes)",
         length, static_cast<unsigned>(MAX_STD_CMD_PAYLOAD_LEN));
    return;
  }

  static StaticJsonDocument<3072> doc;
  doc.clear();

  DeserializationError err = deserializeJson(doc, reinterpret_cast<const char*>(payload), length);
  if (err) {
    g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
    if (err == DeserializationError::NoMemory) {
      LOGE("[MQTT] JSON excedeu memória do parser (NoMemory, len=%u)!", length);
      enqueueAck("overflow-cmd", "failed", nullptr, -1, "invalid_payload", "json_no_memory");
    } else {
      LOGE("[MQTT] JSON inválido: %s", err.c_str());
    }
    return;
  }

  if (doc.overflowed()) {
    g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
    LOGE("[MQTT] Payload excedeu capacidade do documento JSON!");
    enqueueAck("overflow-cmd", "failed", nullptr, -1, "payload_too_large", "json_overflow");
    return;
  }

  const char* targetDevice = doc["device_id"];
  // v5.25.2 (Fase 3C): device_id agora e OBRIGATORIO (antes, ausente era aceito).
  if (!targetDevice || strcmp(targetDevice, THINGNAME) != 0) {
    g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
    LOGW("[MQTT] Comando recusado: device_id %s.", targetDevice ? "de outra estacao" : "ausente");
    return;
  }

  // Compatibilidade de transição: ainda aceita ack_receipt legado via command até corte final da role IAM
  if (ackHandleReceipt(doc)) return;

  char cmdLocal[48] = {0};
  char actionLocal[24] = {0};

  const char* cmdIdRaw = doc["command_id"];
  if (cmdIdRaw && cmdIdRaw[0] != '\0') {
    if (strlen(cmdIdRaw) >= sizeof(cmdLocal)) {
      g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
      LOGE("[MQTT][CMD] command_id excede limite de %u caracteres!", static_cast<unsigned>(sizeof(cmdLocal) - 1));
      return;
    }
    safeCopy(cmdLocal, sizeof(cmdLocal), cmdIdRaw);
  } else {
    g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
    LOGE("[MQTT][CMD] Missing command_id; refusing untraceable command.");
    return;
  }

  if (strchr(cmdLocal, '/') || strchr(cmdLocal, '\\')) {
    g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
    LOGE("[MQTT][CMD] Invalid command_id path characters; refusing command."); return;
  }
  // v5.27.0: "loc-" é exclusivo dos botões físicos; ninguém de fora forja um aperto.
  if (agrolocal::isLocalPrefix(cmdLocal)) {
    g_cmdRejected++;
    LOGW("[MQTT][CMD] command_id com prefixo reservado aos botoes da estacao; recusado.");
    return;
  }
  const char* actionRaw = doc["action"];
  if (actionRaw && actionRaw[0] != '\0') {
    safeCopy(actionLocal, sizeof(actionLocal), actionRaw);
  }

  int32_t duration = doc["duration"] | 0;
  int64_t issuedAt = doc["issued_at"] | 0;
  int64_t expiresAt = doc["expires_at"] | 0;
  if (lockSem(ackMutex, 100)) {
    safeCopy(g_incomingCommandId, sizeof(g_incomingCommandId), cmdLocal);
    g_incomingExpiresAt = expiresAt > 0 ? static_cast<uint64_t>(expiresAt) : 0;
    unlockSem(ackMutex);
  }

  LOGD("[MQTT][CMD] Processando cmd=%s action=%s duration=%ld",
       cmdLocal, actionLocal[0] ? actionLocal : "(vazio)", static_cast<long>(duration));

  if (!actionLocal[0]) {
    enqueueAck(cmdLocal, "failed", nullptr, -1, "invalid_payload", "missing_action");
    return;
  }

  if (strcmp(actionLocal, "ota") != 0 && length > MAX_STD_CMD_PAYLOAD_LEN) {
    g_cmdRejected++;  // v5.25.2 (Fase 3C): recusado sem ACK
    LOGE("[MQTT] JSON inválido: NoMemory (comando '%s' com %u bytes > 512B)", actionLocal, length);
    return;
  }

  agroack::Record durablePrevious{};
  if (ackGet(cmdLocal, durablePrevious)) {
    if (durablePrevious.kind == agroack::Active) {
      bool stillOn = false; uint32_t activeDeadline = 0;
      char activeOwner[48] = {0};
      if (lockSem(valveMutex, 50)) {
        valveReadStateAtomic(stillOn, activeDeadline);
        safeCopy(activeOwner, sizeof(activeOwner), g_activeCommandId);
        unlockSem(valveMutex);
      }
      if (agroack::mayReportStarted(durablePrevious, g_bootId, activeOwner, stillOn))
        enqueueAck(cmdLocal, "started", "on", durablePrevious.duration, nullptr, nullptr);
      else
        LOGE("[ACK][DEDUP_UNKNOWN] cmd=%s active reservation without current ON evidence; no started ACK", cmdLocal);
    } else if (durablePrevious.kind == agroack::Delivered &&
               strcmp(durablePrevious.reason, "cancelled_by_off") == 0 &&
               durablePrevious.duration < 0 &&
               strcmp(actionLocal, "on") == 0) {
      ackPromoteTombstoneToTerminal(cmdLocal, duration);
    }
    LOGI("[ACK][DEDUP] cmd=%s stored_kind=%u", cmdLocal, unsigned(durablePrevious.kind));
    return;
  }

  RecentCmdEntry prevCmd{};
  if (findRecentCommandSafe(cmdLocal, prevCmd)) {
    LOGW("[MQTT][IDEMPOTENCY] command_id=%s já processado (status=%s). Reenfileirando ACK idempotente.",
         cmdLocal, prevCmd.status);
    bool currentlyOn = false;
    uint32_t dummyOff = 0;
    valveReadStateAtomic(currentlyOn, dummyOff);

    const char* ackStatus = prevCmd.status[0] ? prevCmd.status : (currentlyOn ? "started" : "done");
    const char* ackReason = prevCmd.reason[0] ? prevCmd.reason : nullptr;
    enqueueAck(cmdLocal, ackStatus, prevCmd.action, prevCmd.durationS, ackReason, nullptr);
    return;
  }

  // v5.26.0 (Fase 4.0-E): livro de idempotência durável. O registro saiu do outbox (vaga
  // reaproveitada), mas o command_id já foi processado: nunca executar de novo.
  if (ackLedgerSeen(cmdLocal)) {
    LOGW("[ACK][DEDUP_LEDGER] cmd=%s ja processado (livro de idempotencia); nada sera executado", cmdLocal);
    return;
  }

  uint32_t nowEp = epochNow();
  if ((strcmp(actionLocal, "on") == 0 || strcmp(actionLocal, "ota") == 0) && expiresAt > 0 && isValidEpoch(nowEp)) {
    int64_t currentEpoch = static_cast<int64_t>(nowEp);
    if (currentEpoch > expiresAt) {
      LOGW("[MQTT][TTL] Comando %s (%s) expirado (now=%lld > expires_at=%lld).",
           cmdLocal, actionLocal, static_cast<long long>(currentEpoch), static_cast<long long>(expiresAt));
      enqueueAck(cmdLocal, "failed", actionLocal, duration, "command_expired", "ttl_exceeded");
      return;
    }
  }

  if (strcmp(actionLocal, "on") == 0 && duration > 0) {
    if (issuedAt > 0 && g_lastOffIssuedAt > 0 && issuedAt <= g_lastOffIssuedAt) {
      LOGW("[MQTT][SUPERSEDED] Comando ON %s (issued_at=%lld) anterior ao último OFF (%lld). Rejeitando.",
           cmdLocal, static_cast<long long>(issuedAt), static_cast<long long>(g_lastOffIssuedAt));
      enqueueAck(cmdLocal, "failed", "on", duration, "superseded_by_off", "older_than_last_off");
      return;
    }
    // v5.26.0 (Fase 4.0-E): balde anti-rajada (6 seguidos, depois 1 a cada 30 s) e 2 s
    // entre fechar e religar. Recusa volta com o tempo de espera em `error`.
    agroflood::Decision flood = ackFloodCheck(msNow());
    if (flood.verdict != agroflood::Allowed) {
      g_floodRejects++;
      const char* why = (flood.verdict == agroflood::ValveCooldown) ? "valve_cooldown" : "rate_limited";
      char wait[24];
      snprintf(wait, sizeof(wait), "retry_after_s=%lu", static_cast<unsigned long>((flood.retryAfterMs + 999UL) / 1000UL));
      LOGW("[MQTT][FLOOD] LIGAR recusado (%s) cmd=%s; liberado em %lu ms", why, cmdLocal,
           static_cast<unsigned long>(flood.retryAfterMs));
      enqueueAck(cmdLocal, "failed", "on", duration, why, wait);
      return;
    }
  }

  safeCopy(g_lastCommandId, sizeof(g_lastCommandId), cmdLocal);

  // =================================================================================
  // TRATAMENTO DA AÇÃO "ota" (ATUALIZAÇÃO REMOTA ASSINADA — CONTRATO v1)
  // =================================================================================
  if (strcmp(actionLocal, "ota") == 0) {
    enqueueAck(cmdLocal, "received", "ota", 0, nullptr, nullptr);

    const char* targetVer = doc["version"] | "";
    const char* otaUrl    = doc["ota_url"] | "";
    const char* sha256    = doc["sha256"]  | "";
    const char* sigB64    = doc["sig"]     | "";
    const char* sigAlg    = doc["sig_alg"] | "";
    uint32_t fileSize     = doc["file_size"] | 0;

    if (targetVer[0] == 'v' || targetVer[0] == 'V') targetVer++;

    LOGI("[OTA][CMD] Solicitação OTA recebida: cmd=%s version=%s file_size=%lu sha256=%.12s sig_len=%u",
         cmdLocal, targetVer, static_cast<unsigned long>(fileSize),
         sha256, static_cast<unsigned>(strlen(sigB64)));

    // (b) Presença obrigatória de assinatura e algoritmo (fail-closed)
    if (sigB64[0] == '\0' || sigAlg[0] == '\0') {
      LOGE("[OTA][SECURITY] Comando OTA recusado: assinatura ou algoritmo ausentes.");
      enqueueAck(cmdLocal, "failed", "ota", 0, "ota_signature_missing", "missing_ota_signature");
      return;
    }
    if (strlen(sigB64) >= sizeof(g_otaJob.signatureB64) ||
        strlen(sigAlg) >= sizeof(g_otaJob.sigAlg)) {
      LOGE("[OTA][SECURITY] Comando OTA recusado: assinatura ou algoritmo excedem limite.");
      enqueueAck(cmdLocal, "failed", "ota", 0, "ota_signature_invalid", "sig_field_too_long");
      return;
    }

    // (c) SemVer estrito X.Y.Z e proteção anti-downgrade
    uint16_t targetSemver[3] = {0, 0, 0};
    uint16_t currentSemver[3] = {0, 0, 0};
    if (targetVer[0] == '\0' || strlen(targetVer) >= sizeof(g_otaJob.targetVersion) ||
        !otaParseSemverStrict(targetVer, targetSemver) ||
        !otaParseSemverStrict(FW_VERSION, currentSemver)) {
      LOGE("[OTA][CMD] Versão OTA inválida ou malformada (target=%s fw=%s).", targetVer, FW_VERSION);
      enqueueAck(cmdLocal, "failed", "ota", 0, "invalid_payload", "invalid_ota_version");
      return;
    }

    int verCmp = otaCompareSemver(targetSemver, currentSemver);
    if (verCmp == 0) {
      LOGI("[OTA][CMD] Estação já se encontra na versão v%s. Ignorando download.", FW_VERSION);
      enqueueAck(cmdLocal, "done", "ota", 0, "ota_same_version", nullptr);
      return;
    }
    if (verCmp < 0) {
      LOGE("[OTA][SECURITY] Downgrade bloqueado: alvo v%s < instalada v%s.", targetVer, FW_VERSION);
      enqueueAck(cmdLocal, "failed", "ota", 0, "ota_downgrade_blocked", "downgrade_not_allowed");
      return;
    }

    // (d) Lista de bloqueio local (versão que causou crash/rollback anterior)
    if (isOtaVersionBlockedNVS(targetVer)) {
      LOGE("[OTA][SECURITY] Versão v%s bloqueada no NVS após falha anterior.", targetVer);
      enqueueAck(cmdLocal, "failed", "ota", 0, "ota_version_blocked", "version_blocked_after_failure");
      return;
    }

    if (!isValidSha256Hex(sha256) || fileSize == 0) {
      LOGE("[OTA][CMD] Parâmetros OTA inválidos (sha256 ou file_size inválidos).");
      enqueueAck(cmdLocal, "failed", "ota", 0, "invalid_payload", "missing_ota_fields");
      return;
    }

    // (e) Verificação criptográfica ECDSA P-256 + SHA-256 do manifesto v1
    const char* sigFailReason = nullptr;
    if (!otaVerifyManifestSignature(targetVer, sha256, fileSize, sigB64, sigAlg, &sigFailReason)) {
      const char* reasonOut = sigFailReason ? sigFailReason : "ota_signature_invalid";
      enqueueAck(cmdLocal, "failed", "ota", 0, reasonOut, "manifest_signature_rejected");
      return;
    }

    if (otaUrl[0] == '\0') {
      LOGE("[OTA][CMD] ota_url ausente no comando OTA.");
      enqueueAck(cmdLocal, "failed", "ota", 0, "invalid_payload", "missing_ota_fields");
      return;
    }

    if (strlen(otaUrl) >= sizeof(g_otaJob.otaUrl)) {
      LOGE("[OTA][CMD] ota_url excede o buffer máximo (%u >= %u bytes)!",
           static_cast<unsigned>(strlen(otaUrl)), static_cast<unsigned>(sizeof(g_otaJob.otaUrl)));
      enqueueAck(cmdLocal, "failed", "ota", 0, "invalid_payload", "ota_url_too_long");
      return;
    }

    if (!isTrustedOtaUrl(otaUrl)) {
      LOGE("[OTA][SECURITY] URL OTA bloqueada por não pertencer ao bucket S3 oficial autorizado!");
      enqueueAck(cmdLocal, "failed", "ota", 0, "invalid_payload", "ota_url_untrusted_host");
      return;
    }

    // (f) Interlock físico de válvula + agendamento do job assinado
    bool valveCurrentlyOn = false;
    uint32_t dummyOff = 0;
    valveReadStateAtomic(valveCurrentlyOn, dummyOff);
    if (valveCurrentlyOn) {
      LOGW("[OTA][INTERLOCK] Comando OTA recusado: válvula aberta irrigando no momento!");
      enqueueAck(cmdLocal, "failed", "ota", 0, "ota_valve_busy", "valve_currently_open");
      return;
    }

    if (!scheduleOtaJob(cmdLocal, targetVer, sha256, otaUrl, fileSize, sigB64, sigAlg)) {
      LOGW("[OTA][CMD] Já existe uma atualização OTA agendada ou em execução.");
      enqueueAck(cmdLocal, "failed", "ota", 0, "ota_busy", "ota_already_in_progress");
    }
    return;
  }

  // =================================================================================
  // TRATAMENTO DA AÇÃO "config" (CALIBRAÇÃO REMOTA DE SENSORES E INTERVALO)
  // =================================================================================
  if (strcmp(actionLocal, "config") == 0) {
    RuntimeConfig prevCfg = cfgGet();
    RuntimeConfig c = prevCfg;

    bool hasInterval = doc.containsKey("telemetry_interval_ms") && !doc["telemetry_interval_ms"].isNull();
    bool hasDry = doc.containsKey("soil_raw_dry") && !doc["soil_raw_dry"].isNull();
    bool hasWet = doc.containsKey("soil_raw_wet") && !doc["soil_raw_wet"].isNull();

    // v5.27.0: display e botões da estação (não se misturam com intervalo/calibração).
    if (localConfigPresent(doc)) {
      if (hasInterval || hasDry || hasWet) {
        enqueueAck(cmdLocal, "failed", "config", 0, "invalid_payload", "mixed_config_not_supported");
        return;
      }
      const char* localReason = nullptr;
      const char* localError = nullptr;
      bool localOk = localControlsApplyConfig(doc, &localReason, &localError);
      enqueueAck(cmdLocal, localOk ? "done" : "failed", "config", 0, localReason, localError);
      if (localOk) requestImmediateTelemetry("local_config_updated");
      return;
    }

    if (!hasInterval && !hasDry && !hasWet) {
      enqueueAck(cmdLocal, "failed", "config", 0, "invalid_payload", "empty_config_command");
      return;
    }

    if (hasDry != hasWet) {
      enqueueAck(cmdLocal, "failed", "config", 0, "invalid_calibration", "both_dry_and_wet_required");
      return;
    }

    if (hasInterval) {
      int64_t newIntRaw = doc["telemetry_interval_ms"] | -1;
      if (newIntRaw <= 0 || !isValidTelemetryIntervalMs(static_cast<uint32_t>(newIntRaw))) {
        LOGW("[CONFIG] telemetry_interval_ms inválido: %lld", static_cast<long long>(newIntRaw));
        enqueueAck(cmdLocal, "failed", "config", 0, "invalid_config", "telemetry_interval_out_of_range");
        return;
      }
      c.telemetry_interval_ms = static_cast<uint32_t>(newIntRaw);
    }

    if (hasDry && hasWet) {
      c.soil_raw_dry = doc["soil_raw_dry"];
      c.soil_raw_wet = doc["soil_raw_wet"];
    }

    if (isValidSoilCalibrationCommand(c.soil_raw_dry, c.soil_raw_wet)) {
      bool nvsOk = persistRuntimeConfigToNVS(c);
      bool memOk = nvsOk ? cfgSet(c) : false;
      if (memOk && nvsOk) {
        enqueueAck(cmdLocal, "done", "config", 0, "config_updated", nullptr);
        requestImmediateTelemetry("config_updated");
      } else {
        cfgSet(prevCfg);
        enqueueAck(cmdLocal, "failed", "config", 0, "nvs_write_error", "failed_to_persist_config");
      }
    } else {
      LOGW("[CONFIG] Calibração rejeitada: dry(%d) - wet(%d) < %d",
           c.soil_raw_dry, c.soil_raw_wet, SOIL_CALIB_MIN_DELTA);
      enqueueAck(cmdLocal, "failed", "config", 0, "invalid_calibration", "dry_minus_wet_must_be_at_least_100");
    }
    return;
  }

  // =================================================================================
  // TRATAMENTO DAS AÇÕES "on" E "off" (VIA EXPRESSA DE VÁLVULA SOLENOIDE)
  // =================================================================================
  // v5.27.0: mesma seção crítica do botão físico (libera sozinha em qualquer return).
  ValveCommandSection valveSection;
  bool wasOn = false;
  uint32_t dummyOff = 0;
  valveReadStateAtomic(wasOn, dummyOff);

  if (strcmp(actionLocal, "on") == 0) {
    if (duration > 0) {
      if (g_otaInProgress || g_otaJob.pending) {
        LOGW("[INTERLOCK] Comando ON recusado localmente: atualização OTA em andamento!");
        enqueueAck(cmdLocal, "failed", "on", duration, "ota_in_progress", "ota_busy");
        return;
      }

      // v5.25.0 (Fase 3B): fonte instável -> não energiza o relé
      if (powerSafeModeActive()) {
        LOGW("[INTERLOCK] Comando ON recusado localmente: modo seguro de energia ativo (brownouts=%u)!",
             static_cast<unsigned>(g_brownoutStreak));
        enqueueAck(cmdLocal, "failed", "on", duration, "power_unstable", "brownout_safe_mode");
        return;
      }

      // v5.25.0 (Fase 3B): guarda acabou de fechar a válvula e o ACK ainda não saiu
      if (g_valveGuardTripReason.load() != 0) {
        LOGW("[INTERLOCK] Comando ON recusado localmente: guarda independente com ACK pendente!");
        enqueueAck(cmdLocal, "failed", "on", duration, "valve_guard_pending", "valve_busy");
        return;
      }

      if (wasOn) {
        LOGW("[INTERLOCK] Comando ON (%s) recusado localmente: válvula já aberta por (%s)!",
             cmdLocal, g_activeCommandId[0] ? g_activeCommandId : "active_cmd");
        enqueueAck(cmdLocal, "failed", "on", duration, "valve_already_open", "valve_busy");
        return;
      }

      int liveRainRaw = 4095;
      int liveRainPct = 0;
      bool rainingNow = sampleRainSensorNow(liveRainRaw, liveRainPct);
      if (lockSem(dataMutex, 10)) {
        g_latestData.rain_raw = liveRainRaw;
        g_latestData.rain_pct = liveRainPct;
        g_latestData.rain_detected = rainingNow;
        unlockSem(dataMutex);
      }

      if (rainingNow) {
        g_rainInterlocks++;
        LOGW("[INTERLOCK] Comando ON recusado localmente: sensor de chuva ativo (%d%%)!", liveRainPct);
        enqueueAck(cmdLocal, "failed", "on", duration, "rain_interlock", "raining_now");
        return;
      }

      if (!g_timeSynced || !isValidEpoch(nowEp) || expiresAt <= 0 || expiresAt < nowEp || expiresAt > int64_t(nowEp) + 600) {
        enqueueAck(cmdLocal, "failed", "on", duration, "clock_or_ttl_invalid", "valid_clock_and_ttl_required");
        return;
      }
      if (!ackReserveOn(cmdLocal, clampValveDurationS(duration), static_cast<uint64_t>(expiresAt))) {
        // v5.26.0: separa "memória com defeito" de "vagas ocupadas aguardando recibo".
        const char* why = ackOutboxDegraded() ? "ack_storage_unavailable" : "ack_outbox_busy";
        enqueueAck(cmdLocal, "failed", "on", duration, why, "durable_reservation_failed");
        return;
      }
      if (sampleRainSensorNow(liveRainRaw, liveRainPct)) {
        if (lockSem(dataMutex, 10)) {
          g_latestData.rain_raw = liveRainRaw;
          g_latestData.rain_pct = liveRainPct;
          g_latestData.rain_detected = true;
          unlockSem(dataMutex);
        }
        g_rainInterlocks++;
        enqueueAck(cmdLocal, "failed", "on", duration, "rain_interlock", "raining_before_activation");
        return;
      }
      valveApplyCommand(true, duration, cmdLocal);
      uint32_t gpioUs = static_cast<uint32_t>(micros()) - cbStartUs;

      bool nowOn = false;
      valveReadStateAtomic(nowOn, dummyOff);

      if (nowOn) {
        ackFloodConsume(msNow());  // v5.26.0: só LIGAR que abriu a válvula gasta ficha
        enqueueAck(cmdLocal, "started", "on", duration, nullptr, nullptr);
        LOGI("[LATENCY] ON aplicado ao GPIO%d em %lu us (%lu ms) | cmd=%s",
             static_cast<int>(PIN_VALVE),
             static_cast<unsigned long>(gpioUs),
             static_cast<unsigned long>(gpioUs / 1000UL),
             cmdLocal);
      } else {
        enqueueAck(cmdLocal, "failed", "on", duration, "valve_not_on", "valve_failed_to_start");
      }
    } else {
      if (issuedAt > g_lastOffIssuedAt) {
        g_lastOffIssuedAt = issuedAt;
      }
      char interruptedId[48] = {0};
      if (lockSem(valveMutex, 50)) {
        if (g_activeCommandId[0] != '\0') {
          safeCopy(interruptedId, sizeof(interruptedId), g_activeCommandId);
        }
        g_activeCommandId[0] = '\0';
        unlockSem(valveMutex);
      }
      valveApplyCommand(false, 0);
      if (interruptedId[0] != '\0' && strcmp(interruptedId, cmdLocal) != 0) {
        enqueueAck(interruptedId, "done", "off", 0, "manual_stop", nullptr);
      }
      enqueueAck(cmdLocal, "done", "off", 0, "manual_stop", nullptr,
                 interruptedId[0] ? interruptedId : nullptr);
      if (interruptedId[0] != '\0' && strcmp(interruptedId, cmdLocal) != 0) ackDeferFirstSend(interruptedId, ACK_SIBLING_DEFER_MS);
    }
  } else if (strcmp(actionLocal, "off") == 0) {
    if (issuedAt > g_lastOffIssuedAt) {
      g_lastOffIssuedAt = issuedAt;
    }

    char interruptedId[48] = {0};
    if (lockSem(valveMutex, 50)) {
      if (g_activeCommandId[0] != '\0') {
        safeCopy(interruptedId, sizeof(interruptedId), g_activeCommandId);
      }
      g_activeCommandId[0] = '\0';
      unlockSem(valveMutex);
    }
    valveApplyCommand(false, 0);
    uint32_t gpioUs = static_cast<uint32_t>(micros()) - cbStartUs;

    const char* stopReason = wasOn ? "manual_off" : "already_off";
    bool hadActiveExecution = (interruptedId[0] != '\0' && strcmp(interruptedId, cmdLocal) != 0);

    if (!hadActiveExecution) {
      const char* cancelRaw = doc["cancel_command_id"] | "";
      if (cancelRaw[0] != '\0' && strlen(cancelRaw) < sizeof(interruptedId) &&
          !strchr(cancelRaw, '/') && !strchr(cancelRaw, '\\') &&
          strcmp(cancelRaw, cmdLocal) != 0) {
        uint64_t tombstoneExp = expiresAt > 0
          ? static_cast<uint64_t>(expiresAt)
          : (isValidEpoch(nowEp) ? static_cast<uint64_t>(nowEp) + 180ULL : 0ULL);
        if (ackTombstoneCancelledOn(cancelRaw, cmdLocal, tombstoneExp)) {
          safeCopy(interruptedId, sizeof(interruptedId), cancelRaw);
        }
      }
    }

    if (hadActiveExecution) {
      enqueueAck(interruptedId, "done", "off", 0, stopReason, nullptr);
    }
    enqueueAck(cmdLocal, "done", "off", 0, stopReason, nullptr,
               interruptedId[0] ? interruptedId : nullptr);
    // v5.26.0 (Fase 4.0-E): o DESLIGAR comandado chega sozinho ao Firestore; o ACK do
    // LIGAR interrompido sai ACK_SIBLING_DEFER_MS depois (menos disputa de trava).
    if (hadActiveExecution) ackDeferFirstSend(interruptedId, ACK_SIBLING_DEFER_MS);

    LOGI("[LATENCY] OFF aplicado ao GPIO%d em %lu us (%lu ms) | cmd=%s intCmd=%s",
         static_cast<int>(PIN_VALVE),
         static_cast<unsigned long>(gpioUs),
         static_cast<unsigned long>(gpioUs / 1000UL),
         cmdLocal,
         interruptedId[0] ? interruptedId : "-");
  } else {
    enqueueAck(cmdLocal, "failed", actionLocal, duration, "unknown_action", "unsupported_action");
  }
}
