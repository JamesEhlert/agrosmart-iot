/**
 * =====================================================================================
 * ARQUIVO: src/features/telemetry/model/readingsQuery.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T21:30:00Z (UTC)
 * VERSÃO: v5.39.1
 * PROPÓSITO: Regras puras do Histórico de Leituras (F1.3): intervalos no fuso da estação
 *            (a API aceita janelas de até 90 dias), estimativa de quantidade pelo intervalo
 *            de envio, montagem do CSV (protegido contra CSV injection) e nome do arquivo.
 * =====================================================================================
 */

import { escapeCsvCell, formatWithDeviceTimezone } from '../../../shared/lib/formatters';
import { CustomRangeInput, stationDayStart } from '../../events/model/logQuery';
import { TelemetryModel } from './telemetry.types';

export type ReadingsRangeKey = '1h' | '24h' | '7d' | 'all' | 'custom';

export const READINGS_PAGE_SIZE = 50;
/** Janela máxima aceita pela GetTelemetry (MAX_TIME_WINDOW_SEC = 90 dias). */
export const API_MAX_WINDOW_DAYS = 90;
/** Teto de linhas por exportação CSV (titular e Demo): custo e tempo previsíveis. */
export const CSV_MAX_ROWS = 5000;
/** Leituras por chamada durante a exportação (a API aceita até 3000 com janela). */
export const CSV_BATCH = 2500;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const READINGS_RANGES: ReadonlyArray<{ key: ReadingsRangeKey; label: string }> = [
  { key: '1h', label: '1 h' },
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 dias' },
  { key: 'all', label: 'Tudo' },
  { key: 'custom', label: 'Datas…' },
];

export interface ReadingsWindow {
  /** null = sem janela (lista "Tudo", da mais recente para trás). */
  start: Date | null;
  end: Date | null;
}

export function resolveReadingsWindow(
  key: ReadingsRangeKey,
  custom: CustomRangeInput,
  tzOffsetHours: number,
  nowMs: number = Date.now(),
): { window: ReadingsWindow; error: string | null } {
  const now = new Date(nowMs);
  switch (key) {
    case '1h':
      return { window: { start: new Date(nowMs - HOUR_MS), end: now }, error: null };
    case '24h':
      return { window: { start: new Date(nowMs - DAY_MS), end: now }, error: null };
    case '7d':
      return { window: { start: new Date(nowMs - 7 * DAY_MS), end: now }, error: null };
    case 'all':
      return { window: { start: null, end: null }, error: null };
    default: {
      const start = stationDayStart(custom.from, tzOffsetHours);
      const toStart = stationDayStart(custom.to, tzOffsetHours);
      if (!start || !toStart) return { window: { start: null, end: null }, error: 'Preencha as duas datas.' };
      let end = new Date(toStart.getTime() + DAY_MS);
      if (end.getTime() > nowMs) end = now;
      if (start.getTime() >= end.getTime()) {
        return { window: { start: null, end: null }, error: 'A data inicial precisa ser anterior ou igual à final.' };
      }
      if (end.getTime() - start.getTime() > API_MAX_WINDOW_DAYS * DAY_MS) {
        return { window: { start: null, end: null }, error: `Escolha no máximo ${API_MAX_WINDOW_DAYS} dias por vez.` };
      }
      return { window: { start, end }, error: null };
    }
  }
}

/**
 * Janela usada na exportação: a escolhida ou, em "Tudo", os últimos 90 dias (limite da API).
 */
export function exportWindowOf(window: ReadingsWindow, nowMs: number = Date.now()): { start: Date; end: Date } {
  if (window.start && window.end) return { start: window.start, end: window.end };
  return { start: new Date(nowMs - API_MAX_WINDOW_DAYS * DAY_MS), end: new Date(nowMs) };
}

