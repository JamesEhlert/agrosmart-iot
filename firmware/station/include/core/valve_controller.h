#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/core/valve_controller.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Controle atômico e determinístico da válvula solenoide (PIN_VALVE),
 *            gerência de prazos locais e fail-safe físico imediato.
 * ===================================================================================
 */
#include <Arduino.h>
#include <stdint.h>
#include <atomic>
#include "config/app_config.h"
#include "config/board_pins.h"
#include "tasks/rtos_sync.h"

// v5.25.0 (Fase 3B): níveis elétricos derivados da polaridade do driver
#if VALVE_ACTIVE_LOW
  #define VALVE_LEVEL_OPEN   LOW
  #define VALVE_LEVEL_CLOSED HIGH
#else
  #define VALVE_LEVEL_OPEN   HIGH
  #define VALVE_LEVEL_CLOSED LOW
#endif

extern volatile bool     g_valveState;
extern volatile uint32_t g_valveOffTimeMs;
extern uint32_t          g_valveContinuousOnStartMs;
extern uint32_t          g_valveLastDebugMs;
extern char              g_lastCommandId[48];
extern char              g_activeCommandId[48];
extern bool              g_hasActiveCmdInNvs;

// Guarda independente (esp_timer) e heartbeat da taskValveControl
extern std::atomic<uint32_t> g_valveTaskHeartbeatMs;
extern std::atomic<uint32_t> g_valveGuardCapDeadlineMs;
extern std::atomic<uint8_t>  g_valveGuardTripReason;
extern std::atomic<uint32_t> g_valveGuardTrips;
// v5.26.0 (Fase 4.0-E): instante (msNow) do último FECHAMENTO real; 0 = ainda não fechou neste boot.
extern std::atomic<uint32_t> g_valveLastClosedMs;

/**
 * Escreve o nível físico da válvula (respeitando VALVE_ACTIVE_LOW) e espelha no LED de status.
 * Único ponto do firmware que toca PIN_VALVE.
 */
inline void valvePinWrite(bool open) {
  digitalWrite(PIN_VALVE, open ? VALVE_LEVEL_OPEN : VALVE_LEVEL_CLOSED);
#if ENABLE_VALVE_STATUS_LED
  digitalWrite(PIN_VALVE_STATUS_LED, open ? HIGH : LOW);
#endif
}

/**
 * Inicialização segura no boot: grava o nível FECHADO antes e depois de virar saída.
 */
inline void valvePinInitSafe() {
  digitalWrite(PIN_VALVE, VALVE_LEVEL_CLOSED);
  pinMode(PIN_VALVE, OUTPUT);
  digitalWrite(PIN_VALVE, VALVE_LEVEL_CLOSED);
#if ENABLE_VALVE_STATUS_LED
  digitalWrite(PIN_VALVE_STATUS_LED, LOW);
  pinMode(PIN_VALVE_STATUS_LED, OUTPUT);
  digitalWrite(PIN_VALVE_STATUS_LED, LOW);
#endif
}

/**
 * Escrita atômica (via spinlock de hardware) do estado e prazo da válvula.
 */
inline void valveWriteStateAtomic(bool state, uint32_t offTimeMs) {
  portENTER_CRITICAL(&g_valveSpinlock);
  g_valveState = state;
  g_valveOffTimeMs = offTimeMs;
  portEXIT_CRITICAL(&g_valveSpinlock);
}

/**
 * Leitura atômica (via spinlock de hardware) do estado e prazo da válvula.
 */
inline void valveReadStateAtomic(bool& stateOut, uint32_t& offTimeMsOut) {
  portENTER_CRITICAL(&g_valveSpinlock);
  stateOut = g_valveState;
  offTimeMsOut = g_valveOffTimeMs;
  portEXIT_CRITICAL(&g_valveSpinlock);
}

/**
 * Desliga fisicamente a válvula (nível VALVE_LEVEL_CLOSED) com `valveMutex` adquirido.
 */
void valveSetOffLocked();

/**
 * Liga fisicamente a válvula pelo tempo limitado `durationS` com `valveMutex` adquirido.
 */
void valveSetOnForLocked(uint32_t durationS, const char* cmdId);

/**
 * Aplica comando de abertura ou fechamento adquirindo `valveMutex` (ou força OFF atômico em fail-safe).
 */
void valveApplyCommand(bool turnOn, int32_t durationS, const char* cmdId = nullptr);

/**
 * Cria a guarda independente (esp_timer periódico de VALVE_GUARD_PERIOD_MS). Fecha a
 * válvula sozinha se o prazo + tolerância vencer ou se a taskValveControl travar.
 */
void valveGuardInit();
