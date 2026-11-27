/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/services/ota_signature.cpp
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Fase 3 / Parte B — v5.24.0)
 * REVISÃO: 2026-11-22 UTC
 * VERSÃO DO FIRMWARE: 5.24.0
 * PROPÓSITO: Implementação do parser SemVer estrito e da verificação criptográfica
 *            ECDSA P-256 + SHA-256 (contrato v1) usando mbedTLS do ESP-IDF 4.4 /
 *            Arduino ESP32 2.0.17. Fail-closed: toda ausência ou divergência rejeita.
 * CHANGELOG 2026-11-22 (v5.24.0):
 * - Criação do verificador de assinatura de manifesto OTA (contrato v1).
 * ===================================================================================
 */
#include "services/ota_signature.h"
#include "config/ota_signing_pubkey.h"
#include "services/logger.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include <mbedtls/base64.h>
#include <mbedtls/md.h>
#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>

namespace {
constexpr const char* kOtaSigAlgV1      = "ecdsa-p256-sha256-v1";
constexpr const char* kOtaSigContextV1  = "agrosmart-ota-v1";
constexpr const char* kOtaSigClassV1    = "agrosmart-v5-station";
constexpr size_t      kMinDerSigBytes   = 8;
constexpr size_t      kMaxDerSigBytes   = 72;
constexpr size_t      kMaxB64SigLen     = 103;

inline void setReason(const char** outReason, const char* value) {
  if (outReason != nullptr) {
    *outReason = value;
  }
}

inline bool isHex64(const char* s) {
  if (s == nullptr) return false;
  for (size_t i = 0; i < 64; i++) {
    const char c = s[i];
    const bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    if (!ok) return false;
  }
  return s[64] == '\0';
}
} // namespace

bool otaParseSemverStrict(const char* v, uint16_t out[3]) {
  if (!v || !out) return false;

  const char* p = v;
  if (*p == 'v' || *p == 'V') {
    p++;
  }
  if (*p == '\0') return false;

  uint16_t parsed[3] = {0, 0, 0};

  for (int part = 0; part < 3; part++) {
    if (*p < '0' || *p > '9') return false;
    uint32_t acc = 0;
    while (*p >= '0' && *p <= '9') {
      acc = (acc * 10UL) + static_cast<uint32_t>(*p - '0');
      if (acc > 65535UL) return false;
      p++;
    }
    parsed[part] = static_cast<uint16_t>(acc);

    if (part < 2) {
      if (*p != '.') return false;
      p++;
    }
  }

  // Rejeita qualquer sufixo (pré-release, espaço, 4o segmento, etc.)
  if (*p != '\0') return false;

  out[0] = parsed[0];
  out[1] = parsed[1];
  out[2] = parsed[2];
  return true;
}

