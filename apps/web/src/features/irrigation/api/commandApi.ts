// ACK web correction v1: correlated server result; unknown outcome is preserved.
/**
 * =====================================================================================
 * ARQUIVO: src/features/irrigation/api/commandApi.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1 — F1.4)
 * DATA DE ATUALIZAÇÃO: 2026-11-21T02:30:00Z (UTC)
 * VERSÃO: v5.29.0 (ACK Web v1 + Geracao/Revogacao de Passe Demo via Backend AWS)
 * PROPÓSITO: Serviço unificado de envio de comandos (`POST /command`), administração
 *            Zero-Trust de passes Demo (exclusivo do titular) e escuta reativa do ACK
 *            no Firestore com rastreamento detalhado em UTC (diagnostics.ts).
 * =====================================================================================
 */

import { doc, onSnapshot } from 'firebase/firestore';
import { awsAuthenticatedFetch } from '../../../shared/api/httpClient';
import { EnvConfig } from '../../../shared/config/env';
import { firestoreDb } from '../../../shared/config/firebase';
import { logWebDiagnostic } from '../../../shared/lib/diagnostics';
import { parseFirestoreDate } from '../../devices/model/device.schema';
import {
  AckLifecycleStatus,
  CommandAckEvent,
  SendCommandResponse,
} from '../model/command.types';

export interface GenerateDemoPassResponse {
  ok: true;
  deviceId: string;
  plainCode: string;
  tokenHint: string;
  tokenHashPrefix: string;
  expiresEpoch: number;
  oldDemoSchedulesPaused: number;
  message: string;
}

export interface RevokeDemoPassResponse {
  ok: true;
  deviceId: string;
  oldDemoSchedulesPaused: number;
  message: string;
}

export function generateClientCommandId(prefix: 'app' | 'cfg' | 'ota' = 'app'): string {
  const ms = Date.now();
  let randNum = Math.floor(Math.random() * 1_000_000);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    randNum = buf[0] % 1_000_000;
  }
  const rand = randNum.toString().padStart(6, '0');
  return `${prefix}-${ms}-${rand}`;
}

function parseCommandErrorField(rawError: unknown): string | null {
  if (typeof rawError === 'string' && rawError.trim()) {
    return rawError.trim();
  }
  if (typeof rawError === 'object' && rawError !== null) {
    const errObj = rawError as Record<string, unknown>;
    if (typeof errObj.message === 'string' && errObj.message.trim()) {
      return errObj.message.trim();
    }
    if (typeof errObj.type === 'string' && errObj.type.trim()) {
      return errObj.type.trim();
    }
  }
  return null;
}

/**
 * Solicita ao backend AWS (`SendCommand`) a geração criptográfica de um novo passe de
 * uso único (`AGRO-XXXX-XXXX`), gravado exclusivamente em `private/demo_auth` (F1.4).
 */
export async function generateDemoPassOnServer(params: {
  deviceId: string;
  durationMinutes: number;
  signal?: AbortSignal;
}): Promise<GenerateDemoPassResponse> {
  logWebDiagnostic('INFO', 'demo_pass.generate.intent', {
    device_id: params.deviceId,
    duration_minutes: Math.trunc(params.durationMinutes),
  });

  const raw = await awsAuthenticatedFetch<Record<string, unknown>>(
    EnvConfig.aws.commandEndpoint,
    {
      method: 'POST',
      signal: params.signal,
      body: {
        device_id: params.deviceId,
        action: 'generate_demo_pass',
        duration_minutes: Math.trunc(params.durationMinutes),
      },
    },
  );

  const plainCode = typeof raw.plain_code === 'string' ? raw.plain_code.trim() : '';
  const expiresEpoch = typeof raw.expires_epoch === 'number' ? raw.expires_epoch : 0;
  if (!plainCode || expiresEpoch <= 0) {
    throw new Error('Resposta incompleta do servidor ao gerar passe temporário.');
  }

  logWebDiagnostic('INFO', 'demo_pass.generate.success', {
    device_id: params.deviceId,
    token_hint: raw.token_hint ?? null,
    expires_epoch: expiresEpoch,
    old_demo_schedules_paused: raw.old_demo_schedules_paused ?? 0,
  });

  return {
    ok: true,
    deviceId: typeof raw.device_id === 'string' ? raw.device_id : params.deviceId,
    plainCode,
    tokenHint: typeof raw.token_hint === 'string' ? raw.token_hint : 'AGRO-****-****',
    tokenHashPrefix: typeof raw.token_hash_prefix === 'string' ? raw.token_hash_prefix : '',
    expiresEpoch,
    oldDemoSchedulesPaused:
      typeof raw.old_demo_schedules_paused === 'number' ? raw.old_demo_schedules_paused : 0,
    message:
      typeof raw.message === 'string'
        ? raw.message
        : 'Passe temporário gerado com sucesso no servidor.',
  };
}

