/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/services/logger.cpp
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Implementação do sistema de log sincronizado e utilitários de string/hex.
 * ===================================================================================
 */
#include "services/logger.h"
#include "tasks/rtos_sync.h"
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

void logPrintFormatted(const char* level, const char* fmt, ...) {
  char msgBuf[384];
  va_list args;
  va_start(args, fmt);
  vsnprintf(msgBuf, sizeof(msgBuf), fmt, args);
  va_end(args);
  msgBuf[sizeof(msgBuf) - 1] = '\0';

  bool locked = false;
  if (logMutex != nullptr) {
    locked = (xSemaphoreTake(logMutex, pdMS_TO_TICKS(25)) == pdTRUE);
  }

  Serial.printf("[%10lu][%s] %s\n", static_cast<unsigned long>(msNow()), level, msgBuf);

  if (locked) {
    xSemaphoreGive(logMutex);
  }
}

void safeCopy(char* dst, size_t dstSz, const char* src) {
  if (!dst || dstSz == 0) return;
  if (!src) { dst[0] = '\0'; return; }
  strncpy(dst, src, dstSz - 1);
  dst[dstSz - 1] = '\0';
}

bool isValidSha256Hex(const char* hexStr) {
  if (!hexStr) return false;
  size_t len = strlen(hexStr);
  if (len != 64) return false;
  for (size_t i = 0; i < 64; i++) {
    char c = hexStr[i];
    bool isDigit = (c >= '0' && c <= '9');
    bool isLower = (c >= 'a' && c <= 'f');
    bool isUpper = (c >= 'A' && c <= 'F');
    if (!isDigit && !isLower && !isUpper) return false;
  }
  return true;
}

void bytesToHexLower(const uint8_t* bytes, size_t len, char* outHex, size_t outSz) {
  if (!outHex || outSz < (len * 2 + 1)) return;
  static const char hexChars[] = "0123456789abcdef";
  for (size_t i = 0; i < len; i++) {
    outHex[i * 2]     = hexChars[(bytes[i] >> 4) & 0x0F];
    outHex[i * 2 + 1] = hexChars[bytes[i] & 0x0F];
  }
  outHex[len * 2] = '\0';
}