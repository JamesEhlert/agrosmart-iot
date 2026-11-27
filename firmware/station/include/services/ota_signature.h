#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/services/ota_signature.h
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Fase 3 / Parte B — v5.24.0)
 * REVISÃO: 2026-11-22 UTC
 * VERSÃO DO FIRMWARE: 5.24.0
 * PROPÓSITO: Parser estrito de SemVer (X.Y.Z) para anti-downgrade e verificador
 *            criptográfico ECDSA P-256 + SHA-256 (contrato v1) do manifesto OTA
 *            via mbedTLS embarcado (fail-closed, sem modo de bypass).
 * CHANGELOG 2026-11-22 (v5.24.0):
 * - Criação do módulo de assinatura OTA v1 e comparação SemVer estrita.
 * ===================================================================================
 */
#include <stdint.h>
#include <stddef.h>

/**
 * Converte versão SemVer estrita `^\d+\.\d+\.\d+$` (aceita prefixo opcional 'v'/'V')
 * para `out[3] = {major, minor, patch}` com cada componente <= 65535.
 * Rejeita pré-releases, espaços, sinais ou versões malformadas.
 */
bool otaParseSemverStrict(const char* v, uint16_t out[3]);

/**
 * Compara duas tuplas SemVer parseadas (`a` vs `b`).
 * Retorna 1 se a > b, -1 se a < b, 0 se iguais.
 */
int otaCompareSemver(const uint16_t a[3], const uint16_t b[3]);

/**
 * Verifica a assinatura ECDSA P-256 + SHA-256 (DER em base64 padrão, 8..72 bytes)
 * sobre o contrato ASCII canônico v1:
 *   agrosmart-ota-v1|agrosmart-v5-station|<X.Y.Z>|<sha256_lower>|<file_size>
 * Em caso de recusa, preenche `*outReason` com "ota_signature_missing" ou
 * "ota_signature_invalid". Fail-closed: não existe opção para aceitar OTA sem assinatura.
 */
bool otaVerifyManifestSignature(const char* version,
                                const char* sha256HexLower,
                                uint32_t fileSize,
                                const char* sigB64,
                                const char* sigAlg,
                                const char** outReason);