/**
 * Solicita ao backend AWS (`SendCommand`) a revogação imediata do passe e sessão Demo
 * ativa em `private/demo_auth`, derrubando clientes conectados em tempo real (F1.4).
 */
export async function revokeDemoPassOnServer(params: {
  deviceId: string;
  signal?: AbortSignal;
}): Promise<RevokeDemoPassResponse> {
  logWebDiagnostic('INFO', 'demo_pass.revoke.intent', {
    device_id: params.deviceId,
  });

  const raw = await awsAuthenticatedFetch<Record<string, unknown>>(
    EnvConfig.aws.commandEndpoint,
    {
      method: 'POST',
      signal: params.signal,
      body: {
        device_id: params.deviceId,
        action: 'revoke_demo_pass',
      },
    },
  );

  logWebDiagnostic('INFO', 'demo_pass.revoke.success', {
    device_id: params.deviceId,
    old_demo_schedules_paused: raw.old_demo_schedules_paused ?? 0,
  });

  return {
    ok: true,
    deviceId: typeof raw.device_id === 'string' ? raw.device_id : params.deviceId,
    oldDemoSchedulesPaused:
      typeof raw.old_demo_schedules_paused === 'number' ? raw.old_demo_schedules_paused : 0,
    message:
      typeof raw.message === 'string'
        ? raw.message
        : 'Acesso de Usuário Teste revogado imediatamente no servidor.',
  };
}

export async function sendValveCommand(params: {
  deviceId: string;
  action: 'on' | 'off';
  durationSeconds: number;
  commandId?: string;
  signal?: AbortSignal;
}): Promise<SendCommandResponse> {
  const cmdId = params.commandId || generateClientCommandId('app');
  const effectiveDuration = params.action === 'on' ? params.durationSeconds : 0;

  logWebDiagnostic('INFO', 'command.send.valve_intent', {
    device_id: params.deviceId,
    command_id: cmdId,
    action: params.action,
    duration_s: effectiveDuration,
  });

  const raw = await awsAuthenticatedFetch<Record<string, unknown>>(
    EnvConfig.aws.commandEndpoint,
    {
      method: 'POST',
      signal: params.signal,
      body: {
        device_id: params.deviceId,
        action: params.action,
        duration: effectiveDuration,
        command_id: cmdId,
      },
    },
  );

  const resolvedCmdId =
    typeof raw.command_id === 'string' && raw.command_id ? raw.command_id : cmdId;

  logWebDiagnostic('INFO', 'command.send.valve_accepted_http', {
    device_id: params.deviceId,
    command_id: resolvedCmdId,
    action: params.action,
    duration_s: effectiveDuration,
    cancel_command_id: raw.cancel_command_id ?? null,
    expires_at: raw.expires_at,
  });

  return {
    ok: true,
    commandId: resolvedCmdId,
    message:
      typeof raw.message === 'string' ? raw.message : 'Comando enviado com sucesso.',
    expiresAt: typeof raw.expires_at === 'number' ? raw.expires_at : undefined,
  };
}

