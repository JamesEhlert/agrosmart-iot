/**
 * =====================================================================================
 * ARQUIVO: src/test/appcheck_2c.test.ts
 * PROJETO: AgroSmart Precision IoT V5 — Web
 * DATA: 2026-11-23 (UTC)
 * PROPOSITO: Testes da Fase 2C.3 — envio do token do Firebase App Check, sem bloquear
 *            a chamada quando o atestado falhar, sem registrar o token, e CSP do Hosting.
 * =====================================================================================
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const acMocks = vi.hoisted(() => ({ headers: vi.fn() }));
const authMocks = vi.hoisted(() => ({ signInWithCustomToken: vi.fn() }));

vi.mock('../shared/config/appCheck', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/config/appCheck')>();
  return { ...actual, getAppCheckHeaders: () => acMocks.headers() };
});
vi.mock('firebase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/auth')>();
  return { ...actual, signInWithCustomToken: (...a: unknown[]) => authMocks.signInWithCustomToken(...a) };
});

import { awsAuthenticatedFetch } from '../shared/api/httpClient';
import { APP_CHECK_HEADER, buildAppCheckHeaders } from '../shared/config/appCheck';
import { EnvConfig } from '../shared/config/env';
import { firebaseAppCheckReady, firebaseAuth, getFirebaseAppCheck } from '../shared/config/firebase';
import { claimDemoPassAndLogin } from '../features/auth/api/authService';
import { clearWebDiagnostics, logWebDiagnostic } from '../shared/lib/diagnostics';

const TOKEN = 'teste.appcheck.valor-ficticio-0001';
const fakeInstance = { app: {} } as unknown as import('firebase/app-check').AppCheck;

function setUser() {
  Object.defineProperty(firebaseAuth, 'currentUser', {
    get: () => ({ uid: 'user-james-1', getIdToken: vi.fn().mockResolvedValue('jwt-id-token') }),
    configurable: true,
  });
}

describe('Fase 2C.3 — Firebase App Check no web', () => {
  beforeEach(() => {
    clearWebDiagnostics();
    acMocks.headers.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(firebaseAuth, 'currentUser', { get: () => null, configurable: true });
  });

  it('WEB-2C-01: buildAppCheckHeaders devolve o cabecalho quando o token existe', async () => {
    const h = await buildAppCheckHeaders(fakeInstance, async () => ({ token: TOKEN }));
    expect(h).toEqual({ [APP_CHECK_HEADER]: TOKEN });
    expect(APP_CHECK_HEADER).toBe('X-Firebase-AppCheck');
  });

  it('WEB-2C-02: sem instancia, erro ou token vazio => sem cabecalho (nunca lanca)', async () => {
    expect(await buildAppCheckHeaders(null, async () => ({ token: TOKEN }))).toEqual({});
    expect(await buildAppCheckHeaders(fakeInstance, async () => { throw new Error('appCheck/recaptcha-error'); })).toEqual({});
    expect(await buildAppCheckHeaders(fakeInstance, async () => ({ token: '  ' }))).toEqual({});
  });

  it('WEB-2C-03: token lento => tempo limite e segue sem cabecalho', async () => {
    const t0 = Date.now();
    const h = await buildAppCheckHeaders(fakeInstance, () => new Promise(() => undefined), 50);
    expect(h).toEqual({});
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('WEB-2C-04: App Check fica desligado nos testes (MODE=test)', async () => {
    expect(await firebaseAppCheckReady).toBeNull();
    expect(getFirebaseAppCheck()).toBeNull();
  });

  it('WEB-2C-05: awsAuthenticatedFetch envia Authorization e X-Firebase-AppCheck', async () => {
    setUser();
    acMocks.headers.mockResolvedValue({ [APP_CHECK_HEADER]: TOKEN });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await awsAuthenticatedFetch(EnvConfig.aws.commandEndpoint, { method: 'POST', body: { device_id: 'ESP32-X' } });
    const h = (fetchSpy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(h.Authorization).toBe('Bearer jwt-id-token');
    expect(h[APP_CHECK_HEADER]).toBe(TOKEN);
  });

  it('WEB-2C-06: falha do App Check NAO impede a chamada (sem cabecalho)', async () => {
    setUser();
    acMocks.headers.mockResolvedValue({});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const r = await awsAuthenticatedFetch<{ ok: boolean }>(EnvConfig.aws.telemetryEndpoint);
    expect(r.ok).toBe(true);
    const h = (fetchSpy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('x-firebase-appcheck');
  });

  it('WEB-2C-07: claimDemoPassAndLogin envia X-Firebase-AppCheck e continua SEM Authorization', async () => {
    acMocks.headers.mockResolvedValue({ [APP_CHECK_HEADER]: TOKEN });
    const user = { uid: 'demo-uid-1', getIdToken: vi.fn().mockResolvedValue('x') };
    authMocks.signInWithCustomToken.mockResolvedValueOnce({ user });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, custom_token: 'ct', demo_session_id: 'dsid-001122334455' }), { status: 200 }),
    );
    await claimDemoPassAndLogin('AGRO-7K9M-X4P2', 'ESP32-AgroSmart-Station-V5');
    const h = (fetchSpy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    const keys = Object.keys(h).map((k) => k.toLowerCase());
    expect(keys).toContain('x-firebase-appcheck');
    expect(keys).not.toContain('authorization');
  });

  it('WEB-2C-08: o token do App Check nunca aparece nos diagnosticos', async () => {
    setUser();
    acMocks.headers.mockResolvedValue({ [APP_CHECK_HEADER]: TOKEN });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await awsAuthenticatedFetch(EnvConfig.aws.telemetryEndpoint);
    await buildAppCheckHeaders(fakeInstance, async () => { throw new Error('falhou'); });
    logWebDiagnostic('INFO', 'marcador', {});
    const dump = JSON.stringify(spy.mock.calls) + JSON.stringify(globalThis.localStorage ?? {});
    expect(dump).not.toContain('valor-ficticio-0001');
  });

  it('WEB-2C-09: CSP do Hosting libera o reCAPTCHA sem afrouxar o resto', () => {
    const cfg = JSON.parse(readFileSync('firebase.json', 'utf8'));
    const csp: string = cfg.hosting.headers[0].headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value;
    const dir = (n: string) => (csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(n + ' ')) ?? '');
    expect(dir('script-src')).toContain('https://www.google.com/recaptcha/');
    expect(dir('frame-src')).toContain('https://www.google.com/recaptcha/');
    expect(dir('frame-src')).toContain('https://recaptcha.google.com/recaptcha/');
    expect(dir('connect-src')).toContain('https://www.google.com/recaptcha/');
    expect(dir('connect-src')).toContain('https://*.googleapis.com');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(dir('script-src')).not.toContain("'unsafe-inline'");
  });

  it('WEB-2C-10: site key configurada e publica (formato reCAPTCHA)', () => {
    expect(EnvConfig.appCheck.recaptchaEnterpriseSiteKey).toMatch(/^6L[0-9A-Za-z_-]{38}$/);
  });
});
