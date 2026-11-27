/**
 * Testes da tela de Agendamentos (web v5.38.0, F1.2 / SCH-01): próxima execução no fuso
 * da estação, conflitos, minutos por dia, filtros, ordem e limite do titular.
 */
import { describe, expect, it } from 'vitest';
import { OWNER_MAX_SCHEDULES, ScheduleModel } from '../features/schedules/model/schedule.types';
import {
  countOwnerSchedules,
  filterSchedules,
  findConflicts,
  formatNextRunDay,
  formatRelative,
  minutesPerWeekday,
  nextRunOf,
  parseHHMM,
  sortSchedules,
  stationClock,
} from '../features/schedules/model/scheduleInsights';

const TZ = -3;
// Terça-feira 24/11/2026 15:40 na estação (18:40 UTC)
const NOW = Date.UTC(2026, 10, 24, 18, 40, 0);

const s = (id: string, time: string, days: number[], dur = 5, isEnabled = true, extra: Partial<ScheduleModel> = {}): ScheduleModel => ({
  id,
  label: `Rega ${id}`,
  time,
  days,
  durationMinutes: dur,
  isEnabled,
  ...extra,
});

describe('WEB-538 relógio e próxima execução (fuso da estação)', () => {
  it('WEB-538-01 terça 15:40 na estação', () => {
    expect(stationClock(NOW, TZ)).toEqual({ weekday: 2, minuteOfDay: 15 * 60 + 40, weekMinute: 1440 + 940 });
  });
  it('WEB-538-02 hoje mais tarde, amanhã cedo e dia da semana', () => {
    const later = nextRunOf(s('a', '18:00', [2]), NOW, TZ)!;
    expect(later.inMinutes).toBe(140);
    expect(formatNextRunDay(later, NOW, TZ)).toBe('hoje 18:00');
    const tomorrow = nextRunOf(s('b', '06:00', [3]), NOW, TZ)!;
    expect(formatNextRunDay(tomorrow, NOW, TZ)).toBe('amanhã 06:00');
    const fri = nextRunOf(s('c', '06:00', [5]), NOW, TZ)!;
    expect(formatNextRunDay(fri, NOW, TZ)).toBe('sex 06:00');
  });
  it('WEB-538-03 horário que já passou hoje vai para a próxima semana', () => {
    const r = nextRunOf(s('d', '07:00', [2]), NOW, TZ)!;
    expect(r.inMinutes).toBe(7 * 1440 - (940 - 420));
  });
  it('WEB-538-04 domingo → segunda vira a semana corretamente', () => {
    const sundayNight = Date.UTC(2026, 10, 30, 2, 30); // domingo 29/11 23:30 na estação
    expect(stationClock(sundayNight, TZ).weekday).toBe(7);
    const r = nextRunOf(s('e', '06:00', [1]), sundayNight, TZ)!;
    expect(r.inMinutes).toBe(30 + 360);
    expect(formatNextRunDay(r, sundayNight, TZ)).toBe('amanhã 06:00');
  });
  it('WEB-538-05 pausada ou horário inválido não tem próxima execução', () => {
    expect(nextRunOf(s('f', '06:00', [1], 5, false), NOW, TZ)).toBeNull();
    expect(nextRunOf(s('g', '25:00', [1]), NOW, TZ)).toBeNull();
    expect(parseHHMM('6:00')).toBeNull();
  });
  it('WEB-538-06 textos relativos', () => {
    expect(formatRelative(0)).toBe('agora');
    expect(formatRelative(45)).toBe('em 45 min');
    expect(formatRelative(125)).toBe('em 2 h 05 min');
    expect(formatRelative(120)).toBe('em 2 h');
    expect(formatRelative(3 * 1440)).toBe('em 3 dias');
  });
});

describe('WEB-538 conflitos e minutos por dia', () => {
  it('WEB-538-07 sobreposição no mesmo dia é detectada; encostadas não', () => {
    const c = findConflicts([s('a', '06:00', [1], 15), s('b', '06:10', [1, 3], 5), s('c', '06:15', [1], 5)]);
    expect(c.get('a')).toEqual(['b']);
    expect(c.get('b')).toEqual(['a']);
    expect(c.has('c')).toBe(false); // começa exatamente quando a termina
  });
  it('WEB-538-08 virada da meia-noite e de domingo para segunda', () => {
    expect(findConflicts([s('n', '23:55', [2], 15), s('m', '00:05', [3], 5)]).has('n')).toBe(true);
    expect(findConflicts([s('dom', '23:58', [7], 10), s('seg', '00:02', [1], 5)]).has('seg')).toBe(true);
  });
  it('WEB-538-09 pausadas não geram conflito nem contam minutos', () => {
    expect(findConflicts([s('a', '06:00', [1], 15), s('b', '06:05', [1], 5, false)]).size).toBe(0);
    expect(minutesPerWeekday([s('a', '06:00', [1, 3], 10), s('b', '18:00', [1], 5), s('p', '07:00', [1], 15, false)])).toEqual([15, 0, 10, 0, 0, 0, 0]);
  });
});

describe('WEB-538 filtros, ordem e limite', () => {
  const list = [s('x', '18:00', [2]), s('y', '06:00', [3], 5, false), s('z', '07:00', [2]), s('w', '16:00', [2])];
  it('WEB-538-10 filtro por situação e busca sem acentos', () => {
    expect(filterSchedules(list, 'active', '').map((i) => i.id)).toEqual(['x', 'z', 'w']);
    expect(filterSchedules(list, 'paused', '').map((i) => i.id)).toEqual(['y']);
    expect(filterSchedules([s('q', '06:00', [1], 5, true, { label: 'Irrigação do jardim' })], 'all', 'irrigacao').length).toBe(1);
  });
  it('WEB-538-11 ordem pela próxima execução: ativas primeiro, pausadas no fim', () => {
    expect(sortSchedules(list, 'next', NOW, TZ).map((i) => i.id)).toEqual(['w', 'x', 'z', 'y']);
    expect(sortSchedules(list, 'time', NOW, TZ).map((i) => i.id)).toEqual(['y', 'z', 'w', 'x']);
  });
  it('WEB-538-12 limite do titular 20; agendas de sessões Demo não contam', () => {
    expect(OWNER_MAX_SCHEDULES).toBe(20);
    expect(countOwnerSchedules([s('a', '06:00', [1]), s('d', '06:00', [1], 5, true, { createdByDemo: true })])).toBe(1);
  });
});
