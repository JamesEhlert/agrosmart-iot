/**
 * =====================================================================================
 * ARQUIVO: src/shared/api/httpClient.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1B — Erros Estruturados e 429)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T04:53:00Z (UTC)
 * VERSÃO: v5.30.0
 * PROPÓSITO: Cliente HTTP REST autenticado para comunicação com o AWS API Gateway,
 *            instrumentado com logs UTC em milissegundos (diagnostics.ts) e exceções
 *            tipadas com `reason`, `details` e `TooManyRequestsException` (HTTP 429).
 * CHANGELOG:
 * - v5.33.0 (Fase 2C.3): envia o cabecalho `X-Firebase-AppCheck` (quando o token estiver
 *            disponivel) em todas as chamadas a API AWS. Falha do App Check nunca impede a
 *            chamada: o servidor decide (modo log/enforce). O token nunca e registrado.
 * - v5.30.0:
 *   * Adiciona `reason` e `details` em `ApiException` (e subclasses), preenchidos a
 *     partir do corpo JSON de erro da API AWS.
 *   * Cria `TooManyRequestsException` (429) com `retryAfterSec` extraído de
 *     `retry_after_sec` (corpo JSON), fallback para cabeçalho `Retry-After` e padrão 60s.
 * =====================================================================================
 */

import { EnvConfig } from '../config/env';
import { firebaseAuth } from '../config/firebase';
import { APP_CHECK_HEADER, getAppCheckHeaders } from '../config/appCheck';
import { logWebDiagnostic } from '../lib/diagnostics';

const DEFAULT_HTTP_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_AFTER_SEC = 60;

export class ApiException extends Error {
  public readonly statusCode: number;
  public readonly rawBody?: string;
  public readonly reason?: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    rawBody?: string,
    reason?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiException';
    this.statusCode = statusCode;
    this.rawBody = rawBody;
    this.reason = reason;
    this.details = details;
  }
}

export class UnauthorizedException extends ApiException {
  constructor(
    message = 'Sessão expirada. Faça login novamente.',
    rawBody?: string,
    reason?: string,
    details?: Record<string, unknown>,
  ) {
    super(401, message, rawBody, reason, details);
    this.name = 'UnauthorizedException';
  }
}

export class ForbiddenException extends ApiException {
  constructor(
    message = 'Você não tem permissão para acessar esta estação IoT.',
    rawBody?: string,
    reason?: string,
    details?: Record<string, unknown>,
  ) {
    super(403, message, rawBody, reason, details);
    this.name = 'ForbiddenException';
  }
}

export class ConflictException extends ApiException {
  constructor(
    message: string,
    rawBody?: string,
    reason?: string,
    details?: Record<string, unknown>,
  ) {
    super(409, message, rawBody, reason, details);
    this.name = 'ConflictException';
  }
}

export class TooManyRequestsException extends ApiException {
  public readonly retryAfterSec: number;

  constructor(
    message = 'Muitas requisições em sequência. Aguarde antes de tentar novamente.',
    retryAfterSec = DEFAULT_RETRY_AFTER_SEC,
    rawBody?: string,
    reason?: string,
    details?: Record<string, unknown>,
  ) {
    super(429, message, rawBody, reason, details);
    this.name = 'TooManyRequestsException';
    this.retryAfterSec = retryAfterSec;
  }
}

async function getFirebaseBearerToken(
  forceRefresh = false,
  expectedUid?: string,
): Promise<{ token: string; uid: string }> {
  const user = firebaseAuth.currentUser;
  if (!user) {
    throw new UnauthorizedException('Usuário não autenticado.');
  }
  if (expectedUid && user.uid !== expectedUid) {
    throw new UnauthorizedException(
      'A conta ativa mudou durante a requisição. Operação interrompida por segurança.',
    );
  }
  const token = await user.getIdToken(forceRefresh);
  if (!token) {
    throw new UnauthorizedException('Não foi possível obter o token de autenticação.');
  }
  return { token, uid: user.uid };
}

