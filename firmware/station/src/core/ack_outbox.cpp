/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/core/ack_outbox.cpp
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-24 UTC (v5.26.0, Fase 4.0-E)
 * PROPÓSITO: Implementação do Outbox Durável no NVS, recuperação pós-reset de
 *            reservas ativas, tombstone de cancelamento explícito por OFF (com
 *            promoção para Terminal se o ON atrasado chegar), recibos MQTT
 *            (ack_receipt) e cache de idempotência.
 * v5.26.0 (Fase 4.0-E): vagas entregues reaproveitáveis (livro de idempotência
 *            `agroded1`), 2 vagas reservadas ao DESLIGAR, quarentena de registro
 *            corrompido, falha de escrita não permanente, fila de melhor esforço,
 *            DESLIGAR publicado primeiro, abandono de ACK sem recibo e balde
 *            anti-rajada de LIGAR.
 * ===================================================================================
 */
#include "core/ack_outbox.h"
#include "core/time_math.h"
#include "core/valve_controller.h"
#include "hal/nvs_store.h"
#include "hal/rtc_time_service.h"
#include "services/diagnostics_service.h"
#include "services/logger.h"
#include "tasks/rtos_sync.h"
#include <Preferences.h>
#include <WiFi.h>
#include <esp_system.h>
#include <nvs.h>

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "secrets.h não encontrado. Garanta que está em firmware/include/secrets.h"
#endif

extern volatile bool g_wifiConnected;

agroack::Store  g_durableAcks;
agroack::Ledger g_ackLedger;
uint32_t        g_ackRetryAt[agroack::CAPACITY] = {};
static uint16_t s_ackSendCount[agroack::CAPACITY] = {};
static unsigned s_ackSendCursor = 0;

std::atomic<uint32_t> g_ackBestEffort{0};
std::atomic<uint32_t> g_ackAbandoned{0};
std::atomic<uint32_t> g_floodRejects{0};
std::atomic<int32_t>  g_nvsFreeEntries{-1};

// Fila de melhor esforço (RAM): ACK terminal que não achou vaga durável.
struct BestEffortAck {
  agroack::Record r;
  uint32_t nextAtMs;
  uint8_t attempts;
  bool used;
};
static BestEffortAck s_bestEffort[ACK_BESTEFFORT_SLOTS] = {};

static agroflood::Guard s_floodGuard(agroflood::Config{FLOOD_ON_BURST, FLOOD_ON_REFILL_MS, VALVE_MIN_OFF_TO_ON_MS});

RecentCmdEntry g_recentCmds[RECENT_CMD_CACHE_SIZE] = {};
size_t         g_recentCmdIdx = 0;
char           g_incomingCommandId[48] = {0};
uint64_t       g_incomingExpiresAt = 0;

bool findRecentCommandSafe(const char* cmdId, RecentCmdEntry& outEntry) {
  if (!cmdId || cmdId[0] == '\0') return false;
  bool found = false;
  if (lockSem(ackMutex, 25)) {
    for (size_t i = 0; i < RECENT_CMD_CACHE_SIZE; i++) {
      if (g_recentCmds[i].id[0] != '\0' && strcmp(g_recentCmds[i].id, cmdId) == 0) {
        outEntry = g_recentCmds[i];
        found = true;
        break;
      }
    }
    unlockSem(ackMutex);
  }
  return found;
}

