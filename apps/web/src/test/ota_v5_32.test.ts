/**
 * =====================================================================================
 * ARQUIVO: src/test/ota_v5_32.test.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 3 / Parte A — Testes OTA)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T22:10:00Z (UTC)
 * VERSÃO: v5.32.0
 * PROPÓSITO: Testes unitários dedicados da Fase 3 / Parte A (OTA-UT-01 a OTA-UT-08):
 *            compareSemver estrito, isPublishedOtaUpgradeEligible, parseDeviceFromFirestore
 *            (incluindo sig_alg inválido), formatFriendlyOtaError, translateEventReason
 *            (6 novos motivos), computeActiveOtaStep (assinatura e timeout de self-test),
 *            ausência do input livre no OtaExecutivePanel e sendOtaUpdateCommand sem s3_key.
 * =====================================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../shared/api/httpClient';
import { EnvConfig } from '../shared/config/env';
import { firebaseAuth } from '../shared/config/firebase';
import { compareSemver } from '../shared/lib/formatters';
import {
  computeActiveOtaStep,
  parseDeviceFromFirestore,
} from '../features/devices/model/device.schema';
import { translateEventReason } from '../features/events/model/event.types';
import {
  formatFriendlyOtaError,
  isPublishedOtaUpgradeEligible,
} from '../features/firmware-update/components/OtaExecutivePanel';
import { sendOtaUpdateCommand } from '../features/irrigation/api/commandApi';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Fase 3 / Parte A — OTA Anti-Downgrade e Assinatura (v5.32.0)', () => {
  it('OTA-UT-01: compareSemver deve comparar numericamente e rejeitar pré-releases ou strings malformadas', () => {
    expect(compareSemver('5.23.10', '5.23.9')).toBe(1);
    expect(compareSemver('5.23.9', '5.23.10')).toBe(-1);
    expect(compareSemver('5.24.0', '5.24.0')).toBe(0);
    expect(compareSemver('v5.24.0', '5.24.0')).toBe(0);
    expect(compareSemver('5.24.0-rc1', '5.23.2')).toBe(0);
    expect(compareSemver('5.24', '5.23.2')).toBe(0);
    expect(compareSemver('', '5.23.2')).toBe(0);
    expect(compareSemver(null, '5.23.2')).toBe(0);
    expect(compareSemver('5.24.0', null)).toBe(0);
  });

  it('OTA-UT-02: isPublishedOtaUpgradeEligible deve exigir currentFw conhecido e alvo estritamente maior', () => {
    expect(isPublishedOtaUpgradeEligible(null, '5.24.0')).toBe(false);
    expect(isPublishedOtaUpgradeEligible('5.24.0', '5.24.0')).toBe(false);
    expect(isPublishedOtaUpgradeEligible('5.24.0', '5.23.2')).toBe(false);
    expect(isPublishedOtaUpgradeEligible('5.23.9', '5.23.10')).toBe(true);
    expect(isPublishedOtaUpgradeEligible('5.23.2', '5.24.0-rc1')).toBe(false);
  });

  it('OTA-UT-03: parseDeviceFromFirestore exige connection.fw, lê sigAlg/signed e trata sig_alg inválido (número)', () => {
    const withoutFw = parseDeviceFromFirestore(
      {
        online: true,
        available_ota: {
          version: '5.24.0',
          sha256: 'a'.repeat(64),
          file_size: 950000,
          sig_alg: 'ecdsa-p256-sha256-v1',
          signed: true,
        },
      },
      'ESP32-AgroSmart-Station-V5',
    );
    expect(withoutFw.currentFw).toBeNull();
    expect(withoutFw.hasUpdateAvailable).toBe(false);
    expect(withoutFw.availableOta.sigAlg).toBe('ecdsa-p256-sha256-v1');
    expect(withoutFw.availableOta.signed).toBe(true);

    const withValidFw = parseDeviceFromFirestore(
      {
        online: true,
        connection: { fw: '5.23.2', part: 'app0' },
        available_ota: {
          version: '5.24.0',
          sha256: 'a'.repeat(64),
          file_size: 950000,
          sig_alg: 'ecdsa-p256-sha256-v1',
        },
      },
      'ESP32-AgroSmart-Station-V5',
    );
    expect(withValidFw.hasUpdateAvailable).toBe(true);
    expect(withValidFw.availableOta.sigAlg).toBe('ecdsa-p256-sha256-v1');
    expect(withValidFw.availableOta.signed).toBe(true);

    // sig_alg inválido (número) não deve lançar exceção e deve virar null
    const withInvalidSigAlg = parseDeviceFromFirestore(
      {
        online: true,
        connection: { fw: '5.23.2', part: 'app0' },
        available_ota: {
          version: '5.24.0',
          sha256: 'a'.repeat(64),
          sig_alg: 12345,
        },
      },
      'ESP32-AgroSmart-Station-V5',
    );
    expect(withInvalidSigAlg.availableOta.sigAlg).toBeNull();
    expect(withInvalidSigAlg.availableOta.signed).toBe(false);
  });

  it('OTA-UT-04: formatFriendlyOtaError deve tratar 409/403/400 e erro genérico usando ApiException real', () => {
    const errDowngrade = new ApiException(
      409,
      'Downgrade bloqueado',
      '{"reason":"ota_downgrade_blocked"}',
      'ota_downgrade_blocked',
      { reason: 'ota_downgrade_blocked' },
    );
    expect(formatFriendlyOtaError(errDowngrade)).toMatch(/versão anterior/i);

    const errSame = new ApiException(
      409,
      'Mesma versão',
      '{"reason":"ota_same_version"}',
      'ota_same_version',
      { reason: 'ota_same_version' },
    );
    expect(formatFriendlyOtaError(errSame)).toMatch(/já está executando/i);

    const errForbidden = new ApiException(403, 'Forbidden', '{"message":"Forbidden"}');
    expect(formatFriendlyOtaError(errForbidden)).toMatch(/exclusiva do administrador/i);

    const errSig400 = new ApiException(
      400,
      'Release sem assinatura válida. Publique com o comando de release.',
      '{"message":"Release sem assinatura válida."}',
    );
    expect(formatFriendlyOtaError(errSig400)).toMatch(/assinatura válida/i);

    const errGeneric = new Error('TypeError: internal stack trace xyz');
    const friendly = formatFriendlyOtaError(errGeneric);
    expect(friendly).toMatch(/falha de comunicação/i);
    expect(friendly).not.toContain('internal stack trace');
  });

  it('OTA-UT-05: translateEventReason deve traduzir os 6 novos motivos OTA em português', () => {
    expect(translateEventReason('ota_signature_invalid')).toBe(
      'Firmware recusado: assinatura digital inválida',
    );
    expect(translateEventReason('ota_signature_missing')).toBe(
      'Firmware recusado: release sem assinatura digital',
    );
    expect(translateEventReason('ota_downgrade_blocked')).toBe(
      'Atualização recusada: versão mais antiga bloqueada (anti-downgrade)',
    );
    expect(translateEventReason('ota_version_blocked')).toBe(
      'Versão bloqueada na estação após falha anterior',
    );
    expect(translateEventReason('ota_selftest_timeout')).toBe(
      'Nova versão não conectou à AWS no prazo; estação voltou à versão anterior',
    );
    expect(translateEventReason('ota_current_version_unknown')).toBe(
      'Versão atual da estação desconhecida; atualização não iniciada',
    );
  });

  it('OTA-UT-06: computeActiveOtaStep deve mapear assinatura inválida ao passo 2 e selftest timeout ao passo 4', () => {
    const baseOta = {
      inProgress: false,
      awaitingReboot: false,
      targetVersion: '5.24.0',
      previousVersion: '5.23.2',
      verifiedFw: null,
      error: null,
      lastCommandId: 'ota-err-1',
      updatedAt: new Date(),
    };

    expect(
      computeActiveOtaStep({
        otaStatus: { ...baseOta, status: 'failed', reason: 'ota_signature_invalid' },
      }),
    ).toEqual({ currentStep: 2, stateTone: 'error' });

    expect(
      computeActiveOtaStep({
        otaStatus: { ...baseOta, status: 'failed', reason: 'ota_signature_missing' },
      }),
    ).toEqual({ currentStep: 2, stateTone: 'error' });

    expect(
      computeActiveOtaStep({
        otaStatus: { ...baseOta, status: 'failed', reason: 'ota_selftest_timeout' },
      }),
    ).toEqual({ currentStep: 4, stateTone: 'error' });

    expect(
      computeActiveOtaStep({
        otaStatus: { ...baseOta, status: 'rolled_back', reason: 'ota_selftest_timeout' },
      }),
    ).toEqual({ currentStep: 4, stateTone: 'error' });
  });

  it('OTA-UT-07: OtaExecutivePanel não possui input livre de versão e usa o novo texto do passo 4', () => {
    const panelModules = import.meta.glob(
      '/src/features/firmware-update/components/OtaExecutivePanel.tsx',
      { query: '?raw', import: 'default', eager: true },
    ) as Record<string, string>;

    const sources = Object.values(panelModules);
    expect(sources).toHaveLength(1);
    const codeOnly = sources[0]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(codeOnly).not.toContain('ota-manual-semver');
    expect(codeOnly).not.toContain('manualVersion');
    expect(codeOnly).not.toContain('handleManualSubmit');
    expect(codeOnly).not.toContain('s3Key');
    expect(codeOnly).not.toContain('<input');
    expect(codeOnly).toContain('4. Self-Test e Auto-Rollback');
    expect(codeOnly).toContain(
      'Aprova a nova versão após 90 s contínuos conectada à AWS (prazo total de 10 min); se falhar, volta à versão anterior',
    );
  });

  it('OTA-UT-08: sendOtaUpdateCommand envia apenas action, version e sha256 (sem s3_key)', async () => {
    Object.defineProperty(firebaseAuth, 'currentUser', {
      get: () => ({
        uid: 'owner-uid-1',
        getIdToken: () => Promise.resolve('mock-owner-token'),
      }),
      configurable: true,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          command_id: 'ota-1763800000000-123456',
          version: '5.24.0',
          sha256: 'a'.repeat(64),
          file_size: 987654,
        }),
        { status: 200 },
      ),
    );

    await sendOtaUpdateCommand({
      deviceId: 'ESP32-AgroSmart-Station-V5',
      targetVersion: '5.24.0',
      sha256: 'a'.repeat(64),
      commandId: 'ota-1763800000000-123456',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(EnvConfig.aws.commandEndpoint);
    const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    expect(sent.action).toBe('ota');
    expect(sent.version).toBe('5.24.0');
    expect(sent.sha256).toBe('a'.repeat(64));
    expect('s3_key' in sent).toBe(false);
  });
});
