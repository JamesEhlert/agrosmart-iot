/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/core/config_validator.cpp
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Implementação das regras de validação de configuração e calibração ADC.
 * ===================================================================================
 */
#include "core/config_validator.h"

bool isValidTelemetryIntervalMs(uint32_t intervalMs) {
  return (intervalMs >= MIN_TELEMETRY_INTERVAL_MS && intervalMs <= MAX_TELEMETRY_INTERVAL_MS);
}

bool isValidSoilCalibrationAtBoot(int dry, int wet) {
  return ((dry - wet) >= SOIL_CALIB_MIN_DELTA && dry <= ADC_MAX_12BIT && wet >= 0);
}

bool isValidSoilCalibrationCommand(int dry, int wet) {
  return ((dry - wet) >= SOIL_CALIB_MIN_DELTA &&
          dry <= SOIL_RAW_MAX_VALID &&
          wet >= SOIL_RAW_MIN_VALID);
}