void recordOrUpdateCommandOutcome(const char* cmdId, const char* action,
                                  int32_t durationS, const char* status,
                                  const char* reason) {
  if (!cmdId || cmdId[0] == '\0') return;
  if (!lockSem(ackMutex, 25)) return;

  for (size_t i = 0; i < RECENT_CMD_CACHE_SIZE; i++) {
    if (g_recentCmds[i].id[0] != '\0' && strcmp(g_recentCmds[i].id, cmdId) == 0) {
      bool existingIsTerminal =
        (strcmp(g_recentCmds[i].status, "done") == 0 ||
         strcmp(g_recentCmds[i].status, "failed") == 0);
      bool incomingIsIntermediate =
        (status != nullptr && strcmp(status, "received") == 0);

      if (!existingIsTerminal || !incomingIsIntermediate) {
        if (action && action[0]) safeCopy(g_recentCmds[i].action, sizeof(g_recentCmds[i].action), action);
        if (status && status[0]) safeCopy(g_recentCmds[i].status, sizeof(g_recentCmds[i].status), status);
        if (reason) safeCopy(g_recentCmds[i].reason, sizeof(g_recentCmds[i].reason), reason);
        if (durationS >= 0) g_recentCmds[i].durationS = durationS;
      }
      unlockSem(ackMutex);
      return;
    }
  }

  RecentCmdEntry& slot = g_recentCmds[g_recentCmdIdx];
  safeCopy(slot.id, sizeof(slot.id), cmdId);
  safeCopy(slot.action, sizeof(slot.action), action ? action : "");
  safeCopy(slot.status, sizeof(slot.status), status ? status : "received");
  safeCopy(slot.reason, sizeof(slot.reason), reason ? reason : "");
  slot.durationS = durationS;
  g_recentCmdIdx = (g_recentCmdIdx + 1) % RECENT_CMD_CACHE_SIZE;
  unlockSem(ackMutex);
}

agroflood::Decision ackFloodCheck(uint32_t nowMs) {
  return s_floodGuard.check(nowMs, g_valveLastClosedMs.load());
}

void ackFloodConsume(uint32_t nowMs) {
  s_floodGuard.consume(nowMs);
}

static uint64_t ackNowEpoch() {
  uint32_t nowEp = g_timeSynced ? epochNow() : 0;
  return isValidEpoch(nowEp) ? static_cast<uint64_t>(nowEp) : 0ULL;
}

// DESLIGAR, guarda, chuva e supervisor usam as vagas reservadas; o resto não.
static agroack::SlotClass ackClassFor(const char* action) {
  return (action && strcmp(action, "off") == 0) ? agroack::ClassSafety : agroack::ClassNormal;
}

// Toda vaga que recebe um registro novo começa do zero na contabilidade de envio.
static void ackResetSendState(int slot) {
  if (slot < 0 || slot >= int(agroack::CAPACITY)) return;
  g_ackRetryAt[slot] = 0;
  s_ackSendCount[slot] = 0;
}

static void ackBestEffortPushLocked(const agroack::Record& r) {
  int target = -1;
  for (unsigned i = 0; i < ACK_BESTEFFORT_SLOTS; ++i) if (!s_bestEffort[i].used) { target = int(i); break; }
  if (target < 0) {
    target = 0;  // cheia: substitui a mais antiga (a que já foi tentada mais vezes)
    for (unsigned i = 1; i < ACK_BESTEFFORT_SLOTS; ++i)
      if (s_bestEffort[i].attempts > s_bestEffort[target].attempts) target = int(i);
    LOGW("[ACK][BEST_EFFORT] fila cheia: descartando cmd=%s", s_bestEffort[target].r.commandId);
  }
  s_bestEffort[target].r = r;
  s_bestEffort[target].nextAtMs = msNow();
  s_bestEffort[target].attempts = 0;
  s_bestEffort[target].used = true;
  g_ackBestEffort++;
}

int ackNvsRead(void*, unsigned slot, agroack::Record& record) {
  Preferences p;
  if (!p.begin("agroack1", false)) { LOGE("[ACK][READ_ERROR] NVS namespace unavailable slot=%u", slot); return -1; }
  char key[8]; snprintf(key, sizeof(key), "a%u", slot);
  if (!p.isKey(key)) { p.end(); return 0; }
  bool ok = p.getBytesLength(key) == sizeof(record) && p.getBytes(key, &record, sizeof(record)) == sizeof(record);
  p.end();
  if (ok && !agroack::valid(record)) ok = false;
  if (!ok) LOGE("[ACK][READ_ERROR] slot=%u format/CRC/read mismatch; no automatic erase", slot);
  return ok ? 1 : -1;
}

