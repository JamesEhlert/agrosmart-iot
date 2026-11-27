#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/services/logger.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Formatador atômico de logs seriais thread-safe (protegido por logMutex),
 *            macros LOGE/LOGW/LOGI/LOGD e utilitários seguros de strings/hexadecimal.
 * ===================================================================================
 */
#include <Arduino.h>
#include <stdint.h>
#include <stddef.h>
#include "config/app_config.h"

inline uint32_t msNow() {
  return static_cast<uint32_t>(millis());
}

/**
 * Formata e imprime uma linha completa de log na porta Serial de forma sincronizada
 * (protegida por `logMutex`), impedindo que mensagens simultâneas de diferentes tasks
 * do FreeRTOS se misturem na mesma linha.
 */
void logPrintFormatted(const char* level, const char* fmt, ...);

/**
 * Cópia segura de string C com garantia de terminação nula ('\0').
 */
void safeCopy(char* dst, size_t dstSz, const char* src);

/**
 * Verifica se uma string contém exatamente 64 caracteres hexadecimais válidos (SHA-256).
 */
bool isValidSha256Hex(const char* hexStr);

/**
 * Converte um array binário de bytes (ex.: 32 bytes SHA-256) para hexadecimal minúsculo.
 */
void bytesToHexLower(const uint8_t* bytes, size_t len, char* outHex, size_t outSz);

#define LOGE(fmt, ...) do { logPrintFormatted("ERR", (fmt), ##__VA_ARGS__); } while(0)
#define LOGW(fmt, ...) do { if (LOG_LEVEL >= 1) { logPrintFormatted("WRN", (fmt), ##__VA_ARGS__); } } while(0)
#define LOGI(fmt, ...) do { if (LOG_LEVEL >= 1) { logPrintFormatted("INF", (fmt), ##__VA_ARGS__); } } while(0)
#define LOGD(fmt, ...) do { if (LOG_LEVEL >= 2) { logPrintFormatted("DBG", (fmt), ##__VA_ARGS__); } } while(0)