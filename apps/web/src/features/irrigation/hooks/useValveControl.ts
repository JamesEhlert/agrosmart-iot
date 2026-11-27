// ACK web correction v1: correlated server result; unknown outcome is preserved.
/**
 * =====================================================================================
 * ARQUIVO: src/features/irrigation/hooks/useValveControl.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1B — Recusas 400/403/429 e Teto Demo)
 * DATA DE ATUALIZAÇÃO: 2026-11-23T21:00:00Z (UTC)
 * VERSÃO: v5.33.0 (Fase 4.0-B — botão guiado pelo ACK)
 * PROPÓSITO: Hook que gerencia o acionamento/parada da válvula, o cronômetro regressivo
 *            de 1 segundo e grava as transições de fase em UTC (diagnostics.ts).
 * CHANGELOG:
 * - v5.33.0 (Fase 4.0-B):
 *   * Pausa apos confirmacao: 3 s ("estabilizando") -> 1 s (anti duplo clique e
 *     protecao do rele/solenoide). Timeout de ACK nao impoe mais pausa (a parada fica
 *     sempre disponivel). 429 do servidor continua respeitando o retryAfter.
 *   * Estado confirmado pelo ACK vale na tela ate o Firestore refletir (no maximo 10 s),
 *     evitando o botao "voltar" para PARAR depois de um desligamento confirmado.
 *   * Expoe o tempo de espera (busyElapsedSec), o prazo (ACK_TIMEOUT_MS) e o comando
 *     ativo; registra cada fase (ui.valve.phase) e a reconciliacao com o Firestore
 *     (ui.valve.state_reconciled, com o atraso medido).
 * - v5.30.0:
 *   * Trata HTTP 400, 403 e 429 de `sendValveCommand` como recusas definitivas
 *     (preservando `uncertaintyBeforeRequest`), reservando `markUncertain(true)` apenas
 *     para timeout (408 / TIMEOUT_ACK), erro de rede, 5xx ou falha após aceite HTTP.
 *   * Inicia cooldown visual com `retryAfterSec` em HTTP 429 (`TooManyRequestsException`)
 *     e destaca claramente o encerramento de cota quando `reason === "demo_quota_exhausted"`.
 *   * Limita duração manual da sessão Demo a `DEMO_MAX_MANUAL_MINUTES = 5` (OFF livre).
 * =====================================================================================
 */

import { useEffect, useRef, useState } from 'react';
import {
  ApiException,
  ConflictException,
  ForbiddenException,
  TooManyRequestsException,
} from '../../../shared/api/httpClient';
import { logWebDiagnostic } from '../../../shared/lib/diagnostics';
import { useAuth } from '../../auth/hooks/useAuth';
import { DeviceModel } from '../../devices/model/device.types';
import {
  generateClientCommandId,
  sendValveCommand,
  waitForCommandAck,
} from '../api/commandApi';
import {
  isProtectiveRejection,
  isUnknownCommandOutcome,
  parseAckRetryAfterSec,
  translateValveRejectionReason,
} from '../model/command.types';

export type ValvePhase = 'idle' | 'sending_http' | 'waiting_ack';

export const DEMO_MAX_MANUAL_MINUTES = 5;
export const OWNER_MAX_MANUAL_MINUTES = 15;
/** Prazo maximo para a estacao confirmar (ACK) um comando. */
export const ACK_TIMEOUT_MS = 20_000;
/** Pausa curta apos um resultado confirmado: evita duplo clique e protege rele/solenoide. */
export const POST_CONFIRM_GUARD_SECONDS = 1;
/** Por quanto tempo o resultado do ACK prevalece na tela enquanto o Firestore nao reflete. */
export const ACK_STATE_OVERRIDE_MS = 10_000;

export interface AckStateOverride {
  open: boolean;
  untilMs: number;
  setAtMs: number;
  endsAtMs: number | null;
  commandId: string;
}