bool ackNvsWrite(void*, unsigned slot, const agroack::Record& record) {
  Preferences p;
  if (!p.begin("agroack1", false)) { LOGE("[ACK][WRITE_ERROR] NVS namespace unavailable slot=%u", slot); return false; }
  char key[8]; snprintf(key, sizeof(key), "a%u", slot);
  agroack::Record check{};
  bool ok = p.putBytes(key, &record, sizeof(record)) == sizeof(record) &&
    p.getBytesLength(key) == sizeof(check) && p.getBytes(key, &check, sizeof(check)) == sizeof(check) &&
    memcmp(&record, &check, sizeof(record)) == 0;
  p.end();
  if (!ok) LOGE("[ACK][WRITE_ERROR] slot=%u write/readback failed", slot);
  return ok;
}

bool ackNvsErase(void*, unsigned slot) {
  Preferences p;
  if (!p.begin("agroack1", false)) return false;
  char key[8]; snprintf(key, sizeof(key), "a%u", slot);
  bool ok = !p.isKey(key) || p.remove(key);
  p.end();
  LOGW("[ACK][QUARANTINE] slot=%u apagado=%d (registro ilegivel posto em quarentena)", slot, int(ok));
  return ok;
}

static int ackLedgerRead(void*, agroack::LedgerBlob& blob) {
  Preferences p;
  if (!p.begin("agroded1", false)) return -1;
  if (!p.isKey("l")) { p.end(); return 0; }
  bool ok = p.getBytesLength("l") == sizeof(blob) && p.getBytes("l", &blob, sizeof(blob)) == sizeof(blob);
  p.end();
  return ok ? 1 : -1;
}

static bool ackLedgerWrite(void*, const agroack::LedgerBlob& blob) {
  static agroack::LedgerBlob check;  // estático: 780 B fora da pilha da Net task
  Preferences p;
  if (!p.begin("agroded1", false)) return false;
  bool ok = p.putBytes("l", &blob, sizeof(blob)) == sizeof(blob) &&
    p.getBytesLength("l") == sizeof(check) && p.getBytes("l", &check, sizeof(check)) == sizeof(check) &&
    memcmp(&blob, &check, sizeof(blob)) == 0;
  p.end();
  if (!ok) LOGE("[ACK][LEDGER] escrita/conferencia falhou");
  return ok;
}

void ackCapture(agroack::Record& r, const char* commandId, const char* status, const char* action,
                int32_t duration, const char* reason, const char* error, const char* interrupted) {
  r = agroack::Record{};
  snprintf(r.eventId, sizeof(r.eventId), "%08lx%08lx%08lx%08lx",
    (unsigned long)esp_random(), (unsigned long)esp_random(), (unsigned long)esp_random(), (unsigned long)esp_random());
  safeCopy(r.commandId, sizeof(r.commandId), commandId);
  safeCopy(r.status, sizeof(r.status), status);
  safeCopy(r.action, sizeof(r.action), action);
  safeCopy(r.reason, sizeof(r.reason), reason);
  safeCopy(r.error, sizeof(r.error), error);
  safeCopy(r.interruptedId, sizeof(r.interruptedId), interrupted);
  safeCopy(r.fw, sizeof(r.fw), FW_VERSION);
  safeCopy(r.part, sizeof(r.part), g_runningPartition);
  safeCopy(r.bootId, sizeof(r.bootId), g_bootId);
  safeCopy(r.resetReason, sizeof(r.resetReason), g_resetReason);
  uint32_t ts = epochNow(); r.timestamp = g_timeSynced && isValidEpoch(ts) ? ts : 0;
  r.uptimeS = msNow() / 1000UL; r.bootCount = g_bootCount; r.session = g_mqttSessionSeq.load();
  r.heap = esp_get_free_heap_size(); r.rssi = g_wifiConnected ? WiFi.RSSI() : -127;
  RuntimeConfig c = cfgGet(); r.intervalMs = c.telemetry_interval_ms; r.soilDry = c.soil_raw_dry; r.soilWet = c.soil_raw_wet;
  r.duration = duration;
}

