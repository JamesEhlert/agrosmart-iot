/**
 * Testes da navegação dos logs (web v5.37.0, WEB-12): intervalo de datas no fuso da
 * estação, ordem, paginação, número de operação e textos do rodapé.
 */
import { describe, expect, it } from 'vitest';
import { parseActivityLogFromFirestore } from '../features/events/model/event.types';
import {
  formatCount,
  LOG_PAGE_SIZE,
  looksLikeOperationId,
  pageCountOf,
  pageSlice,
  rangeKeyOf,
  resolveLogRange,
  SCAN_BATCH,
  SCAN_MAX_DOCS,
  serverRangeLabel,
  sortLogs,
  stationDayStart,
  stationIsoDay,
  stationMonthBounds,
} from '../features/events/model/logQuery';

const TZ = -3;
const NOW = Date.UTC(2026, 10, 24, 18, 40, 0); // 24/11/2026 15:40 na estação

const mk = (id: string, iso: string) =>
  parseActivityLogFromFirestore(
    { type: 'command_execution', source: 'manual', message: id, timestamp: { toDate: () => new Date(iso) } },
    id,
  );

describe('WEB-537 intervalo de datas (fuso da estação)', () => {
  it('WEB-537-01 meia-noite da estação (-3) = 03:00 UTC', () => {
    expect(stationDayStart('2026-03-02', TZ)?.toISOString()).toBe('2026-03-02T03:00:00.000Z');
  });
  it('WEB-537-02 data impossível ou mal formatada é recusada', () => {
    expect(stationDayStart('2026-02-30', TZ)).toBeNull();
    expect(stationDayStart('02/03/2026', TZ)).toBeNull();
  });
  it('WEB-537-03 "hoje" respeita o fuso (21:30 UTC ainda é o mesmo dia; 02:30 UTC é o dia anterior)', () => {
    expect(stationIsoDay(Date.UTC(2026, 10, 24, 21, 30), TZ)).toBe('2026-11-24');
    expect(stationIsoDay(Date.UTC(2026, 10, 25, 2, 30), TZ)).toBe('2026-11-24');
  });
  it('WEB-537-04 dia final entra inteiro (fim exclusivo = meia-noite do dia seguinte)', () => {
    const { range, error } = resolveLogRange('custom', { from: '2026-03-02', to: '2026-03-03' }, TZ, NOW);
    expect(error).toBeNull();
    expect(range.from?.toISOString()).toBe('2026-03-02T03:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-03-04T03:00:00.000Z');
  });
  it('WEB-537-05 início depois do fim é recusado; um lado vazio fica aberto', () => {
    expect(resolveLogRange('custom', { from: '2026-03-05', to: '2026-03-01' }, TZ, NOW).error).toMatch(/anterior/);
    const open = resolveLogRange('custom', { from: '', to: '2026-07-03' }, TZ, NOW);
    expect(open.error).toBeNull();
    expect(open.range.from).toBeNull();
    expect(open.range.to?.toISOString()).toBe('2026-07-04T03:00:00.000Z');
  });
  it('WEB-537-06 atalhos: 7 dias conta de agora; Tudo não limita', () => {
    expect(resolveLogRange('7d', { from: '', to: '' }, TZ, NOW).range.from?.getTime()).toBe(NOW - 7 * 86400000);
    expect(resolveLogRange('all', { from: '', to: '' }, TZ, NOW).range).toEqual({ from: null, to: null });
  });
  it('WEB-537-07 "Este mês" vai até hoje; "Mês passado" é o mês inteiro', () => {
    expect(stationMonthBounds(NOW, TZ, 0)).toEqual({ from: '2026-11-01', to: '2026-11-24' });
    expect(stationMonthBounds(NOW, TZ, -1)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(stationMonthBounds(Date.UTC(2026, 0, 10, 12), TZ, -1)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
  it('WEB-537-08 chave de cache estável para o mesmo intervalo', () => {
    const a = resolveLogRange('custom', { from: '2026-03-02', to: '2026-03-03' }, TZ, NOW).range;
    const b = resolveLogRange('custom', { from: '2026-03-02', to: '2026-03-03' }, TZ, NOW + 60000).range;
    expect(rangeKeyOf(a)).toBe(rangeKeyOf(b));
    expect(rangeKeyOf({ from: null, to: null })).toBe('-|-');
  });
});

describe('WEB-537 ordem e paginação', () => {
  const logs = [mk('b', '2026-03-02T10:00:00Z'), mk('a', '2026-03-01T10:00:00Z'), mk('c', '2026-03-03T10:00:00Z')];
  it('WEB-537-09 mais recentes / mais antigos primeiro', () => {
    expect(sortLogs(logs, 'desc').map((l) => l.id)).toEqual(['c', 'b', 'a']);
    expect(sortLogs(logs, 'asc').map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });
  it('WEB-537-10 páginas de 50: 436 resultados = 9 páginas; a última tem 36', () => {
    const items = Array.from({ length: 436 }, (_, i) => i);
    expect(LOG_PAGE_SIZE).toBe(50);
    expect(pageCountOf(436)).toBe(9);
    expect(pageSlice(items, 8)).toHaveLength(36);
    expect(pageSlice(items, 0)[0]).toBe(0);
    expect(pageCountOf(0)).toBe(1);
  });
  it('WEB-537-11 rodapé do modo servidor', () => {
    expect(serverRangeLabel(1, 50, 1279)).toBe('Registros 51–100 de 1.279');
    expect(serverRangeLabel(25, 29, 1279)).toBe('Registros 1.251–1.279 de 1.279');
    expect(serverRangeLabel(0, 50, null)).toBe('Registros 1–50');
    expect(formatCount(1279)).toBe('1.279');
  });
  it('WEB-537-12 limites da varredura (custo previsível)', () => {
    expect(SCAN_BATCH).toBe(250);
    expect(SCAN_MAX_DOCS).toBe(3000);
  });
});

describe('WEB-537 busca por número de operação', () => {
  it('WEB-537-13 reconhece ids reais', () => {
    for (const id of ['app-1792399661720-213368', 'demo-78c1bec77347a6db5ef84fd4', 'e2e-rede-1795505446742-9738', 'sched-abc123-1']) {
      expect(looksLikeOperationId(id)).toBe(true);
    }
  });
  it('WEB-537-14 texto comum não vira busca por id', () => {
    for (const q of ['chuva', 'solo umido', 'manual_off', 'Irrigação ligada', 'abc-def', '', 'a-1']) {
      expect(looksLikeOperationId(q)).toBe(false);
    }
  });
});
