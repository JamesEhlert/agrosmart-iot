/**
 * =====================================================================================
 * ARQUIVO: src/shared/config/env.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1C — Rota /demo/claim)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T18:50:00Z (UTC)
 * VERSÃO: v5.31.0
 * PROPÓSITO: Centraliza e valida as configurações públicas de ambiente (Endpoints REST
 *            AWS API Gateway e identificadores públicos do projeto Firebase Web).
 * CHANGELOG:
 * - v5.33.0 (Fase 2C.3): `appCheck.recaptchaEnterpriseSiteKey` (chave PUBLICA do reCAPTCHA
 *            Enterprise usada pelo Firebase App Check; pode ser sobrescrita por
 *            `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY`).
 * - v5.31.0: Adiciona `demoClaimEndpoint` (`${cleanApiBaseUrl}/demo/claim`) para
 *            separar o resgate do passe Demo da rota de comandos operacionais.
 * - v5.24.3: Criação inicial espelhando `app_config.dart` e `firebase_options.dart`.
 * =====================================================================================
 */

const rawApiBaseUrl =
  (import.meta.env.VITE_AWS_API_BASE_URL as string | undefined)?.trim() ||
  'https://your-api-id.execute-api.us-east-2.amazonaws.com/prod';

const cleanApiBaseUrl = rawApiBaseUrl.replace(/\/+$/, '');

/**
 * Configurações imutáveis de endpoints da nuvem AWS e do projeto Google Firebase.
 */
export const EnvConfig = {
  aws: {
    apiBaseUrl: cleanApiBaseUrl,
    telemetryEndpoint: `${cleanApiBaseUrl}/telemetry`,
    commandEndpoint: `${cleanApiBaseUrl}/command`,
    demoClaimEndpoint: `${cleanApiBaseUrl}/demo/claim`,
  },
  firebase: {
    apiKey:
      (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined)?.trim() ||
      'YOUR_FIREBASE_WEB_API_KEY',
    appId:
      (import.meta.env.VITE_FIREBASE_APP_ID as string | undefined)?.trim() ||
      'YOUR_FIREBASE_APP_ID',
    messagingSenderId:
      (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined)?.trim() ||
      '702774061254',
    projectId:
      (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined)?.trim() ||
      'agrosmart-v5',
    authDomain:
      (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined)?.trim() ||
      'agrosmart-v5.firebaseapp.com',
    storageBucket:
      (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined)?.trim() ||
      'agrosmart-v5.firebasestorage.app',
  },
  appCheck: {
    /** Chave PUBLICA (site key) do reCAPTCHA Enterprise; nao e segredo. */
    recaptchaEnterpriseSiteKey:
      (import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY as string | undefined)?.trim() ||
      '6Leq8C0uAAAAAFg6Ru52uZ_2_Fj3M0K38QCEBV4P', // gitleaks:allow (site key PUBLICA do reCAPTCHA)
  },
} as const;
