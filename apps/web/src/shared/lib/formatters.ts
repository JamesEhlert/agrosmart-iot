/**
 * =====================================================================================
 * ARQUIVO: src/shared/lib/formatters.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 3 / Parte A — SemVer Estrito)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T22:00:00Z (UTC)
 * VERSÃO: v5.32.0
 * PROPÓSITO: Funções utilitárias puras para formatação de grandezas físicas, métricas
 *            de diagnóstico FreeRTOS (Uptime, Heap, RSSI, Fila WAL SD), datas, SemVer,
 *            frescor de telemetria e proteção de exportação CSV.
 * CHANGELOG:
 * - v5.32.0: Alinha `compareSemver` ao contrato estrito X.Y.Z do backend (rejeita
 *            pré-releases e versões malformadas retornando 0, impedindo habilitar OTA).
 * - v5.25.0: [Auditorias 01 e 02]
 *            1. `formatPendingBytes` diferencia dado ausente (`Sem leitura`) de `0 B`;
 *            2. `formatResetReason` não infere OTA em `sw_reset` sem evidência e cobre
 *               `deepsleep`, `sdio` e `unknown`;
 *            3. Proteção contra `NaN`, `Infinity` e `rssi >= 0` em todos os formatadores;
 *            4. Adicionados `compareSemver`, `classifyTelemetryFreshness`, `escapeCsvCell`,
 *               `toDateTimeLocalInputValue` e `parseDateTimeLocalInputValue`.
 * =====================================================================================
 */

/**
 * Converte o tempo contínuo de atividade (Uptime em segundos) em texto amigável (ex.: "2d 4h 15m").
 */