export async function sendHardwareConfigCommand(params: {
  deviceId: string;
  telemetryIntervalMs: number;
  soilRawDry: number;
  soilRawWet: number;
  commandId?: string;
  signal?: AbortSignal;
}): Promise<SendCommandResponse> {
  const cmdId = params.commandId || generateClientCommandId('cfg');

  logWebDiagnostic('INFO', 'command.send.config_intent', {
    device_id: params.deviceId,
    command_id: cmdId,
    telemetry_interval_ms: Math.trunc(params.telemetryIntervalMs),
    soil_raw_dry: Math.trunc(params.soilRawDry),
    soil_raw_wet: Math.trunc(params.soilRawWet),
  });

  const raw = await awsAuthenticatedFetch<Record<string, unknown>>(
    EnvConfig.aws.commandEndpoint,
    {
      method: 'POST',
      signal: params.signal,
      body: {
        device_id: params.deviceId,
        action: 'config',
        duration: 0,
        command_id: cmdId,
        telemetry_interval_ms: Math.trunc(params.telemetryIntervalMs),
        soil_raw_dry: Math.trunc(params.soilRawDry),
        soil_raw_wet: Math.trunc(params.soilRawWet),
      },
    },
  );

  return {
    ok: true,
    commandId: typeof raw.command_id === 'string' && raw.command_id ? raw.command_id : cmdId,
    message:
      typeof raw.message === 'string'
        ? raw.message
        : 'Calibração NVS enviada para a estação.',
  };
}

/** v5.41.0: modos do display aceitos pela SendCommand v5.38.0 / firmware 5.27.0. */
export type DisplayModeCommand = 'on' | 'off' | 'default_on' | 'default_off';

/** v5.41.0: corpo do pedido (puro, testável). `display_minutes` só vai com `on`. */
export function buildLocalControlsConfigBody(params: {
  deviceId: string;
  commandId: string;
  displayMode?: DisplayModeCommand;
  displayMinutes?: number;
  btnIrrigMin?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    device_id: params.deviceId,
    action: 'config',
    duration: 0,
    command_id: params.commandId,
  };
  if (params.displayMode) {
    body.display_mode = params.displayMode;
    if (params.displayMode === 'on') body.display_minutes = Math.trunc(params.displayMinutes ?? 5);
  }
  if (typeof params.btnIrrigMin === 'number') body.btn_irrig_min = Math.trunc(params.btnIrrigMin);
  return body;
}

/**
 * v5.41.0: display e botão de irrigação da estação (`action: "config"`, só o titular).
 * Display e botão podem ir juntos; nunca junto com intervalo/calibração (o servidor recusa).
 */
export async function sendLocalControlsConfigCommand(params: {
  deviceId: string;
  displayMode?: DisplayModeCommand;
  displayMinutes?: number;
  btnIrrigMin?: number;
  commandId?: string;
  signal?: AbortSignal;
}): Promise<SendCommandResponse> {
  const cmdId = params.commandId || generateClientCommandId('cfg');
  const body = buildLocalControlsConfigBody({ ...params, commandId: cmdId });

  logWebDiagnostic('INFO', 'command.send.local_config_intent', {
    device_id: params.deviceId,
    command_id: cmdId,
    display_mode: params.displayMode ?? null,
    display_minutes: body.display_minutes ?? null,
    btn_irrig_min: body.btn_irrig_min ?? null,
  });

  const raw = await awsAuthenticatedFetch<Record<string, unknown>>(EnvConfig.aws.commandEndpoint, {
    method: 'POST',
    signal: params.signal,
    body,
  });

  return {
    ok: true,
    commandId: typeof raw.command_id === 'string' && raw.command_id ? raw.command_id : cmdId,
    message: typeof raw.message === 'string' ? raw.message : 'Ajuste enviado para a estação.',
  };
}

