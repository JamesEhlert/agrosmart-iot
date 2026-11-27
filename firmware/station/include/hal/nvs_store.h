#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/hal/nvs_store.h
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Fase 3 / Parte B — v5.24.0)
 * REVISÃO: 2026-11-22 UTC
 * CHANGELOG 2026-11-22 (v5.24.0):
 * - Declara helpers NVS de bloqueio de versão OTA (`ota_badver`) e motivo de rollback (`ota_rbwhy`).
 * PROPÓSITO: Adaptador de persistência na Flash NVS (Preferences), configuração ativa
 *            em RAM (RuntimeConfig), ponteiros WAL, sequência de telemetria e
 *            recuperação de falhas de energia/crash no boot.
 * ===================================================================================
 */
#include <Arduino.h>
#include <atomic>
#include <stdint.h>
#include "config/app_config.h"
#include "config/system_types.h"

extern RuntimeConfig         g_cfg;
extern std::atomic<uint32_t> g_telemetrySeq;

extern uint32_t g_seqDirty;
extern uint32_t g_offDirty;

extern uint32_t g_pendingOffset;
extern uint32_t g_pendingSegRead;
extern uint32_t g_pendingSegWrite;

/**
 * Lê uma cópia thread-safe da configuração operacional ativa (`g_cfg`).
 */
RuntimeConfig cfgGet();

/**
 * Atualiza a configuração operacional ativa em RAM protegida por `cfgMutex`.
 */
bool cfgSet(const RuntimeConfig& c);

/**
 * Grava `telemetry_interval_ms`, `soil_raw_dry` e `soil_raw_wet` no NVS.
 */
bool persistRuntimeConfigToNVS(const RuntimeConfig& c);

/**
 * Grava ou limpa o `command_id` da rega ativa na memória Flash NVS (Crash Recovery).
 */
void persistActiveCommandNVS(const char* cmdId);

/**
 * Marca ou limpa no NVS se há uma gravação de Flash OTA em andamento (`K_OTA_INPROG`).
 */
void persistOtaInProgressNVS(const char* cmdId);

/**
 * Salva ou limpa no NVS os metadados de uma atualização OTA prestes a reiniciar (`K_OTA_SELFTEST`).
 */
void persistPendingOtaVerificationNVS(const char* cmdId, const char* targetVersion);

/**
 * Verifica se `version` corresponde à versão bloqueada em NVS (`ota_badver`).
 */
bool isOtaVersionBlockedNVS(const char* version);

/**
 * Grava uma versão problemática no slot único de bloqueio NVS (`ota_badver`).
 */
void persistOtaBlockedVersionNVS(const char* version);

/**
 * Grava ou limpa o motivo do último rollback OTA na chave NVS (`ota_rbwhy`).
 */
void persistOtaRollbackReasonNVS(const char* reason);

/**
 * Persiste `g_telemetrySeq` no NVS com proteção de wear-leveling (a cada 10 amostras ou forçado).
 */
void persistSeqIfNeeded(bool force = false);

/**
 * Persiste os ponteiros da fila WAL (`pend_off`, `pend_seg_r`, `pend_seg_w`) no NVS.
 */
void persistOffsetIfNeeded(bool force = false);

/**
 * Carrega parâmetros do NVS no boot e verifica marcadores de Crash Recovery (Válvula, OTA e Self-Test).
 */
void loadFromNVSAndCheckCrashRecovery();