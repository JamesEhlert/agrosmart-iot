#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/services/diagnostics_service.h
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Bloco 2 — F4.2 Tópico ack_receipt)
 * REVISÃO: 2026-11-21 UTC
 * PROPÓSITO: Contadores atômicos de saúde operacional, diagnósticos de boot/partição,
 *            tópicos MQTT da estação (incluindo canal dedicado `ack_receipt`) e
 *            construtores JSON (Telemetria V2 e Presença).
 * ===================================================================================
 */
#include <Arduino.h>
#include <atomic>
#include <stdint.h>
#include <stddef.h>
#include <esp_system.h>
#include "config/app_config.h"
#include "config/system_types.h"

// Tópicos MQTT exclusivos da estação
extern char g_topicTelemetry[128];
extern char g_topicCommand[128];
extern char g_topicAck[128];
extern char g_topicAckReceipt[128];
extern char g_topicPresence[128];

// Estado de partição Flash e Self-Test OTA
extern char     g_runningPartition[16];
extern bool     g_partitionNeedsVerify;
extern bool     g_appSelfTestPending;
extern uint32_t g_wifiConnectedSinceMs;

// Contadores atômicos de diagnóstico, sessões e saúde operacional
extern std::atomic<uint32_t> g_sdWriteErrors;
extern std::atomic<uint32_t> g_sdCorruptLines;
extern std::atomic<uint32_t> g_wifiDisconnects;
extern std::atomic<uint32_t> g_mqttReconnects;
extern std::atomic<uint32_t> g_mqttSessionSeq;
extern std::atomic<uint32_t> g_sensorErrAHT;
extern std::atomic<uint32_t> g_rainInterlocks;
extern std::atomic<uint32_t> g_ackDrops;
extern std::atomic<uint32_t> g_cmdRejected;  // v5.25.2 (Fase 3C): comandos recusados sem ACK
extern std::atomic<uint32_t> g_telemetryDropped;

// Diagnósticos de Boot
extern uint32_t    g_bootCount;
extern char        g_bootId[17];
extern const char* g_resetReason;

// Modo seguro de energia (v5.25.0 (Fase 3B))
extern uint8_t           g_brownoutStreak;
extern std::atomic<bool> g_brownoutStreakClearRequested;

/**
 * true enquanto o modo seguro de energia estiver ativo (comandos ON recusados).
 */
bool powerSafeModeActive();

/**
 * Chamado no loop da taskNetworkStorage: expira o modo seguro e zera a série de
 * brownouts após POWER_BROWNOUT_STREAK_CLEAR_MS ou após um ciclo de rega completo.
 */
void powerStabilityTick(uint32_t nowMs);

/**
 * Constrói os cinco tópicos MQTT exclusivos desta estação usando o THINGNAME.
 */
void buildMqttTopics();

/**
 * Traduz o código de motivo de reset do ESP-IDF para string legível de auditoria.
 */
const char* resetReasonName(esp_reset_reason_t r);

/**
 * Persiste o contador de inicializações (`boot_cnt`) na Flash NVS.
 */
void persistBootCount();

/**
 * Inicializa `g_resetReason`, incrementa `g_bootCount` e gera `g_bootId` aleatório de 64 bits.
 */
void initBootDiagnostics();

/**
 * Imprime no Monitor Serial o resumo da versão, partição, tópicos MQTT e parâmetros NVS.
 */
void printConfig();

/**
 * Formata o identificador único de telemetria (`<THINGNAME>:<timestamp>:<seq>`).
 */
void makeTelemetryId(char* out, size_t outSz, uint32_t ts, uint32_t seq);

/**
 * Constrói o JSON de telemetria Schema V2 com leituras de sensores e bloco `sys`.
 */
bool buildTelemetryJson(const TelemetryData& d, char* out, size_t outSz, uint32_t& outLen);

/**
 * Constrói o JSON de presença (`birth`, `heartbeat`, `lwt` ou `ota_reboot`) com `session_seq`.
 */
bool buildPresenceJson(const char* state, const char* kind, uint32_t sessionSeq,
                       char* out, size_t outSz, uint32_t& outLen);