export async function sendOtaUpdateCommand(params: {
  deviceId: string;
  targetVersion: string;
  sha256?: string | null;
  commandId?: string;
  signal?: AbortSignal;
}): Promise<SendCommandResponse> {
  const cmdId = params.commandId || generateClientCommandId('ota');
  const cleanVer = params.targetVersion.trim().replace(/^[vV]/, '');

  logWebDiagnostic('INFO', 'command.send.ota_intent', {
    device_id: params.deviceId,
    command_id: cmdId,
    target_version: cleanVer,
    sha256: params.sha256 ?? null,
  });

  const payload: Record<string, unknown> = {
    device_id: params.deviceId,
    action: 'ota',
    version: cleanVer,
    duration: 0,
    command_id: cmdId,
  };

  if (params.sha256 && params.sha256.trim()) {
    payload.sha256 = params.sha256.trim();
  }

  const raw = await awsAuthenticatedFetch<Record<string, unknown>>(
    EnvConfig.aws.commandEndpoint,
    {
      method: 'POST',
      signal: params.signal,
      body: payload,
    },
  );

  return {
    ok: true,
    commandId: typeof raw.command_id === 'string' && raw.command_id ? raw.command_id : cmdId,
    message:
      typeof raw.message === 'string'
        ? raw.message
        : 'Solicitação de atualização OTA enviada.',
    version: typeof raw.version === 'string' ? raw.version : cleanVer,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : undefined,
    fileSize: typeof raw.file_size === 'number' ? raw.file_size : undefined,
  };
}

