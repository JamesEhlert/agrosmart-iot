/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/hal/nvs_store.cpp
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Fase 3 / Parte B — v5.24.0)
 * REVISÃO: 2026-11-22 UTC
 * PROPÓSITO: Implementação do armazenamento não-volátil (NVS) e Crash Recovery.
 * CHANGELOG 2026-11-22 (v5.24.0):
 * - Implementa `isOtaVersionBlockedNVS`, `persistOtaBlockedVersionNVS` (`ota_badver`)
 *   e `persistOtaRollbackReasonNVS` (`ota_rbwhy`).
 * - No caminho panic/WDT pós-OTA, aciona rollback com motivo "crash_after_ota" e
 *   evita novo rollback quando o bootloader já reverteu para a versão anterior.
 * CHANGELOG 2026-11-21 (v5.23.1):
 * - Adiciona validação read-back pós-gravação e restauração defensiva em caso de
 *   escrita parcial dentro de `persistRuntimeConfigToNVS`.
 * ===================================================================================
 */
#include "hal/nvs_store.h"
#include "core/ack_outbox.h"
#include "core/config_validator.h"
#include "core/valve_controller.h"
#include "hal/rtc_time_service.h"
#include "services/diagnostics_service.h"
#include "services/logger.h"
#include "tasks/rtos_sync.h"
#include <Preferences.h>
#include <esp_system.h>

void triggerEmergencyOtaRollbackAndReboot(const char* failReasonLog);

RuntimeConfig         g_cfg;
std::atomic<uint32_t> g_telemetrySeq{0};

uint32_t g_seqDirty = 0;
uint32_t g_offDirty = 0;

uint32_t g_pendingOffset   = 0;
uint32_t g_pendingSegRead  = 0;
uint32_t g_pendingSegWrite = 0;

RuntimeConfig cfgGet() {
  RuntimeConfig c;
  if (lockSem(cfgMutex, 50)) {
    c = g_cfg;
    unlockSem(cfgMutex);
  } else {
    c = g_cfg;
  }
  return c;
}

bool cfgSet(const RuntimeConfig& c) {
  if (lockSem(cfgMutex, 100)) {
    g_cfg = c;
    unlockSem(cfgMutex);
    return true;
  }
  return false;
}

bool persistRuntimeConfigToNVS(const RuntimeConfig& c) {
  Preferences p;
  if (!p.begin(NVS_NS, false)) {
    LOGE("[NVS] Falha ao abrir namespace '%s' para persistir config.", NVS_NS);
    return false;
  }

  bool hadPrevInt = p.isKey(K_TELE_INT);
  bool hadPrevDry = p.isKey(K_SOIL_DRY);
  bool hadPrevWet = p.isKey(K_SOIL_WET);
  uint32_t prevInt = hadPrevInt ? p.getUInt(K_TELE_INT, DEFAULT_TELEMETRY_INTERVAL_MS) : 0;
  int prevDry      = hadPrevDry ? p.getInt(K_SOIL_DRY, 3000) : 0;
  int prevWet      = hadPrevWet ? p.getInt(K_SOIL_WET, 1200) : 0;

  size_t w1 = p.putUInt(K_TELE_INT, c.telemetry_interval_ms);
  size_t w2 = p.putInt(K_SOIL_DRY, c.soil_raw_dry);
  size_t w3 = p.putInt(K_SOIL_WET, c.soil_raw_wet);

  // Validação read-back pós-gravação (garante integridade real na Flash NVS)
  uint32_t rbInt = p.getUInt(K_TELE_INT, 0);
  int rbDry      = p.getInt(K_SOIL_DRY, -1);
  int rbWet      = p.getInt(K_SOIL_WET, -1);

  bool ok = (w1 > 0 && w2 > 0 && w3 > 0 &&
             rbInt == c.telemetry_interval_ms &&
             rbDry == c.soil_raw_dry &&
             rbWet == c.soil_raw_wet);

  if (!ok) {
    LOGE("[NVS][READBACK_FAIL] Falha ao confirmar config na Flash (escrito=%lu/%d/%d lido=%lu/%d/%d). Tentando restaurar anterior...",
         static_cast<unsigned long>(c.telemetry_interval_ms), c.soil_raw_dry, c.soil_raw_wet,
         static_cast<unsigned long>(rbInt), rbDry, rbWet);
    if (hadPrevInt) p.putUInt(K_TELE_INT, prevInt);
    if (hadPrevDry) p.putInt(K_SOIL_DRY, prevDry);
    if (hadPrevWet) p.putInt(K_SOIL_WET, prevWet);
  }

  p.end();
  LOGI("[NVS] Configuração persistida e verificada (ok=%d): tele_int=%lu dry=%d wet=%d",
       static_cast<int>(ok),
       static_cast<unsigned long>(c.telemetry_interval_ms), c.soil_raw_dry, c.soil_raw_wet);
  return ok;
}

