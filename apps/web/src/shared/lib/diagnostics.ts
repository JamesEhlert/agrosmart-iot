/**
 * =====================================================================================
 * ARQUIVO: src/shared/lib/diagnostics.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 4.0-B — Diagnostico profissional)
 * DATA DE ATUALIZAÇÃO: 2026-11-23T21:00:00Z (UTC)
 * VERSÃO: v5.33.0
 * PROPÓSITO: Gravador estruturado de logs de diagnóstico em UTC (JSONL) para testes de
 *            ponta a ponta. Registra eventos de UI, HTTP, listeners Firestore, telemetria,
 *            erros globais, rede e desempenho, com sanitização estrita de segredos,
 *            passes, JWTs, IP e GPS.
 * CHANGELOG:
 * - v5.33.0 (Fase 4.0-B):
 *   * Sessao automatica por aba (`session_id`, ex.: W7F3A9C) + numero sequencial `seq`
 *     em cada registro, para correlacionar com AWS/ESP32 sem digitar nada.
 *   * `fw_web` vem do package.json (appInfo.ts), nao mais fixo no codigo.
 *   * Rotulo opcional do teste (sanitizado); sem rotulo, usa a propria sessao.
 *   * Exportacao com cabecalho (versao, build, sessao, contagem por nivel, navegador,
 *     fuso) e nome unico: agrosmart-web-log_<UTC>_<sessao>[_<rotulo>].jsonl.
 *   * "Novo teste" (limpar) inicia uma sessao nova.
 *   * Captura global: erros JS, promessas rejeitadas, online/offline, visibilidade
 *     da aba e tempos de carregamento da pagina.
 * - v5.29.0-diag: Amplia chaves sensíveis e mascara códigos `AGRO-XXXX-XXXX` e JWTs.
 * =====================================================================================
 */

import { APP_BUILD_UTC, APP_VERSION_LABEL } from '../config/appInfo';

export type DiagnosticLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface WebDiagnosticRecord {
  schema_version: 1;
  event_ts_utc: string;
  monotonic_ms: number;
  session_id: string;
  seq: number;
  test_run_id: string;
  component: 'web_app';
  fw_web: string;
  level: DiagnosticLevel;
  event_name: string;
  [key: string]: unknown;
}

export interface DiagnosticsSummary {
  total: number;
  counts: Record<DiagnosticLevel, number>;
  sessionId: string;
  sessionStartedUtc: string;
  label: string;
  lastEventName: string | null;
  lastEventUtc: string | null;
}

const STORAGE_KEY = 'agrosmart_web_diag_jsonl_v2';
const SESSION_KEY = 'agrosmart_web_diag_session_v2';
const LABEL_KEY = 'agrosmart_web_diag_label_v2';
const MAX_BUFFER_RECORDS = 4000;
const LABEL_MAX = 32;

const SENSITIVE_KEYS = new Set([
  'authorization',
  'token',
  'idtoken',
  'refreshtoken',
  'custom_token',
  'customtoken',
  'password',
  'demo_token',
  'demotoken',
  'demo_pass_token',
  'demopasstoken',
  'plain_code',
  'plaincode',
  'demo_session_id',
  'demosessionid',
  'demo_sid',
  'demosid',
  'demo_token_hash',
  'demotokenhash',
  'ota_url',
  'otaurl',
  'latitude',
  'longitude',
  'lat',
  'lon',
  'ip',
  'lastip',
  'source_ip',
  'sourceip',
  'private_key',
  'token_secret',
  'x-firebase-appcheck',
  'appcheck_token',
]);

const DEMO_CODE_INLINE_RE = /\bAGRO-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}\b/gi;
const JWT_INLINE_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

interface SessionInfo {
  id: string;
  startedUtc: string;
  seq: number;
}

let memoryBuffer: WebDiagnosticRecord[] = [];
let session: SessionInfo | null = null;
let initialized = false;
let globalsInstalled = false;
let labelMemory = '';
const countListeners = new Set<(count: number) => void>();
const summaryListeners = new Set<(summary: DiagnosticsSummary) => void>();

