/**
 * =====================================================================================
 * ARQUIVO: src/features/schedules/model/scheduleInsights.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T20:30:00Z (UTC)
 * VERSÃO: v5.38.0
 * PROPÓSITO: Regras puras da tela de Agendamentos (F1.2): próxima execução no fuso da
 *            estação, conflitos (regas que se sobrepõem), minutos de rega por dia,
 *            filtros e ordenação. Sem Firebase aqui, para ser testável.
 *            Dias: 1 = segunda … 7 = domingo (mesma convenção da Scheduler_Logic).
 * =====================================================================================
 */

import { ScheduleModel, WEEKDAYS_LIST } from './schedule.types';

export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

export type ScheduleStatusFilter = 'all' | 'active' | 'paused';
export type ScheduleSortMode = 'next' | 'time';

function safeOffset(tzOffsetHours: number): number {
  return Number.isFinite(tzOffsetHours) ? tzOffsetHours : -3;
}

/** "HH:mm" → minutos desde 00:00 (ou null se inválido). */
export function parseHHMM(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((hhmm ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Agora no fuso da estação: dia ISO (1..7), minuto do dia e minuto da semana. */
export function stationClock(nowMs: number, tzOffsetHours: number): { weekday: number; minuteOfDay: number; weekMinute: number } {
  const shifted = new Date(nowMs + safeOffset(tzOffsetHours) * 3600 * 1000);
  const js = shifted.getUTCDay();
  const weekday = js === 0 ? 7 : js;
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return { weekday, minuteOfDay, weekMinute: (weekday - 1) * MINUTES_PER_DAY + minuteOfDay };
}

export interface NextRun {
  /** Minutos até a próxima execução (0 = neste minuto). */
  inMinutes: number;
  weekday: number;
  time: string;
}

/** Próxima execução de uma agenda ATIVA (null se pausada ou sem dia/horário válido). */
export function nextRunOf(s: ScheduleModel, nowMs: number, tzOffsetHours: number): NextRun | null {
  if (!s.isEnabled) return null;
  const minute = parseHHMM(s.time);
  if (minute === null) return null;
  const now = stationClock(nowMs, tzOffsetHours);
  let best: NextRun | null = null;
  for (const day of new Set(s.days)) {
    if (day < 1 || day > 7) continue;
    const wm = (day - 1) * MINUTES_PER_DAY + minute;
    const delta = (wm - now.weekMinute + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
    if (!best || delta < best.inMinutes) best = { inMinutes: delta, weekday: day, time: s.time };
  }
  return best;
}

/** "em 45 min", "em 2 h 05 min", "em 3 dias". */
export function formatRelative(inMinutes: number): string {
  if (inMinutes <= 0) return 'agora';
  if (inMinutes < 60) return `em ${inMinutes} min`;
  if (inMinutes < MINUTES_PER_DAY) {
    const h = Math.floor(inMinutes / 60);
    const m = inMinutes % 60;
    return m ? `em ${h} h ${String(m).padStart(2, '0')} min` : `em ${h} h`;
  }
  const d = Math.round(inMinutes / MINUTES_PER_DAY);
  return `em ${d} dia${d > 1 ? 's' : ''}`;
}

/** "hoje 18:00", "amanhã 06:00", "qua 06:00". */
export function formatNextRunDay(run: NextRun, nowMs: number, tzOffsetHours: number): string {
  const now = stationClock(nowMs, tzOffsetHours);
  const dayOffset = Math.floor((now.minuteOfDay + run.inMinutes) / MINUTES_PER_DAY);
  if (dayOffset === 0) return `hoje ${run.time}`;
  if (dayOffset === 1) return `amanhã ${run.time}`;
  const short = WEEKDAYS_LIST.find((w) => w.day === run.weekday)?.short.toLowerCase() ?? '';
  return `${short} ${run.time}`;
}

/**
 * Regas ativas que se sobrepõem (início + duração) em algum dia, inclusive virando a
 * meia-noite e de domingo para segunda. Devolve, para cada agenda, as que conflitam com ela.
 */
export function findConflicts(list: ScheduleModel[]): Map<string, string[]> {
  type Win = { id: string; start: number; end: number };
  const wins: Win[] = [];
  for (const s of list) {
    if (!s.isEnabled) continue;
    const minute = parseHHMM(s.time);
    const dur = Math.max(1, Math.floor(s.durationMinutes || 0));
    if (minute === null) continue;
    for (const day of new Set(s.days)) {
      if (day < 1 || day > 7) continue;
      const start = (day - 1) * MINUTES_PER_DAY + minute;
      wins.push({ id: s.id, start, end: start + dur });
    }
  }
  const overlaps = (a: Win, b: Win) => {
    for (const shift of [0, MINUTES_PER_WEEK, -MINUTES_PER_WEEK]) {
      if (a.start < b.end + shift && b.start + shift < a.end) return true;
    }
    return false;
  };
  const out = new Map<string, Set<string>>();
  for (let i = 0; i < wins.length; i += 1) {
    for (let j = i + 1; j < wins.length; j += 1) {
      const a = wins[i];
      const b = wins[j];
      if (a.id === b.id || !overlaps(a, b)) continue;
      if (!out.has(a.id)) out.set(a.id, new Set());
      if (!out.has(b.id)) out.set(b.id, new Set());
      out.get(a.id)!.add(b.id);
      out.get(b.id)!.add(a.id);
    }
  }
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}

/** Minutos de rega programados por dia da semana (índice 0 = segunda), só agendas ativas. */
export function minutesPerWeekday(list: ScheduleModel[]): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const s of list) {
    if (!s.isEnabled || parseHHMM(s.time) === null) continue;
    for (const day of new Set(s.days)) {
      if (day >= 1 && day <= 7) out[day - 1] += Math.max(0, Math.floor(s.durationMinutes || 0));
    }
  }
  return out;
}

function norm(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function filterSchedules(list: ScheduleModel[], status: ScheduleStatusFilter, query: string): ScheduleModel[] {
  const q = norm(query);
  return list.filter((s) => {
    if (status === 'active' && !s.isEnabled) return false;
    if (status === 'paused' && s.isEnabled) return false;
    return !q || norm(`${s.label} ${s.time}`).includes(q);
  });
}

/** 'next': ativas pela próxima execução, depois pausadas por horário. 'time': por horário. */
export function sortSchedules(list: ScheduleModel[], mode: ScheduleSortMode, nowMs: number, tzOffsetHours: number): ScheduleModel[] {
  const byTime = (a: ScheduleModel, b: ScheduleModel) => a.time.localeCompare(b.time) || a.label.localeCompare(b.label);
  if (mode === 'time') return [...list].sort(byTime);
  return [...list].sort((a, b) => {
    const na = nextRunOf(a, nowMs, tzOffsetHours);
    const nb = nextRunOf(b, nowMs, tzOffsetHours);
    if (na && nb) return na.inMinutes - nb.inMinutes || byTime(a, b);
    if (na) return -1;
    if (nb) return 1;
    return byTime(a, b);
  });
}

/** Agendas do titular (as de sessões Demo não contam no limite do titular). */
export function countOwnerSchedules(list: ScheduleModel[]): number {
  return list.filter((s) => !s.createdByDemo).length;
}