bool ackGet(const char* commandId, agroack::Record& result) {
  if (!lockSem(durableAckMutex, 100)) return false;
  int slot = g_durableAcks.find(commandId);
  if (slot >= 0) { result = g_durableAcks.records[slot]; g_ackRetryAt[slot] = 0; }
  unlockSem(durableAckMutex); return slot >= 0;
}

bool ackReserveOn(const char* commandId, uint32_t duration, uint64_t expiresAt) {
  agroack::Record r{};
  ackCapture(r, commandId, "active", "on", duration, nullptr, nullptr, nullptr);
  r.kind = agroack::Active; r.expiresAt = expiresAt;
  if (!lockSem(durableAckMutex, 100)) return false;
  int slot = g_durableAcks.find(commandId);
  bool ok = false;
  if (slot < 0) {
    slot = g_durableAcks.allocate(ackNowEpoch(), agroack::ClassNormal, &g_ackLedger);
    if (slot >= 0) { ok = g_durableAcks.put(slot, r); if (ok) ackResetSendState(slot); }
  }
  unsigned freeNow = g_durableAcks.freeSlots();
  unlockSem(durableAckMutex);
  LOGI("[ACK][RESERVE] cmd=%s durable=%d free=%u", commandId, int(ok), freeNow);
  return ok;
}

bool ackTombstoneCancelledOn(const char* cancelCommandId, const char* byOffCommandId, uint64_t expiresAt) {
  if (!cancelCommandId || cancelCommandId[0] == '\0') return false;

  uint32_t nowEp = g_timeSynced ? epochNow() : 0;
  uint64_t effectiveExpiresAt = expiresAt;
  if (effectiveExpiresAt == 0 && isValidEpoch(nowEp)) {
    effectiveExpiresAt = static_cast<uint64_t>(nowEp) + 180ULL;
  }

  // duration = -1 sinaliza que o tombstone foi criado preventivamente pelo OFF
  // antes do pacote ON atrasado chegar ao ESP32.
  agroack::Record r{};
  ackCapture(r, cancelCommandId, "failed", "on", -1, "cancelled_by_off", "superseded_by_off", byOffCommandId);
  r.kind = agroack::Delivered;
  r.expiresAt = effectiveExpiresAt;

  if (!lockSem(durableAckMutex, 100)) return false;
  int slot = g_durableAcks.find(cancelCommandId);
  bool ok = false;
  if (slot >= 0) {
    // Só confirma tombstone se o registro existente já era um tombstone (cancelled_by_off).
    // Se o comando ON já havia concluído normalmente no passado, não o sobrescreve!
    const agroack::Record& existing = g_durableAcks.records[slot];
    ok = (existing.kind != agroack::Active && strcmp(existing.reason, "cancelled_by_off") == 0);
  } else {
    slot = g_durableAcks.allocate(ackNowEpoch(), agroack::ClassNormal, &g_ackLedger);
    if (slot >= 0) {
      ok = g_durableAcks.put(slot, r);
      if (ok) ackResetSendState(slot);
    }
  }
  unlockSem(durableAckMutex);

  if (ok) {
    recordOrUpdateCommandOutcome(cancelCommandId, "on", 0, "failed", "cancelled_by_off");
    LOGI("[ACK][TOMBSTONE] cmd=%s invalidado preventivamente por off=%s exp=%llu",
         cancelCommandId,
         (byOffCommandId && byOffCommandId[0]) ? byOffCommandId : "-",
         static_cast<unsigned long long>(effectiveExpiresAt));
  } else {
    LOGW("[ACK][TOMBSTONE_SKIP] cmd=%s nao pode ser invalidado (ja executado ou storage ocupado)", cancelCommandId);
  }
  return ok;
}