/**
 * Estado da valvula exibido: o resultado confirmado pelo ACK prevalece enquanto o
 * Firestore ainda nao refletiu (ate `untilMs`); depois, vale o Firestore.
 */
export function resolveEffectiveValveOpen(
  deviceValveOpen: boolean,
  override: AckStateOverride | null,
  nowMs: number,
): { open: boolean; overrideActive: boolean } {
  const overrideActive = Boolean(override && nowMs < override.untilMs && override.open !== deviceValveOpen);
  return { open: overrideActive && override ? override.open : deviceValveOpen, overrideActive };
}

/** O aviso "estado nao confirmado" so aparece com o botao livre (nunca durante a espera do ACK). */
export function shouldShowUnconfirmedBanner(confirmationUncertain: boolean, phase: ValvePhase): boolean {
  return confirmationUncertain && phase === 'idle';
}

export interface ValveCommandErrorOutcome {
  shouldMarkUncertain: boolean;
  feedback: {
    type: 'warning' | 'error';
    message: string;
  };
  cooldownSec?: number;
}

/**
 * Resolve a duração efetiva (em minutos) para acionamento manual `on`,
 * aplicando o teto de 5 min para Usuário Teste e 15 min para o titular.
 */
export function resolveManualValveMinutes(
  overrideMinutes: number | undefined,
  deviceDefaultMinutes: number,
  isDemoUser: boolean,
): number {
  const maxAllowed = isDemoUser ? DEMO_MAX_MANUAL_MINUTES : OWNER_MAX_MANUAL_MINUTES;
  const candidate = overrideMinutes ?? deviceDefaultMinutes;
  const safeCandidate = Number.isFinite(candidate) ? Math.trunc(candidate) : 1;
  return Math.max(1, Math.min(maxAllowed, safeCandidate));
}

/**
 * AGRO_E1: mensagem do HTTP 429. Usa a frase do servidor quando ela vier em português;
 * o 429 do próprio API Gateway ("Too Many Requests") e o 429 sem motivo viram frase clara.
 */
export function resolveTooManyRequestsMessage(
  reason: string | undefined,
  serverMessage: string | undefined,
  retryAfterSec: number,
): string {
  const msg = (serverMessage ?? '').trim();
  const sec = Math.max(1, Math.trunc(retryAfterSec));
  if (msg && !/too many requests|rate exceeded|limit exceeded/i.test(msg)) return msg;
  if (reason === 'demo_cooldown') return `Modo Usuário Teste: aguarde ${sec} s antes de iniciar outra irrigação.`;
  if (reason === 'device_rate_limited') return translateValveRejectionReason('device_rate_limited', sec);
  return `Muitos pedidos em pouco tempo. Aguarde ${sec} s e tente de novo.`;
}

/**
 * Classifica exceções do fluxo de válvula diferenciando recusas HTTP definitivas
 * (400, 403, 409 e 429 antes do aceite) de incerteza física (timeout, rede, 5xx
 * ou falha após o backend aceitar o comando).
 */
/** v5.36.0 (WEB-08/10): nível do registro de diagnóstico conforme a classificação. */
export function valveExceptionLogLevel(outcome: ValveCommandErrorOutcome): 'WARN' | 'ERROR' {
  return outcome.feedback.type === 'error' ? 'ERROR' : 'WARN';
}

