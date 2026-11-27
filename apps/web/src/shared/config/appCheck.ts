/**
 * =====================================================================================
 * ARQUIVO: src/shared/config/appCheck.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 2C.3 / 4.0-A — Firebase App Check)
 * DATA DE CRIACAO: 2026-11-23T09:30:00Z (UTC)
 * VERSAO: v5.34.0
 * PROPOSITO: Obtem o token do Firebase App Check para o cabecalho `X-Firebase-AppCheck`
 *            das chamadas REST a AWS. Nunca lanca excecao, nunca registra o token e nunca
 *            bloqueia a chamada: sem token, segue sem o cabecalho (o servidor esta em modo log).
 * CHANGELOG:
 * - v5.34.0 (Fase 4.0-A): espera no maximo 1,5 s (antes 6 s) e tem um "disjuntor": depois de
 *            uma falha ou demora, para de esperar pelo token por 5 min (chamadas seguem na hora,
 *            sem cabecalho) e tenta de novo em segundo plano a cada 30 s; volta sozinho quando o
 *            token chega. Assim o App Check nunca deixa o site lento.
 * - v5.33.0 (Fase 2C.3): versao inicial (tempo limite de 6 s por chamada).
 * =====================================================================================
 */

import { getToken, type AppCheck, type AppCheckTokenResult } from 'firebase/app-check';
import { firebaseAppCheckReady } from './firebase';
import { logWebDiagnostic } from '../lib/diagnostics';

export const APP_CHECK_HEADER = 'X-Firebase-AppCheck';
/** Espera maxima por chamada antes de seguir sem o token. */
export const APP_CHECK_TIMEOUT_MS = 1500;
/** Depois de uma falha, quanto tempo as chamadas seguem direto, sem esperar o token. */
export const APP_CHECK_BREAKER_MS = 5 * 60 * 1000;
/** Intervalo minimo entre as tentativas em segundo plano com o disjuntor aberto. */
export const APP_CHECK_PROBE_INTERVAL_MS = 30 * 1000;
/** Tempo limite de cada tentativa em segundo plano. */
export const APP_CHECK_PROBE_TIMEOUT_MS = 10 * 1000;

type TokenGetter = (instance: AppCheck, forceRefresh: boolean) => Promise<AppCheckTokenResult>;
type Outcome = { token: string } | { fail: string };

const TIMEOUT = Symbol('appcheck_timeout');

/** Corre `p` contra um relogio; devolve TIMEOUT se o relogio vencer. Limpa o relogio sempre. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([p, clock]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errorFields(err: unknown): Record<string, string> {
  return {
    error_name: (err as Error)?.name || 'Error',
    error_message: String((err as Error)?.message || '').slice(0, 120),
  };
}

/**
 * Versao simples e testavel (sem disjuntor): recebe a instancia, a funcao de token e o tempo limite.
 */
export async function buildAppCheckHeaders(
  instance: AppCheck | null,
  tokenGetter: TokenGetter,
  timeoutMs: number = APP_CHECK_TIMEOUT_MS,
): Promise<Record<string, string>> {
  if (!instance) {
    return {};
  }
  try {
    const result = await withTimeout(tokenGetter(instance, false), timeoutMs);
    if (result === TIMEOUT) {
      throw new Error('appcheck_timeout');
    }
    const token = typeof result?.token === 'string' ? result.token.trim() : '';
    return token ? { [APP_CHECK_HEADER]: token } : {};
  } catch (err: unknown) {
    logWebDiagnostic('WARN', 'appcheck.token_unavailable', errorFields(err));
    return {};
  }
}

export interface AppCheckHeaderSourceOptions {
  ready: Promise<AppCheck | null>;
  tokenGetter: TokenGetter;
  timeoutMs?: number;
  breakerMs?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  now?: () => number;
}

export interface AppCheckHeaderSource {
  getHeaders(): Promise<Record<string, string>>;
  isCircuitOpen(): boolean;
}

/**
 * Fonte de cabecalhos com disjuntor. Regras:
 * - App Check desligado (sem reCAPTCHA, testes): devolve `{}` na hora, sem esperar;
 * - token pronto: devolve o cabecalho;
 * - falha ou demora maior que `timeoutMs`: abre o disjuntor; por `breakerMs` as chamadas
 *   seguem na hora sem cabecalho, e uma tentativa em segundo plano (no maximo a cada
 *   `probeIntervalMs`) fecha o disjuntor assim que o token voltar.
 */
export function createAppCheckHeaderSource(opts: AppCheckHeaderSourceOptions): AppCheckHeaderSource {
  const timeoutMs = opts.timeoutMs ?? APP_CHECK_TIMEOUT_MS;
  const breakerMs = opts.breakerMs ?? APP_CHECK_BREAKER_MS;
  const probeIntervalMs = opts.probeIntervalMs ?? APP_CHECK_PROBE_INTERVAL_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? APP_CHECK_PROBE_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());

  let openUntil = 0;
  let lastProbeAt = 0;
  let probing = false;

  async function attempt(): Promise<Outcome> {
    const instance = await opts.ready;
    if (!instance) {
      return { fail: 'disabled' };
    }
    const result = await opts.tokenGetter(instance, false);
    const token = typeof result?.token === 'string' ? result.token.trim() : '';
    return token ? { token } : { fail: 'empty_token' };
  }

  function isCircuitOpen(): boolean {
    return now() < openUntil;
  }

  function openCircuit(reason: string, extra: Record<string, string> = {}): void {
    const wasOpen = isCircuitOpen();
    openUntil = now() + breakerMs;
    lastProbeAt = now();
    if (!wasOpen) {
      logWebDiagnostic('WARN', 'appcheck.circuit_open', {
        reason,
        retry_in_s: Math.round(breakerMs / 1000),
        ...extra,
      });
    }
  }

  function probe(): void {
    if (probing || now() - lastProbeAt < probeIntervalMs) {
      return;
    }
    probing = true;
    lastProbeAt = now();
    withTimeout(attempt(), probeTimeoutMs)
      .then((res) => {
        if (res !== TIMEOUT && 'token' in res && isCircuitOpen()) {
          openUntil = 0;
          logWebDiagnostic('INFO', 'appcheck.circuit_closed', {});
        }
      })
      .catch(() => undefined)
      .finally(() => {
        probing = false;
      });
  }

  async function getHeaders(): Promise<Record<string, string>> {
    if (isCircuitOpen()) {
      probe();
      return {};
    }
    try {
      const res = await withTimeout(attempt(), timeoutMs);
      if (res === TIMEOUT) {
        openCircuit('timeout', { waited_ms: String(timeoutMs) });
        return {};
      }
      if ('token' in res) {
        return { [APP_CHECK_HEADER]: res.token };
      }
      if (res.fail === 'disabled') {
        return {};
      }
      openCircuit(res.fail);
      return {};
    } catch (err: unknown) {
      openCircuit('error', errorFields(err));
      return {};
    }
  }

  return { getHeaders, isCircuitOpen };
}

const defaultSource = createAppCheckHeaderSource({
  ready: firebaseAppCheckReady,
  tokenGetter: getToken,
});

/** Cabecalhos do App Check para chamadas a API AWS (vazio se indisponivel; nunca demora > 1,5 s). */
export function getAppCheckHeaders(): Promise<Record<string, string>> {
  return defaultSource.getHeaders();
}
