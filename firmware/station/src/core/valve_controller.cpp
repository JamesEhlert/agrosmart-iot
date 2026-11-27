/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/core/valve_controller.cpp
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Implementação do controle físico da válvula solenoide e fail-safe GPIO.
 * ===================================================================================
 */
#include "core/valve_controller.h"
#include "config/board_pins.h"
#include "config/app_config.h"
#include "core/time_math.h"
#include "hal/sensor_drivers.h"
#include "services/logger.h"
#include <esp_timer.h>

volatile bool     g_valveState               = false;
volatile uint32_t g_valveOffTimeMs           = 0;
uint32_t          g_valveContinuousOnStartMs = 0;
uint32_t          g_valveLastDebugMs         = 0;
char              g_lastCommandId[48]        = {0};
char              g_activeCommandId[48]      = {0};
bool              g_hasActiveCmdInNvs        = false;

// v5.25.0 (Fase 3B): guarda independente
std::atomic<uint32_t> g_valveTaskHeartbeatMs{0};
std::atomic<uint32_t> g_valveGuardCapDeadlineMs{0};
std::atomic<uint8_t>  g_valveGuardTripReason{0};
std::atomic<uint32_t> g_valveGuardTrips{0};
std::atomic<uint32_t> g_valveLastClosedMs{0};  // v5.26.0 (Fase 4.0-E)
static esp_timer_handle_t s_valveGuardTimer = nullptr;

void valveSetOffLocked() {
  bool wasOpen = false;
  uint32_t dummyOff = 0;
  valveReadStateAtomic(wasOpen, dummyOff);

  valvePinWrite(false);
  valveWriteStateAtomic(false, 0);
  g_valveGuardCapDeadlineMs.store(0);
  if (wasOpen) { uint32_t t = msNow(); g_valveLastClosedMs.store(t ? t : 1); }
  g_valveContinuousOnStartMs = 0;
  g_valveLastDebugMs = 0;
  // Keep active recovery evidence until terminal ACK is durably committed.

  if (wasOpen) {
    requestDeferredTelemetryAfterValve("valve_off");
  }
}

void valveSetOnForLocked(uint32_t durationS, const char* cmdId) {
  if (durationS == 0) {
    valveSetOffLocked();
    return;
  }

  bool wasOpen = false;
  uint32_t dummyOff = 0;
  valveReadStateAtomic(wasOpen, dummyOff);

  uint32_t now = msNow();
  if (!wasOpen || g_valveContinuousOnStartMs == 0) {
    g_valveContinuousOnStartMs = now;
  }
  // Teto contínuo publicado para a guarda ANTES de energizar o pino.
  g_valveGuardCapDeadlineMs.store(g_valveContinuousOnStartMs + (MAX_VALVE_DURATION_S * 1000UL));
  valvePinWrite(true);
  valveWriteStateAtomic(true, now + durationS * 1000UL);
  g_valveLastDebugMs = now;
  if (cmdId && cmdId[0] != '\0') {
    safeCopy(g_activeCommandId, sizeof(g_activeCommandId), cmdId);
    // Durable reservation already committed before activation.
  }
  LOGI("[VALVULA] ON por %lus (cmd=%s)", static_cast<unsigned long>(durationS), cmdId ? cmdId : "-");
  requestDeferredTelemetryAfterValve("valve_on");
}

void valveApplyCommand(bool turnOn, int32_t durationS, const char* cmdId) {
  if (lockSem(valveMutex, 50)) {
    if (!turnOn) {
      LOGI("[VALVULA] OFF imediato.");
      valveSetOffLocked();
    } else {
      uint32_t safeS = clampValveDurationS(durationS);
      valveSetOnForLocked(safeS, cmdId);
    }
    unlockSem(valveMutex);
  } else {
    LOGE("[FAIL-SAFE] Mutex da válvula ocupado. Forçando OFF físico (GPIO) de forma atômica.");
    valvePinWrite(false);
    valveWriteStateAtomic(false, 0);
    { uint32_t t = msNow(); g_valveLastClosedMs.store(t ? t : 1); }
    g_valveGuardCapDeadlineMs.store(0);
    requestDeferredTelemetryAfterValve("valve_failsafe_off");
  }
}

// ---------------------------------------------------------------------------------
// Guarda independente (v5.25.0 (Fase 3B)) — roda na task do esp_timer, sem mutex e sem log.
// Só age com a válvula ABERTA; nunca abre nada.
// ---------------------------------------------------------------------------------
static void valveGuardCallback(void* /*arg*/) {
  bool open = false;
  uint32_t offAt = 0;
  valveReadStateAtomic(open, offAt);
  if (!open) return;

  // Heartbeat lido ANTES do relógio para a subtração nunca ficar negativa.
  uint32_t hb  = g_valveTaskHeartbeatMs.load();
  uint32_t cap = g_valveGuardCapDeadlineMs.load();
  uint32_t now = msNow();

  uint8_t reason = 0;
  if (offAt == 0 ||
      timeReached(now, offAt + VALVE_GUARD_GRACE_MS) ||
      (cap != 0 && timeReached(now, cap + VALVE_GUARD_GRACE_MS))) {
    reason = VALVE_GUARD_TRIP_DEADLINE;
  } else if (static_cast<uint32_t>(now - hb) > VALVE_GUARD_HEARTBEAT_STALE_MS) {
    reason = VALVE_GUARD_TRIP_STALL;
  }
  if (reason == 0) return;

  valvePinWrite(false);
  valveWriteStateAtomic(false, 0);
  g_valveGuardCapDeadlineMs.store(0);
  g_valveLastClosedMs.store(now ? now : 1);
  g_valveGuardTrips++;
  g_valveGuardTripReason.store(reason);  // a taskValveControl envia o ACK
}

void valveGuardInit() {
  if (s_valveGuardTimer != nullptr) return;
  g_valveTaskHeartbeatMs.store(msNow());
  esp_timer_create_args_t args{};
  args.callback = &valveGuardCallback;
  args.arg = nullptr;
  args.dispatch_method = ESP_TIMER_TASK;
  args.name = "valve_guard";
  esp_err_t err = esp_timer_create(&args, &s_valveGuardTimer);
  if (err == ESP_OK) {
    err = esp_timer_start_periodic(s_valveGuardTimer, VALVE_GUARD_PERIOD_MS * 1000ULL);
  }
  if (err == ESP_OK) {
    LOGI("[VALVULA][GUARD] Guarda independente ativa (periodo=%lums, tolerancia=%lums, stall=%lums).",
         static_cast<unsigned long>(VALVE_GUARD_PERIOD_MS),
         static_cast<unsigned long>(VALVE_GUARD_GRACE_MS),
         static_cast<unsigned long>(VALVE_GUARD_HEARTBEAT_STALE_MS));
  } else {
    LOGE("[VALVULA][GUARD] Falha ao criar guarda independente (err=%d)!", static_cast<int>(err));
  }
}
