/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/hal/sensor_drivers.cpp
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Implementação dos filtros ADC, amostragem rápida de chuva e gatilhos
 *            atômicos de despertar da taskSensors.
 * ===================================================================================
 */
#include "hal/sensor_drivers.h"
#include "services/logger.h"

Adafruit_AHTX0 aht;
volatile bool g_ahtOk = false;

std::atomic<bool>     g_forceImmediateTelemetry{false};
std::atomic<uint32_t> g_deferredTelemetryWakeAtMs{0};

TelemetryData g_latestData{};

void requestImmediateTelemetry(const char* reasonLabel) {
  g_forceImmediateTelemetry.store(true);
  LOGD("[SENSORS][WAKE] Coleta imediata solicitada (motivo=%s).", reasonLabel ? reasonLabel : "-");
}

void requestDeferredTelemetryAfterValve(const char* reasonLabel) {
  uint32_t wakeTarget = msNow() + POST_VALVE_TELEMETRY_DELAY_MS;
  if (wakeTarget == 0) wakeTarget = 1;
  g_deferredTelemetryWakeAtMs.store(wakeTarget);
  LOGD("[SENSORS][DEFER-WAKE] Coleta pós-válvula agendada para +%lums (motivo=%s).",
       static_cast<unsigned long>(POST_VALVE_TELEMETRY_DELAY_MS),
       reasonLabel ? reasonLabel : "-");
}

int readAdcFiltered(int pin) {
  constexpr int N = 9;
  int samples[N];
  for (int i = 1; i < N; i++) {
    samples[i] = analogRead(pin);
    delayMicroseconds(150);
  }
  samples[0] = analogRead(pin);
  for (int i = 1; i < N; i++) {
    int key = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > key) {
      samples[j + 1] = samples[j];
      j--;
    }
    samples[j + 1] = key;
  }
  return (samples[3] + samples[4] + samples[5]) / 3;
}

bool sampleRainSensorNow(int& rawOut, int& pctOut) {
  rawOut = readAdcFiltered(PIN_CHUVA);
  pctOut = constrain(map(rawOut, ADC_MAX_12BIT, RAIN_RAW_WET_LIMIT, 0, 100), 0, 100);
  return (pctOut > RAIN_THRESHOLD_PCT);
}