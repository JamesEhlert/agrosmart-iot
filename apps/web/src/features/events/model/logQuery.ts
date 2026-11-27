/**
 * =====================================================================================
 * ARQUIVO: src/features/events/model/logQuery.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T19:30:00Z (UTC)
 * VERSÃO: v5.37.0
 * PROPÓSITO: Regras puras da navegação dos logs (WEB-12): intervalo de datas no fuso da
 *            estação, ordem, paginação, detecção de número de operação e textos do rodapé.
 *            Sem Firebase aqui, para ser testável.
 * =====================================================================================
 */

import { ActivityLogModel } from './event.types';
import { LogPeriodKey, periodStart } from './logFilters';

export type LogOrder = 'desc' | 'asc';
export type LogRangeKey = LogPeriodKey | 'custom';

/** Intervalo de busca no servidor: `from` inclusivo, `to` exclusivo; null = aberto. */
export interface LogRange {
  from: Date | null;
  to: Date | null;
}

/** Itens por página (lista leve: no máximo 50 linhas na tela). */
export const LOG_PAGE_SIZE = 50;
/** Leituras por lote quando o filtro de categoria/busca precisa varrer o período. */
export const SCAN_BATCH = 250;
/** Teto da varredura por período: acima disso, pedir um intervalo de datas menor. */
export const SCAN_MAX_DOCS = 3000;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const RANGE_OPTIONS: ReadonlyArray<{ key: LogRangeKey; label: string }> = [
  { key: '1h', label: '1 h' },
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 dias' },
  { key: '30d', label: '30 dias' },
  { key: 'all', label: 'Tudo' },
  { key: 'custom', label: 'Datas…' },
];

function safeOffset(tzOffsetHours: number): number {
  return Number.isFinite(tzOffsetHours) ? tzOffsetHours : -3;
}

/** 'AAAA-MM-DD' (dia no fuso da estação) → instante UTC da meia-noite daquele dia. */
export function stationDayStart(isoDay: string, tzOffsetHours: number): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return new Date(utc - safeOffset(tzOffsetHours) * HOUR_MS);
}

/** Dia de hoje ('AAAA-MM-DD') no fuso da estação. */
export function stationIsoDay(nowMs: number, tzOffsetHours: number): string {
  const shifted = new Date(nowMs + safeOffset(tzOffsetHours) * HOUR_MS);
  return shifted.toISOString().slice(0, 10);
}

/** Primeiro e último dia de um mês relativo ao atual (0 = este mês, -1 = mês passado). */
export function stationMonthBounds(nowMs: number, tzOffsetHours: number, monthDelta: number): { from: string; to: string } {
  const today = stationIsoDay(nowMs, tzOffsetHours);
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1 + monthDelta;
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const from = first.toISOString().slice(0, 10);
  const lastIso = last.toISOString().slice(0, 10);
  return { from, to: monthDelta >= 0 && lastIso > today ? today : lastIso };
}

export interface CustomRangeInput {
  from: string;
  to: string;
}

/**
 * Resolve o intervalo escolhido. Atalhos contam a partir de agora; "Datas…" usa dias
 * inteiros no fuso da estação (o dia final entra inteiro).
 */
export function resolveLogRange(
  key: LogRangeKey,
  custom: CustomRangeInput,
  tzOffsetHours: number,
  nowMs: number = Date.now(),
): { range: LogRange; error: string | null } {
  if (key !== 'custom') return { range: { from: periodStart(key, nowMs), to: null }, error: null };
  const fromTxt = custom.from.trim();
  const toTxt = custom.to.trim();
  const from = fromTxt ? stationDayStart(fromTxt, tzOffsetHours) : null;
  const toStart = toTxt ? stationDayStart(toTxt, tzOffsetHours) : null;
  if (fromTxt && !from) return { range: { from: null, to: null }, error: 'Data inicial inválida.' };
  if (toTxt && !toStart) return { range: { from: null, to: null }, error: 'Data final inválida.' };
  const to = toStart ? new Date(toStart.getTime() + DAY_MS) : null;
  if (from && to && from.getTime() >= to.getTime()) {
    return { range: { from: null, to: null }, error: 'A data inicial precisa ser anterior ou igual à final.' };
  }
  return { range: { from, to }, error: null };
}

/** Chave estável de um intervalo (para cache). */
export function rangeKeyOf(range: LogRange): string {
  return `${range.from ? range.from.getTime() : '-'}|${range.to ? range.to.getTime() : '-'}`;
}

function tsOf(log: ActivityLogModel): number {
  const t = log.timestamp?.getTime();
  return typeof t === 'number' && !Number.isNaN(t) ? t : 0;
}

/** Ordena por data do registro (estável). */
export function sortLogs(logs: ActivityLogModel[], order: LogOrder): ActivityLogModel[] {
  const dir = order === 'asc' ? 1 : -1;
  return logs
    .map((log, i) => ({ log, i }))
    .sort((a, b) => (tsOf(a.log) - tsOf(b.log)) * dir || a.i - b.i)
    .map((x) => x.log);
}

export function pageCountOf(total: number, size: number = LOG_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

export function pageSlice<T>(items: T[], pageIndex: number, size: number = LOG_PAGE_SIZE): T[] {
  const start = Math.max(0, pageIndex) * size;
  return items.slice(start, start + size);
}

/**
 * Texto que parece número de operação (ex.: app-1792399661720-213368, demo-78c1…,
 * e2e-rede-…, sched-…): busca direta no servidor em todo o histórico.
 */
export function looksLikeOperationId(text: string): boolean {
  const t = text.trim();
  if (t.length < 8 || t.length > 120 || /\s/.test(t)) return false;
  return /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+){1,8}$/.test(t) && /\d/.test(t);
}

const NUM = new Intl.NumberFormat('pt-BR');
export function formatCount(n: number): string {
  return NUM.format(n);
}

/** "Registros 51–100 de 1.279" */
export function serverRangeLabel(pageIndex: number, shown: number, total: number | null, size: number = LOG_PAGE_SIZE): string {
  if (shown <= 0) return total === null ? 'Nenhum registro' : `0 de ${formatCount(total)}`;
  const first = pageIndex * size + 1;
  const last = first + shown - 1;
  return `Registros ${formatCount(first)}–${formatCount(last)}${total === null ? '' : ` de ${formatCount(total)}`}`;
}
