/**
 * =====================================================================================
 * ARQUIVO: src/features/devices/model/device.schema.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 3 / Parte A — OTA Assinado)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T22:00:00Z (UTC)
 * VERSÃO: v5.32.0
 * PROPÓSITO: Schemas Zod para validação em runtime, desserialização resiliente dos
 *            documentos `devices/{device_id}` e `devices/{device_id}/demo_view/current`,
 *            e máquina de estados pura do Stepper OTA.
 * CHANGELOG:
 * - v5.33.0 (Fase 3C item 9, 2026-11-23 UTC): status `verifying` (observação de 90 s
 *   após o boot da nova versão) ativa a etapa 4 do Stepper OTA.
 * - v5.32.0:
 *   * Exige `currentFw` conhecido para `hasUpdateAvailable` (remove `!currentFw ||`),
 *     alinhado à regra anti-downgrade do backend v5.32.0.
 *   * Valida `available_ota.sig_alg` opcional com Zod e expõe `sigAlg` e `signed`.
 * - v5.30.0: Lê `demo_summary.locked_until_epoch` e deriva `lockedBruteForce` do tempo.
 * - v5.29.0: Desserialização de `demo_summary` e suporte transparente à `demo_view/current`.
 * =====================================================================================
 */

import { z } from 'zod';
import { compareSemver } from '../../../shared/lib/formatters';
import {
  DeviceAvailableOta,
  DeviceDemoSummary,
  DeviceModel,
  DeviceOtaStatus,
  DeviceSettings,
  DeviceState,
  SensorCapability,
} from './device.types';

/**
 * Schema Zod para validar edições de configurações operacionais antes de salvar no Firestore.
 */
export const deviceSettingsFormSchema = z
  .object({
    deviceName: z
      .string()
      .trim()
      .min(1, 'Informe um nome para a estação.')
      .max(60, 'O nome deve ter no máximo 60 caracteres.'),
    targetMoisture: z.number().min(0).max(100),
    manualDuration: z.number().int().min(1).max(15),
    timezoneOffset: z.number().int().min(-12).max(14),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    enableWeatherControl: z.boolean(),
    telemetryIntervalMs: z.number().int().min(10000).max(3600000),
    soilRawDry: z.number().int().min(100).max(4080),
    soilRawWet: z.number().int().min(100).max(4080),
  })
  .refine((data) => data.soilRawDry - data.soilRawWet >= 100, {
    message:
      'O valor ADC de Solo Seco deve ser pelo menos 100 unidades maior que o de Solo Molhado.',
    path: ['soilRawDry'],
  });

const availableOtaSigSchema = z.object({
  sig_alg: z.string().trim().min(1).max(64).optional().nullable(),
  signed: z.boolean().optional(),
});

function parseSafeNumber(val: unknown, fallback: number): number {
  if (val === undefined || val === null || typeof val === 'boolean') return fallback;
  if (typeof val === 'string' && !val.trim()) return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function parseSafeBool(val: unknown, fallback = false): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (clean === 'true' || clean === '1') return true;
    if (clean === 'false' || clean === '0') return false;
  }
  return fallback;
}

function parsePositiveEpoch(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    return Math.trunc(val);
  }
  return null;
}

function parseNonNegativeEpochInt(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val) && Number.isInteger(val) && val >= 0) {
    return val;
  }
  if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
    const parsed = Number(val.trim());
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

/**
 * Converte qualquer representação de data do Firestore (Timestamp, Date, ISO string ou Epoch) em `Date`.
 */
