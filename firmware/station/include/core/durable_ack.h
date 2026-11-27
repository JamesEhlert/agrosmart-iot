#pragma once
// =====================================================================================
// Durable ACK protocol v1 (formato do registro inalterado) + política de vagas v2.
// Sem dependência do Arduino: exercitado por testes nativos de injeção de falhas
// (firmware/test_host/durable_ack_host_test.cpp).
//
// v5.26.0 (Fase 4.0-E):
// - Vagas ENTREGUES (Delivered) passam a ser reaproveitáveis a qualquer momento; se o
//   comando ainda estiver dentro do TTL, ele é copiado antes para o livro de
//   idempotência (Ledger), que impede reexecutar o mesmo command_id.
// - SAFETY_RESERVE vagas ficam sempre disponíveis para ACK terminal de segurança
//   (DESLIGAR, guarda, chuva, supervisor). Reservas de LIGAR e demais terminais só
//   entram se, depois delas, ainda sobrarem SAFETY_RESERVE vagas.
// - Falha de leitura/CRC no boot não trava mais o outbox para sempre: a vaga é posta
//   em quarentena, apagada e reaproveitada (repaired++). Falha de escrita não é mais
//   permanente: só a operação falha; a próxima tenta de novo.
// =====================================================================================
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <type_traits>

namespace agroack {
static const unsigned CAPACITY = 8;
static const unsigned SAFETY_RESERVE = 2;
static const uint32_t MAGIC = 0x41434B31;
static const unsigned WRITE_FAULT_STREAK = 3;  // falhas de escrita seguidas = outbox degradado
enum Kind : uint8_t { Empty = 0, Active = 1, Terminal = 2, Delivered = 3 };
enum SlotClass : uint8_t { ClassNormal = 0, ClassSafety = 1 };
struct Record {
  uint32_t magic;
  uint16_t version;
  uint16_t bytes;
  uint64_t sequence;
  uint8_t kind;
  uint8_t reserved[7];
  char eventId[33], commandId[48], status[16], action[16];
  char reason[48], error[48], interruptedId[48];
  char fw[24], part[16], bootId[17], resetReason[32];
  uint32_t timestamp, uptimeS, bootCount, session, heap;
  int32_t rssi;
  uint32_t intervalMs;
  int32_t soilDry, soilWet;
  int32_t duration;
  uint64_t expiresAt;
  uint32_t crc;
};
static_assert(std::is_trivially_copyable<Record>::value, "NVS record must be POD");
inline uint32_t crc32(const uint8_t* p, size_t n) {
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < n; ++i) {
    crc ^= p[i];
    for (unsigned b = 0; b < 8; ++b) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
  }
  return ~crc;
}
inline uint32_t checksum(const Record& r) {
  return crc32(reinterpret_cast<const uint8_t*>(&r), offsetof(Record, crc));
}
inline bool valid(const Record& r) {
  return r.magic == MAGIC && r.version == 1 && r.bytes == sizeof(Record) &&
    r.kind >= Active && r.kind <= Delivered && r.sequence > 0 &&
    memchr(r.eventId, 0, sizeof(r.eventId)) && strlen(r.eventId) == 32 &&
    memchr(r.commandId, 0, sizeof(r.commandId)) && r.commandId[0] &&
    memchr(r.status, 0, sizeof(r.status)) && memchr(r.action, 0, sizeof(r.action)) &&
    memchr(r.reason, 0, sizeof(r.reason)) && memchr(r.error, 0, sizeof(r.error)) &&
    memchr(r.interruptedId, 0, sizeof(r.interruptedId)) &&
    memchr(r.fw, 0, sizeof(r.fw)) && memchr(r.part, 0, sizeof(r.part)) &&
    memchr(r.bootId, 0, sizeof(r.bootId)) && memchr(r.resetReason, 0, sizeof(r.resetReason)) &&
    r.crc == checksum(r);
}
inline bool mayReportStarted(const Record& r, const char* currentBoot, const char* activeCommand, bool isOn) {
  return r.kind == Active && isOn && strcmp(r.bootId, currentBoot) == 0 && strcmp(r.commandId, activeCommand) == 0;
}
// Tombstone preventivo de LIGAR cancelado por DESLIGAR (ver ack_outbox.cpp).
inline bool isCancelTombstone(const Record& r) {
  return r.kind == Delivered && r.duration < 0 && strcmp(r.reason, "cancelled_by_off") == 0;
}
// Registro cujo command_id ainda precisa de proteção contra reexecução.
inline bool needsDedupMemory(const Record& r, uint64_t nowEpoch) {
  if (r.expiresAt == 0) return false;                       // DESLIGAR/config: repetir é inofensivo
  if (nowEpoch == 0) return true;                           // relógio desconhecido: conservador
  return !(nowEpoch > r.expiresAt && nowEpoch - r.expiresAt > 60);
}

