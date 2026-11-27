#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/core/config_validator.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Funções puras de validação de parâmetros operacionais e calibração ADC.
 * ===================================================================================
 */
#include <stdint.h>
#include "config/app_config.h"
#include "config/system_types.h"

/**
 * Verifica se o intervalo de telemetria está entre 10s (10.000ms) e 1h (3.600.000ms).
 */
bool isValidTelemetryIntervalMs(uint32_t intervalMs);

/**
 * Valida a calibração de solo carregada do NVS durante o boot.
 */
bool isValidSoilCalibrationAtBoot(int dry, int wet);

/**
 * Valida a calibração de solo recebida via comando MQTT `config`.
 */
bool isValidSoilCalibrationCommand(int dry, int wet);