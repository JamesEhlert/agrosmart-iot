/**
 * =====================================================================================
 * ARQUIVO: src/features/events/model/logFilters.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * DATA DE CRIAÇÃO: 2026-11-24 (UTC) — Web v5.36.0
 * PROPÓSITO: Regras puras (sem Firebase) da página "Logs & Auditoria":
 *            período, categorias, busca e proteção de exclusão.
 *            A proteção espelha a regra do Firestore v5.32.0: alerta de segurança com
 *            menos de 30 dias não pode ser excluído (o servidor recusa de qualquer jeito;
 *            aqui só evitamos enviar o pedido e explicamos ao usuário).
 * =====================================================================================
 */

import { ActivityLogModel, isOtaEvent, PROTECTIVE_EVENT_REASONS } from './event.types';
import { classifyAuditEvent } from './auditPresentation';

export type LogPeriodKey = '1h' | '24h' | '7d' | '30d' | 'all';

export const LOG_PERIODS: ReadonlyArray<{ key: LogPeriodKey; label: string }> = [
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 dias' },
  { key: '30d', label: '30 dias' },
  { key: 'all', label: 'Tudo' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Início da janela do período (null = sem limite). */
export function periodStart(period: LogPeriodKey, nowMs: number = Date.now()): Date | null {
  switch (period) {
    case '1h':
      return new Date(nowMs - 3600 * 1000);
    case '24h':
      return new Date(nowMs - DAY_MS);
    case '7d':
      return new Date(nowMs - 7 * DAY_MS);
    case '30d':
      return new Date(nowMs - 30 * DAY_MS);
    default:
      return null;
  }
}

export type LogCategoryKey =
  | 'all'
  | 'schedule'
  | 'manual'
  | 'demo'
  | 'irrigation'
  | 'skipped'
  | 'local'
  | 'display'
  | 'unconfirmed'
  | 'failed'
  | 'protection'
  | 'ota_config'
  | 'security';

export const LOG_CATEGORIES: ReadonlyArray<{ key: LogCategoryKey; label: string; hint: string }> = [
  { key: 'all', label: 'Todos', hint: 'Todos os registros carregados' },
  { key: 'irrigation', label: 'Irrigações', hint: 'Toda abertura e fechamento da válvula, de qualquer origem' },
  { key: 'manual', label: 'Manuais', hint: 'Acionamentos pelo titular no site' },
  { key: 'schedule', label: 'Agendas', hint: 'Execuções e bloqueios das rotinas semanais' },
  { key: 'skipped', label: 'Regas puladas', hint: 'Agendas não executadas: chuva, previsão de chuva ou solo úmido' },
  { key: 'local', label: 'Botões da estação', hint: 'Apertos nos botões físicos da caixa (irrigação e display)' },
  { key: 'display', label: 'Display', hint: 'Tela da estação: botão físico e ajustes pelo site' },
  { key: 'demo', label: 'Demonstração', hint: 'Acionamentos feitos por convidados' },
  { key: 'unconfirmed', label: 'Sem confirmação', hint: 'A estação não confirmou no prazo' },
  { key: 'failed', label: 'Falhas', hint: 'Execuções que falharam na estação' },
  { key: 'protection', label: 'Proteções', hint: 'Chuva, solo úmido, anti-rajada e travas de segurança' },
  { key: 'ota_config', label: 'OTA e ajustes', hint: 'Atualizações de firmware, calibração, display e botões' },
  { key: 'security', label: 'Segurança', hint: 'Comandos sem registro no servidor e alertas de segurança' },
];

const SECURITY_PROTECTION_MS = 30 * DAY_MS;

const PROTECTION_REASONS: ReadonlySet<string> = new Set([
  'rain_interlock',
  'power_unstable',
  'power_loss_reset',
  'power_loss_rollback',
  'failsafe',
  'failsafe_no_deadline',
  'failsafe_guard_timer',
  'valve_task_stall',
  'command_expired',
  'ota_valve_busy',
]);

/** Comando feito por convidado (o servidor carimba `demo-` no command_id). */
export function isDemoLog(log: ActivityLogModel): boolean {
  if (log.commandId && log.commandId.startsWith('demo-')) return true;
  const requestedBy = log.details?.requested_by;
  return (
    typeof requestedBy === 'object' &&
    requestedBy !== null &&
    (requestedBy as Record<string, unknown>).kind === 'demo'
  );
}

/** v5.41.0: evento dos botões físicos da estação (AckToFirestore v5.33.0). */
export function isLocalStationLog(log: ActivityLogModel): boolean {
  return (
    log.type === 'local_action' ||
    log.source === 'local_button' ||
    log.eventCode === 'LOCAL_BUTTON' ||
    Boolean(log.commandId && log.commandId.startsWith('loc-'))
  );
}

/** v5.42.0: tipo do evento do botão (`loc-<boot>-<seq>-<on|off|disp>`), ou null. */
export function localEventKind(log: ActivityLogModel): 'on' | 'off' | 'disp' | null {
  const k = log.details?.local_kind;
  if (k === 'on' || k === 'off' || k === 'disp') return k;
  const m = /^loc-[0-9A-Fa-f]{1,32}-\d{1,10}-(on|off|disp)$/.exec(log.commandId ?? '');
  return m ? (m[1] as 'on' | 'off' | 'disp') : null;
}

const DISPLAY_REASONS: ReadonlySet<string> = new Set(['display_on', 'display_off', 'display_updated']);

/** v5.42.0: tela da estação (botão do display ou ajuste do display pelo site). */
export function isDisplayLog(log: ActivityLogModel): boolean {
  if (localEventKind(log) === 'disp') return true;
  const r = (log.reason ?? '').toLowerCase();
  if (DISPLAY_REASONS.has(r)) return true;
  return r === 'local_config_updated' && /display/i.test(log.message);
}

/** v5.42.0: agenda que não chegou a irrigar (chuva, previsão ou solo úmido). */
export function isSkippedWateringLog(log: ActivityLogModel): boolean {
  if (log.type === 'skipped') return true;
  const c = classifyAuditEvent(log);
  return c === 'weather_sensor' || c === 'weather_forecast' || c === 'wet_soil';
}

/** v5.42.0: abertura/fechamento da válvula, de qualquer origem (site, agenda, convidado, botão). */
export function isIrrigationLog(log: ActivityLogModel): boolean {
  if (isSkippedWateringLog(log) || isDisplayLog(log) || isOtaOrConfigLog(log)) return false;
  const kind = localEventKind(log);
  if (kind === 'on' || kind === 'off') return true;
  const req = log.details?.requested as Record<string, unknown> | undefined;
  const action = typeof req?.action === 'string' ? req.action : typeof log.details?.action === 'string' ? log.details.action : '';
  if (action === 'on' || action === 'off') return true;
  return /irriga|v[aá]lvula|\brega\b/i.test(log.message);
}

/** v5.41.0: ajustes do display/botões vindos do site (motivos do ACK). */
const LOCAL_CONFIG_REASONS: ReadonlySet<string> = new Set(['display_updated', 'buttons_updated', 'local_config_updated']);

/** Alerta de segurança: comando sem registro no servidor ou `type=security_alert`. */
export function isSecurityLog(log: ActivityLogModel): boolean {
  return Boolean(
    log.isUnregistered ||
      log.type === 'security_alert' ||
      log.source === 'unregistered' ||
      log.eventCode === 'CMD_UNREGISTERED',
  );
}

export function isUnconfirmedLog(log: ActivityLogModel): boolean {
  return classifyAuditEvent(log) === 'unconfirmed';
}

export function isFailedLog(log: ActivityLogModel): boolean {
  const r = (log.reason ?? '').toLowerCase();
  if (PROTECTIVE_EVENT_REASONS.has(r)) return false;
  return log.result === 'failed' || log.type === 'error';
}

export function isProtectionLog(log: ActivityLogModel): boolean {
  const r = (log.reason ?? '').toLowerCase();
  const c = classifyAuditEvent(log);
  return (
    PROTECTIVE_EVENT_REASONS.has(r) ||
    PROTECTION_REASONS.has(r) ||
    c === 'weather_sensor' ||
    c === 'weather_forecast' ||
    c === 'wet_soil' ||
    log.type === 'skipped' ||
    log.source === 'weather_ai'
  );
}

export function isOtaOrConfigLog(log: ActivityLogModel): boolean {
  const r = (log.reason ?? '').toLowerCase();
  return (
    isOtaEvent(log) ||
    r.startsWith('config_') ||
    r === 'invalid_calibration' ||
    LOCAL_CONFIG_REASONS.has(r) ||
    log.type === 'ota_verification'
  );
}

export function matchesCategory(log: ActivityLogModel, category: LogCategoryKey): boolean {
  switch (category) {
    case 'all':
      return true;
    case 'schedule':
      return log.isFromSchedule;
    case 'manual':
      return log.isManualCommand && !isDemoLog(log) && !isOtaOrConfigLog(log);
    case 'demo':
      return isDemoLog(log);
    case 'local':
      return isLocalStationLog(log);
    case 'display':
      return isDisplayLog(log);
    case 'irrigation':
      return isIrrigationLog(log);
    case 'skipped':
      return isSkippedWateringLog(log);
    case 'unconfirmed':
      return isUnconfirmedLog(log);
    case 'failed':
      return isFailedLog(log);
    case 'protection':
      return isProtectionLog(log);
    case 'ota_config':
      return isOtaOrConfigLog(log);
    case 'security':
      return isSecurityLog(log);
    default:
      return true;
  }
}

/** Busca simples, sem diferenciar maiúsculas nem acentos, na mensagem, no motivo e no command_id. */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function matchesSearch(log: ActivityLogModel, rawQuery: string): boolean {
  const q = normalizeSearch(rawQuery);
  if (!q) return true;
  const hay = normalizeSearch(
    [log.message, log.reason ?? '', log.commandId ?? '', log.scheduleLabel ?? '', log.source].join(' '),
  );
  return q.split(/\s+/).every((term) => hay.includes(term));
}

export function countByCategory(logs: ActivityLogModel[]): Record<LogCategoryKey, number> {
  const out = {} as Record<LogCategoryKey, number>;
  for (const c of LOG_CATEGORIES) out[c.key] = 0;
  for (const log of logs) {
    for (const c of LOG_CATEGORIES) {
      if (matchesCategory(log, c.key)) out[c.key] += 1;
    }
  }
  return out;
}

/**
 * Espelho da regra do Firestore v5.32.0: alerta de segurança com menos de 30 dias
 * (ou sem data) fica protegido contra exclusão.
 */
export function isDeletionProtected(log: ActivityLogModel, nowMs: number = Date.now()): boolean {
  if (!isSecurityLog(log)) return false;
  const ts = log.timestamp?.getTime();
  if (typeof ts !== 'number' || Number.isNaN(ts)) return true;
  return nowMs - ts < SECURITY_PROTECTION_MS;
}

/** Dias restantes de proteção (para a dica na tela). */
export function protectionDaysLeft(log: ActivityLogModel, nowMs: number = Date.now()): number {
  const ts = log.timestamp?.getTime();
  if (typeof ts !== 'number' || Number.isNaN(ts)) return 30;
  return Math.max(0, Math.ceil((SECURITY_PROTECTION_MS - (nowMs - ts)) / DAY_MS));
}

export const CLEANUP_AGE_OPTIONS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 7, label: 'mais de 7 dias' },
  { days: 30, label: 'mais de 30 dias' },
  { days: 90, label: 'mais de 90 dias' },
];