/** Intervalo típico entre leituras (ms): mediana das diferenças da página carregada. */
export function typicalIntervalMs(items: TelemetryModel[]): number | null {
  const ts = items.map((i) => i.timestamp.getTime()).filter((t) => Number.isFinite(t));
  if (ts.length < 3) return null;
  const diffs: number[] = [];
  for (let i = 1; i < ts.length; i += 1) {
    const d = Math.abs(ts[i - 1] - ts[i]);
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return null;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/** Estimativa de leituras numa janela (a tabela não guarda contagem; é só uma estimativa). */
export function estimateReadings(window: ReadingsWindow, intervalMs: number | null): number | null {
  if (!window.start || !window.end || !intervalMs || intervalMs <= 0) return null;
  return Math.max(0, Math.round((window.end.getTime() - window.start.getTime()) / intervalMs));
}

/** "a cada 30 s", "a cada 15 min" */
export function formatInterval(intervalMs: number): string {
  const s = Math.round(intervalMs / 1000);
  if (s < 90) return `a cada ${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `a cada ${m} min`;
  return `a cada ${Math.round(m / 60)} h`;
}

export const CSV_HEADER = [
  'Timestamp_UTC_ISO',
  'Data_Hora_Estacao',
  'Fuso_Estacao',
  'Temp_Ar_C',
  'Umid_Ar_Pct',
  'Sensor_Ar_OK',
  'Umid_Solo_Pct',
  'Falha_Solo',
  'Luminosidade_Pct',
  'Indice_UV',
  'Chuva_Pct',
  'Chuva_Detectada',
  'Firmware',
  'Particao',
  'RSSI_dBm',
] as const;

/**
 * CSV no padrão internacional (vírgula + ponto decimal), UTF-8 com BOM para o Excel abrir
 * os acentos. Toda célula passa por `escapeCsvCell` (aspas, quebras de linha e proteção
 * contra CSV/formula injection: texto começando com = + - @ ganha um apóstrofo).
 */
export function buildTelemetryCsv(items: TelemetryModel[], tzOffsetHours: number): string {
  const tzLabel = `UTC${tzOffsetHours >= 0 ? `+${tzOffsetHours}` : tzOffsetHours}`;
  const rows = items.map((it) =>
    [
      escapeCsvCell(it.timestamp.toISOString()),
      escapeCsvCell(formatWithDeviceTimezone(it.timestamp, tzOffsetHours)),
      escapeCsvCell(tzLabel),
      it.ahtOk ? escapeCsvCell(it.airTemp.toFixed(2)) : '',
      it.ahtOk ? escapeCsvCell(it.airHumidity.toFixed(0)) : '',
      escapeCsvCell(it.ahtOk),
      it.soilFault ? '' : escapeCsvCell(it.soilMoisture.toFixed(0)),
      escapeCsvCell(it.soilFault),
      escapeCsvCell(it.lightLevel.toFixed(0)),
      escapeCsvCell(it.uvIndex.toFixed(2)),
      escapeCsvCell(it.rainPct),
      escapeCsvCell(it.rainDetected),
      escapeCsvCell(it.fw ?? ''),
      escapeCsvCell(it.part ?? ''),
      escapeCsvCell(it.rssi ?? ''),
    ].join(','),
  );
  return `﻿${[CSV_HEADER.join(','), ...rows].join('\r\n')}\r\n`;
}

function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** agrosmart-leituras_<estação>_<inícioUTC>_<fimUTC>.csv (só caracteres seguros). */
export function csvFileName(deviceId: string, start: Date, end: Date): string {
  const safe = deviceId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'estacao';
  return `agrosmart-leituras_${safe}_${utcStamp(start)}_${utcStamp(end)}.csv`;
}

/** v5.39.1: disjuntor de consultas da tela de leituras (rede de segurança contra loops). */
export const READINGS_REQ_BUDGET = 12;
export const READINGS_REQ_WINDOW_MS = 10_000;

export function createRequestBudget(max: number, windowMs: number): { allow: (nowMs: number) => boolean } {
  const stamps: number[] = [];
  return {
    allow(nowMs: number) {
      while (stamps.length && nowMs - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length >= max) return false;
      stamps.push(nowMs);
      return true;
    },
  };
}

/** Mensagem amigável para erros da consulta (sem detalhes internos). */
export function friendlyReadingsError(err: unknown): string {
  const e = err as { status?: number; statusCode?: number; message?: string };
  const status = e?.status ?? e?.statusCode;
  const msg = String(e?.message ?? '');
  if (status === 429 || /too many requests|429/i.test(msg)) {
    return 'Muitas consultas em pouco tempo. Aguarde alguns segundos e clique em “Atualizar”.';
  }
  if (status === 401 || status === 403) return 'Sua sessão expirou ou não tem acesso a esta estação. Entre novamente.';
  return 'Não foi possível carregar as leituras agora. Tente “Atualizar” em instantes.';
}