void persistActiveCommandNVS(const char* cmdId) {
  bool wantSave = (cmdId != nullptr && cmdId[0] != '\0');
  if (!wantSave && !g_hasActiveCmdInNvs) {
    return;
  }

  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  if (wantSave) {
    p.putString(K_ACTIVE_CMD, cmdId);
    g_hasActiveCmdInNvs = true;
    LOGD("[NVS][VALVE] Active command salvo no NVS: %s", cmdId);
  } else {
    if (p.isKey(K_ACTIVE_CMD)) {
      p.remove(K_ACTIVE_CMD);
    }
    g_hasActiveCmdInNvs = false;
    LOGD("[NVS][VALVE] Active command removido do NVS.");
  }
  p.end();
}

void persistOtaInProgressNVS(const char* cmdId) {
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  if (cmdId && cmdId[0] != '\0') {
    p.putString(K_OTA_INPROG, cmdId);
    LOGD("[NVS][OTA] Flag ota_inprog gravada para proteção contra queda de luz (cmd=%s).", cmdId);
  } else if (p.isKey(K_OTA_INPROG)) {
    p.remove(K_OTA_INPROG);
    LOGD("[NVS][OTA] Flag ota_inprog removida do NVS.");
  }
  p.end();
}

void persistPendingOtaVerificationNVS(const char* cmdId, const char* targetVersion) {
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  if (p.isKey(K_OTA_RBWHY)) p.remove(K_OTA_RBWHY);
  if (cmdId && cmdId[0] != '\0' && targetVersion && targetVersion[0] != '\0') {
    p.putString(K_OTA_CMD, cmdId);
    p.putString(K_OTA_TARGET, targetVersion);
    p.putUChar(K_OTA_SELFTEST, 1);
    LOGI("[NVS][OTA] Rastreio pós-boot e Self-Test ativados: cmd=%s target_ver=%s", cmdId, targetVersion);
  } else {
    if (p.isKey(K_OTA_CMD)) p.remove(K_OTA_CMD);
    if (p.isKey(K_OTA_TARGET)) p.remove(K_OTA_TARGET);
    if (p.isKey(K_OTA_SELFTEST)) p.remove(K_OTA_SELFTEST);
    LOGD("[NVS][OTA] Rastreio pós-boot e Self-Test limpos do NVS.");
  }
  p.end();
}

bool isOtaVersionBlockedNVS(const char* version) {
  if (!version || version[0] == '\0') return false;
  const char* clean = (version[0] == 'v' || version[0] == 'V') ? (version + 1) : version;
  Preferences p;
  if (!p.begin(NVS_NS, true)) return false;
  String blocked = p.isKey(K_OTA_BADVER) ? p.getString(K_OTA_BADVER, "") : "";
  p.end();
  return (blocked.length() > 0 && blocked.equalsIgnoreCase(clean));
}

void persistOtaBlockedVersionNVS(const char* version) {
  if (!version || version[0] == '\0') return;
  const char* clean = (version[0] == 'v' || version[0] == 'V') ? (version + 1) : version;
  if (clean[0] == '\0') return;
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  p.putString(K_OTA_BADVER, clean);
  p.end();
  LOGW("[NVS][OTA] Versão v%s gravada na lista de bloqueio local (%s).", clean, K_OTA_BADVER);
}

