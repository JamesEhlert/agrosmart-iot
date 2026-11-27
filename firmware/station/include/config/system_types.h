#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/config/system_types.h
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Fase 3 / Parte B — v5.24.0)
 * REVISÃO: 2026-11-22 UTC
 * PROPÓSITO: Estruturas de dados compartilhadas entre camadas (TelemetryData,
 *            RuntimeConfig, AckMessage, RecentCmdEntry, OtaJobRequest, BackoffState).
 * CHANGELOG 2026-11-22 (v5.24.0):
 * - Adiciona `signatureB64[104]` e `sigAlg[24]` em `OtaJobRequest` para
 *   revalidação ECDSA P-256 pós-download em `ota_manager.cpp`.
 * ===================================================================================
 */
#include <stdint.h>
#include <stddef.h>
#include "config/app_config.h"

struct TelemetryData {
  uint32_t timestamp;
  uint32_t seq;
  float air_temp;
  float air_hum;
  int soil_moisture;
  int soil_raw;
  bool soil_fault;
  int light_level;
  int rain_raw;
  int rain_pct;
  bool rain_detected;
  float uv_index;
  uint8_t sampled_valve_state;
  uint32_t sampled_valve_rem_s;
  uint32_t sampled_heap;
  int32_t sampled_rssi;
  bool sampled_wifi_conn;
};

struct RuntimeConfig {
  uint32_t telemetry_interval_ms = DEFAULT_TELEMETRY_INTERVAL_MS;
  int soil_raw_dry = 3000;
  int soil_raw_wet = 1200;

  uint32_t pending_flush_every_ms = PENDING_FLUSH_EVERY_MS_DEFAULT;
  uint32_t pending_flush_max_items = PENDING_FLUSH_MAX_ITEMS_DEFAULT;
  uint32_t pending_flush_max_ms = PENDING_FLUSH_MAX_MS_DEFAULT;
};

struct AckMessage {
  char commandId[48];
  char status[16];
  char action[16];
  int32_t durationS;
  char reason[32];
  char error[32];
  char interruptedCmdId[48];
  char originBoot[17];
  uint32_t originSession, originTs, originUptime, originInterval;
  int32_t originSoilDry, originSoilWet;
};

/**
 * Entrada do cache circular de idempotência que preserva o resultado exato de cada comando.
 */
struct RecentCmdEntry {
  char id[48];
  char action[16];
  char status[16];
  char reason[32];
  int32_t durationS;
};

/**
 * Estrutura que armazena os parâmetros de uma atualização OTA agendada pelo callback
 * MQTT para execução segura e fora de interrupção pela taskNetworkStorage.
 */
struct OtaJobRequest {
  bool pending = false;
  char commandId[48];
  char targetVersion[24];
  char expectedSha256[65];
  char otaUrl[1600];
  uint32_t expectedSize = 0;
  char signatureB64[104];
  char sigAlg[24];
};

/**
 * Estado da máquina de Backoff Exponencial com Jitter (Wi-Fi e MQTT).
 */
struct BackoffState {
  uint32_t attempt = 0;
  uint32_t nextTryMs = 0;
};