export function parseFirestoreDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof (value as { toDate: () => Date }).toDate === 'function'
  ) {
    const d = (value as { toDate: () => Date }).toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (typeof value === 'string') {
    const clean = value.trim();
    if (!clean) return null;
    const parsed = new Date(clean);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 100_000_000_000 ? value : value * 1000;
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

const DEFAULT_CAPABILITIES: SensorCapability[] = ['air', 'soil', 'light', 'rain', 'uv'];

/**
 * Desserializa um mapa vindo de `devices/{deviceId}` ou `devices/{deviceId}/demo_view/current`
 * em um objeto `DeviceModel` tipado e seguro contra nulos.
 */
export function parseDeviceFromFirestore(
  data: Record<string, unknown> | undefined,
  docId: string,
): DeviceModel {
  const root = data ?? {};
  const rawSettings = (root.settings as Record<string, unknown> | undefined) ?? {};
  const rawState = (root.state as Record<string, unknown> | undefined) ?? {};
  const rawConn = (root.connection as Record<string, unknown> | undefined) ?? {};
  const rawOta = (root.ota_status as Record<string, unknown> | undefined) ?? {};
  const rawAvailOta = (root.available_ota as Record<string, unknown> | undefined) ?? {};
  const rawDemoSummary = (root.demo_summary as Record<string, unknown> | undefined) ?? {};

  const capabilities: SensorCapability[] = Array.isArray(rawSettings.capabilities)
    ? (rawSettings.capabilities.filter((c) =>
        ['air', 'soil', 'light', 'rain', 'uv'].includes(String(c)),
      ) as SensorCapability[])
    : DEFAULT_CAPABILITIES;

  const rawTargetMoisture = parseSafeNumber(rawSettings.target_soil_moisture, 60);
  const rawManualDuration = parseSafeNumber(rawSettings.manual_valve_duration, 5);
  const rawTz = parseSafeNumber(rawSettings.timezone_offset, -3);

  const hasDemoSummaryMap = Object.keys(rawDemoSummary).length > 0;
  const legacyHash =
    typeof rawSettings.demo_token_hash === 'string' && rawSettings.demo_token_hash.trim()
      ? rawSettings.demo_token_hash.trim().toLowerCase()
      : null;

  const summaryExpiresEpoch =
    parsePositiveEpoch(rawDemoSummary.expires_epoch) ??
    parsePositiveEpoch(rawSettings.demo_expires_epoch);
  const summaryPassClaimed = hasDemoSummaryMap
    ? parseSafeBool(rawDemoSummary.pass_claimed, false)
    : parseSafeBool(rawSettings.demo_pass_claimed, false);
  const summaryFailedAttempts = Math.max(
    0,
    Math.trunc(
      parseSafeNumber(
        hasDemoSummaryMap ? rawDemoSummary.failed_attempts : rawSettings.demo_failed_attempts,
        0,
      ),
    ),
  );
  const summaryTokenHint =
    typeof rawDemoSummary.token_hint === 'string' && rawDemoSummary.token_hint.trim()
      ? rawDemoSummary.token_hint.trim().toUpperCase()
      : typeof rawSettings.demo_token_hint === 'string' && rawSettings.demo_token_hint.trim()
        ? rawSettings.demo_token_hint.trim().toUpperCase()
        : null;
  const summaryHashPrefix =
    typeof rawDemoSummary.token_hash_prefix === 'string' &&
    rawDemoSummary.token_hash_prefix.trim()
      ? rawDemoSummary.token_hash_prefix.trim().toLowerCase()
      : legacyHash
        ? legacyHash.slice(0, 16)
        : null;

  const hasLockedUntilField =
    hasDemoSummaryMap &&
    Object.prototype.hasOwnProperty.call(rawDemoSummary, 'locked_until_epoch') &&
    rawDemoSummary.locked_until_epoch !== undefined &&
    rawDemoSummary.locked_until_epoch !== null;

  const summaryLockedUntilEpoch = hasLockedUntilField
    ? parseNonNegativeEpochInt(rawDemoSummary.locked_until_epoch)
    : 0;

  // Quando `locked_until_epoch` existe, o bloqueio é derivado estritamente do relógio;
  // apenas em documentos legados sem o campo recorre ao booleano `locked_brute_force`.
  const summaryLockedBruteForce = hasLockedUntilField
    ? summaryLockedUntilEpoch * 1000 > Date.now()
    : hasDemoSummaryMap
      ? parseSafeBool(rawDemoSummary.locked_brute_force, false)
      : false;

  const demoSummary: DeviceDemoSummary = {
    active: hasDemoSummaryMap
      ? parseSafeBool(rawDemoSummary.active, false)
      : Boolean(summaryExpiresEpoch && (summaryTokenHint || legacyHash)),
    tokenHint: summaryTokenHint,
    tokenHashPrefix: summaryHashPrefix,
    expiresEpoch: summaryExpiresEpoch,
    passClaimed: summaryPassClaimed,
    failedAttempts: summaryFailedAttempts,
    lockedBruteForce: summaryLockedBruteForce,
    lockedUntilEpoch: summaryLockedUntilEpoch,
    claimedAt: parseFirestoreDate(
      hasDemoSummaryMap ? rawDemoSummary.claimed_at : rawSettings.demo_claimed_at,
    ),
    updatedAt: parseFirestoreDate(rawDemoSummary.updated_at),
  };

  const settings: DeviceSettings = {
    deviceName:
      typeof rawSettings.device_name === 'string' && rawSettings.device_name.trim()
        ? rawSettings.device_name.trim()
        : 'Estação Sem Nome',
    targetMoisture: Math.min(100, Math.max(0, rawTargetMoisture)),
    manualDuration: Math.min(15, Math.max(1, Math.trunc(rawManualDuration))),
    timezoneOffset: Math.min(14, Math.max(-12, Math.trunc(rawTz))),
    latitude: Math.min(90, Math.max(-90, parseSafeNumber(rawSettings.latitude, 0))),
    longitude: Math.min(180, Math.max(-180, parseSafeNumber(rawSettings.longitude, 0))),
    enableWeatherControl: parseSafeBool(rawSettings.enable_weather_control, false),
    capabilities: capabilities.length > 0 ? capabilities : DEFAULT_CAPABILITIES,
    telemetryIntervalMs: Math.min(
      3600000,
      Math.max(10000, Math.trunc(parseSafeNumber(rawSettings.telemetry_interval_ms, 30000))),
    ),
    soilRawDry: Math.min(
      4080,
      Math.max(100, Math.trunc(parseSafeNumber(rawSettings.soil_raw_dry, 3000))),
    ),
    soilRawWet: Math.min(
      4080,
      Math.max(100, Math.trunc(parseSafeNumber(rawSettings.soil_raw_wet, 1200))),
    ),
    demoExpiresEpoch:
      parsePositiveEpoch(rawSettings.demo_expires_epoch) ?? demoSummary.expiresEpoch,
    demoPassClaimed:
      rawSettings.demo_pass_claimed !== undefined
        ? parseSafeBool(rawSettings.demo_pass_claimed, false)
        : demoSummary.passClaimed,
    demoToken: null,
    demoTokenHash: legacyHash,
    demoTokenHint: demoSummary.tokenHint,
    demoSessionId:
      typeof rawSettings.demo_session_id === 'string' && rawSettings.demo_session_id.trim()
        ? rawSettings.demo_session_id.trim()
        : null,
    demoFailedAttempts: demoSummary.failedAttempts,
    demoClaimedAt: demoSummary.claimedAt,
  };

  const rawResExp = parseSafeNumber(rawState.reservation_expires_epoch, 0);

  const state: DeviceState = {
    valveOpen: parseSafeBool(rawState.valve_open, false),
    valvePending: parseSafeBool(rawState.valve_pending, false),
    reservationExpiresEpoch: rawResExp > 0 ? Math.trunc(rawResExp) : null,
    valveOrigin: typeof rawState.valve_origin === 'string' ? rawState.valve_origin : null,
    currentCommandId:
      typeof rawState.current_command_id === 'string' ? rawState.current_command_id : null,
    valveEndsAt: parseFirestoreDate(rawState.valve_ends_at),
    confirmationSource:
      typeof rawState.confirmation_source === 'string' ? rawState.confirmation_source : null,
    executionEvidence:
      typeof rawState.execution_evidence === 'string' ? rawState.execution_evidence : null,
    reconciledCommandId:
      typeof rawState.reconciled_command_id === 'string' ? rawState.reconciled_command_id : null,
  };

  const otaStatus: DeviceOtaStatus = {
    inProgress: parseSafeBool(rawOta.in_progress, false),
    awaitingReboot: parseSafeBool(rawOta.awaiting_reboot, false),
    status: typeof rawOta.status === 'string' ? rawOta.status : null,
    targetVersion: typeof rawOta.target_version === 'string' ? rawOta.target_version : null,
    previousVersion:
      typeof rawOta.previous_version === 'string' ? rawOta.previous_version : null,
    verifiedFw:
      typeof rawOta.verified_fw === 'string'
        ? rawOta.verified_fw
        : typeof rawOta.reported_fw === 'string'
          ? rawOta.reported_fw
          : null,
    reason: typeof rawOta.reason === 'string' ? rawOta.reason : null,
    error: typeof rawOta.error === 'string' ? rawOta.error : null,
    lastCommandId: typeof rawOta.last_command_id === 'string' ? rawOta.last_command_id : null,
    originBootId:
      typeof rawOta.origin_boot_id === 'string' && rawOta.origin_boot_id.trim()
        ? rawOta.origin_boot_id.trim()
        : null,
    updatedAt: parseFirestoreDate(rawOta.updated_at),
  };

  const cleanAvailVer =
    typeof rawAvailOta.version === 'string'
      ? rawAvailOta.version.trim().replace(/^[vV]/, '')
      : null;

  const parsedAvailSig = availableOtaSigSchema.safeParse(rawAvailOta);
  const parsedSigAlg =
    parsedAvailSig.success && parsedAvailSig.data.sig_alg
      ? parsedAvailSig.data.sig_alg
      : null;
  const parsedSigned =
    parsedAvailSig.success && typeof parsedAvailSig.data.signed === 'boolean'
      ? parsedAvailSig.data.signed
      : Boolean(parsedSigAlg);

  const availableOta: DeviceAvailableOta = {
    version: cleanAvailVer || null,
    s3Key: typeof rawAvailOta.s3_key === 'string' ? rawAvailOta.s3_key : null,
    sha256: typeof rawAvailOta.sha256 === 'string' ? rawAvailOta.sha256 : null,
    fileSize:
      typeof rawAvailOta.file_size === 'number' && Number.isFinite(rawAvailOta.file_size)
        ? rawAvailOta.file_size
        : null,
    sigAlg: parsedSigAlg,
    signed: parsedSigned,
    releaseNotes:
      typeof rawAvailOta.release_notes === 'string' ? rawAvailOta.release_notes : null,
    releasedAt: parseFirestoreDate(rawAvailOta.released_at),
  };

  const currentFw =
    typeof rawConn.fw === 'string' && rawConn.fw.trim()
      ? rawConn.fw.trim().replace(/^[vV]/, '')
      : null;
  const currentPartition =
    typeof rawConn.part === 'string' && rawConn.part.trim() ? rawConn.part.trim() : null;

  const hasUpdateAvailable = Boolean(
    availableOta.version &&
      currentFw &&
      compareSemver(availableOta.version, currentFw) > 0,
  );

  return {
    id: docId,
    isOnline: parseSafeBool(root.online, false),
    settings,
    state,
    demoSummary,
    currentFw,
    currentPartition,
    lastIp: typeof rawConn.ip === 'string' ? rawConn.ip : null,
    bootCount:
      typeof rawConn.boot_count === 'number' && Number.isFinite(rawConn.boot_count)
        ? Math.trunc(rawConn.boot_count)
        : null,
    resetReason: typeof rawConn.reset_reason === 'string' ? rawConn.reset_reason : null,
    otaStatus,
    availableOta,
    hasUpdateAvailable,
  };
}

/**
 * Calcula a etapa ativa (1..4) e o tom visual do Stepper de Atualização Remota OTA,
 * dando precedência aos estados em andamento sobre motivos de ciclos anteriores (OTA-1).
 */
export function computeActiveOtaStep(device: Pick<DeviceModel, 'otaStatus'>): {
  currentStep: number;
  stateTone: 'idle' | 'active' | 'success' | 'error';
} {
  const st = (device.otaStatus.status ?? '').trim().toLowerCase();
  const reason = (device.otaStatus.reason ?? '').trim().toLowerCase();

  if (st === 'publish_failed') {
    return { currentStep: 1, stateTone: 'error' };
  }

  // v5.33.0 (Fase 3C item 9): a nova versão já iniciou e está na observação de 90 s.
  if (st === 'verifying') {
    return { currentStep: 4, stateTone: 'active' };
  }

  if (device.otaStatus.awaitingReboot || st === 'rebooting') {
    return { currentStep: 3, stateTone: 'active' };
  }
  if (st === 'started') {
    return { currentStep: 2, stateTone: 'active' };
  }
  if (st === 'pending' || st === 'received' || device.otaStatus.inProgress) {
    return { currentStep: 1, stateTone: 'active' };
  }

  if (
    st === 'rolled_back' ||
    reason === 'ota_rollback' ||
    reason === 'ota_selftest_timeout'
  ) {
    return { currentStep: 4, stateTone: 'error' };
  }
  if (st === 'failed' || st === 'error') {
    if (reason === 'ota_selftest_timeout') {
      return { currentStep: 4, stateTone: 'error' };
    }
    if (
      reason === 'ota_http_failed' ||
      reason === 'ota_hash_mismatch' ||
      reason === 'ota_flash_error' ||
      reason === 'ota_signature_invalid' ||
      reason === 'ota_signature_missing'
    ) {
      return { currentStep: 2, stateTone: 'error' };
    }
    return { currentStep: 1, stateTone: 'error' };
  }

  if (st === 'done' && reason === 'ota_rebooting') {
    return { currentStep: 3, stateTone: 'active' };
  }
  if (st === 'verified_online' || reason === 'ota_updated') {
    return { currentStep: 4, stateTone: 'success' };
  }
  if (st === 'done' && reason === 'ota_same_version') {
    return { currentStep: 0, stateTone: 'idle' };
  }

  return { currentStep: 0, stateTone: 'idle' };
}