bool ackPromoteTombstoneToTerminal(const char* commandId, int32_t duration) {
  if (!commandId || commandId[0] == '\0') return false;
  if (!lockSem(durableAckMutex, 100)) return false;

  int slot = g_durableAcks.find(commandId);
  bool promoted = false;
  if (slot >= 0) {
    agroack::Record r = g_durableAcks.records[slot];
    if (r.kind == agroack::Delivered && strcmp(r.reason, "cancelled_by_off") == 0 && r.duration < 0) {
      r.kind = agroack::Terminal;
      r.duration = duration >= 0 ? duration : 0;
      uint32_t ts = epochNow();
      r.timestamp = (g_timeSynced && isValidEpoch(ts)) ? ts : r.timestamp;
      r.uptimeS = msNow() / 1000UL;
      r.bootCount = g_bootCount;
      r.session = g_mqttSessionSeq.load();
      safeCopy(r.bootId, sizeof(r.bootId), g_bootId);
      promoted = g_durableAcks.put(slot, r);
      if (promoted) ackResetSendState(slot);
    }
  }
  unlockSem(durableAckMutex);

  if (promoted) {
    recordOrUpdateCommandOutcome(commandId, "on", duration >= 0 ? duration : 0, "failed", "cancelled_by_off");
    LOGI("[ACK][TOMBSTONE_PROMOTED] cmd=%s recebido atrasado e promovido a ACK Terminal (cancelled_by_off)", commandId);
  }
  return promoted;
}

bool ackSaveTerminal(const char* commandId, const char* status, const char* action,
                     int32_t duration, const char* reason, const char* error, const char* interrupted) {
  agroack::Record r{};
  ackCapture(r, commandId, status, action, duration, reason, error, interrupted);
  r.kind = agroack::Terminal;
  uint32_t nowEp = g_timeSynced ? epochNow() : 0;
  uint64_t fallbackExp = isValidEpoch(nowEp) ? (static_cast<uint64_t>(nowEp) + 180ULL) : UINT64_MAX;
  if (action && strcmp(action, "on") == 0) r.expiresAt = fallbackExp;
  if (lockSem(ackMutex, 100)) {
    if (strcmp(g_incomingCommandId, commandId) == 0 && action && strcmp(action, "on") == 0) {
      r.expiresAt = (g_incomingExpiresAt > 0) ? g_incomingExpiresAt : fallbackExp;
    }
    unlockSem(ackMutex);
  }
  // v5.26.0: espera maior (gravações NVS levam 10-30 ms); um terminal nunca deve se perder por fila de mutex.
  if (!lockSem(durableAckMutex, 500)) {
    LOGE("[ACK][LOCK_TIMEOUT] cmd=%s status=%s: outbox ocupado por >500 ms", commandId, status ? status : "-");
    return false;
  }
  int slot = g_durableAcks.find(commandId);
  bool alreadyStored = slot >= 0 && g_durableAcks.records[slot].kind != agroack::Active;
  bool otaRollback = alreadyStored && action && strcmp(action, "ota") == 0 && reason && strcmp(reason, "ota_rollback") == 0 &&
    strcmp(g_durableAcks.records[slot].reason, "ota_rollback") != 0;
  if (slot >= 0 && !alreadyStored) {
    r.expiresAt = g_durableAcks.records[slot].expiresAt;
  }
  if (slot < 0 || otaRollback) slot = g_durableAcks.allocate(ackNowEpoch(), ackClassFor(action), &g_ackLedger);
  bool ok = alreadyStored && !otaRollback;
  bool wrote = false;
  if (!ok && slot >= 0) { ok = g_durableAcks.put(slot, r); wrote = ok; }
  if (wrote || alreadyStored) ackResetSendState(slot);
  bool bestEffort = false;
  if (!ok) {
    // Sem vaga durável: nunca some em silêncio. Vai da RAM (mesmo formato, com event_id),
    // e um LIGAR recusado entra no livro para jamais ser executado depois.
    r.magic = agroack::MAGIC; r.version = 1; r.bytes = sizeof(agroack::Record);
    ackBestEffortPushLocked(r);
    if (action && strcmp(action, "on") == 0) g_ackLedger.remember(commandId, agroack::outcomeOf(r), ackNowEpoch());
    bestEffort = true;
  }
  unsigned freeNow = g_durableAcks.freeSlots();
  unlockSem(durableAckMutex);
  if (ok) {
    Preferences p;
    if (p.begin(NVS_NS, false)) {
      // v5.25.1 (Fase 3B): isKey() evita o log de erro do core quando a chave nao existe
      if (p.isKey(K_ACTIVE_CMD) && p.getString(K_ACTIVE_CMD, "") == commandId) { p.remove(K_ACTIVE_CMD); g_hasActiveCmdInNvs = false; }
      p.end();
    }
    LOGI("[ACK][DURABLE] cmd=%s status=%s reason=%s free=%u", commandId, status, reason ? reason : "-", freeNow);
  } else if (bestEffort) {
    LOGW("[ACK][BEST_EFFORT] cmd=%s status=%s reason=%s: sem vaga duravel (livres=%u, degradado=%d); envio pela RAM",
         commandId, status, reason ? reason : "-", freeNow, int(g_durableAcks.fault));
  }
  return ok;
}