export function classifyValveCommandError(
  err: unknown,
  uncertaintyBeforeRequest: boolean,
  httpAccepted: boolean,
): ValveCommandErrorOutcome {
  if (!httpAccepted) {
    if (err instanceof ConflictException) {
      const scheduleOwnsReservation = /irrigação ou reserva \(schedule\)/i.test(err.message);
      return {
        shouldMarkUncertain: uncertaintyBeforeRequest,
        feedback: {
          type: 'warning',
          message: scheduleOwnsReservation
            ? 'Uma irrigação agendada reservou a estação. O pedido manual foi recusado.'
            : 'A estação recusou este pedido por conflito de estado. Confira o estado atual e tente novamente.',
        },
        cooldownSec: POST_CONFIRM_GUARD_SECONDS,
      };
    }

    if (
      err instanceof TooManyRequestsException ||
      (err instanceof ApiException && err.statusCode === 429)
    ) {
      const retryAfterSec =
        err instanceof TooManyRequestsException ? err.retryAfterSec : 60;
      return {
        shouldMarkUncertain: uncertaintyBeforeRequest,
        feedback: {
          type: 'warning',
          message: resolveTooManyRequestsMessage(err.reason, err.message, retryAfterSec),
        },
        cooldownSec: Math.max(1, Math.trunc(retryAfterSec)),
      };
    }

    if (
      err instanceof ForbiddenException ||
      (err instanceof ApiException && err.statusCode === 403)
    ) {
      const isQuotaExhausted = err.reason === 'demo_quota_exhausted';
      const serverMsg = err.message?.trim() || '';
      const message = isQuotaExhausted
        ? /cota/i.test(serverMsg)
          ? serverMsg
          : 'Modo Usuário Teste: a cota máxima de irrigação desta sessão foi atingida. Encerre ou renove o acesso para continuar.'
        : serverMsg || 'Ação não permitida para a conta atual.';
      return {
        shouldMarkUncertain: uncertaintyBeforeRequest,
        feedback: {
          type: 'warning',
          message,
        },
      };
    }

    if (err instanceof ApiException && err.statusCode === 400) {
      return {
        shouldMarkUncertain: uncertaintyBeforeRequest,
        feedback: {
          type: 'warning',
          message: err.message || 'Parâmetros do comando recusados pelo servidor.',
        },
      };
    }
  }

  const msg = (err as Error)?.message || '';
  if (msg === 'TIMEOUT_ACK') {
    return {
      shouldMarkUncertain: true,
      feedback: {
        type: 'warning',
        message: `A estação não confirmou em ${ACK_TIMEOUT_MS / 1000} s. O comando pode ter sido executado ou não (queda de energia ou de internet na bancada). Por segurança, novos inícios ficam bloqueados até uma parada confirmada.`,
      },
    };
  }

  return {
    shouldMarkUncertain: true,
    feedback: {
      type: 'error',
      message: `Não foi possível confirmar o comando (${msg || 'falha de conexão'}). Ele pode ter sido executado. Por segurança, envie uma parada para sincronizar o estado.`,
    },
  };
}

// Preserve uncertainty during remount/navigation and, when available, tab reloads.
const uncertainDevices = new Set<string>();
const deviceOperationTokens = new Map<string, symbol>();
function readUncertainty(deviceId: string): boolean {
  try { return uncertainDevices.has(deviceId) || globalThis.sessionStorage?.getItem(`agro:valve-unconfirmed:${deviceId}`) === '1'; }
  catch { return uncertainDevices.has(deviceId); }
}
function storeUncertainty(deviceId: string, value: boolean): void {
  if (value) uncertainDevices.add(deviceId); else uncertainDevices.delete(deviceId);
  try {
    if (value) globalThis.sessionStorage?.setItem(`agro:valve-unconfirmed:${deviceId}`, '1');
    else globalThis.sessionStorage?.removeItem(`agro:valve-unconfirmed:${deviceId}`);
  } catch { /* Storage unavailable: preserve the conservative in-memory state. */ }
}

