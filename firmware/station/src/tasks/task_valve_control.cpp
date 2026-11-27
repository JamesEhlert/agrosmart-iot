/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/tasks/task_valve_control.cpp
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Implementação da taskValveControl (ciclo de 100ms, teto contínuo de 900s
 *            e amostragem rápida de chuva a cada 200ms com debounce de 3 leituras).
 * ===================================================================================
 */
#include "tasks/task_valve_control.h"
#include "config/app_config.h"
#include "core/time_math.h"
#include "core/valve_controller.h"
#include "hal/sensor_drivers.h"
#include "tasks/rtos_sync.h"
#include "services/logger.h"
#include "services/diagnostics_service.h"
#include <esp_task_wdt.h>
#include <atomic>

extern std::atomic<uint32_t> g_rainInterlocks;

void enqueueAck(const char* commandId, const char* status, const char* action = nullptr,
                int32_t durationS = -1, const char* reason = nullptr, const char* error = nullptr,
                const char* interruptedCmdId = nullptr);

void taskValveControl(void* pvParameters) {
  (void)pvParameters;
#ifdef ESP32
  esp_task_wdt_add(NULL);
#endif

  uint32_t lastFastRainSampleMs = 0;
  uint8_t  rainWetStreak = 0;

  for (;;) {
#ifdef ESP32
    esp_task_wdt_reset();
#endif
    g_valveTaskHeartbeatMs.store(msNow());

    // v5.25.0 (Fase 3B): a guarda independente fechou a válvula -> ACK terminal de falha
    uint8_t guardTrip = g_valveGuardTripReason.exchange(0);
    if (guardTrip != 0) {
      char tripCmd[48] = {0};
      bool tripHandled = false;
      if (lockSem(valveMutex, 50)) {
        if (g_activeCommandId[0] != '\0') safeCopy(tripCmd, sizeof(tripCmd), g_activeCommandId);
        g_activeCommandId[0] = '\0';
        valveSetOffLocked();
        unlockSem(valveMutex);
        tripHandled = true;
      } else {
        g_valveGuardTripReason.store(guardTrip);  // mutex ocupado: tenta de novo no proximo ciclo
      }
      if (tripHandled) {
        const char* tripReason = (guardTrip == VALVE_GUARD_TRIP_STALL) ? "valve_task_stall" : "failsafe_guard_timer";
        LOGE("[FAIL-SAFE][GUARD] Guarda independente fechou a valvula (motivo=%s, cmd=%s, total=%lu).",
             tripReason, tripCmd[0] ? tripCmd : "-", static_cast<unsigned long>(g_valveGuardTrips.load()));
        requestDeferredTelemetryAfterValve("valve_guard_off");
        if (tripCmd[0] != '\0') {
          enqueueAck(tripCmd, "failed", "off", 0, tripReason, "failsafe");
        }
      }
    }

    bool vStateSnapshot = false;
    uint32_t vOffSnapshot = 0;
    valveReadStateAtomic(vStateSnapshot, vOffSnapshot);

    bool liveRainConfirmed = false;

    if (vStateSnapshot) {
      uint32_t now = msNow();
      if (lastFastRainSampleMs == 0 || timeReached(now, lastFastRainSampleMs + VALVE_RAIN_SAMPLE_EVERY_MS)) {
        lastFastRainSampleMs = now;
        int fastRainRaw = 4095;
        int fastRainPct = 0;
        bool isWetSample = sampleRainSensorNow(fastRainRaw, fastRainPct);

        if (isWetSample) {
          if (rainWetStreak < 255) rainWetStreak++;
          if (rainWetStreak >= VALVE_RAIN_DEBOUNCE_SAMPLES) {
            liveRainConfirmed = true;
            if (lockSem(dataMutex, 10)) {
              g_latestData.rain_raw = fastRainRaw;
              g_latestData.rain_pct = fastRainPct;
              g_latestData.rain_detected = true;
              unlockSem(dataMutex);
            }
          }
        } else {
          rainWetStreak = 0;
          if (lockSem(dataMutex, 10)) {
            g_latestData.rain_raw = fastRainRaw;
            g_latestData.rain_pct = fastRainPct;
            g_latestData.rain_detected = false;
            unlockSem(dataMutex);
          }
        }
      }
    } else {
      rainWetStreak = 0;
      lastFastRainSampleMs = 0;
    }

    bool doAck = false;
    bool ackIsError = false;
    char ackCmd[48] = {0};
    const char* ackReason = nullptr;

    if (lockSem(valveMutex, 20)) {
      bool vState = false;
      uint32_t vOffMs = 0;
      valveReadStateAtomic(vState, vOffMs);

      if (vState) {
        uint32_t now = msNow();
        bool continuousCapReached = (g_valveContinuousOnStartMs != 0) &&
          timeReached(now, g_valveContinuousOnStartMs + (MAX_VALVE_DURATION_S * 1000UL));

        if (vOffMs == 0) {
          LOGE("[FAIL-SAFE] Válvula ON sem deadline! Forçando OFF.");
          if (g_activeCommandId[0] != '\0') safeCopy(ackCmd, sizeof(ackCmd), g_activeCommandId);
          g_activeCommandId[0] = '\0';
          valveSetOffLocked();
          doAck = true;
          ackIsError = true;
          ackReason = "failsafe_no_deadline";
        } else if (liveRainConfirmed) {
          LOGW("[INTERLOCK] Chuva detectada ao vivo durante a rega (debounce=%u)! Abortando irrigação.",
               static_cast<unsigned>(rainWetStreak));
          g_rainInterlocks++;
          rainWetStreak = 0;
          if (g_activeCommandId[0] != '\0') safeCopy(ackCmd, sizeof(ackCmd), g_activeCommandId);
          g_activeCommandId[0] = '\0';
          valveSetOffLocked();
          doAck = true;
          ackIsError = false;
          ackReason = "rain_interlock";
        } else if (timeReached(now, vOffMs) || continuousCapReached) {
          LOGI("[VALVULA] Tempo programado concluído! Desligando válvula.");
          if (g_activeCommandId[0] != '\0') safeCopy(ackCmd, sizeof(ackCmd), g_activeCommandId);
          g_activeCommandId[0] = '\0';
          valveSetOffLocked();
          doAck = true;
          ackIsError = false;
          ackReason = "duration_elapsed";
          g_brownoutStreakClearRequested.store(true);  // ciclo completo sem brownout
        } else if (timeReached(now, g_valveLastDebugMs + VALVE_DEBUG_EVERY_MS)) {
          uint32_t remaining = static_cast<uint32_t>(vOffMs - now);
          LOGI("[VALVULA] Regando... restante ~%lus", static_cast<unsigned long>(remaining / 1000UL));
          g_valveLastDebugMs = now;
        }
      }
      unlockSem(valveMutex);
    }

    if (doAck && ackCmd[0] != '\0') {
      enqueueAck(
        ackCmd,
        ackIsError ? "failed" : "done",
        "off",
        0,
        ackReason,
        ackIsError ? "failsafe" : nullptr
      );
    }

    vTaskDelay(pdMS_TO_TICKS(100));
  }
}