void persistOtaRollbackReasonNVS(const char* reason) {
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  if (reason && reason[0] != '\0') {
    p.putString(K_OTA_RBWHY, reason);
    LOGW("[NVS][OTA] Motivo de rollback gravado (%s=%s).", K_OTA_RBWHY, reason);
  } else if (p.isKey(K_OTA_RBWHY)) {
    p.remove(K_OTA_RBWHY);
  }
  p.end();
}

void persistSeqIfNeeded(bool force) {
  if (!force && g_seqDirty < SEQ_PERSIST_EVERY) return;
  uint32_t seqVal = g_telemetrySeq.load();
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  p.putUInt(K_SEQ, seqVal);
  p.end();
  g_seqDirty = 0;
  LOGD("[NVS] tele_seq=%lu persistido na Flash (force=%d).",
       static_cast<unsigned long>(seqVal), static_cast<int>(force));
}

void persistOffsetIfNeeded(bool force) {
  static bool saved = false;
  static uint32_t lastOff = 0, lastRead = 0, lastWrite = 0;
  if (!force && g_offDirty < OFF_PERSIST_EVERY) return;
  if (saved && lastOff == g_pendingOffset && lastRead == g_pendingSegRead && lastWrite == g_pendingSegWrite) {
    g_offDirty = 0; return;
  }
  Preferences p;
  if (!p.begin(NVS_NS, false)) { LOGE("[NVS][WAL] open failed"); return; }
  bool ok = p.putUInt(K_PEND_OFF, g_pendingOffset) == sizeof(uint32_t) &&
    p.putUInt(K_PEND_SEG_R, g_pendingSegRead) == sizeof(uint32_t) &&
    p.putUInt(K_PEND_SEG_W, g_pendingSegWrite) == sizeof(uint32_t);
  p.end();
  if (!ok) { LOGE("[NVS][WAL] pointer write failed; dirty state retained"); return; }
  saved = true; lastOff = g_pendingOffset; lastRead = g_pendingSegRead; lastWrite = g_pendingSegWrite;
  g_offDirty = 0;
  LOGD("[NVS] Ponteiros WAL persistidos: segR=%lu segW=%lu off=%lu",
       static_cast<unsigned long>(g_pendingSegRead), static_cast<unsigned long>(g_pendingSegWrite), static_cast<unsigned long>(g_pendingOffset));
}