export const CLEANUP_CONFIRM_WORD = 'EXCLUIR';

export interface DeletionSummary {
  requested: number;
  deleted: number;
  protectedKept: number;
  denied: number;
}

/**
 * Exclusão adaptativa em lotes: começa com `initialBatch` e, se o servidor recusar um lote,
 * divide o lote ao meio até chegar a 1 item (assim um único documento recusado não derruba
 * os demais e o limite de leituras das regras nunca é excedido).
 */
export async function runAdaptiveDeletion(
  ids: string[],
  commit: (chunk: string[]) => Promise<void>,
  opts: { initialBatch?: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<{ deleted: string[]; denied: string[] }> {
  const deleted: string[] = [];
  const denied: string[] = [];
  const total = ids.length;
  const report = () => opts.onProgress?.(deleted.length + denied.length, total);
  const queue: string[][] = [];
  const size = Math.max(1, Math.min(opts.initialBatch ?? 40, 450));
  for (let i = 0; i < ids.length; i += size) queue.push(ids.slice(i, i + size));
  while (queue.length > 0) {
    if (opts.signal?.aborted) break;
    const chunk = queue.shift() as string[];
    try {
      await commit(chunk);
      deleted.push(...chunk);
      report();
    } catch {
      if (chunk.length === 1) {
        denied.push(chunk[0]);
        report();
      } else {
        const half = Math.ceil(chunk.length / 2);
        queue.unshift(chunk.slice(0, half), chunk.slice(half));
      }
    }
  }
  return { deleted, denied };
}