void ackInitAndRecover() {
  agroack::Storage storage{nullptr, ackNvsRead, ackNvsWrite, ackNvsErase};
  bool ok = g_durableAcks.begin(storage);
  unsigned blockedCount = 0;
  for (unsigned i = 0; i < agroack::CAPACITY; ++i) if (g_durableAcks.blocked[i]) ++blockedCount;
  g_ackLedger.begin(agroack::LedgerStorage{nullptr, ackLedgerRead, ackLedgerWrite});
  LOGI("[ACK][BOOT] storage_ok=%d capacity=%u reserve=%u record_bytes=%u repaired=%lu blocked=%u ledger_ok=%d",
       int(ok), agroack::CAPACITY, agroack::SAFETY_RESERVE, unsigned(sizeof(agroack::Record)),
       static_cast<unsigned long>(g_durableAcks.repaired), blockedCount, int(!g_ackLedger.wasReset));
  if (g_ackLedger.wasReset) LOGW("[ACK][LEDGER] livro de idempotencia ausente/ilegivel no boot: recomecando vazio");
  for (unsigned i = 0; i < agroack::CAPACITY; ++i) {
    if (g_durableAcks.blocked[i]) continue;
    agroack::Record r = g_durableAcks.records[i];
    if (r.kind != agroack::Active) continue;
    r.kind = agroack::Terminal;
    safeCopy(r.status, sizeof(r.status), "failed");
    safeCopy(r.action, sizeof(r.action), "off");
    safeCopy(r.reason, sizeof(r.reason), "execution_unknown_after_reset");
    safeCopy(r.error, sizeof(r.error), "terminal_evidence_missing");
    r.timestamp = 0; r.duration = 0;
    bool persisted = g_durableAcks.put(i, r);
    LOGW("[ACK][RECOVERY] cmd=%s outcome=unknown persisted=%d", r.commandId, int(persisted));
  }
}

bool ackHandleReceipt(JsonDocument& doc) {
  const char* action = doc["action"] | "";
  if (strcmp(action, "ack_receipt") != 0) return false;
  const char* device = doc["device_id"] | "";
  const char* event = doc["event_id"] | "";
  const char* command = doc["command_id"] | "";
  const char* disposition = doc["disposition"] | "";
  if (strcmp(device, THINGNAME) != 0 || strlen(event) != 32 || !command[0] ||
      (strcmp(disposition, "committed") != 0 && strcmp(disposition, "duplicate") != 0 && strcmp(disposition, "conflict_recorded") != 0)) return true;
  bool ok = false;
  if (lockSem(durableAckMutex, 100)) {
    ok = g_durableAcks.receipt(event, command);
    if (!ok) {
      for (unsigned i = 0; i < ACK_BESTEFFORT_SLOTS; ++i) {
        BestEffortAck& b = s_bestEffort[i];
        if (b.used && strcmp(b.r.eventId, event) == 0 && strcmp(b.r.commandId, command) == 0) { b.used = false; ok = true; break; }
      }
    }
    unlockSem(durableAckMutex);
  }
  LOGI("[ACK][RECEIPT] cmd=%s event=%s persisted=%d disposition=%s", command, event, int(ok), disposition);
  return true;
}