function storageGet(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // Cota do sessionStorage ou armazenamento indisponivel: segue so em memoria.
  }
}

function storageRemove(key: string): void {
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    // ignore
  }
}

/** "2026-11-23T20:15:44.781Z" -> "20261123T201544Z" */
export function compactUtc(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

function randomTag(): string {
  try {
    const bytes = new Uint8Array(3);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  } catch {
    return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0').toUpperCase();
  }
}

function newSession(): SessionInfo {
  const s: SessionInfo = { id: `W${randomTag()}`, startedUtc: new Date().toISOString(), seq: 0 };
  storageSet(SESSION_KEY, JSON.stringify(s));
  return s;
}

function persistSession(): void {
  if (session) storageSet(SESSION_KEY, JSON.stringify(session));
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  try {
    const rawSession = storageGet(SESSION_KEY);
    const parsed = rawSession ? (JSON.parse(rawSession) as SessionInfo) : null;
    session =
      parsed && typeof parsed.id === 'string' && typeof parsed.seq === 'number' ? parsed : newSession();
  } catch {
    session = newSession();
  }
  try {
    const raw = storageGet(STORAGE_KEY);
    if (raw) {
      memoryBuffer = raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as WebDiagnosticRecord;
          } catch {
            return null;
          }
        })
        .filter((item): item is WebDiagnosticRecord => item !== null);
    }
  } catch {
    memoryBuffer = [];
  }
}

function currentSession(): SessionInfo {
  ensureInitialized();
  if (!session) session = newSession();
  return session;
}

export function getDiagnosticsSummary(): DiagnosticsSummary {
  const s = currentSession();
  const counts: Record<DiagnosticLevel, number> = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
  for (const r of memoryBuffer) {
    if (r.level in counts) counts[r.level] += 1;
  }
  const last = memoryBuffer.length > 0 ? memoryBuffer[memoryBuffer.length - 1] : null;
  return {
    total: memoryBuffer.length,
    counts,
    sessionId: s.id,
    sessionStartedUtc: s.startedUtc,
    label: getTestLabel(),
    lastEventName: last?.event_name ?? null,
    lastEventUtc: last?.event_ts_utc ?? null,
  };
}

function notifyListeners(): void {
  const count = memoryBuffer.length;
  countListeners.forEach((cb) => {
    try {
      cb(count);
    } catch {
      // Ignora erro em listener de UI
    }
  });
  if (summaryListeners.size > 0) {
    const summary = getDiagnosticsSummary();
    summaryListeners.forEach((cb) => {
      try {
        cb(summary);
      } catch {
        // Ignora erro em listener de UI
      }
    });
  }
}

function sanitizeValue(key: string, value: unknown): unknown {
  const lowerKey = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lowerKey)) {
    return '***REDACTED***';
  }
  if (typeof value === 'string') {
    let cleaned = value;
    if (cleaned.startsWith('Bearer ')) {
      return 'Bearer ***REDACTED***';
    }
    if (cleaned.includes('X-Amz-Signature=')) {
      cleaned = cleaned.split('?')[0] + '?***PRESIGNED_REDACTED***';
    }
    cleaned = cleaned.replace(DEMO_CODE_INLINE_RE, 'AGRO-****-****');
    cleaned = cleaned.replace(JWT_INLINE_RE, '***JWT_REDACTED***');
    return cleaned;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(key, item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeValue(k, v);
    }
    return out;
  }
  return value;
}

/** Rotulo opcional do teste: so letras, numeros, "-" e "_" (max 32). */
export function sanitizeTestLabel(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, LABEL_MAX);
}

export function getTestLabel(): string {
  return sanitizeTestLabel(storageGet(LABEL_KEY) ?? labelMemory);
}