function assertTrustedAwsUrl(url: string): void {
  const base = EnvConfig.aws.apiBaseUrl;
  if (!url.startsWith(`${base}/`) && url !== base) {
    throw new ApiException(
      400,
      'Destino HTTP inválido: o cliente autenticado aceita apenas rotas da API AWS configurada.',
    );
  }
}

interface ParsedErrorPayload {
  message: string;
  reason?: string;
  details?: Record<string, unknown>;
}

function parseErrorPayload(rawText: string, fallbackMessage: string): ParsedErrorPayload {
  if (!rawText) {
    return { message: fallbackMessage };
  }
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const message =
        (typeof record.message === 'string' && record.message.trim()) ||
        (typeof record.error === 'string' && record.error.trim()) ||
        fallbackMessage;
      const reason =
        typeof record.reason === 'string' && record.reason.trim()
          ? record.reason.trim()
          : undefined;
      return {
        message,
        reason,
        details: record,
      };
    }
  } catch {
    // Corpo não é JSON; mantém fallback
  }
  return { message: fallbackMessage };
}

function parsePositiveSeconds(rawValue: unknown): number | null {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    return Math.max(1, Math.trunc(rawValue));
  }
  if (typeof rawValue === 'string') {
    const clean = rawValue.trim();
    if (/^\d+(\.\d+)?$/.test(clean)) {
      const n = Number(clean);
      if (Number.isFinite(n) && n > 0) {
        return Math.max(1, Math.trunc(n));
      }
    }
  }
  return null;
}

function resolveRetryAfterSec(
  details?: Record<string, unknown>,
  retryAfterHeader?: string | null,
): number {
  const fromBody = parsePositiveSeconds(details?.retry_after_sec);
  if (fromBody !== null) {
    return fromBody;
  }

  if (typeof retryAfterHeader === 'string' && retryAfterHeader.trim()) {
    const fromHeaderNumber = parsePositiveSeconds(retryAfterHeader);
    if (fromHeaderNumber !== null) {
      return fromHeaderNumber;
    }
    const parsedDateMs = Date.parse(retryAfterHeader.trim());
    if (Number.isFinite(parsedDateMs)) {
      const diffSec = Math.ceil((parsedDateMs - Date.now()) / 1000);
      if (diffSec > 0) {
        return diffSec;
      }
    }
  }

  return DEFAULT_RETRY_AFTER_SEC;
}

function throwForStatus(
  statusCode: number,
  rawText: string,
  defaultMsg: string,
  retryAfterHeader?: string | null,
): never {
  const { message, reason, details } = parseErrorPayload(rawText, defaultMsg);
  if (statusCode === 401) throw new UnauthorizedException(message, rawText, reason, details);
  if (statusCode === 403) throw new ForbiddenException(message, rawText, reason, details);
  if (statusCode === 409) throw new ConflictException(message, rawText, reason, details);
  if (statusCode === 429) {
    const retryAfterSec = resolveRetryAfterSec(details, retryAfterHeader);
    throw new TooManyRequestsException(message, retryAfterSec, rawText, reason, details);
  }
  throw new ApiException(statusCode, message, rawText, reason, details);
}