// ------------------------------------------------------------------------------------
// Livro de idempotência: anel de hashes de command_id (FNV-1a 64), persistido num blob.
// ------------------------------------------------------------------------------------
static const unsigned LEDGER_CAPACITY = 48;
static const uint32_t LEDGER_MAGIC = 0x4C444731;  // "LDG1"
enum Outcome : uint8_t { OutcomeNone = 0, OutcomeExecuted = 1, OutcomeRejected = 2, OutcomeCancelled = 3 };
struct LedgerEntry {
  uint64_t hash;
  uint32_t atEpoch;
  uint8_t outcome;
  uint8_t reserved[3];
};
struct LedgerBlob {
  uint32_t magic;
  uint16_t version;
  uint16_t head;
  LedgerEntry entries[LEDGER_CAPACITY];
  uint32_t crc;
};
static_assert(std::is_trivially_copyable<LedgerBlob>::value, "NVS ledger must be POD");
inline uint64_t commandHash(const char* id) {
  uint64_t h = 1469598103934665603ULL;
  for (const unsigned char* p = reinterpret_cast<const unsigned char*>(id); p && *p; ++p) {
    h ^= *p; h *= 1099511628211ULL;
  }
  return h == 0 ? 1 : h;  // 0 = entrada vazia
}
inline uint32_t ledgerChecksum(const LedgerBlob& b) {
  return crc32(reinterpret_cast<const uint8_t*>(&b), offsetof(LedgerBlob, crc));
}
inline bool ledgerValid(const LedgerBlob& b) {
  return b.magic == LEDGER_MAGIC && b.version == 1 && b.head < LEDGER_CAPACITY && b.crc == ledgerChecksum(b);
}
// read: 0 ausente, 1 carregado, -1 erro. write grava E confere.
struct LedgerStorage {
  void* context;
  int (*read)(void*, LedgerBlob&);
  bool (*write)(void*, const LedgerBlob&);
};
class Ledger {
 public:
  LedgerBlob blob{};
  LedgerStorage storage{};
  bool persistent = false;     // false = só RAM (NVS indisponível)
  uint32_t writeFailures = 0;
  bool wasReset = false;       // blob ausente ou corrompido no boot
  void reset() {
    blob = LedgerBlob{};
    blob.magic = LEDGER_MAGIC; blob.version = 1; blob.head = 0;
    blob.crc = ledgerChecksum(blob);
  }
  void begin(LedgerStorage s) {
    storage = s;
    LedgerBlob loaded{};
    int rc = (s.read != nullptr) ? s.read(s.context, loaded) : -1;
    if (rc == 1 && ledgerValid(loaded)) { blob = loaded; persistent = true; wasReset = false; return; }
    reset();
    wasReset = (rc != 0);
    persistent = (s.write != nullptr);
  }
  bool contains(const char* commandId) const {
    if (!commandId || !commandId[0]) return false;
    uint64_t h = commandHash(commandId);
    for (unsigned i = 0; i < LEDGER_CAPACITY; ++i) if (blob.entries[i].hash == h) return true;
    return false;
  }
  // true = lembrado de forma durável (ou já estava). Em falha de NVS fica só em RAM e
  // devolve false, para o chamador NÃO descartar a única cópia durável.
  bool remember(const char* commandId, uint8_t outcome, uint64_t nowEpoch) {
    if (!commandId || !commandId[0]) return false;
    if (contains(commandId)) return true;
    LedgerEntry& e = blob.entries[blob.head];
    e = LedgerEntry{};
    e.hash = commandHash(commandId);
    e.atEpoch = static_cast<uint32_t>(nowEpoch > 0xFFFFFFFFULL ? 0xFFFFFFFFULL : nowEpoch);
    e.outcome = outcome;
    blob.head = static_cast<uint16_t>((blob.head + 1) % LEDGER_CAPACITY);
    blob.crc = ledgerChecksum(blob);
    if (!persistent || storage.write == nullptr) return false;
    if (!storage.write(storage.context, blob)) { ++writeFailures; return false; }
    return true;
  }
};

