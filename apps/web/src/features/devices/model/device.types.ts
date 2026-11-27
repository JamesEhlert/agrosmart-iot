/**
 * =====================================================================================
 * ARQUIVO: src/features/devices/model/device.types.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 3 / Parte A — Metadados OTA)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T22:00:00Z (UTC)
 * VERSÃO: v5.32.0
 * PROPÓSITO: Define as interfaces estritas do documento mestre `devices/{device_id}`
 *            (leitura exclusiva do titular) e da projeção sanitizada
 *            `devices/{device_id}/demo_view/current` (leitura da sessão Demo).
 * CHANGELOG:
 * - v5.32.0: Adiciona `sigAlg` e `signed` opcionais em `DeviceAvailableOta` para
 *            exibir o selo de firmware assinado no painel OTA.
 * - v5.30.0: Atualiza `MAX_DEMO_FAILED_ATTEMPTS = 30` e adiciona `lockedUntilEpoch`.
 * - v5.29.0: Adicionada interface `DeviceDemoSummary` (`devices/{id}.demo_summary`).
 * =====================================================================================
 */

export type SensorCapability = 'air' | 'soil' | 'light' | 'rain' | 'uv';

export const MAX_DEMO_FAILED_ATTEMPTS = 30;

/**
 * Resumo não-sensível do passe temporário em `devices/{id}.demo_summary` (visível apenas ao titular).
 * Credenciais reais (`token_hash` completo e `session_id`) ficam isoladas em `private/demo_auth`.
 */
export interface DeviceDemoSummary {
  active: boolean;
  tokenHint: string | null;
  tokenHashPrefix: string | null;
  expiresEpoch: number | null;
  passClaimed: boolean;
  failedAttempts: number;
  lockedBruteForce: boolean;
  lockedUntilEpoch: number;
  claimedAt: Date | null;
  updatedAt: Date | null;
}

/** Configurações operacionais e NVS em `devices/{id}.settings` (ou projeção sanitizada em `demo_view/current`). */
export interface DeviceSettings {
  deviceName: string;
  targetMoisture: number;
  manualDuration: number;
  timezoneOffset: number;
  latitude: number;
  longitude: number;
  enableWeatherControl: boolean;
  capabilities: SensorCapability[];
  telemetryIntervalMs: number;
  soilRawDry: number;
  soilRawWet: number;
  demoExpiresEpoch: number | null;
  demoPassClaimed?: boolean;
  /** @deprecated Migrado para `private/demo_auth` e `demo_summary` (v5.29.0). */
  demoToken?: string | null;
  /** @deprecated Migrado para `private/demo_auth` (v5.29.0). */
  demoTokenHash?: string | null;
  /** @deprecated Migrado para `demo_summary.tokenHint` (v5.29.0). */
  demoTokenHint?: string | null;
  /** @deprecated Migrado para `private/demo_auth` (v5.29.0). */
  demoSessionId?: string | null;
  /** @deprecated Migrado para `demo_summary.failedAttempts` (v5.29.0). */
  demoFailedAttempts?: number;
  /** @deprecated Migrado para `demo_summary.claimedAt` (v5.29.0). */
  demoClaimedAt?: Date | null;
}

/** Estado lógico e de reserva atual da válvula solenoide em `devices/{id}.state`. */
export interface DeviceState {
  valveOpen: boolean;
  valvePending?: boolean;
  reservationExpiresEpoch?: number | null;
  valveOrigin: string | null;
  currentCommandId: string | null;
  valveEndsAt: Date | null;
  confirmationSource?: string | null;
  executionEvidence?: string | null;
  reconciledCommandId?: string | null;
}

/** Estado em tempo real do motor de atualização OTA em `devices/{id}.ota_status`. */
export interface DeviceOtaStatus {
  inProgress: boolean;
  awaitingReboot: boolean;
  status: string | null;
  targetVersion: string | null;
  previousVersion: string | null;
  verifiedFw: string | null;
  reason: string | null;
  error: string | null;
  lastCommandId: string | null;
  originBootId?: string | null;
  updatedAt: Date | null;
}

/** Metadados de nova versão publicada no Amazon S3 em `devices/{id}.available_ota`. */
export interface DeviceAvailableOta {
  version: string | null;
  s3Key: string | null;
  sha256: string | null;
  fileSize: number | null;
  sigAlg?: string | null;
  signed?: boolean;
  releaseNotes: string | null;
  releasedAt: Date | null;
}

/** Modelo completo e reativo de uma estação ESP32 no AgroSmart V5. */
export interface DeviceModel {
  id: string;
  isOnline: boolean;
  settings: DeviceSettings;
  state: DeviceState;
  demoSummary: DeviceDemoSummary;
  currentFw: string | null;
  currentPartition: string | null;
  lastIp: string | null;
  bootCount: number | null;
  resetReason: string | null;
  otaStatus: DeviceOtaStatus;
  availableOta: DeviceAvailableOta;
  hasUpdateAvailable: boolean;
}
