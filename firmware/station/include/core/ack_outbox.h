#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/core/ack_outbox.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-24 UTC (v5.26.0, Fase 4.0-E)
 * PROPÓSITO: Gerenciador do Outbox de ACK Durável (agroack::Store em Flash NVS),
 *            livro de idempotência durável (agroack::Ledger), cache circular de
 *            idempotência em RAM, balde anti-rajada de LIGAR (agroflood::Guard),
 *            tombstone de cancelamento explícito, fila de melhor esforço para ACK
 *            sem vaga durável e enfileiramento seguro (enqueueAck).
 * ===================================================================================
 */
#include <Arduino.h>
#include <ArduinoJson.h>
#include <stdint.h>
#include <stddef.h>
#include "config/app_config.h"
#include "config/system_types.h"
#include "core/durable_ack.h"
#include "core/flood_guard.h"
#include <atomic>

extern agroack::Store g_durableAcks;
extern agroack::Ledger g_ackLedger;
extern uint32_t       g_ackRetryAt[agroack::CAPACITY];

extern RecentCmdEntry g_recentCmds[RECENT_CMD_CACHE_SIZE];
extern size_t         g_recentCmdIdx;
extern char           g_incomingCommandId[48];
extern uint64_t       g_incomingExpiresAt;

// v5.26.0 (Fase 4.0-E): contadores publicados na telemetria (sys).
extern std::atomic<uint32_t> g_ackBestEffort;   // ACK terminal sem vaga durável (enviado da RAM)
extern std::atomic<uint32_t> g_ackAbandoned;    // ACK sem recibo após ACK_ABANDON_AFTER_SENDS envios
extern std::atomic<uint32_t> g_floodRejects;    // LIGAR recusados pelo balde/intervalo mínimo
extern std::atomic<int32_t>  g_nvsFreeEntries;  // entradas livres da NVS (-1 = desconhecido)

/**
 * Busca um `command_id` no cache circular de idempotência de forma thread-safe.
 */
bool findRecentCommandSafe(const char* cmdId, RecentCmdEntry& outEntry);

/**
 * Registra ou atualiza o desfecho de um comando no cache circular de idempotência.
 */
void recordOrUpdateCommandOutcome(const char* cmdId, const char* action,
                                  int32_t durationS, const char* status,
                                  const char* reason);

/**
 * v5.26.0 (Fase 4.0-E): balde anti-rajada de LIGAR + intervalo mínimo após fechar.
 * `ackFloodCheck` só consulta; `ackFloodConsume` gasta 1 ficha quando a válvula abriu.
 * DESLIGAR nunca passa por aqui.
 */
agroflood::Decision ackFloodCheck(uint32_t nowMs);
void ackFloodConsume(uint32_t nowMs);

/**
 * Callbacks de armazenamento NVS e operações do protocolo de ACK durável v1.
 */
int  ackNvsRead(void*, unsigned slot, agroack::Record& record);
bool ackNvsWrite(void*, unsigned slot, const agroack::Record& record);
bool ackNvsErase(void*, unsigned slot);
void ackCapture(agroack::Record& r, const char* commandId, const char* status, const char* action,
                int32_t duration, const char* reason, const char* error, const char* interrupted);
bool ackGet(const char* commandId, agroack::Record& result);
bool ackReserveOn(const char* commandId, uint32_t duration, uint64_t expiresAt);
bool ackTombstoneCancelledOn(const char* cancelCommandId, const char* byOffCommandId, uint64_t expiresAt);
bool ackPromoteTombstoneToTerminal(const char* commandId, int32_t duration);
bool ackSaveTerminal(const char* commandId, const char* status, const char* action,
                     int32_t duration, const char* reason, const char* error, const char* interrupted);
void ackInitAndRecover();
bool ackHandleReceipt(JsonDocument& doc);

/**
 * Enfileira um ACK na `ackQueue` (ou persiste diretamente no Outbox durável se terminal).
 */
void enqueueAck(const char* commandId, const char* status, const char* action = nullptr,
                int32_t durationS = -1, const char* reason = nullptr, const char* error = nullptr,
                const char* interruptedCmdId = nullptr);

/**
 * v5.26.0 (Fase 4.0-E): serviços do outbox v2.
 * - ackLedgerSeen: command_id já visto (livro durável) -> nunca reexecutar.
 * - ackDeferFirstSend: adia o 1º envio de um terminal (ex.: LIGAR interrompido, para o
 *   DESLIGAR comandado chegar sozinho ao Firestore).
 * - ackNextDurableToSend / ackNoteSent: seleção e contabilidade de envio (Net task).
 * - ackBestEffortNext: ACK terminal guardado só na RAM por falta de vaga durável.
 * - ackOutboxDegraded: outbox sem vagas legíveis ou com escrita falhando.
 * - ackHealthTick: autocura das vagas bloqueadas e estatística da NVS (a cada 60 s).
 */
bool ackLedgerSeen(const char* commandId);
void ackDeferFirstSend(const char* commandId, uint32_t delayMs);
bool ackNextDurableToSend(uint32_t nowMs, agroack::Record& out);
void ackNoteSent(const char* eventId, const char* commandId, bool mqttOk);
bool ackBestEffortNext(uint32_t nowMs, agroack::Record& out);
bool ackOutboxDegraded();
void ackHealthTick(uint32_t nowMs);
