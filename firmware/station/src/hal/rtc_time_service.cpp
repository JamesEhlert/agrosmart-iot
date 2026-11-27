/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/hal/rtc_time_service.cpp
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Confiabilidade Offline (v5.23.2)
 * REVISÃO: 2026-11-21 UTC
 * PROPÓSITO: Implementação do driver DS3231 protegido por i2cMutex, sincronismo NTP
 *            e normalização monotônica de timestamps.
 * CHANGELOG 2026-11-21 (v5.23.2):
 * - Adiciona guarda explícita de ano (`2020..2037`) em `getSystemTime()` e
 *   `checkAsyncNTP()`, rejeitando leituras I2C espúrias (ex.: ano 2106).
 * ===================================================================================
 */
#include "hal/rtc_time_service.h"
#include "core/time_math.h"
#include "tasks/rtos_sync.h"
#include "services/logger.h"
#include <Preferences.h>
#include <time.h>

RTC_DS3231 rtc;
volatile bool g_rtcOk      = false;
volatile bool g_timeSynced = false;

uint32_t    g_lastTelemetryTs = 0;
uint32_t    g_tsDirty         = 0;
const char* g_lastTsSource    = "rtc";

void persistLastTsIfNeeded(bool force, uint32_t tsToSave) {
  if (!force) return;
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  p.putUInt(K_LAST_TS, tsToSave);
  p.end();
  LOGD("[NVS] last_ts=%lu persistido na Flash.", static_cast<unsigned long>(tsToSave));
}

uint32_t normalizeTelemetryTimestamp(uint32_t candidateEpoch) {
  uint32_t ts = candidateEpoch;
  bool shouldPersistNVS = false;

  if (lockSem(tsMutex, 50)) {
    if (isValidEpoch(ts)) {
      if (g_timeSynced && g_lastTelemetryTs > (ts + 3600UL)) {
        LOGW("[TIME][SELF-HEAL] last_ts estava adiantado em relação ao NTP (%lu > %lu). Realinhando.",
             static_cast<unsigned long>(g_lastTelemetryTs), static_cast<unsigned long>(ts));
        g_lastTelemetryTs = ts;
        g_lastTsSource = g_rtcOk ? "rtc" : "ntp_posix";
        shouldPersistNVS = true;
      } else if (ts <= g_lastTelemetryTs) {
        g_lastTsSource = "rtc_adjusted";
        ts = g_lastTelemetryTs + 1;
      } else {
        g_lastTsSource = g_rtcOk ? "rtc" : "ntp_posix";
      }
    } else {
      uint32_t approx = FALLBACK_EPOCH_BASE + static_cast<uint32_t>(msNow() / 1000UL);
      ts = approx;
      g_lastTsSource = "approx";
      if (ts <= g_lastTelemetryTs) {
        ts = g_lastTelemetryTs + 1;
      }
    }

    g_lastTelemetryTs = ts;
    g_tsDirty++;
    if (g_tsDirty >= TS_PERSIST_EVERY) {
      g_tsDirty = 0;
      shouldPersistNVS = true;
    }
    unlockSem(tsMutex);
  }

  if (shouldPersistNVS) {
    persistLastTsIfNeeded(true, ts);
  }
  return ts;
}

DateTime getSystemTime() {
  if (g_rtcOk && lockSem(i2cMutex, I2C_MUTEX_WAIT_MS)) {
    DateTime now = rtc.now();
    unlockSem(i2cMutex);
    uint32_t u = now.unixtime();
    if (now.year() >= 2020 && now.year() < 2038 && isValidEpoch(u)) {
      return now;
    }
  }

  time_t posixNow = time(nullptr);
  if (posixNow > 0 && isValidEpoch(static_cast<uint32_t>(posixNow))) {
    return DateTime(static_cast<uint32_t>(posixNow));
  }

  return DateTime(static_cast<uint32_t>(0));
}

uint32_t epochNow() {
  DateTime nowUTC = getSystemTime();
  uint32_t unixSec = nowUTC.unixtime();
  if (isValidEpoch(unixSec)) {
    return unixSec;
  }

  time_t posixNow = time(nullptr);
  if (posixNow > 0 && isValidEpoch(static_cast<uint32_t>(posixNow))) {
    return static_cast<uint32_t>(posixNow);
  }

  uint32_t lastSnap = 0;
  if (lockSem(tsMutex, 15)) {
    lastSnap = g_lastTelemetryTs;
    unlockSem(tsMutex);
  }
  if (isValidEpoch(lastSnap)) {
    return lastSnap;
  }

  return FALLBACK_EPOCH_BASE + static_cast<uint32_t>(msNow() / 1000UL);
}

void requestAsyncNTP() {
  LOGI("[TIME] Solicitando sincronização NTP em background (%s)...", NTP_SERVER);
  configTime(0, 0, NTP_SERVER);
}

bool checkAsyncNTP() {
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 10)) {
    int year = timeinfo.tm_year + 1900;
    if (year >= 2020 && year < 2038) {
      if (g_rtcOk && lockSem(i2cMutex, I2C_MUTEX_WAIT_MS)) {
        rtc.adjust(DateTime(year, timeinfo.tm_mon + 1, timeinfo.tm_mday,
                            timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec));
        unlockSem(i2cMutex);
      }
      g_timeSynced = true;
      LOGI("[TIME] Hora sincronizada via NTP com sucesso (%04d-%02d-%02d %02d:%02d:%02d UTC).",
           year, timeinfo.tm_mon + 1, timeinfo.tm_mday,
           timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
      return true;
    }
  }
  return false;
}