export function setTestLabel(raw: string): string {
  const clean = sanitizeTestLabel(raw);
  const before = getTestLabel();
  labelMemory = clean;
  if (clean) storageSet(LABEL_KEY, clean);
  else storageRemove(LABEL_KEY);
  if (clean !== before) {
    logWebDiagnostic('INFO', 'diagnostics.label_set', { label: clean || null });
  }
  return clean;
}

/** Identificador da rodada gravado em cada registro: o rotulo, ou a propria sessao. */
export function getActiveTestRunId(): string {
  return getTestLabel() || currentSession().id;
}

/** Compatibilidade com chamadas antigas. */
export function setActiveTestRunId(runId: string): void {
  setTestLabel(runId);
}

export function logWebDiagnostic(
  level: DiagnosticLevel,
  eventName: string,
  fields: Record<string, unknown> = {},
): void {
  const s = currentSession();

  const sanitizedFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) {
      sanitizedFields[k] = sanitizeValue(k, v);
    }
  }

  s.seq += 1;
  const nowIsoUtc = new Date().toISOString();
  const record: WebDiagnosticRecord = {
    schema_version: 1,
    event_ts_utc: nowIsoUtc,
    monotonic_ms: typeof performance !== 'undefined' ? Math.round(performance.now()) : 0,
    session_id: s.id,
    seq: s.seq,
    test_run_id: getTestLabel() || s.id,
    component: 'web_app',
    fw_web: APP_VERSION_LABEL,
    level,
    event_name: eventName,
    ...sanitizedFields,
  };

  memoryBuffer.push(record);
  if (memoryBuffer.length > MAX_BUFFER_RECORDS) {
    memoryBuffer.shift();
  }

  persistSession();
  storageSet(STORAGE_KEY, memoryBuffer.map((r) => JSON.stringify(r)).join('\n'));

  // eslint-disable-next-line no-console
  console.log(`[AGRO-DIAG][${nowIsoUtc}][${level}] ${eventName}`, sanitizedFields);
  notifyListeners();
}

export function getWebDiagnosticsCount(): number {
  ensureInitialized();
  return memoryBuffer.length;
}

export function subscribeWebDiagnosticsCount(listener: (count: number) => void): () => void {
  ensureInitialized();
  countListeners.add(listener);
  listener(memoryBuffer.length);
  return () => {
    countListeners.delete(listener);
  };
}

export function subscribeWebDiagnostics(listener: (summary: DiagnosticsSummary) => void): () => void {
  ensureInitialized();
  summaryListeners.add(listener);
  listener(getDiagnosticsSummary());
  return () => {
    summaryListeners.delete(listener);
  };
}

/** "Novo teste": apaga os registros e inicia uma sessao nova (o rotulo e mantido). */
export function clearWebDiagnostics(): void {
  ensureInitialized();
  const previous = session?.id ?? null;
  memoryBuffer = [];
  storageRemove(STORAGE_KEY);
  session = newSession();
  logWebDiagnostic('INFO', 'diagnostics.buffer_cleared', {
    note: 'Registro zerado pelo operador (novo teste)',
    previous_session_id: previous,
    app_version: APP_VERSION_LABEL,
  });
}

/** Nome unico do arquivo: agrosmart-web-log_<UTC>_<sessao>[_<rotulo>].jsonl */
export function buildExportFileName(now: Date = new Date()): string {
  const s = currentSession();
  const label = getTestLabel();
  return `agrosmart-web-log_${compactUtc(now)}_${s.id}${label ? `_${label}` : ''}.jsonl`;
}

function environmentInfo(): Record<string, unknown> {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  let timezone = 'n/d';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'n/d';
  } catch {
    // ignore
  }
  const win = globalThis as unknown as { innerWidth?: number; innerHeight?: number; location?: Location };
  return {
    user_agent: nav?.userAgent ?? 'n/d',
    language: nav?.language ?? 'n/d',
    online: nav?.onLine ?? null,
    timezone,
    tz_offset_min: -new Date().getTimezoneOffset(),
    viewport: win.innerWidth && win.innerHeight ? `${win.innerWidth}x${win.innerHeight}` : 'n/d',
    url_path: win.location?.pathname ?? 'n/d',
  };
}