void enqueueAck(const char* commandId, const char* status, const char* action,
                int32_t durationS, const char* reason, const char* error,
                const char* interruptedCmdId) {
  if (!commandId || commandId[0] == '\0' || !ackQueue) return;

  if (status && (strcmp(status, "done") == 0 || strcmp(status, "failed") == 0)) {
    // v5.26.0: o desfecho entra no cache de idempotência mesmo se foi pela fila de melhor
    // esforço (o ACK saiu de qualquer forma e o comando não pode ser reexecutado).
    ackSaveTerminal(commandId, status, action, durationS, reason, error, interruptedCmdId);
    recordOrUpdateCommandOutcome(commandId, action, durationS, status, reason);
    return;
  }

  recordOrUpdateCommandOutcome(commandId, action, durationS, status, reason);

  AckMessage msg{};
  safeCopy(msg.commandId, sizeof(msg.commandId), commandId);
  safeCopy(msg.status, sizeof(msg.status), status ? status : "unknown");
  safeCopy(msg.action, sizeof(msg.action), action ? action : "");
  msg.durationS = durationS;
  safeCopy(msg.reason, sizeof(msg.reason), reason ? reason : "");
  safeCopy(msg.error, sizeof(msg.error), error ? error : "");
  safeCopy(msg.interruptedCmdId, sizeof(msg.interruptedCmdId), interruptedCmdId ? interruptedCmdId : "");

  safeCopy(msg.originBoot, sizeof(msg.originBoot), g_bootId);
  msg.originSession = g_mqttSessionSeq.load();
  uint32_t originTs = epochNow(); msg.originTs = g_timeSynced && isValidEpoch(originTs) ? originTs : 0;
  msg.originUptime = msNow() / 1000UL;
  RuntimeConfig originCfg = cfgGet();
  msg.originInterval = originCfg.telemetry_interval_ms;
  msg.originSoilDry = originCfg.soil_raw_dry; msg.originSoilWet = originCfg.soil_raw_wet;
  bool sent = false;
  if (lockSem(ackMutex, 30)) {
    if (xQueueSend(ackQueue, &msg, 0) == pdPASS) {
      sent = true;
    } else {
      g_ackDrops++;
      AckMessage dropped{};
      xQueueReceive(ackQueue, &dropped, 0);
      sent = (xQueueSend(ackQueue, &msg, 0) == pdPASS);
      LOGW("[ACK][QUEUE] Fila cheia (drops=%lu), substituindo ACK antigo (%s) por cmd=%s status=%s",
           static_cast<unsigned long>(g_ackDrops.load()), dropped.commandId, msg.commandId, msg.status);
    }
    unlockSem(ackMutex);
  }

  if (sent) {
    LOGD("[ACK][QUEUE] Enfileirado cmd=%s status=%s action=%s reason=%s intCmd=%s",
         msg.commandId, msg.status,
         msg.action[0] ? msg.action : "-",
         msg.reason[0] ? msg.reason : "-",
         msg.interruptedCmdId[0] ? msg.interruptedCmdId : "-");
  }
}

// =====================================================================================
// v5.26.0 (Fase 4.0-E): serviços do outbox v2
// =====================================================================================
bool ackLedgerSeen(const char* commandId) {
  if (!commandId || !commandId[0]) return false;
  bool seen = false;
  if (lockSem(durableAckMutex, 50)) { seen = g_ackLedger.contains(commandId); unlockSem(durableAckMutex); }
  return seen;
}

void ackDeferFirstSend(const char* commandId, uint32_t delayMs) {
  if (!commandId || !commandId[0]) return;
  if (!lockSem(durableAckMutex, 50)) return;
  int slot = g_durableAcks.find(commandId);
  if (slot >= 0 && g_durableAcks.records[slot].kind == agroack::Terminal && g_ackRetryAt[slot] == 0) {
    uint32_t at = msNow() + delayMs;
    g_ackRetryAt[slot] = at ? at : 1;  // 0 significa "nunca enviado"
  }
  unlockSem(durableAckMutex);
}