// read: 0 ausente, 1 carregado, -1 erro. write grava E confere. erase remove a chave.
struct Storage {
  void* context;
  int (*read)(void*, unsigned, Record&);
  bool (*write)(void*, unsigned, const Record&);
  bool (*erase)(void*, unsigned);
};
inline uint8_t outcomeOf(const Record& r) {
  if (strcmp(r.reason, "cancelled_by_off") == 0) return OutcomeCancelled;
  if (strcmp(r.status, "failed") == 0 && strcmp(r.action, "on") == 0 && r.duration >= 0 &&
      strcmp(r.reason, "manual_stop") != 0) return OutcomeRejected;
  return OutcomeExecuted;
}
class Store {
 public:
  Record records[CAPACITY]{};
  bool blocked[CAPACITY]{};     // vaga ilegível que nem apagar conseguiu
  bool fault = false;           // outbox degradado (todas as vagas bloqueadas ou escrita falhando)
  uint64_t nextSequence = 1;
  Storage storage{};
  uint32_t repaired = 0, evicted = 0, writeFailures = 0, writeFailStreak = 0, allocRefused = 0;

  void refreshFault() {
    unsigned usable = 0;
    for (unsigned i = 0; i < CAPACITY; ++i) if (!blocked[i]) ++usable;
    fault = (usable == 0) || (writeFailStreak >= WRITE_FAULT_STREAK);
  }
  // Tenta liberar uma vaga ilegível apagando a chave. Retorna true se ficou utilizável.
  bool quarantine(unsigned i) {
    records[i] = Record{};
    if (storage.erase != nullptr && storage.erase(storage.context, i)) {
      blocked[i] = false; ++repaired; return true;
    }
    blocked[i] = true;
    return false;
  }
  bool begin(Storage s) {
    storage = s;
    for (unsigned i = 0; i < CAPACITY; ++i) {
      Record r{};
      int result = s.read(s.context, i, r);
      if (result == 0) { records[i] = Record{}; blocked[i] = false; continue; }
      if (result < 0 || !valid(r)) { quarantine(i); continue; }
      records[i] = r; blocked[i] = false;
      if (r.sequence >= nextSequence) nextSequence = r.sequence + 1;
    }
    if (nextSequence == 0) nextSequence = 1;
    refreshFault();
    return !fault;
  }
  // Autocura periódica: tenta de novo as vagas bloqueadas. Retorna quantas voltaram.
  unsigned healBlocked() {
    unsigned healed = 0;
    for (unsigned i = 0; i < CAPACITY; ++i) if (blocked[i] && quarantine(i)) ++healed;
    refreshFault();
    return healed;
  }
  int find(const char* commandId) const {
    int found = -1;
    for (unsigned i = 0; i < CAPACITY; ++i)
      if (!blocked[i] && records[i].kind && strcmp(records[i].commandId, commandId) == 0 &&
          (found < 0 || records[i].sequence > records[found].sequence)) found = int(i);
    return found;
  }
  // Vagas que podem receber um registro novo agora (vazias + já entregues).
  unsigned freeSlots() const {
    unsigned n = 0;
    for (unsigned i = 0; i < CAPACITY; ++i)
      if (!blocked[i] && (records[i].kind == Empty || records[i].kind == Delivered)) ++n;
    return n;
  }
  unsigned countKind(Kind k) const {
    unsigned n = 0;
    for (unsigned i = 0; i < CAPACITY; ++i) if (!blocked[i] && records[i].kind == k) ++n;
    return n;
  }
  // Escolhe a vaga para um registro novo. ClassNormal exige que sobrem SAFETY_RESERVE.
  // Preferência: vazia > entregue já expirada (mais antiga) > entregue dentro do TTL
  // (mais antiga; tombstones por último), que antes vai para o livro de idempotência.
  int allocate(uint64_t nowEpoch, SlotClass cls, Ledger* ledger) {
    unsigned need = (cls == ClassSafety) ? 1u : SAFETY_RESERVE + 1u;
    if (freeSlots() < need) { ++allocRefused; return -1; }
    int empty = -1, expired = -1, live = -1, liveTomb = -1;
    for (unsigned i = 0; i < CAPACITY; ++i) {
      if (blocked[i]) continue;
      const Record& r = records[i];
      if (r.kind == Empty) { if (empty < 0) empty = int(i); continue; }
      if (r.kind != Delivered) continue;
      if (!needsDedupMemory(r, nowEpoch)) {
        if (expired < 0 || r.sequence < records[expired].sequence) expired = int(i);
      } else if (isCancelTombstone(r)) {
        if (liveTomb < 0 || r.sequence < records[liveTomb].sequence) liveTomb = int(i);
      } else if (live < 0 || r.sequence < records[live].sequence) {
        live = int(i);
      }
    }
    if (empty >= 0) return empty;
    if (expired >= 0) { ++evicted; return expired; }
    int pick = live >= 0 ? live : liveTomb;
    if (pick < 0) { ++allocRefused; return -1; }
    if (ledger == nullptr || !ledger->remember(records[pick].commandId, outcomeOf(records[pick]), nowEpoch)) {
      ++allocRefused; return -1;   // sem livro durável não se descarta a única memória do comando
    }
    ++evicted;
    return pick;
  }
  bool put(unsigned slot, Record r, bool newSequence = true) {
    if (slot >= CAPACITY || blocked[slot]) return false;
    r.magic = MAGIC; r.version = 1; r.bytes = sizeof(Record);
    if (newSequence) {
      if (nextSequence == UINT64_MAX) return false;
      r.sequence = nextSequence++;
    }
    r.crc = checksum(r);
    if (!valid(r)) return false;
    if (!storage.write(storage.context, slot, r)) {
      ++writeFailures; ++writeFailStreak; refreshFault();
      return false;
    }
    writeFailStreak = 0;
    records[slot] = r;
    refreshFault();
    return true;
  }
  bool receipt(const char* eventId, const char* commandId) {
    for (unsigned i = 0; i < CAPACITY; ++i) {
      const Record& r = records[i];
      if (!blocked[i] && r.kind == Terminal && strcmp(r.eventId, eventId) == 0 && strcmp(r.commandId, commandId) == 0) {
        Record next = r; next.kind = Delivered;
        return put(i, next, false);
      }
    }
    return false;
  }
  // Próximo terminal a publicar: primeiro os nunca enviados (o mais NOVO primeiro: o
  // DESLIGAR comandado é gravado depois do LIGAR interrompido); depois rodízio dos
  // reenvios vencidos. retryAt[i] == 0 = nunca enviado.
  int nextToSend(const uint32_t* retryAt, uint32_t nowMs, unsigned& cursor) const {
    int fresh = -1;
    for (unsigned i = 0; i < CAPACITY; ++i)
      if (!blocked[i] && records[i].kind == Terminal && retryAt[i] == 0 &&
          (fresh < 0 || records[i].sequence > records[fresh].sequence)) fresh = int(i);
    if (fresh >= 0) return fresh;
    for (unsigned n = 0; n < CAPACITY; ++n) {
      unsigned i = cursor++ % CAPACITY;
      if (!blocked[i] && records[i].kind == Terminal && static_cast<int32_t>(nowMs - retryAt[i]) >= 0) return int(i);
    }
    return -1;
  }
};
} // namespace agroack
