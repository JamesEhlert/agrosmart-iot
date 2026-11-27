#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/core/time_math.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Funções puras de tempo (comparação anti-rollover de millis(), validação
 *            de epoch Unix, teto de segurança da válvula e Backoff com Jitter).
 * ===================================================================================
 */
#include <stdint.h>
#include "config/app_config.h"
#include "config/system_types.h"

/**
 * Comparação temporal imune ao estouro de 32 bits do `millis()` (a cada ~49,7 dias).
 */
inline bool timeReached(uint32_t now, uint32_t deadline) {
  return static_cast<int32_t>(now - deadline) >= 0;
}

/**
 * Verifica se um timestamp Unix está na janela de sanidade [2020-01-01 .. 2038-01-01).
 */
inline bool isValidEpoch(uint32_t ts) {
  return (ts >= EPOCH_2020_01_01 && ts < EPOCH_MAX_SANE);
}

/**
 * Limita a duração de abertura da válvula ao teto físico de segurança (MAX_VALVE_DURATION_S = 900s).
 */
inline uint32_t clampValveDurationS(int32_t requestedS) {
  if (requestedS <= 0) return 0;
  if (static_cast<uint32_t>(requestedS) > MAX_VALVE_DURATION_S) return MAX_VALVE_DURATION_S;
  return static_cast<uint32_t>(requestedS);
}

uint32_t jitter(uint32_t baseMs);
uint32_t backoffDelay(uint32_t baseMs, uint32_t maxMs, uint32_t attempt);
bool backoffCanTry(const BackoffState& b);
void backoffOnFail(BackoffState& b, uint32_t baseMs, uint32_t maxMs);
void backoffReset(BackoffState& b);