/** Conteudo JSONL exportado: 1 linha de cabecalho + os registros. */
export function buildDiagnosticsJsonl(now: Date = new Date()): string {
  const summary = getDiagnosticsSummary();
  const header = {
    schema_version: 1,
    event_ts_utc: now.toISOString(),
    session_id: summary.sessionId,
    component: 'web_app',
    fw_web: APP_VERSION_LABEL,
    level: 'INFO',
    event_name: 'diagnostics.export_header',
    build_utc: APP_BUILD_UTC,
    session_started_utc: summary.sessionStartedUtc,
    label: summary.label || null,
    records: summary.total,
    counts: summary.counts,
    first_event_utc: memoryBuffer[0]?.event_ts_utc ?? null,
    last_event_utc: summary.lastEventUtc,
    ...environmentInfo(),
  };
  return [JSON.stringify(sanitizeValue('header', header)), ...memoryBuffer.map((r) => JSON.stringify(r))].join('\n') + '\n';
}

export function downloadWebDiagnosticsJsonl(): string {
  ensureInitialized();
  const fileName = buildExportFileName();
  logWebDiagnostic('INFO', 'diagnostics.export_triggered', {
    exported_records_count: memoryBuffer.length + 1,
    file_name: fileName,
  });
  const blob = new Blob([buildDiagnosticsJsonl()], { type: 'application/x-ndjson;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return fileName;
}

function pathOnly(src: unknown): string {
  const s = String(src ?? '');
  try {
    return new URL(s).pathname;
  } catch {
    return s.split('?')[0].slice(0, 160);
  }
}

/**
 * Captura global (instalada uma unica vez em main.tsx): inicio do app, tempos de
 * carregamento, erros JS, promessas rejeitadas, rede e visibilidade da aba.
 */
export function installGlobalDiagnostics(): void {
  if (globalsInstalled || typeof window === 'undefined') return;
  globalsInstalled = true;

  logWebDiagnostic('INFO', 'app.start', {
    app_version: APP_VERSION_LABEL,
    build_utc: APP_BUILD_UTC,
    ...environmentInfo(),
  });

  const reportNavigation = () => {
    try {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (!nav) return;
      logWebDiagnostic('INFO', 'perf.page_load', {
        navigation_type: nav.type,
        ttfb_ms: Math.round(nav.responseStart - nav.requestStart),
        dom_ready_ms: Math.round(nav.domContentLoadedEventEnd),
        load_ms: Math.round(nav.loadEventEnd),
        transfer_kb: Math.round((nav.transferSize || 0) / 1024),
      });
    } catch {
      // ignore
    }
  };
  if (document.readyState === 'complete') setTimeout(reportNavigation, 0);
  else window.addEventListener('load', () => setTimeout(reportNavigation, 0), { once: true });

  window.addEventListener('error', (ev: ErrorEvent) => {
    logWebDiagnostic('ERROR', 'window.error', {
      error_message: String(ev.message || '').slice(0, 300),
      source: pathOnly(ev.filename),
      line: ev.lineno ?? null,
      column: ev.colno ?? null,
    });
  });
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const reason = ev.reason as { name?: string; message?: string } | undefined;
    logWebDiagnostic('ERROR', 'window.unhandled_rejection', {
      error_name: reason?.name ?? typeof ev.reason,
      error_message: String(reason?.message ?? ev.reason ?? '').slice(0, 300),
    });
  });
  window.addEventListener('online', () => logWebDiagnostic('INFO', 'network.online', {}));
  window.addEventListener('offline', () => logWebDiagnostic('WARN', 'network.offline', {}));
  document.addEventListener('visibilitychange', () =>
    logWebDiagnostic('DEBUG', 'page.visibility', { state: document.visibilityState }),
  );
  window.addEventListener('pagehide', () => logWebDiagnostic('INFO', 'page.hide', {}));
}
