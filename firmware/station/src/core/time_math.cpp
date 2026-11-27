/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/core/time_math.cpp
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Implementação do Backoff Exponencial com Jitter (75% a 125%).
 * ===================================================================================
 */
#include "core/time_math.h"
#include "services/logger.h"
#include <esp_system.h>

uint32_t jitter(uint32_t baseMs) {
  uint32_t r = static_cast<uint32_t>(esp_random());
  uint32_t pct = 75 + (r % 51);
  return (baseMs * pct) / 100;
}

uint32_t backoffDelay(uint32_t baseMs, uint32_t maxMs, uint32_t attempt) {
  uint32_t a = attempt > 10 ? 10 : attempt;
  uint64_t d = static_cast<uint64_t>(baseMs) * (1ULL << a);
  if (d > maxMs) d = maxMs;
  return jitter(static_cast<uint32_t>(d));
}

bool backoffCanTry(const BackoffState& b) {
  if (b.nextTryMs == 0) return true;
  return timeReached(msNow(), b.nextTryMs);
}

void backoffOnFail(BackoffState& b, uint32_t baseMs, uint32_t maxMs) {
  uint32_t d = backoffDelay(baseMs, maxMs, b.attempt);
  b.attempt++;
  b.nextTryMs = msNow() + d;
  LOGW("[BACKOFF] próxima tentativa em %lums (attempt=%lu)",
       static_cast<unsigned long>(d), static_cast<unsigned long>(b.attempt));
}

void backoffReset(BackoffState& b) {
  b.attempt = 0;
  b.nextTryMs = 0;
}