int otaCompareSemver(const uint16_t a[3], const uint16_t b[3]) {
  for (int i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

bool otaVerifyManifestSignature(const char* version,
                                const char* sha256HexLower,
                                uint32_t fileSize,
                                const char* sigB64,
                                const char* sigAlg,
                                const char** outReason) {
  setReason(outReason, "ota_signature_invalid");

  if (!sigB64 || sigB64[0] == '\0' || !sigAlg || sigAlg[0] == '\0') {
    setReason(outReason, "ota_signature_missing");
    LOGW("[OTA][SIG] Assinatura ou algoritmo ausentes (key_id=%s).", OTA_SIGNING_KEY_ID);
    return false;
  }

  if (strcmp(sigAlg, kOtaSigAlgV1) != 0) {
    setReason(outReason, "ota_signature_invalid");
    LOGW("[OTA][SIG] Algoritmo de assinatura não suportado (alg=%s key_id=%s).",
         sigAlg, OTA_SIGNING_KEY_ID);
    return false;
  }

  uint16_t verParts[3] = {0, 0, 0};
  if (!otaParseSemverStrict(version, verParts) || fileSize == 0 || !isHex64(sha256HexLower)) {
    setReason(outReason, "ota_signature_invalid");
    LOGW("[OTA][SIG] Parâmetros do manifesto inválidos para verificação (key_id=%s).",
         OTA_SIGNING_KEY_ID);
    return false;
  }

  const char* cleanVer = (version[0] == 'v' || version[0] == 'V') ? (version + 1) : version;

  // Normaliza SHA-256 para hexadecimal minúsculo conforme contrato v1
  char shaLower[65] = {0};
  for (size_t i = 0; i < 64; i++) {
    shaLower[i] = static_cast<char>(tolower(static_cast<unsigned char>(sha256HexLower[i])));
  }
  shaLower[64] = '\0';

  const size_t sigB64Len = strlen(sigB64);
  if (sigB64Len == 0 || sigB64Len > kMaxB64SigLen || (sigB64Len % 4) != 0) {
    setReason(outReason, "ota_signature_invalid");
    LOGW("[OTA][SIG] Base64 da assinatura com tamanho inválido (len=%u key_id=%s).",
         static_cast<unsigned>(sigB64Len), OTA_SIGNING_KEY_ID);
    return false;
  }

  unsigned char sigDer[80] = {0};
  size_t sigDerLen = 0;
  int b64Rc = mbedtls_base64_decode(
      sigDer,
      sizeof(sigDer),
      &sigDerLen,
      reinterpret_cast<const unsigned char*>(sigB64),
      sigB64Len);

  if (b64Rc != 0 || sigDerLen < kMinDerSigBytes || sigDerLen > kMaxDerSigBytes) {
    setReason(outReason, "ota_signature_invalid");
    LOGW("[OTA][SIG] Falha ao decodificar assinatura base64/DER (rc=%d der_len=%u key_id=%s).",
         b64Rc, static_cast<unsigned>(sigDerLen), OTA_SIGNING_KEY_ID);
    return false;
  }

  // Monta mensagem ASCII canônica v1 (sem '\n' no final)
  char canonicalMsg[192] = {0};
  int msgLen = snprintf(
      canonicalMsg,
      sizeof(canonicalMsg),
      "%s|%s|%s|%s|%lu",
      kOtaSigContextV1,
      kOtaSigClassV1,
      cleanVer,
      shaLower,
      static_cast<unsigned long>(fileSize));

  if (msgLen <= 0 || static_cast<size_t>(msgLen) >= sizeof(canonicalMsg)) {
    setReason(outReason, "ota_signature_invalid");
    LOGE("[OTA][SIG] Erro ao formatar mensagem canônica do manifesto.");
    return false;
  }

  unsigned char msgHash[32] = {0};
  mbedtls_sha256_context shaCtx;
  mbedtls_sha256_init(&shaCtx);
  int shaRc = mbedtls_sha256_starts_ret(&shaCtx, 0);
  if (shaRc == 0) {
    shaRc = mbedtls_sha256_update_ret(
        &shaCtx,
        reinterpret_cast<const unsigned char*>(canonicalMsg),
        static_cast<size_t>(msgLen));
  }
  if (shaRc == 0) {
    shaRc = mbedtls_sha256_finish_ret(&shaCtx, msgHash);
  }
  mbedtls_sha256_free(&shaCtx);

  if (shaRc != 0) {
    setReason(outReason, "ota_signature_invalid");
    LOGE("[OTA][SIG] Falha no cálculo SHA-256 do manifesto (rc=%d).", shaRc);
    return false;
  }

  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);

  bool verified = false;
  int pkRc = mbedtls_pk_parse_public_key(
      &pk,
      reinterpret_cast<const unsigned char*>(OTA_SIGNING_PUBKEY_PEM),
      strlen(OTA_SIGNING_PUBKEY_PEM) + 1);

  if (pkRc != 0) {
    LOGE("[OTA][SIG] Falha ao carregar chave pública embarcada (rc=-0x%04X key_id=%s).",
         static_cast<unsigned>(-pkRc), OTA_SIGNING_KEY_ID);
  } else if (!mbedtls_pk_can_do(&pk, MBEDTLS_PK_ECKEY)) {
    LOGE("[OTA][SIG] Chave pública embarcada não é ECKEY (key_id=%s).", OTA_SIGNING_KEY_ID);
  } else {
    int verRc = mbedtls_pk_verify(
        &pk,
        MBEDTLS_MD_SHA256,
        msgHash,
        sizeof(msgHash),
        sigDer,
        sigDerLen);
    if (verRc == 0) {
      verified = true;
    } else {
      LOGW("[OTA][SIG] Assinatura ECDSA P-256 rejeitada (rc=-0x%04X ver=%s sha=%.12s sig_len=%u key_id=%s).",
           static_cast<unsigned>(-verRc),
           cleanVer,
           shaLower,
           static_cast<unsigned>(sigDerLen),
           OTA_SIGNING_KEY_ID);
    }
  }

  mbedtls_pk_free(&pk);

  if (!verified) {
    setReason(outReason, "ota_signature_invalid");
    return false;
  }

  setReason(outReason, nullptr);
  LOGI("[OTA][SIG] Assinatura ECDSA P-256 válida (ver=%s sha=%.12s sig_len=%u key_id=%s).",
       cleanVer, shaLower, static_cast<unsigned>(sigDerLen), OTA_SIGNING_KEY_ID);
  return true;
}