void loadFromNVSAndCheckCrashRecovery() {
  Preferences p;
  if (!p.begin(NVS_NS, false)) {
    LOGW("[NVS] Falha ao abrir NVS. Usando defaults.");
    return;
  }

  RuntimeConfig c;
  if (!NVS_FORCE_CONFIG_DEFAULTS) {
    c.telemetry_interval_ms = p.getUInt(K_TELE_INT, c.telemetry_interval_ms);
    c.soil_raw_dry = p.getInt(K_SOIL_DRY, c.soil_raw_dry);
    c.soil_raw_wet = p.getInt(K_SOIL_WET, c.soil_raw_wet);
  } else {
    LOGW("[NVS] FORÇANDO DEFAULTS (ignora tele_int/soil_* do NVS)");
  }

  if (!isValidSoilCalibrationAtBoot(c.soil_raw_dry, c.soil_raw_wet)) {
    LOGW("[NVS] Calibração de solo inválida (dry=%d wet=%d). Revertendo defaults.", c.soil_raw_dry, c.soil_raw_wet);
    c.soil_raw_dry = 3000;
    c.soil_raw_wet = 1200;
  }
  if (!isValidTelemetryIntervalMs(c.telemetry_interval_ms)) {
    c.telemetry_interval_ms = DEFAULT_TELEMETRY_INTERVAL_MS;
  }

  uint32_t loadedSeq = p.getUInt(K_SEQ, 0);
  esp_reset_reason_t resetCode = esp_reset_reason();

  if (loadedSeq > 0 && resetCode != ESP_RST_SW) {
    loadedSeq += SEQ_PERSIST_EVERY;
    p.putUInt(K_SEQ, loadedSeq);
    LOGI("[NVS][SEQ-GUARD] Salto preventivo pós-reset (%s): tele_seq avançado em +%lu -> %lu",
         g_resetReason,
         static_cast<unsigned long>(SEQ_PERSIST_EVERY),
         static_cast<unsigned long>(loadedSeq));
  }
  g_telemetrySeq.store(loadedSeq);

  g_pendingOffset   = p.getUInt(K_PEND_OFF, 0);
  g_pendingSegRead  = p.getUInt(K_PEND_SEG_R, 0);
  g_pendingSegWrite = p.getUInt(K_PEND_SEG_W, 0);
  g_bootCount       = p.getUInt(K_BOOT_CNT, 0);

  uint32_t savedLastTs = p.getUInt(K_LAST_TS, 0);
  if (savedLastTs >= EPOCH_MAX_SANE) {
    LOGW("[NVS][TS-GUARD] last_ts corrompido no futuro (%lu) descartado.",
         static_cast<unsigned long>(savedLastTs));
    p.remove(K_LAST_TS);
    savedLastTs = 0;
  }
  g_lastTelemetryTs = savedLastTs;

  // 1. Crash Recovery de Válvula
  String interruptedCmd = p.isKey(K_ACTIVE_CMD) ? p.getString(K_ACTIVE_CMD, "") : "";
  if (interruptedCmd.length() > 0) {
    LOGW("[RECOVERY][VALVE] Marcador de irrigação encontrado após reboot; resultado anterior não confirmado! cmd=%s", interruptedCmd.c_str());
    agroack::Record known{};
    if (!ackGet(interruptedCmd.c_str(), known)) {
      enqueueAck(interruptedCmd.c_str(), "failed", "off", 0, "execution_unknown_after_reset", "legacy_recovery_no_terminal");
    }
    if (ackGet(interruptedCmd.c_str(), known) && known.kind != agroack::Active) {
      p.remove(K_ACTIVE_CMD); g_hasActiveCmdInNvs = false;
    }
  }

  // 2. Crash Recovery de Download OTA
  String interruptedOtaCmd = p.isKey(K_OTA_INPROG) ? p.getString(K_OTA_INPROG, "") : "";
  if (interruptedOtaCmd.length() > 0) {
    LOGW("[RECOVERY][OTA] Queda de energia detectada durante download OTA! Partição '%s' (v%s) preservada intacta. cmd=%s",
         g_runningPartition, FW_VERSION, interruptedOtaCmd.c_str());
    p.remove(K_OTA_INPROG);
    enqueueAck(interruptedOtaCmd.c_str(), "failed", "ota", 0, "ota_power_loss", "interrupted_by_power_loss");
  }

  // 3. Verificação de Self-Test pós-OTA
  uint8_t selfTestFlag = p.isKey(K_OTA_SELFTEST) ? p.getUChar(K_OTA_SELFTEST, 0) : 0;
  if (selfTestFlag == 1) {
    String pendingTarget = p.isKey(K_OTA_TARGET) ? p.getString(K_OTA_TARGET, "") : "";
    if (pendingTarget.length() > 0 && !pendingTarget.equalsIgnoreCase(FW_VERSION)) {
      // O bootloader já reverteu para a partição anterior antes da aprovação (observação de 90s);
      // limpa apenas ota_selftest e preserva ota_cmd/ota_target para o ACK pós-MQTT.
      p.remove(K_OTA_SELFTEST);
      LOGW("[OTA][SELF-TEST] Bootloader já reverteu de v%s para v%s; ACK de rollback será enviado ao conectar.",
           pendingTarget.c_str(), FW_VERSION);
    } else if (resetCode == ESP_RST_PANIC || resetCode == ESP_RST_TASK_WDT ||
               resetCode == ESP_RST_INT_WDT || resetCode == ESP_RST_WDT) {
      p.end();
      triggerEmergencyOtaRollbackAndReboot("crash_after_ota");
      return;
    } else {
      g_appSelfTestPending = true;
      LOGI("[OTA][SELF-TEST] Aguardando verificação de estabilidade local e conexão mTLS AWS IoT...");
    }
  }

  p.end();
  cfgSet(c);
  printConfig();
}