export function formatUptime(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return '--';
  }
  const totalSec = Math.floor(seconds);
  if (totalSec === 0) return '0m 0s';

  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const remSec = totalSec % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${remSec}s`;
}

/**
 * Traduz o código técnico de reinicialização do ESP-IDF (`esp_reset_reason_t`) para português claro.
 */
export function formatResetReason(reason?: string | null): string {
  if (!reason || !reason.trim()) return 'Não informado';
  switch (reason.trim().toLowerCase()) {
    case 'poweron':
      return 'Energia (Power-On)';
    case 'sw_reset':
      return 'Reinício por Software';
    case 'task_wdt':
    case 'int_wdt':
    case 'other_wdt':
      return 'Watchdog Timer (Auto-Recovery)';
    case 'brownout':
      return 'Queda de Tensão (Brownout)';
    case 'panic':
      return 'Exceção Crítica (Panic)';
    case 'ext_reset':
      return 'Pino Reset Externo (EN)';
    case 'deepsleep':
      return 'Retorno de Deep Sleep';
    case 'sdio':
      return 'Reinício via SDIO';
    case 'unknown':
      return 'Motivo não identificado';
    default:
      return reason.trim();
  }
}

/**
 * Formata o volume de dados pendentes na fila offline Write-Ahead Log (WAL) do cartão MicroSD,
 * distinguindo zero confirmado ("0 B (Sincronizado)") de ausência de leitura ("Sem leitura").
 */
export function formatPendingBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return 'Sem leitura';
  }
  const cleanBytes = Math.trunc(bytes);
  if (cleanBytes === 0) {
    return '0 B (Sincronizado)';
  }
  if (cleanBytes < 1024) return `${cleanBytes} B na fila`;
  const kb = cleanBytes / 1024.0;
  return `${kb.toFixed(1)} KB na fila`;
}

/**
 * Formata a memória RAM dinâmica livre (FreeRTOS Heap) em kilobytes e bytes.
 */
export function formatFreeHeap(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes <= 0) {
    return '--';
  }
  const cleanBytes = Math.trunc(bytes);
  const kb = cleanBytes / 1024.0;
  return `${kb.toFixed(1)} KB (${cleanBytes.toLocaleString('pt-BR')} B)`;
}

/**
 * Classifica semanticamente a potência do sinal Wi-Fi (RSSI em dBm).
 * Leituras válidas de RSSI Wi-Fi no ESP32 são negativas (tipicamente entre -100 e -10 dBm).
 */
export function classifyRssiQuality(rssi?: number | null): {
  label: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
} {
  if (rssi === undefined || rssi === null || !Number.isFinite(rssi) || rssi >= 0 || rssi < -120) {
    return { label: 'Sem leitura', tone: 'neutral' };
  }
  if (rssi >= -60) return { label: 'Excelente', tone: 'success' };
  if (rssi >= -67) return { label: 'Muito Bom', tone: 'success' };
  if (rssi >= -75) return { label: 'Regular', tone: 'warning' };
  if (rssi >= -85) return { label: 'Fraco', tone: 'warning' };
  return { label: 'Crítico', tone: 'error' };
}

/**
 * Formata uma data aplicando o fuso horário configurado na estação (ex.: UTC-3 Brasília).
 */
export function formatWithDeviceTimezone(
  date?: Date | null,
  timezoneOffsetHours = -3,
  includeSeconds = true,
): string {
  if (!date || !(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'Horário não informado';
  }
  const safeOffset = Number.isFinite(timezoneOffsetHours) ? timezoneOffsetHours : -3;
  const utcMs = date.getTime();
  const targetMs = utcMs + safeOffset * 3600 * 1000;
  const shifted = new Date(targetMs);

  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = shifted.getUTCFullYear();
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');
  const ss = String(shifted.getUTCSeconds()).padStart(2, '0');

  return includeSeconds
    ? `${dd}/${mm}/${yyyy} • ${hh}:${min}:${ss}`
    : `${dd}/${mm} ${hh}:${min}`;
}

/**
 * Converte um objeto `Date` para o formato `YYYY-MM-DDTHH:mm` esperado por `<input type="datetime-local">`
 * respeitando o fuso horário configurado na estação (evita o desvio de 3h do `toISOString()`).
 */
export function toDateTimeLocalInputValue(date: Date, timezoneOffsetHours = -3): string {
  const safeDate =
    date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const safeOffset = Number.isFinite(timezoneOffsetHours) ? timezoneOffsetHours : -3;
  const shifted = new Date(safeDate.getTime() + safeOffset * 3600 * 1000);

  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

/**
 * Converte o texto `YYYY-MM-DDTHH:mm` de `<input type="datetime-local">` em um objeto `Date` UTC real
 * interpretando o valor digitado no fuso horário da estação.
 */
export function parseDateTimeLocalInputValue(
  rawValue: string,
  timezoneOffsetHours = -3,
): Date | null {
  const clean = (rawValue ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(clean);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;

  const safeOffset = Number.isFinite(timezoneOffsetHours) ? timezoneOffsetHours : -3;
  const utcMillis =
    Date.UTC(year, month - 1, day, hour, minute, second) - safeOffset * 3600 * 1000;
  const result = new Date(utcMillis);
  return Number.isNaN(result.getTime()) ? null : result;
}

/**
 * Compara duas strings SemVer estritas `X.Y.Z` (`"5.23.10"` vs `"5.23.9"`),
 * rejeitando pré-releases e strings malformadas.
 * Retorna `1` se `verA > verB`, `-1` se `verA < verB`, ou `0` se equivalentes/inválidas.
 */
export function compareSemver(verA?: string | null, verB?: string | null): number {
  const parseParts = (v?: string | null): [number, number, number] | null => {
    if (!v || typeof v !== 'string') return null;
    const clean = v.trim().replace(/^[vV]/, '');
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(clean);
    if (!match) return null;
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
  };

  const a = parseParts(verA);
  const b = parseParts(verB);
  if (!a || !b) return 0;

  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

export interface TelemetryFreshnessInfo {
  status: 'fresh' | 'delayed' | 'stale' | 'unknown';
  ageSeconds: number | null;
  badgeText: string;
}

/**
 * Avalia a idade da última amostra de telemetria em relação ao intervalo configurado na estação
 * (suporta tanto 30s na bancada quanto 10 min ou 30 min em campo, igual à Lambda Scheduler).
 */
export function classifyTelemetryFreshness(
  timestamp?: Date | null,
  telemetryIntervalMs = 30000,
  nowMs = Date.now(),
): TelemetryFreshnessInfo {
  if (!timestamp || !(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    return {
      status: 'unknown',
      ageSeconds: null,
      badgeText: 'Idade desconhecida',
    };
  }

  const ageSec = Math.max(0, Math.floor((nowMs - timestamp.getTime()) / 1000));
  const intervalSec = Math.max(15, Math.floor((telemetryIntervalMs || 30000) / 1000));
  const freshThresholdSec = Math.max(90, Math.floor(intervalSec * 1.5) + 30);
  const maxAllowedSec = Math.max(180, intervalSec * 2 + 120);

  const ageLabel =
    ageSec < 60
      ? `há ${ageSec}s`
      : ageSec < 3600
        ? `há ${Math.floor(ageSec / 60)}m`
        : ageSec < 86400
          ? `há ${Math.floor(ageSec / 3600)}h`
          : `há ${Math.floor(ageSec / 86400)}d`;

  if (ageSec <= freshThresholdSec) {
    return {
      status: 'fresh',
      ageSeconds: ageSec,
      badgeText: `Recente (${ageLabel})`,
    };
  }
  if (ageSec <= maxAllowedSec) {
    return {
      status: 'delayed',
      ageSeconds: ageSec,
      badgeText: `Na janela (${ageLabel})`,
    };
  }
  return {
    status: 'stale',
    ageSeconds: ageSec,
    badgeText: `Amostra antiga (${ageLabel})`,
  };
}

/**
 * Escapa uma célula para exportação CSV segura contra quebra de colunas e CSV Formula Injection (OWASP).
 */
export function escapeCsvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean') {
    return value ? 'SIM' : 'NAO';
  }
  let text = String(value).replace(/\r?\n|\r/g, ' ').trim();
  if (/^[=+\-@]/.test(text) && !/^-[0-9]+(\.[0-9]+)?$/.test(text)) {
    text = `'${text}`;
  }
  if (/[",]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
