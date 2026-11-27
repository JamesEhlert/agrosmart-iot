/**
 * =====================================================================================
 * ARQUIVO: src/shared/config/firebase.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-23T11:30:00Z
 * VERSÃO: v5.34.0
 * PROPÓSITO: Inicializa e exporta as instâncias Singleton do Firebase Authentication,
 *            Cloud Firestore e provedor Google OAuth 2.0.
 * CHANGELOG:
 * - v5.34.0 (Fase 4.0-A): o App Check so e ligado DEPOIS que o script do reCAPTCHA Enterprise
 *            carrega e fica pronto (limite de 4 s, em segundo plano). Motivo: o SDK do App Check
 *            espera o reCAPTCHA sem tempo limite, e o Auth e o Firestore esperam o App Check; numa
 *            rede ou extensao que bloqueia o reCAPTCHA, o site travaria. Agora, sem reCAPTCHA, o
 *            site segue sem App Check (o servidor esta em modo log). O Firestore aceita o App
 *            Check ligado depois dele (suporte oficial do SDK).
 * - v5.33.0 (Fase 2C.3): inicializa o Firebase App Check (reCAPTCHA Enterprise, invisivel,
 *            renovacao automatica) ANTES de Auth/Firestore, para o Firestore anexar o token.
 *            Desligado em testes (MODE=test) e fora do navegador.
 * - v5.24.3: Inicialização segura evitando duplicação em Hot Module Replacement (HMR).
 * =====================================================================================
 */

import { initializeApp, getApps, getApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { EnvConfig } from './env';
import { logWebDiagnostic } from '../lib/diagnostics';

/** Instância principal da aplicação Firebase (`agrosmart-v5`). */
export const firebaseApp =
  getApps().length > 0 ? getApp() : initializeApp(EnvConfig.firebase);

/** Mesmo endereco que o SDK do App Check usa (ja liberado na CSP: script-src www.google.com/recaptcha/). */
export const RECAPTCHA_ENTERPRISE_SCRIPT_URL = 'https://www.google.com/recaptcha/enterprise.js';
/** Tempo maximo (em segundo plano) para o reCAPTCHA carregar e ficar pronto. */
export const RECAPTCHA_READY_TIMEOUT_MS = 4000;

type RecaptchaWindow = { grecaptcha?: { enterprise?: { ready?: (cb: () => void) => void } } };
type ScriptLike = { src: string; async: boolean; onload: (() => void) | null; onerror: (() => void) | null };
type DocLike = { createElement: (tag: 'script') => ScriptLike; head: { appendChild: (el: ScriptLike) => unknown } };

/**
 * Carrega o script do reCAPTCHA Enterprise e espera o `ready()` dele, com tempo limite.
 * Resolve `true` so se o reCAPTCHA ficou pronto; `false` em erro, bloqueio ou demora.
 * Nunca lanca excecao. `win`/`doc` sao injetaveis para os testes.
 */
export function waitForRecaptchaEnterprise(
  timeoutMs: number = RECAPTCHA_READY_TIMEOUT_MS,
  win: RecaptchaWindow = globalThis as unknown as RecaptchaWindow,
  doc: DocLike = (globalThis as unknown as { document: DocLike }).document,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const whenLoaded = () => {
      const ready = win.grecaptcha?.enterprise?.ready;
      if (typeof ready !== 'function') {
        finish(false);
        return;
      }
      try {
        ready(() => finish(true));
      } catch {
        finish(false);
      }
    };
    try {
      if (win.grecaptcha?.enterprise) {
        whenLoaded();
        return;
      }
      const script = doc.createElement('script');
      script.src = RECAPTCHA_ENTERPRISE_SCRIPT_URL;
      script.async = true;
      script.onload = whenLoaded;
      script.onerror = () => finish(false);
      doc.head.appendChild(script);
    } catch {
      finish(false);
    }
  });
}

let appCheckInstance: AppCheck | null = null;

/** Instancia atual do App Check (`null` enquanto liga, em testes ou sem reCAPTCHA). */
export function getFirebaseAppCheck(): AppCheck | null {
  return appCheckInstance;
}

/**
 * Liga o App Check em segundo plano, so com o reCAPTCHA pronto. Resolve `null` em testes,
 * fora do navegador, sem site key, sem reCAPTCHA ou em erro (o site continua funcionando).
 */
async function startFirebaseAppCheck(): Promise<AppCheck | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined' || import.meta.env.MODE === 'test') {
    return null;
  }
  const siteKey = EnvConfig.appCheck.recaptchaEnterpriseSiteKey;
  if (!siteKey) {
    return null;
  }
  const t0 = Date.now();
  const ready = await waitForRecaptchaEnterprise(RECAPTCHA_READY_TIMEOUT_MS);
  if (!ready) {
    logWebDiagnostic('WARN', 'appcheck.disabled_recaptcha_unavailable', {
      waited_ms: Date.now() - t0,
      note: 'reCAPTCHA bloqueado ou lento; site segue sem App Check (servidor em modo log)',
    });
    return null;
  }
  try {
    appCheckInstance = initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
    logWebDiagnostic('INFO', 'appcheck.enabled', { ready_ms: Date.now() - t0 });
    return appCheckInstance;
  } catch (err: unknown) {
    logWebDiagnostic('WARN', 'appcheck.init_failed', {
      error_name: (err as Error)?.name || 'Error',
      error_message: String((err as Error)?.message || '').slice(0, 120),
    });
    return null;
  }
}

/** Promessa do App Check (resolve com a instancia ou `null`; nunca rejeita). */
export const firebaseAppCheckReady: Promise<AppCheck | null> = startFirebaseAppCheck();

/** Instância Singleton do serviço de autenticação Firebase Auth. */
export const firebaseAuth = getAuth(firebaseApp);

/** Instância Singleton do banco de dados em tempo real Cloud Firestore. */
export const firestoreDb = getFirestore(firebaseApp);

/** Provedor configurado para Login Social com conta Google. */
export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({
  prompt: 'select_account',
});