export interface AwsRequestOptions {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface AttemptResult {
  status: number;
  ok: boolean;
  rawText: string;
  retryAfterHeader: string | null;
  uid: string;
  elapsedMs: number;
}

export async function awsAuthenticatedFetch<T = unknown>(
  url: string,
  options: AwsRequestOptions = {},
): Promise<T> {
  assertTrustedAwsUrl(url);

  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const serializedBody = options.body ? JSON.stringify(options.body) : undefined;
  const cmdId =
    options.body && typeof options.body.command_id === 'string'
      ? options.body.command_id
      : undefined;
  const devId =
    options.body && typeof options.body.device_id === 'string'
      ? options.body.device_id
      : undefined;

  const executeAttempt = async (
    attemptNum: number,
    forceRefreshToken: boolean,
    expectedUid?: string,
  ): Promise<AttemptResult> => {
    if (options.signal?.aborted) {
      throw new DOMException('Requisição cancelada', 'AbortError');
    }

    const t0 = performance.now();
    const controller = new AbortController();
    let timedOut = false;

    const timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const { token, uid } = await getFirebaseBearerToken(forceRefreshToken, expectedUid);
      const appCheckHeaders = await getAppCheckHeaders();

      if (controller.signal.aborted) {
        if (timedOut) {
          throw new ApiException(
            408,
            `Tempo limite de ${Math.round(timeoutMs / 1000)}s excedido ao comunicar com a AWS.`,
          );
        }
        throw new DOMException('Requisição cancelada', 'AbortError');
      }

      logWebDiagnostic('DEBUG', 'http.request.start', {
        method,
        url,
        attempt: attemptNum,
        force_refresh_token: forceRefreshToken,
        uid_prefix: uid.slice(0, 8),
        device_id: devId,
        command_id: cmdId,
        request_body: options.body,
        has_app_check: Boolean(appCheckHeaders[APP_CHECK_HEADER]),
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...appCheckHeaders,
      };

      const response = await fetch(url, {
        method,
        headers,
        body: serializedBody,
        signal: controller.signal,
      });

      const rawText = await response.text();
      const retryAfterHeader =
        typeof response.headers?.get === 'function'
          ? response.headers.get('retry-after')
          : null;
      const elapsedMs = Math.round(performance.now() - t0);

      logWebDiagnostic(
        response.ok ? 'INFO' : 'WARN',
        'http.request.end',
        {
          method,
          url,
          attempt: attemptNum,
          status_code: response.status,
          ok: response.ok,
          elapsed_ms: elapsedMs,
          uid_prefix: uid.slice(0, 8),
          device_id: devId,
          command_id: cmdId,
        },
      );

      return {
        status: response.status,
        ok: response.ok,
        rawText,
        retryAfterHeader,
        uid,
        elapsedMs,
      };
    } catch (err: unknown) {
      const elapsedMs = Math.round(performance.now() - t0);
      // v5.36.0 (WEB-02): cancelamento pedido pela tela (troca de página) não é erro.
      const cancelledByUi = (err as Error)?.name === 'AbortError' && !timedOut;
      logWebDiagnostic(cancelledByUi ? 'DEBUG' : 'ERROR', 'http.request.exception', {
        method,
        url,
        attempt: attemptNum,
        timed_out: timedOut,
        elapsed_ms: elapsedMs,
        device_id: devId,
        command_id: cmdId,
        error_name: (err as Error)?.name || 'Error',
        error_message: (err as Error)?.message || String(err),
      });

      if (timedOut) {
        throw new ApiException(
          408,
          `Tempo limite de ${Math.round(timeoutMs / 1000)}s excedido na resposta da AWS.`,
        );
      }
      throw err;
    } finally {
      globalThis.clearTimeout(timeoutId);
      if (options.signal) {
        options.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  };

  let attempt = await executeAttempt(1, false);

  if (attempt.status === 401) {
    logWebDiagnostic('WARN', 'http.request.retry_401', {
      method,
      url,
      uid_prefix: attempt.uid.slice(0, 8),
      command_id: cmdId,
    });
    attempt = await executeAttempt(2, true, attempt.uid);
  }

  if (!attempt.ok) {
    throwForStatus(
      attempt.status,
      attempt.rawText,
      'Falha na comunicação com a API da AWS.',
      attempt.retryAfterHeader,
    );
  }

  if (!attempt.rawText || !attempt.rawText.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(attempt.rawText) as T;
  } catch {
    throw new ApiException(
      502,
      'A API retornou uma resposta em formato inválido (JSON malformado).',
      attempt.rawText,
    );
  }
}
