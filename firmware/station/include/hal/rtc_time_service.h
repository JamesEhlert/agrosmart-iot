#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/hal/rtc_time_service.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Serviço de relógio de tempo real (DS3231 I2C + fallback NTP POSIX) e
 *            gerador de timestamp estritamente monotônico para telemetria.
 * ===================================================================================
 */
#include <Arduino.h>
#include <RTClib.h>
#include <stdint.h>
#include "config/app_config.h"

extern RTC_DS3231 rtc;
extern volatile bool g_rtcOk;
extern volatile bool g_timeSynced;

extern uint32_t    g_lastTelemetryTs;
extern uint32_t    g_tsDirty;
extern const char* g_lastTsSource;

/**
 * Persiste o último timestamp de telemetria (`last_ts`) na Flash NVS.
 */
void persistLastTsIfNeeded(bool force, uint32_t tsToSave);

/**
 * Gera um timestamp estritamente monotônico EXCLUSIVO para pacotes de Telemetria.
 */
uint32_t normalizeTelemetryTimestamp(uint32_t candidateEpoch);

/**
 * Retorna a data/hora UTC atual (priorizando o DS3231 I2C e usando fallback POSIX NTP).
 */
DateTime getSystemTime();

/**
 * Retorna o horário Unix atual (em segundos UTC) sem efeitos colaterais.
 */
uint32_t epochNow();

/**
 * Dispara sincronização assíncrona NTP em background (`configTime`).
 */
void requestAsyncNTP();

/**
 * Verifica se a resposta NTP chegou e ajusta automaticamente o RTC físico DS3231.
 */
bool checkAsyncNTP();