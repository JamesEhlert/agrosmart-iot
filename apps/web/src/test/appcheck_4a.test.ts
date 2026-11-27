/**
 * =====================================================================================
 * ARQUIVO: src/test/appcheck_4a.test.ts
 * PROJETO: AgroSmart Precision IoT V5 — Web
 * DATA: 2026-11-23 (UTC)
 * PROPOSITO: Testes da Fase 4.0-A — o App Check nunca deixa o site lento:
 *            tempo limite curto, disjuntor de 5 min com retomada em segundo plano, e o
 *            App Check so liga quando o reCAPTCHA carrega (bloqueado/lento = segue sem ele).
 * =====================================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AppCheck } from 'firebase/app-check';
import {
  APP_CHECK_BREAKER_MS,
  APP_CHECK_HEADER,
  APP_CHECK_TIMEOUT_MS,
  createAppCheckHeaderSource,
} from '../shared/config/appCheck';
import { RECAPTCHA_ENTERPRISE_SCRIPT_URL, waitForRecaptchaEnterprise } from '../shared/config/firebase';
import { clearWebDiagnostics } from '../shared/lib/diagnostics';

const TOKEN = 'teste.appcheck.valor-ficticio-4a01';
const instance = { app: {} } as unknown as AppCheck;
const hang = () => new Promise<never>(() => undefined);
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

let logSpy: MockInstance;
/** Campos dos eventos de diagnostico com esse nome (o diagnostico imprime `[AGRO-DIAG][ts][NIVEL] nome`, campos). */
function eventsNamed(name: string): Record<string, unknown>[] {
  return logSpy.mock.calls
    .filter((c) => typeof c[0] === 'string' && (c[0] as string).endsWith(`] ${name}`))
    .map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

describe('Fase 4.0-A — App Check sem deixar o site lento', () => {
  beforeEach(() => {
    clearWebDiagnostics();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('WEB-4A-01: tempo limite padrao e curto (1,5 s) e o disjuntor dura 5 min', () => {
    expect(APP_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(1500);
    expect(APP_CHECK_BREAKER_MS).toBe(5 * 60 * 1000);
  });

  it('WEB-4A-02: token disponivel => cabecalho, disjuntor fechado', async () => {
    const src = createAppCheckHeaderSource({ ready: Promise.resolve(instance), tokenGetter: async () => ({ token: TOKEN }) });
    expect(await src.getHeaders()).toEqual({ [APP_CHECK_HEADER]: TOKEN });
    expect(src.isCircuitOpen()).toBe(false);
  });

  it('WEB-4A-03: App Check desligado (sem reCAPTCHA) => {} na hora, sem abrir disjuntor nem registrar', async () => {
    const getter = vi.fn();
    const src = createAppCheckHeaderSource({ ready: Promise.resolve(null), tokenGetter: getter });
    const t0 = Date.now();
    expect(await src.getHeaders()).toEqual({});
    expect(Date.now() - t0).toBeLessThan(100);
    expect(getter).not.toHaveBeenCalled();
    expect(src.isCircuitOpen()).toBe(false);
    expect(eventsNamed('appcheck.circuit_open')).toHaveLength(0);
  });

  it('WEB-4A-04: token travado => espera so o tempo limite, abre o disjuntor e as proximas chamadas sao imediatas', async () => {
    const getter = vi.fn(hang);
    const src = createAppCheckHeaderSource({ ready: Promise.resolve(instance), tokenGetter: getter, timeoutMs: 40 });
    const t0 = Date.now();
    expect(await src.getHeaders()).toEqual({});
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(src.isCircuitOpen()).toBe(true);
    const t1 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      expect(await src.getHeaders()).toEqual({});
    }
    expect(Date.now() - t1).toBeLessThan(50);
    expect(getter).toHaveBeenCalledTimes(1);
    const open = eventsNamed('appcheck.circuit_open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ reason: 'timeout' });
  });

  it('WEB-4A-05: App Check ainda ligando (ready pendente) tambem respeita o tempo limite', async () => {
    const src = createAppCheckHeaderSource({ ready: hang(), tokenGetter: async () => ({ token: TOKEN }), timeoutMs: 40 });
    const t0 = Date.now();
    expect(await src.getHeaders()).toEqual({});
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(src.isCircuitOpen()).toBe(true);
  });

  it('WEB-4A-06: erro do SDK (ex.: throttle de 24 h) => {} e disjuntor aberto, sem vazar token', async () => {
    const src = createAppCheckHeaderSource({
      ready: Promise.resolve(instance),
      tokenGetter: async () => { throw new Error('appCheck/initial-throttle 403'); },
    });
    expect(await src.getHeaders()).toEqual({});
    expect(src.isCircuitOpen()).toBe(true);
    expect(eventsNamed('appcheck.circuit_open')[0]).toMatchObject({ reason: 'error' });
  });

  it('WEB-4A-07: com o disjuntor aberto, tenta em segundo plano a cada 30 s e fecha quando o token volta', async () => {
    const clock = makeClock();
    let ok = false;
    const getter = vi.fn(async () => {
      if (!ok) throw new Error('falhou');
      return { token: TOKEN };
    });
    const src = createAppCheckHeaderSource({ ready: Promise.resolve(instance), tokenGetter: getter, now: clock.now });
    expect(await src.getHeaders()).toEqual({});
    expect(src.isCircuitOpen()).toBe(true);
    expect(getter).toHaveBeenCalledTimes(1);

    clock.advance(10_000); // antes de 30 s: nao tenta de novo
    expect(await src.getHeaders()).toEqual({});
    await flush();
    expect(getter).toHaveBeenCalledTimes(1);

    ok = true;
    clock.advance(25_000); // passou de 30 s: tenta em segundo plano (esta chamada nao espera)
    expect(await src.getHeaders()).toEqual({});
    await flush(); await flush();
    expect(getter).toHaveBeenCalledTimes(2);
    expect(src.isCircuitOpen()).toBe(false);
    expect(eventsNamed('appcheck.circuit_closed')).toHaveLength(1);

    expect(await src.getHeaders()).toEqual({ [APP_CHECK_HEADER]: TOKEN });
  });

  it('WEB-4A-08: depois de 5 min o disjuntor fecha sozinho e volta a tentar normalmente', async () => {
    const clock = makeClock();
    let ok = false;
    const src = createAppCheckHeaderSource({
      ready: Promise.resolve(instance),
      tokenGetter: async () => { if (!ok) throw new Error('x'); return { token: TOKEN }; },
      now: clock.now,
      probeIntervalMs: 10 * 60 * 1000, // sem tentativa em segundo plano neste teste
    });
    await src.getHeaders();
    expect(src.isCircuitOpen()).toBe(true);
    ok = true;
    clock.advance(APP_CHECK_BREAKER_MS + 1);
    expect(src.isCircuitOpen()).toBe(false);
    expect(await src.getHeaders()).toEqual({ [APP_CHECK_HEADER]: TOKEN });
  });

  it('WEB-4A-09: o token nunca aparece nos diagnosticos', async () => {
    const src = createAppCheckHeaderSource({ ready: Promise.resolve(instance), tokenGetter: async () => ({ token: TOKEN }) });
    await src.getHeaders();
    const src2 = createAppCheckHeaderSource({
      ready: Promise.resolve(instance),
      tokenGetter: async () => { throw new Error('falhou sem token'); },
    });
    await src2.getHeaders();
    const dump = JSON.stringify(logSpy.mock.calls) + JSON.stringify(globalThis.sessionStorage ?? {});
    expect(dump).not.toContain('valor-ficticio-4a01');
    expect(eventsNamed('appcheck.circuit_open')).toHaveLength(1);
  });

  describe('waitForRecaptchaEnterprise (o App Check so liga com o reCAPTCHA pronto)', () => {
    type Script = { src: string; async: boolean; onload: (() => void) | null; onerror: (() => void) | null };
    function fakeDoc() {
      const added: Script[] = [];
      return {
        added,
        doc: {
          createElement: () => ({ src: '', async: false, onload: null, onerror: null }) as Script,
          head: { appendChild: (el: Script) => { added.push(el); return el; } },
        },
      };
    }

    it('WEB-4A-10: script carrega e fica pronto => true', async () => {
      const { added, doc } = fakeDoc();
      const win: { grecaptcha?: { enterprise?: { ready?: (cb: () => void) => void } } } = {};
      const p = waitForRecaptchaEnterprise(500, win, doc);
      expect(added).toHaveLength(1);
      expect(added[0].src).toBe(RECAPTCHA_ENTERPRISE_SCRIPT_URL);
      win.grecaptcha = { enterprise: { ready: (cb) => cb() } };
      added[0].onload?.();
      expect(await p).toBe(true);
    });

    it('WEB-4A-11: script bloqueado (onerror) => false na hora', async () => {
      const { added, doc } = fakeDoc();
      const t0 = Date.now();
      const p = waitForRecaptchaEnterprise(5000, {}, doc);
      added[0].onerror?.();
      expect(await p).toBe(false);
      expect(Date.now() - t0).toBeLessThan(500);
    });

    it('WEB-4A-12: script carrega mas o reCAPTCHA nunca fica pronto => false no tempo limite', async () => {
      const { added, doc } = fakeDoc();
      const win: { grecaptcha?: { enterprise?: { ready?: (cb: () => void) => void } } } = {};
      const p = waitForRecaptchaEnterprise(60, win, doc);
      win.grecaptcha = { enterprise: { ready: () => undefined } };
      added[0].onload?.();
      expect(await p).toBe(false);
    });

    it('WEB-4A-13: rede que segura o script (nem onload nem onerror) => false no tempo limite', async () => {
      const { doc } = fakeDoc();
      const t0 = Date.now();
      expect(await waitForRecaptchaEnterprise(60, {}, doc)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(1000);
    });

    it('WEB-4A-14: reCAPTCHA ja presente na pagina => nao injeta outro script', async () => {
      const { added, doc } = fakeDoc();
      const win = { grecaptcha: { enterprise: { ready: (cb: () => void) => cb() } } };
      expect(await waitForRecaptchaEnterprise(500, win, doc)).toBe(true);
      expect(added).toHaveLength(0);
    });
  });
});
