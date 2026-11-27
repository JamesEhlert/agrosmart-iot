#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/hal/sensor_drivers.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Aquisição filtrada de sensores (ADC mediana + média aparada, chuva,
 *            AHTX0), último snapshot de telemetria e gatilhos de despertar.
 * ===================================================================================
 */
#include <Arduino.h>
#include <Adafruit_AHTX0.h>
#include <atomic>
#include <stdint.h>
#include "config/app_config.h"
#include "config/board_pins.h"
#include "config/system_types.h"

extern Adafruit_AHTX0 aht;
extern volatile bool g_ahtOk;

extern std::atomic<bool>     g_forceImmediateTelemetry;
extern std::atomic<uint32_t> g_deferredTelemetryWakeAtMs;

extern TelemetryData g_latestData;

/**
 * Solicita que a `taskSensors` interrompa seu ciclo de espera imediatamente (usado em `config`).
 */
void requestImmediateTelemetry(const char* reasonLabel);

/**
 * Solicita que a `taskSensors` colete um novo pacote de telemetria 2 segundos APÓS o
 * acionamento ou fechamento da válvula, preservando SPI e TLS livres para o envio do ACK.
 */
void requestDeferredTelemetryAfterValve(const char* reasonLabel);

/**
 * Filtro Digital de Mediana + Média Aparada (Trimmed Mean de 9 amostras) para ADC 12 bits.
 */
int readAdcFiltered(int pin);

/**
 * Realiza uma leitura filtrada imediata do sensor físico de chuva (PIN_CHUVA / ADC1)
 * e converte para porcentagem (0..100%) e flag booleana (> 50%).
 */
bool sampleRainSensorNow(int& rawOut, int& pctOut);