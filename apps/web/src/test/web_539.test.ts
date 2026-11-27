/**
 * Testes do Histórico de Leituras (web v5.39.0, F1.3): janelas no fuso da estação,
 * limite de 90 dias da API, estimativa por intervalo de envio e CSV protegido.
 */
import { describe, expect, it } from 'vitest';
import { TelemetryModel } from '../features/telemetry/model/telemetry.types';
import {
  API_MAX_WINDOW_DAYS,
  buildTelemetryCsv,
  CSV_HEADER,
  CSV_MAX_ROWS,
  csvFileName,
  estimateReadings,
  exportWindowOf,
  formatInterval,
  resolveReadingsWindow,
  typicalIntervalMs,
} from '../features/telemetry/model/readingsQuery';

const TZ = -3;
const NOW = Date.UTC(2026, 10, 24, 21, 0, 0);
const DAY = 86400000;

const reading = (iso: string, extra: Partial<TelemetryModel> = {}): TelemetryModel =>
  ({
    airTemp: 24.5,
    airHumidity: 61,
    soilMoisture: 37,
    soilRaw: 2100,
    uvIndex: 1.25,
    lightLevel: 55,
    rainRaw: 4095,
    rainPct: 0,
    rainDetected: false,
    timestamp: new Date(iso),
    fw: '5.26.0',
    part: 'app0',
    rssi: -61,
    ahtOk: true,
    soilFault: false,
    ...extra,
  }) as unknown as TelemetryModel;

describe('WEB-539 janelas do histórico', () => {
  it('WEB-539-01 atalhos e "Tudo" sem janela', () => {
    expect(resolveReadingsWindow('24h', { from: '', to: '' }, TZ, NOW).window.start?.getTime()).toBe(NOW - DAY);
    expect(resolveReadingsWindow('all', { from: '', to: '' }, TZ, NOW).window).toEqual({ start: null, end: null });
  });
  it('WEB-539-02 datas: dia inteiro no fuso; fim não passa de agora', () => {
    const { window, error } = resolveReadingsWindow('custom', { from: '2026-11-24', to: '2026-11-24' }, TZ, NOW);
    expect(error).toBeNull();
    expect(window.start?.toISOString()).toBe('2026-11-24T03:00:00.000Z');
    expect(window.end?.getTime()).toBe(NOW);
  });
  it('WEB-539-03 mais de 90 dias e datas invertidas são recusadas', () => {
    expect(resolveReadingsWindow('custom', { from: '2026-01-01', to: '2026-11-20' }, TZ, NOW).error).toMatch(/90 dias/);
    expect(resolveReadingsWindow('custom', { from: '2026-11-20', to: '2026-11-10' }, TZ, NOW).error).toMatch(/anterior/);
    expect(API_MAX_WINDOW_DAYS).toBe(90);
  });
  it('WEB-539-04 exportação em "Tudo" usa os últimos 90 dias (limite da API)', () => {
    const w = exportWindowOf({ start: null, end: null }, NOW);
    expect(w.end.getTime() - w.start.getTime()).toBe(90 * DAY);
  });
});

describe('WEB-539 estimativa', () => {
  const page = [0, 30, 60, 90, 120].map((s) => reading(new Date(NOW - s * 1000).toISOString()));
  it('WEB-539-05 intervalo típico pela mediana e texto', () => {
    expect(typicalIntervalMs(page)).toBe(30000);
    expect(formatInterval(30000)).toBe('a cada 30 s');
    expect(formatInterval(15 * 60000)).toBe('a cada 15 min');
  });
  it('WEB-539-06 24 h a cada 30 s ≈ 2.880 leituras; sem janela não estima', () => {
    expect(estimateReadings({ start: new Date(NOW - DAY), end: new Date(NOW) }, 30000)).toBe(2880);
    expect(estimateReadings({ start: null, end: null }, 30000)).toBeNull();
  });
});

describe('WEB-539 CSV', () => {
  it('WEB-539-07 BOM, cabeçalho e linha com ponto decimal', () => {
    const csv = buildTelemetryCsv([reading('2026-11-24T18:00:00.000Z')], TZ);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(CSV_HEADER.join(','));
    expect(lines[1].startsWith('2026-11-24T18:00:00.000Z,24/11/2026 • 15:00:00,UTC-3,24.50,61,SIM,37,NAO,55,1.25,0,NAO,5.26.0,app0,-61')).toBe(true);
  });
  it('WEB-539-08 sensor com falha deixa a célula vazia', () => {
    const line = buildTelemetryCsv([reading('2026-11-24T18:00:00.000Z', { ahtOk: false, soilFault: true })], TZ).split('\r\n')[1];
    expect(line.split(',').slice(3, 8)).toEqual(['', '', 'NAO', '', 'SIM']);
  });
  it('WEB-539-09 CSV injection: texto que começa com "=" vira texto', () => {
    const line = buildTelemetryCsv([reading('2026-11-24T18:00:00.000Z', { fw: '=HYPERLINK("x")' })], TZ).split('\r\n')[1];
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
  });
  it('WEB-539-10 nome de arquivo seguro e teto de linhas', () => {
    expect(csvFileName('ESP32-AgroSmart-Station-V5', new Date('2026-11-23T03:00:00Z'), new Date('2026-11-24T03:00:00Z'))).toBe(
      'agrosmart-leituras_ESP32-AgroSmart-Station-V5_20261123T030000Z_20261124T030000Z.csv',
    );
    expect(csvFileName('../x y', new Date(0), new Date(0))).toMatch(/^agrosmart-leituras_+x_y_19700101T000000Z_19700101T000000Z\.csv$/);
    expect(CSV_MAX_ROWS).toBe(5000);
  });
});