/** Wait only for the correlated command document confirmed by the Firestore server. */
export function waitForCommandAck(params: {
  deviceId: string;
  commandId: string;
  targetStatuses: AckLifecycleStatus[];
  expectedAction?: 'on' | 'off' | 'config' | 'ota';
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CommandAckEvent> {
  const timeoutMs = params.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('INVALID_ACK_TIMEOUT'));
  const waitStartPerf = performance.now();
  const cmdRef = doc(firestoreDb, 'devices', params.deviceId, 'commands', params.commandId);

  logWebDiagnostic('DEBUG', 'ack.wait.start', {
    device_id: params.deviceId, command_id: params.commandId,
    expected_action: params.expectedAction, target_statuses: params.targetStatuses,
    timeout_ms: timeoutMs, confirmation_policy: 'server_command_document',
  });

  return new Promise<CommandAckEvent>((resolve, reject) => {
    let settled = false;
    let unsubscribeCmd: (() => void) | null = null;
    let timerId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const cleanup = () => {
      if (timerId !== null) { globalThis.clearTimeout(timerId); timerId = null; }
      params.signal?.removeEventListener('abort', onAbort);
      if (unsubscribeCmd) { const unsubscribe = unsubscribeCmd; unsubscribeCmd = null; unsubscribe(); }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    };
    const onAbort = () => {
      logWebDiagnostic('WARN', 'ack.wait.aborted', {
        device_id: params.deviceId, command_id: params.commandId,
        elapsed_ms: Math.round(performance.now() - waitStartPerf),
      });
      fail(new DOMException('Espera de ACK cancelada; isso não cancela um comando já enviado.', 'AbortError'));
    };
    if (params.signal?.aborted) { onAbort(); return; }
    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (params.signal?.aborted) { onAbort(); return; }
    timerId = globalThis.setTimeout(() => {
      logWebDiagnostic('WARN', 'ack.wait.timeout', {
        device_id: params.deviceId, command_id: params.commandId,
        expected_action: params.expectedAction, outcome: 'unconfirmed',
        elapsed_ms: Math.round(performance.now() - waitStartPerf),
      });
      fail(new Error('TIMEOUT_ACK'));
    }, timeoutMs);
    try {
      unsubscribeCmd = onSnapshot(
        cmdRef,
        { includeMetadataChanges: true },
        (snap) => {
          if (settled || !snap.exists()) return;
          const data = snap.data() ?? {};
          const rawStatus = String(data.last_status ?? data.status ?? 'unknown').trim().toLowerCase() as AckLifecycleStatus;
          const parsedError = parseCommandErrorField(data.error);
          const resolvedInterruptedId =
            typeof data.interrupted_cmd_id === 'string' && data.interrupted_cmd_id
              ? data.interrupted_cmd_id
              : typeof data.released_pending_command_id === 'string' && data.released_pending_command_id
                ? data.released_pending_command_id
                : null;

          logWebDiagnostic('DEBUG', 'ack.snapshot.command_doc', {
            device_id: params.deviceId, command_id: params.commandId,
            status: rawStatus, result: data.result ?? null, reason: data.reason ?? null,
            interrupted_cmd_id: resolvedInterruptedId,
            terminal_event_id: data.terminal_event_id ?? null, evidence: data.evidence ?? null,
            from_cache: snap.metadata.fromCache, has_pending_writes: snap.metadata.hasPendingWrites,
            elapsed_ms: Math.round(performance.now() - waitStartPerf),
          });
          if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
          if ((data.command_id != null && data.command_id !== params.commandId) ||
              (data.device_id != null && data.device_id !== params.deviceId)) {
            logWebDiagnostic('ERROR', 'ack.snapshot.identity_mismatch', {
              device_id: params.deviceId, command_id: params.commandId,
            });
            return;
          }
          if (params.expectedAction && data.requested_action != null && data.requested_action !== params.expectedAction) {
            logWebDiagnostic('ERROR', 'ack.snapshot.requested_action_mismatch', {
              device_id: params.deviceId, command_id: params.commandId,
            });
            return;
          }
          if (!params.targetStatuses.includes(rawStatus)) return;
          if (params.expectedAction === 'off' && rawStatus === 'done' && data.action !== 'off') return;
          if (params.expectedAction === 'on' && rawStatus === 'started' && data.action !== 'on') return;
          const ackEvent: CommandAckEvent = {
            commandId: params.commandId, status: rawStatus,
            result: typeof data.result === 'string' ? data.result : null,
            action: typeof data.action === 'string' ? data.action : null,
            duration: typeof data.duration === 'number' && Number.isFinite(data.duration) ? data.duration : null,
            reason: typeof data.reason === 'string' ? data.reason : null,
            error: parsedError,
            updatedAt: parseFirestoreDate(data.last_status_at ?? data.updated_at),
            evidence: typeof data.evidence === 'string' ? data.evidence : null,
            terminalEventId: typeof data.terminal_event_id === 'string' ? data.terminal_event_id : null,
            ackProtocol: typeof data.ack_protocol === 'number' ? data.ack_protocol : null,
            interruptedCommandId: resolvedInterruptedId,
            resolvedBy: 'command_doc', confirmedByServer: true,
          };
          settled = true; cleanup();
          logWebDiagnostic('INFO', 'ack.wait.resolved', {
            device_id: params.deviceId, command_id: params.commandId, resolved_by: 'command_doc',
            status: ackEvent.status, result: ackEvent.result, reason: ackEvent.reason,
            interrupted_cmd_id: ackEvent.interruptedCommandId,
            evidence: ackEvent.evidence, terminal_event_id: ackEvent.terminalEventId,
            confirmed_by_server: true, elapsed_ms: Math.round(performance.now() - waitStartPerf),
          });
          resolve(ackEvent);
        },
        (error) => {
          if (settled) return;
          logWebDiagnostic('ERROR', 'ack.snapshot.error', {
            device_id: params.deviceId, command_id: params.commandId, outcome: 'unconfirmed',
            error_message: error?.message || String(error),
          });
          fail(error);
        },
      );
      if (settled && unsubscribeCmd) { unsubscribeCmd(); unsubscribeCmd = null; }
    } catch (error) { fail(error); }
  });
}