bool ackNextDurableToSend(uint32_t nowMs, agroack::Record& out) {
  if (!lockSem(durableAckMutex, 20)) return false;
  int slot = g_durableAcks.nextToSend(g_ackRetryAt, nowMs, s_ackSendCursor);
  if (slot >= 0) {
    out = g_durableAcks.records[slot];
    uint32_t at = nowMs + ACK_RETRY_BASE_MS + (esp_random() % ACK_RETRY_JITTER_MS);
    g_ackRetryAt[slot] = at ? at : 1;
  }
  unlockSem(durableAckMutex);
  return slot >= 0;
}

// Terminal publicado com sucesso N vezes sem recibo: o backend está rejeitando ou fora do
// ar há horas. Marca como entregue (mantém a memória de idempotência) para a estação não
// ficar sem vagas para sempre. Fica registrado em log e na telemetria (ack_abandoned).
void ackNoteSent(const char* eventId, const char* commandId, bool mqttOk) {
  if (!mqttOk || !eventId || !commandId) return;
  if (!lockSem(durableAckMutex, 20)) return;
  for (unsigned i = 0; i < agroack::CAPACITY; ++i) {
    const agroack::Record& r = g_durableAcks.records[i];
    if (g_durableAcks.blocked[i] || r.kind != agroack::Terminal || strcmp(r.eventId, eventId) != 0) continue;
    if (++s_ackSendCount[i] >= ACK_ABANDON_AFTER_SENDS) {
      agroack::Record next = r; next.kind = agroack::Delivered;
      if (g_durableAcks.put(i, next, false)) {
        g_ackAbandoned++;
        LOGE("[ACK][ABANDONED] cmd=%s event=%s: %u envios sem recibo; vaga liberada (idempotencia mantida)",
             commandId, eventId, static_cast<unsigned>(s_ackSendCount[i]));
      }
    }
    break;
  }
  unlockSem(durableAckMutex);
}

bool ackBestEffortNext(uint32_t nowMs, agroack::Record& out) {
  bool found = false;
  if (!lockSem(durableAckMutex, 20)) return false;
  for (unsigned i = 0; i < ACK_BESTEFFORT_SLOTS; ++i) {
    BestEffortAck& b = s_bestEffort[i];
    if (!b.used || static_cast<int32_t>(nowMs - b.nextAtMs) < 0) continue;
    out = b.r;
    b.attempts++;
    b.nextAtMs = nowMs + ACK_RETRY_BASE_MS + (esp_random() % ACK_RETRY_JITTER_MS);
    if (b.attempts >= ACK_BESTEFFORT_ATTEMPTS) b.used = false;  // última tentativa
    found = true;
    break;
  }
  unlockSem(durableAckMutex);
  return found;
}

bool ackOutboxDegraded() {
  bool degraded = true;
  if (lockSem(durableAckMutex, 20)) { degraded = g_durableAcks.fault; unlockSem(durableAckMutex); }
  return degraded;
}

void ackHealthTick(uint32_t nowMs) {
  static uint32_t lastMs = 0;
  if (lastMs != 0 && static_cast<int32_t>(nowMs - lastMs) < static_cast<int32_t>(ACK_HEALTH_TICK_MS)) return;
  lastMs = nowMs ? nowMs : 1;
  unsigned healed = 0;
  bool fault = false;
  if (lockSem(durableAckMutex, 50)) {
    healed = g_durableAcks.healBlocked();
    fault = g_durableAcks.fault;
    unlockSem(durableAckMutex);
  }
  if (healed) LOGW("[ACK][HEAL] %u vaga(s) do outbox recuperada(s) sem reiniciar", healed);
  if (fault) LOGE("[ACK][HEALTH] outbox degradado (vagas bloqueadas ou escrita falhando); LIGAR recusado ate recuperar");
  nvs_stats_t st{};
  if (nvs_get_stats(nullptr, &st) == ESP_OK) g_nvsFreeEntries.store(static_cast<int32_t>(st.free_entries));
}