export function useValveControl(
  device: DeviceModel,
  onTelemetryRefreshRequested: () => void,
) {
  const { isDemoUser } = useAuth();
  const [phase, setPhase] = useState<ValvePhase>('idle');
  const [cooldownSec, setCooldownSec] = useState<number>(0);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'warning' | 'error';
    message: string;
  } | null>(null);
  const [remainingText, setRemainingText] = useState<string>('--:--');
  const [busySinceMs, setBusySinceMs] = useState<number | null>(null);
  const [busyElapsedSec, setBusyElapsedSec] = useState<number>(0);
  const [activeCommandId, setActiveCommandId] = useState<string | null>(null);
  const [ackOverride, setAckOverride] = useState<AckStateOverride | null>(null);

  const [confirmationUncertain, setConfirmationUncertain] = useState(() => readUncertainty(device.id));
  const markUncertain = (value: boolean) => {
    storeUncertainty(device.id, value);
    setConfirmationUncertain(value);
  };

  const isBusyRef = useRef<boolean>(false);
  const opGenerationRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const deviceValveOpen = device.state.valveOpen;
  const { open: isValveOpen, overrideActive } = resolveEffectiveValveOpen(deviceValveOpen, ackOverride, Date.now());
  const isValvePending =
    !(overrideActive && ackOverride && !ackOverride.open) &&
    Boolean(
      device.state.valvePending &&
        (!device.state.reservationExpiresEpoch ||
          Math.floor(Date.now() / 1000) <= device.state.reservationExpiresEpoch),
    );
  const valveEndsAt =
    device.state.valveEndsAt ??
    (overrideActive && ackOverride?.open && ackOverride.endsAtMs ? new Date(ackOverride.endsAtMs) : null);

  // O Firestore alcancou o resultado do ACK: registra o atraso e encerra a sobreposicao.
  useEffect(() => {
    if (!ackOverride) return;
    if (deviceValveOpen === ackOverride.open) {
      logWebDiagnostic('DEBUG', 'ui.valve.state_reconciled', {
        device_id: device.id,
        command_id: ackOverride.commandId,
        valve_open: deviceValveOpen,
        firestore_lag_ms: Date.now() - ackOverride.setAtMs,
      });
      setAckOverride(null);
      return;
    }
    const wait = ackOverride.untilMs - Date.now();
    if (wait <= 0) {
      logWebDiagnostic('WARN', 'ui.valve.state_reconcile_timeout', {
        device_id: device.id,
        command_id: ackOverride.commandId,
        ack_valve_open: ackOverride.open,
        firestore_valve_open: deviceValveOpen,
      });
      setAckOverride(null);
      return;
    }
    const t = globalThis.setTimeout(() => setAckOverride((cur) => (cur ? { ...cur } : cur)), wait + 50);
    return () => globalThis.clearTimeout(t);
  }, [ackOverride, deviceValveOpen, device.id]);

  // Cronometro da espera (mostrado no botao enquanto aguarda a estacao).
  useEffect(() => {
    if (busySinceMs === null) {
      setBusyElapsedSec(0);
      return;
    }
    const tick = () => setBusyElapsedSec(Math.floor((Date.now() - busySinceMs) / 1000));
    tick();
    const id = globalThis.setInterval(tick, 250);
    return () => globalThis.clearInterval(id);
  }, [busySinceMs]);

  useEffect(() => {
    opGenerationRef.current += 1;
    abortControllerRef.current?.abort();
    isBusyRef.current = false;
    setPhase('idle');
    setBusySinceMs(null);
    setActiveCommandId(null);
    setAckOverride(null);
    setCooldownSec(0);
    setFeedback(null);
    setConfirmationUncertain(readUncertainty(device.id));

    return () => {
      opGenerationRef.current += 1;
      abortControllerRef.current?.abort();
      isBusyRef.current = false;
    };
  }, [device.id]);

  useEffect(() => {
    if (cooldownSec <= 0) return;
    const timer = globalThis.setInterval(() => {
      setCooldownSec((prev) => (prev > 1 ? prev - 1 : 0));
    }, 1000);
    return () => globalThis.clearInterval(timer);
  }, [cooldownSec]);

  useEffect(() => {
    if (!isValveOpen || !valveEndsAt) {
      setRemainingText(isValvePending ? 'Reserva pendente...' : '--:--');
      return;
    }

    const updateTimer = () => {
      const diffSec = Math.floor((valveEndsAt.getTime() - Date.now()) / 1000);
      if (diffSec <= 0) {
        setRemainingText('Aguardando fechamento...');
        return;
      }
      const mins = Math.floor(diffSec / 60);
      const secs = diffSec % 60;
      setRemainingText(`${mins}m ${String(secs).padStart(2, '0')}s`);
    };

    updateTimer();
    const intervalId = globalThis.setInterval(updateTimer, 1000);
    return () => globalThis.clearInterval(intervalId);
  }, [isValveOpen, isValvePending, valveEndsAt]);

  const triggerValveToggle = async (overrideMinutes?: number, forceAction?: 'off') => {
    if (isBusyRef.current || phase !== 'idle' || (cooldownSec > 0 && forceAction !== 'off')) {
      logWebDiagnostic('WARN', 'ui.valve.click_ignored_busy_or_cooldown', {
        device_id: device.id,
        phase,
        cooldown_sec: cooldownSec,
        is_busy: isBusyRef.current,
      });
      return;
    }
    const shouldStop = forceAction === 'off' || isValveOpen || isValvePending;
    if (!shouldStop && confirmationUncertain) {
      setFeedback({ type: 'warning', message: 'Há um comando sem confirmação. Envie uma parada antes de tentar iniciar outra irrigação.' });
      return;
    }
    isBusyRef.current = true;
    setFeedback(null);

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const currentGen = ++opGenerationRef.current;
    const targetDeviceId = device.id;
    const stableCmdId = generateClientCommandId('app');
    const operationToken = Symbol(stableCmdId);
    deviceOperationTokens.set(targetDeviceId, operationToken);
    const intendedAction = shouldStop ? 'off' : 'on';
    const t0Total = performance.now();

    logWebDiagnostic('INFO', 'ui.valve.toggle_click', {
      device_id: targetDeviceId,
      command_id: stableCmdId,
      intended_action: intendedAction,
      observed_valve_open_before: isValveOpen,
      observed_valve_pending_before: isValvePending,
      override_minutes: overrideMinutes ?? null,
    });

    const uncertaintyBeforeRequest = readUncertainty(targetDeviceId);
    let httpAccepted = false;
    // Registro antecipado (write-ahead): se a aba fechar no meio, o estado fica "sem
    // confirmacao". A tela so mostra o aviso quando a espera termina sem ACK.
    markUncertain(true);
    setBusySinceMs(Date.now());
    setActiveCommandId(stableCmdId);
    const logPhase = (ph: ValvePhase, extra: Record<string, unknown> = {}) =>
      logWebDiagnostic('DEBUG', 'ui.valve.phase', {
        device_id: targetDeviceId,
        command_id: stableCmdId,
        phase: ph,
        intended_action: intendedAction,
        elapsed_ms: Math.round(performance.now() - t0Total),
        ...extra,
      });
    try {
      setPhase('sending_http');
      logPhase('sending_http');

      if (shouldStop) {
        const res = await sendValveCommand({
          deviceId: targetDeviceId,
          action: 'off',
          durationSeconds: 0,
          commandId: stableCmdId,
          signal: controller.signal,
        });
        httpAccepted = true;

        if (currentGen !== opGenerationRef.current) return;

        setPhase('waiting_ack');
        setActiveCommandId(res.commandId);
        logPhase('waiting_ack', { server_command_id: res.commandId });
        const ack = await waitForCommandAck({
          deviceId: targetDeviceId,
          commandId: res.commandId,
          expectedAction: 'off',
          targetStatuses: ['done', 'failed', 'error', 'publish_failed'],
          timeoutMs: ACK_TIMEOUT_MS,
          signal: controller.signal,
        });

        if (currentGen !== opGenerationRef.current) return;

        const isSuccess = ack.status === 'done' && ack.result === 'success' && ack.action === 'off' && !isUnknownCommandOutcome(ack);
        logWebDiagnostic(isSuccess ? 'INFO' : 'ERROR', 'ui.valve.off_completed', {
          device_id: targetDeviceId,
          command_id: res.commandId,
          ack_status: ack.status,
          ack_result: ack.result,
          ack_reason: ack.reason,
          interrupted_cmd_id: ack.interruptedCommandId ?? null,
          ack_evidence: ack.evidence ?? null,
          terminal_event_id: ack.terminalEventId ?? null,
          confirmed_by_server: ack.confirmedByServer ?? false,
          total_e2e_ms: Math.round(performance.now() - t0Total),
        });

        if (isSuccess) {
          markUncertain(false);
          const nowMs = Date.now();
          setAckOverride({ open: false, untilMs: nowMs + ACK_STATE_OVERRIDE_MS, setAtMs: nowMs, endsAtMs: null, commandId: res.commandId });
          setFeedback({
            type: 'success',
            message:
              ack.reason === 'already_off' && ack.interruptedCommandId
                ? 'Reserva cancelada. A estação confirmou a válvula desligada.'
                : ack.reason === 'already_off'
                  ? 'A estação confirmou: a válvula já estava desligada.'
                  : 'Irrigação encerrada. A estação ESP32 confirmou o desligamento da válvula.',
          });
          setCooldownSec(POST_CONFIRM_GUARD_SECONDS);
          onTelemetryRefreshRequested();
        } else {
          markUncertain(true);
          setFeedback({
            type: 'warning',
            message: isUnknownCommandOutcome(ack)
              ? translateValveRejectionReason(ack.reason)
              : `A estação não confirmou o desligamento (${ack.reason || ack.error || 'resultado incompleto'}). Envie a parada novamente antes de um novo início.`,
          });
        }
      } else {
        const minutes = resolveManualValveMinutes(
          overrideMinutes,
          device.settings.manualDuration,
          isDemoUser,
        );
        const durationSeconds = minutes * 60;

        const res = await sendValveCommand({
          deviceId: targetDeviceId,
          action: 'on',
          durationSeconds,
          commandId: stableCmdId,
          signal: controller.signal,
        });
        httpAccepted = true;

        if (currentGen !== opGenerationRef.current) return;

        setPhase('waiting_ack');
        setActiveCommandId(res.commandId);
        logPhase('waiting_ack', { server_command_id: res.commandId });
        const ack = await waitForCommandAck({
          deviceId: targetDeviceId,
          commandId: res.commandId,
          expectedAction: 'on',
          targetStatuses: ['started', 'done', 'failed', 'error', 'publish_failed'],
          timeoutMs: ACK_TIMEOUT_MS,
          signal: controller.signal,
        });

        if (currentGen !== opGenerationRef.current) return;

        const isFailed =
          ack.result === 'failed' ||
          ack.status === 'failed' ||
          ack.status === 'error' ||
          ack.status === 'publish_failed';

        logWebDiagnostic(isFailed ? 'WARN' : 'INFO', 'ui.valve.on_completed', {
          device_id: targetDeviceId,
          command_id: res.commandId,
          requested_duration_s: durationSeconds,
          ack_status: ack.status,
          ack_result: ack.result,
          ack_reason: ack.reason,
          ack_evidence: ack.evidence ?? null,
          terminal_event_id: ack.terminalEventId ?? null,
          confirmed_by_server: ack.confirmedByServer ?? false,
          total_e2e_ms: Math.round(performance.now() - t0Total),
        });

        if (ack.status === 'done' && (ack.result !== 'success' || isUnknownCommandOutcome(ack))) {
          markUncertain(true);
          setFeedback({ type: 'warning', message: 'A estação devolveu um resultado incompleto para este comando. Por segurança, envie uma parada antes de um novo início.' });
        } else if (isFailed) {
          markUncertain(isUnknownCommandOutcome(ack));
          // AGRO_E1: recusa de proteção mostra o tempo de espera e bloqueia o botão até lá.
          const protective = isProtectiveRejection(ack.reason);
          const retryAfterSec = protective ? parseAckRetryAfterSec(ack.error) : null;
          setFeedback({
            type: protective || ack.reason === 'rain_interlock' || isUnknownCommandOutcome(ack) ? 'warning' : 'error',
            message: translateValveRejectionReason(ack.reason || ack.error, retryAfterSec),
          });
          setCooldownSec(retryAfterSec ?? POST_CONFIRM_GUARD_SECONDS);
        } else if (ack.status === 'started') {
          markUncertain(false);
          const nowMs = Date.now();
          setAckOverride({
            open: true,
            untilMs: nowMs + ACK_STATE_OVERRIDE_MS,
            setAtMs: nowMs,
            endsAtMs: nowMs + durationSeconds * 1000,
            commandId: res.commandId,
          });
          setFeedback({
            type: 'success',
            message: `Irrigação iniciada. A estação ESP32 confirmou a válvula aberta por ${minutes} min.`,
          });
          setCooldownSec(POST_CONFIRM_GUARD_SECONDS);
          onTelemetryRefreshRequested();
        } else if (ack.status === 'done') {
          markUncertain(false);
          const doneMsg =
            ack.reason === 'manual_off' || ack.reason === 'manual_stop'
              ? 'Este ciclo foi interrompido manualmente na estação.'
              : ack.reason === 'rain_interlock'
                ? 'A estação interrompeu este ciclo porque detectou chuva.'
                : 'A estação registrou o encerramento deste comando.';
          setFeedback({
            type: 'warning',
            message: doneMsg,
          });
          setCooldownSec(POST_CONFIRM_GUARD_SECONDS);
          onTelemetryRefreshRequested();
        }
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        // Store using captured device identity; never set state on an unmounted/changed device.
        if (deviceOperationTokens.get(targetDeviceId) === operationToken) {
          storeUncertainty(targetDeviceId, true);
          if (currentGen === opGenerationRef.current) setConfirmationUncertain(true);
        }
        return;
      }
      if (currentGen !== opGenerationRef.current) return;

      const outcome = classifyValveCommandError(
        err,
        uncertaintyBeforeRequest,
        httpAccepted,
      );

      // v5.36.0 (WEB-08/10): recusa de proteção (429/403) e falta de confirmação no prazo
      // são situações previstas e explicadas na tela -> AVISO, não ERRO.
      logWebDiagnostic(valveExceptionLogLevel(outcome), 'ui.valve.exception', {
        device_id: targetDeviceId,
        command_id: stableCmdId,
        intended_action: intendedAction,
        error_name: (err as Error)?.name || 'Error',
        error_message: (err as Error)?.message || String(err),
        feedback_type: outcome.feedback.type,
        total_e2e_ms: Math.round(performance.now() - t0Total),
      });
      markUncertain(outcome.shouldMarkUncertain);
      setFeedback(outcome.feedback);
      if (outcome.cooldownSec !== undefined) {
        setCooldownSec(outcome.cooldownSec);
      }
    } finally {
      if (deviceOperationTokens.get(targetDeviceId) === operationToken) deviceOperationTokens.delete(targetDeviceId);
      if (currentGen === opGenerationRef.current) {
        isBusyRef.current = false;
        setPhase('idle');
        setBusySinceMs(null);
        setActiveCommandId(null);
        logWebDiagnostic('DEBUG', 'ui.valve.phase', {
          device_id: targetDeviceId,
          command_id: stableCmdId,
          phase: 'idle',
          intended_action: intendedAction,
          elapsed_ms: Math.round(performance.now() - t0Total),
        });
      }
    }
  };

  return {
    phase,
    busyElapsedSec,
    activeCommandId,
    isValveOpen,
    cooldownSec,
    confirmationUncertain,
    isValvePending,
    requestValveStop: () => triggerValveToggle(undefined, 'off'),
    feedback,
    clearFeedback: () => setFeedback(null),
    remainingText,
    triggerValveToggle,
  };
}
