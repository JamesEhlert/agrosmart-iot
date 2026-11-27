#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/hal/sd_telemetry_wal.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Fila Write-Ahead Log (WAL) segmentada no cartão MicroSD (/queue),
 *            reconciliação de segmentos, cache atômico O(1) de bytes pendentes,
 *            flush resiliente para nuvem, log CSV diário e drain pré-reboot.
 * ===================================================================================
 */
#include <Arduino.h>
#include <atomic>
#include <stdint.h>
#include <stddef.h>
#include "config/app_config.h"
#include "config/system_types.h"

extern volatile bool g_sdOk;
extern char          g_netSharedJsonBuf[1536];

extern std::atomic<uint32_t> g_cachedQueueBytes;
extern std::atomic<bool>     g_queueBytesDirty;
extern uint32_t              g_appendCounter;
extern uint32_t              g_sdLastReinitMs;

String   getDailyCsvFilename();
void     queueMakeSegPath(uint32_t segId, char* out, size_t outSz);
bool     sdQueueEnsureDirLocked();
bool     sdQueueFindMinMaxLocked(uint32_t& minSeg, uint32_t& maxSeg, uint32_t& count);
uint32_t sdQueueSegSizeLocked(uint32_t segId);
uint32_t sdQueueComputeTotalBytesLocked();
uint32_t sdQueueTotalBytes(bool forceRecalc = false);
void     sdReconcilePendingState(const char* reason);
bool     sdBeginWithFreq(uint32_t freqHz);
bool     sdInit();
void     sdMarkErrorAndTriggerReinit(const char* context);
void     sdTryReinit();

bool     isValidJsonEnvelope(const char* line, uint32_t len);
bool     sdAppendPendingLine(const char* line, uint32_t len);
bool     sdQueueReadLine(uint32_t segId, uint32_t offset, char* outLine, size_t maxLen,
                         uint32_t& nextOffset, uint32_t& segSize, uint32_t& outLen, bool& truncated);
bool     pendingFlushTick(bool force = false);
void     gracefulDrainBeforeOtaReboot(const char* contextLabel);