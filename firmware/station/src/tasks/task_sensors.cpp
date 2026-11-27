/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/tasks/task_sensors.cpp
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Confiabilidade Offline (v5.23.2)
 * REVISÃO: 2026-11-21 UTC
 * PROPÓSITO: Implementação da taskSensors (AHTX0, solo capacitivo, chuva, luz, UV,
 *            preservação de cadência entre reboots e polling de despertar de 250ms).
 * CHANGELOG 2026-11-21 (v5.23.2):
 * - Preserva o tempo restante até a próxima coleta após reboot via `g_lastTelemetryTs`
 *   (evitando coletas extras que anulavam intervalos de 15/30 min em campo).
 * - Persiste `last_ts` na NVS a cada amostra quando `telemetry_interval_ms >= 5 min`
 *   para manter a cadência mesmo após queda repentina de energia.
 * - Ancora o início do ciclo (`cycleStartMs`) antes da leitura dos sensores,
 *   eliminando o desvio acumulado (+0,53s/amostra) na periodicidade.
 * ===================================================================================
 */
#include "tasks/task_sensors.h"
#include "config/app_config.h"
#include "config/board_pins.h"
#include "config/system_types.h"
#include "core/time_math.h"
#include "core/valve_controller.h"
#include "hal/nvs_store.h"
#include "hal/rtc_time_service.h"
#include "hal/sensor_drivers.h"
#include "services/diagnostics_service.h"
#include "services/logger.h"
#include "tasks/rtos_sync.h"
#include <WiFi.h>
#include <esp_task_wdt.h>
#include <math.h>

extern volatile bool g_wifiConnected;

static void waitRemainingCadenceOnBoot() {
  RuntimeConfig c = cfgGet();
  uint32_t intervalSec = c.telemetry_interval_ms / 1000UL;
  if (intervalSec < 10UL) return;

  uint32_t lastTs = 0;
  if (lockSem(tsMutex, 50)) {
    lastTs = g_lastTelemetryTs;
    unlockSem(tsMutex);
  }

  uint32_t nowEp = epochNow();
  if (!isValidEpoch(lastTs) || !isValidEpoch(nowEp) || nowEp < lastTs) {
    return;
  }

  uint32_t elapsedSec = nowEp - lastTs;
  if (elapsedSec >= intervalSec) {
    return;
  }

  uint32_t initialRemainingSec = intervalSec - elapsedSec;
  LOGI("[SENSORS][BOOT-CADENCE] Última coleta há %lus (intervalo=%lus). Aguardando %lus para preservar cadência pós-reboot...",
       static_cast<unsigned long>(elapsedSec),
       static_cast<unsigned long>(intervalSec),
       static_cast<unsigned long>(initialRemainingSec));

  uint32_t startWaitMs = msNow();
  uint32_t lastWdtFeedMs = startWaitMs;
  while (true) {
    uint32_t now = msNow();
    if (g_forceImmediateTelemetry.exchange(false)) {
      LOGI("[SENSORS][BOOT-CADENCE] Despertar imediato acionado durante espera pós-boot.");
      break;
    }

    uint32_t deferredTarget = g_deferredTelemetryWakeAtMs.load();
    if (deferredTarget != 0 && timeReached(now, deferredTarget)) {
      g_deferredTelemetryWakeAtMs.store(0);
      LOGI("[SENSORS][BOOT-CADENCE] Despertar pós-válvula acionado durante espera pós-boot.");
      break;
    }

    uint32_t latestIntervalSec = cfgGet().telemetry_interval_ms / 1000UL;
    uint32_t effectiveRemainingMs = (latestIntervalSec > elapsedSec)
      ? ((latestIntervalSec - elapsedSec) * 1000UL)
      : 0UL;

    uint32_t waitedMs = now - startWaitMs;
    if (waitedMs >= effectiveRemainingMs) break;

    uint32_t leftMs = effectiveRemainingMs - waitedMs;
    uint32_t stepMs = (leftMs > SENSOR_WAKE_POLL_MS) ? SENSOR_WAKE_POLL_MS : leftMs;
    vTaskDelay(pdMS_TO_TICKS(stepMs));

    if (timeReached(msNow(), lastWdtFeedMs + SENSOR_WDT_FEED_MS)) {
      lastWdtFeedMs = msNow();
#ifdef ESP32
      esp_task_wdt_reset();
#endif
    }
  }
}

void taskSensors(void* pvParameters) {
  (void)pvParameters;
#ifdef ESP32
  esp_task_wdt_add(NULL);
#endif

  waitRemainingCadenceOnBoot();

  for (;;) {
#ifdef ESP32
    esp_task_wdt_reset();
#endif

    // Ancora o instante de início ANTES da aquisição para evitar drift acumulado no período
    uint32_t cycleStartMs = msNow();

    g_forceImmediateTelemetry.store(false);
    g_deferredTelemetryWakeAtMs.store(0);

    RuntimeConfig c = cfgGet();
    TelemetryData data{};

    DateTime nowUTC = getSystemTime();
    data.timestamp = normalizeTelemetryTimestamp(nowUTC.unixtime());

    // Em intervalos longos (>= 5 min), salva last_ts na NVS a cada leitura para preservar cadência pós-apagão
    if (c.telemetry_interval_ms >= 300000UL && isValidEpoch(data.timestamp)) {
      persistLastTsIfNeeded(true, data.timestamp);
    }

    data.seq = ++g_telemetrySeq;
    g_seqDirty++;
    persistSeqIfNeeded(false);

    if (lockSem(i2cMutex, I2C_MUTEX_WAIT_MS)) {
      sensors_event_t h, t;
      if (g_ahtOk && aht.getEvent(&h, &t)) {
        data.air_temp = roundf(t.temperature * 100.0f) / 100.0f;
        data.air_hum = roundf(h.relative_humidity * 100.0f) / 100.0f;
      } else {
        if (aht.begin()) {
          g_ahtOk = true;
        } else {
          g_ahtOk = false;
        }
        data.air_temp = 0.0f;
        data.air_hum = 0.0f;
        g_sensorErrAHT++;
      }
      unlockSem(i2cMutex);
    }

    int rawSolo = readAdcFiltered(PIN_SOLO);
    data.soil_raw = rawSolo;
    data.soil_fault = (rawSolo < SOIL_RAW_MIN_VALID || rawSolo > SOIL_RAW_MAX_VALID);
    if (data.soil_fault) {
      LOGW("[SENSORS] Alerta físico no sensor de solo (raw=%d fora da faixa %d..%d)",
           rawSolo, SOIL_RAW_MIN_VALID, SOIL_RAW_MAX_VALID);
      data.soil_moisture = 0;
    } else {
      int dry = c.soil_raw_dry;
      int wet = c.soil_raw_wet;
      if ((dry - wet) < SOIL_CALIB_MIN_DELTA) { dry = 3000; wet = 1200; }
      data.soil_moisture = constrain(map(rawSolo, dry, wet, 0, 100), 0, 100);
    }

    int rawLuz = readAdcFiltered(PIN_LUZ);
    data.light_level = constrain(map(rawLuz, 0, ADC_MAX_12BIT, 0, 100), 0, 100);

    data.rain_detected = sampleRainSensorNow(data.rain_raw, data.rain_pct);

    long somaUV = 0;
    for (int i = 0; i < 16; i++) {
      somaUV += analogRead(PIN_UV);
      vTaskDelay(1);
    }
    float uv_raw = (((static_cast<float>(somaUV) / 16.0f) * ADC_VREF_VOLTS) / static_cast<float>(ADC_MAX_12BIT)) / UV_SENSOR_GAIN;
    if (uv_raw < UV_MIN_NOISE_FLOOR) uv_raw = 0.0f;
    data.uv_index = roundf(uv_raw * 100.0f) / 100.0f;

    bool valveOn = false;
    uint32_t offMs = 0;
    valveReadStateAtomic(valveOn, offMs);
    data.sampled_valve_state = valveOn ? 1 : 0;
    data.sampled_valve_rem_s = 0;
    if (valveOn && offMs != 0) {
      uint32_t now = msNow();
      if (!timeReached(now, offMs)) {
        data.sampled_valve_rem_s = static_cast<uint32_t>((offMs - now) / 1000UL);
      }
    }
    data.sampled_heap = static_cast<uint32_t>(esp_get_free_heap_size());
    data.sampled_wifi_conn = g_wifiConnected;
    data.sampled_rssi = g_wifiConnected ? WiFi.RSSI() : 0;

    LOGD("[SENSORS] seq=%lu ts=%lu temp=%.2fC hum=%.2f%% soil=%d%%(raw=%d fault=%d) luz=%d%% chuva=%d%%(raw=%d det=%d) uv=%.2f",
         static_cast<unsigned long>(data.seq), static_cast<unsigned long>(data.timestamp),
         data.air_temp, data.air_hum, data.soil_moisture, data.soil_raw, static_cast<int>(data.soil_fault),
         data.light_level, data.rain_pct, data.rain_raw, static_cast<int>(data.rain_detected), data.uv_index);

    if (lockSem(dataMutex, 100)) {
      g_latestData = data;
      unlockSem(dataMutex);
    }

    if (xQueueSend(sensorQueue, &data, 0) != pdPASS) {
      g_telemetryDropped++;
      LOGW("[SENSORS] Fila de memória cheia (dropped=%lu)! Descartando amostra mais antiga.",
           static_cast<unsigned long>(g_telemetryDropped.load()));
      TelemetryData dropped{};
      xQueueReceive(sensorQueue, &dropped, 0);
      xQueueSend(sensorQueue, &data, 0);
    }

    uint32_t lastWdtFeedMs = msNow();
    while (true) {
      uint32_t now = msNow();
      if (g_forceImmediateTelemetry.exchange(false)) {
        LOGI("[SENSORS] Despertar imediato acionado! Coletando nova amostra...");
        break;
      }

      uint32_t deferredTarget = g_deferredTelemetryWakeAtMs.load();
      if (deferredTarget != 0 && timeReached(now, deferredTarget)) {
        g_deferredTelemetryWakeAtMs.store(0);
        LOGI("[SENSORS] Despertar pós-válvula (2s) concluído! Coletando nova amostra...");
        break;
      }

      RuntimeConfig latestCfg = cfgGet();
      uint32_t targetIntervalMs = latestCfg.telemetry_interval_ms;
      uint32_t elapsedMs = now - cycleStartMs;
      if (elapsedMs >= targetIntervalMs) break;

      uint32_t remainingMs = targetIntervalMs - elapsedMs;
      uint32_t stepMs = (remainingMs > SENSOR_WAKE_POLL_MS) ? SENSOR_WAKE_POLL_MS : remainingMs;
      vTaskDelay(pdMS_TO_TICKS(stepMs));

      if (timeReached(msNow(), lastWdtFeedMs + SENSOR_WDT_FEED_MS)) {
        lastWdtFeedMs = msNow();
#ifdef ESP32
        esp_task_wdt_reset();
#endif
      }
    }
  }
}