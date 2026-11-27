/**
 * =====================================================================================
 * ARQUIVO: backend/LambdasFuncs/AgroSmart_Firebase_Authorizer/AgroSmart_Firebase_Authorizer.mjs
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1C — Flag Legada Demo Pass)
 * DATA DE CRIACAO: 2026-02-18 05:30
 * ULTIMA ATT: 2026-11-23T09:00:00Z (UTC)
 * VERSAO: v5.32.0 (Fase 2C - Firebase App Check + Authorizer TOKEN/REQUEST)
 * =====================================================================================
 * PROPÓSITO ARQUITETURAL:
 * Custom Authorizer do Amazon API Gateway (ES Module compatível com Node.js 20 e 22)
 * responsável por:
 *   1. Validar criptograficamente os tokens JWT (Firebase ID Token RS256 via JWKS);
 *   2. Bloquear na borda (0ms de custo nas Lambdas de negócio) qualquer token JWT que
 *      não pertença ao Operador Titular (`ALLOWED_OWNER_EMAILS` com `email_verified === true`)
 *      ou a uma sessão ativa Zero-Credential (`is_demo === true` com `demo_sid` e
 *      `demo_device_id` presentes);
 *   3. Controlar o trânsito legado de códigos de convite de uso único (`AGRO-XXXX-XXXX`)
 *      em `POST /command` via flag `ACCEPT_DEMO_PASS_ON_COMMAND` (padrão `"true"`),
 *      permitindo desativação controlada após migração do web app para `POST /demo/claim`.
 *
 * CHANGELOG v5.32.0 (2026-11-23, Fase 2C.2):
 * - Aceita eventos TOKEN (legado) e REQUEST. No tipo REQUEST le os cabecalhos
 *   `Authorization` e `X-Firebase-AppCheck` sem diferenciar maiusculas/minusculas.
 * - Valida o token do Firebase App Check (RS256 via JWKS oficial, iss do projeto,
 *   aud `projects/<numero>`, `sub` na lista APPCHECK_APP_IDS, `typ` JWT, expiracao).
 * - APPCHECK_MODE: `off` (nao verifica), `log` (padrao: so registra) ou `enforce`
 *   (recusa com Deny/403 quando o atestado nao e valido). Valor invalido => `log`.
 * - Log `authorizer_appcheck` com status/motivo; o token NUNCA e registrado.
 * - O contexto repassado as Lambdas ganha `appcheck` (valid|missing|invalid|off|unavailable).
 *
 * CHANGELOG v5.31.0 (2026-11-22):
 * - Fase 1C: Adiciona env `ACCEPT_DEMO_PASS_ON_COMMAND` (padrão `"true"`; apenas
 *   `"false"` case-insensitive ignorando espaços desliga). Quando desligada, qualquer
 *   passe `AGRO-XXXX-XXXX` em qualquer rota lança `Error("Unauthorized")` e registra
 *   o evento `authorizer_demo_pass_legacy_disabled`.
 *
 * CHANGELOG v5.28.2 (2026-11-17):
 * - Correção P-2: Exige explicitamente `payload.email_verified === true` para tokens
 *   de Operador Titular, emitindo log `authorizer_owner_email_unverified` em caso de
 *   rejeição, em total paridade com `isTrustedOwnerAccount()` do `firestore.rules` v5.28.2.
 * =====================================================================================
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

const PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || "").trim();
const ISSUER = PROJECT_ID ? `https://securetoken.google.com/${PROJECT_ID}` : null;

const DEFAULT_OWNER_EMAILS = "__OWNER_EMAIL__";
const ALLOWED_OWNER_EMAILS = new Set(
  (process.env.ALLOWED_OWNER_EMAILS || DEFAULT_OWNER_EMAILS)
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

// Flag de transição da Fase 1C: apenas "false" (case-insensitive, ignorando espaços) desliga
const ACCEPT_DEMO_PASS_ON_COMMAND =
  String(process.env.ACCEPT_DEMO_PASS_ON_COMMAND ?? "true").trim().toLowerCase() !== "false";

// Formato estrito do Passe de Uso Único (ex.: AGRO-7K9M-X4P2)
const DEMO_INVITE_PASS_RE = /^AGRO-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

// Endpoint oficial JWKS (JSON Web Key Set) do Google para tokens do Firebase Auth
const JWKS_URL = new URL(
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
);
const JWKS = createRemoteJWKSet(JWKS_URL, {
  timeoutDuration: 3000,
  cooldownDuration: 30000,
});

// ---------------------------------------------------------------------------------
// Firebase App Check (Fase 2C): atestado de que a chamada vem do web app oficial
// ---------------------------------------------------------------------------------
const APPCHECK_MODES = new Set(["off", "log", "enforce"]);
const APPCHECK_MODE_RAW = String(process.env.APPCHECK_MODE ?? "log").trim().toLowerCase();
const APPCHECK_MODE = APPCHECK_MODES.has(APPCHECK_MODE_RAW) ? APPCHECK_MODE_RAW : "log";
const APPCHECK_PROJECT_NUMBER = String(process.env.APPCHECK_PROJECT_NUMBER ?? "").trim();
const APPCHECK_APP_IDS = new Set(
  String(process.env.APPCHECK_APP_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const APPCHECK_JWKS = createRemoteJWKSet(
  new URL("https://firebaseappcheck.googleapis.com/v1/jwks"),
  {
    timeoutDuration: 3000,
    cooldownDuration: 30000,
    cacheMaxAge: 6 * 60 * 60 * 1000,
  }
);

/**
 * Emite log estruturado em JSON de linha única para o Amazon CloudWatch.
 */
function logJson(level, eventName, fields = {}) {
  const payload = {
    level,
    component: "FirebaseAuthorizer",
    fw_backend: "v5.33.0",
    event_name: eventName,
    ts: new Date().toISOString(),
    ...fields,
  };
  console.log(JSON.stringify(payload));
}

/**
 * Constrói o documento de política IAM retornado ao Amazon API Gateway.
 */
function buildPolicy(effect, resourceArn, principalId, context = {}) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resourceArn,
        },
      ],
    },
    context,
  };
}

/**
 * Normaliza o methodArn para liberar as rotas do mesmo estágio (ex.: prod/<recurso>/<metodo>)
 * para usuários autenticados com JWT válido.
 */
function resolveStageResourceArn(methodArn) {
  if (typeof methodArn !== "string" || !methodArn.trim()) {
    return null;
  }
  const parts = methodArn.split(":");
  if (parts.length < 6) {
    return methodArn;
  }
  const apiGatewayArnTmp = parts[5].split("/");
  if (apiGatewayArnTmp.length < 2) {
    return methodArn;
  }
  const apiId = apiGatewayArnTmp[0];
  const stage = apiGatewayArnTmp[1];
  const prefix = parts.slice(0, 5).join(":");
  return `${prefix}:${apiId}/${stage}/*/*`;
}

/**
 * Verifica se o methodArn corresponde estritamente à invocação de `POST /command`.
 */
function isPostCommandMethodArn(methodArn) {
  if (typeof methodArn !== "string" || !methodArn.trim()) {
    return false;
  }
  const parts = methodArn.split(":");
  if (parts.length < 6) {
    return false;
  }
  const arnPath = parts.slice(5).join(":");
  return /\/POST\/command$/i.test(arnPath);
}

/**
 * Verifica rapidamente se a string possui estrutura de 3 partes JWT (header.payload.signature)
 * sem espaços em branco.
 */
function hasValidJwtFormat(token) {
  if (!token || token.length < 32 || token.length > 4096 || /\s/.test(token)) {
    return false;
  }
  const segments = token.split(".");
  return (
    segments.length === 3 &&
    segments[0].length > 0 &&
    segments[1].length > 0 &&
    segments[2].length > 0
  );
}

/**
 * Le um cabecalho HTTP sem diferenciar maiusculas/minusculas (eventos REQUEST).
 */
function getHeaderCI(headers, wantedLower) {
  if (!headers || typeof headers !== "object") {
    return "";
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof key === "string" && key.toLowerCase() === wantedLower && typeof value === "string") {
      return value;
    }
  }
  return "";
}

/**
 * Rota curta para log (ex.: "POST/command"), sem conta nem ID da API.
 */
function routeForLog(methodArn) {
  if (typeof methodArn !== "string") {
    return "";
  }
  const parts = methodArn.split(":");
  const path = parts.length >= 6 ? parts.slice(5).join(":") : "";
  const segs = path.split("/");
  return segs.length >= 4 ? segs.slice(2).join("/").slice(0, 80) : "";
}

/**
 * Verifica o token do Firebase App Check. Nunca lanca excecao; nunca registra o token.
 * Retorna { status: "valid"|"missing"|"invalid"|"off"|"unavailable", reason?, app? }.
 */
async function verifyAppCheckToken(rawToken, headersAvailable) {
  if (APPCHECK_MODE === "off") {
    return { status: "off" };
  }
  if (!headersAvailable) {
    return { status: "unavailable", reason: "token_authorizer_sem_cabecalhos" };
  }
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!token) {
    return { status: "missing" };
  }
  if (!hasValidJwtFormat(token)) {
    return { status: "invalid", reason: "malformed" };
  }
  if (!/^[0-9]{6,20}$/.test(APPCHECK_PROJECT_NUMBER) || APPCHECK_APP_IDS.size === 0) {
    return { status: "invalid", reason: "config_missing" };
  }
  try {
    const { payload } = await jwtVerify(token, APPCHECK_JWKS, {
      issuer: `https://firebaseappcheck.googleapis.com/${APPCHECK_PROJECT_NUMBER}`,
      audience: `projects/${APPCHECK_PROJECT_NUMBER}`,
      algorithms: ["RS256"],
      typ: "JWT",
      clockTolerance: 5,
      requiredClaims: ["exp", "iat", "sub"],
    });
    const appId = typeof payload.sub === "string" ? payload.sub : "";
    if (!APPCHECK_APP_IDS.has(appId)) {
      return { status: "invalid", reason: "app_not_allowed", app: appId.slice(-24) };
    }
    return { status: "valid", app: appId.slice(-24) };
  } catch (err) {
    const code = typeof err?.code === "string" ? err.code : "verify_error";
    const claim = typeof err?.claim === "string" ? `:${err.claim}` : "";
    return { status: "invalid", reason: `${code}${claim}`.slice(0, 80) };
  }
}

const agrosmartMainHandler = async (event, context) => {
  const startMs = performance.now();
  const requestId = context?.awsRequestId || "n/a";

  try {
    if (!PROJECT_ID || !ISSUER) {
      logJson("ERROR", "authorizer_missing_project_id", { request_id: requestId });
      throw new Error("Unauthorized");
    }

    const methodArn = event?.methodArn;
    if (typeof methodArn !== "string" || !methodArn.trim()) {
      logJson("WARN", "authorizer_missing_method_arn", { request_id: requestId });
      throw new Error("Unauthorized");
    }

    const isRequestEvent = event?.type === "REQUEST";
    const rawAuth = isRequestEvent
      ? getHeaderCI(event?.headers, "authorization")
      : typeof event?.authorizationToken === "string"
        ? event.authorizationToken
        : "";
    const rawAppCheck = isRequestEvent ? getHeaderCI(event?.headers, "x-firebase-appcheck") : "";
    const token = rawAuth.toLowerCase().startsWith("bearer ")
      ? rawAuth.slice(7).trim()
      : rawAuth.trim();

    if (!token || token.length > 4096) {
      logJson("WARN", "authorizer_empty_or_oversized_token", {
        request_id: requestId,
      });
      throw new Error("Unauthorized");
    }

    // 1. Fluxo Legado Zero-Credential de Resgate de Passe (controlado por ACCEPT_DEMO_PASS_ON_COMMAND)
    const upperCandidate = token.toUpperCase();
    if (DEMO_INVITE_PASS_RE.test(upperCandidate)) {
      if (!ACCEPT_DEMO_PASS_ON_COMMAND) {
        logJson("WARN", "authorizer_demo_pass_legacy_disabled", {
          request_id: requestId,
          method_arn: methodArn,
        });
        throw new Error("Unauthorized");
      }

      if (!isPostCommandMethodArn(methodArn)) {
        logJson("WARN", "authorizer_demo_pass_invalid_route", {
          request_id: requestId,
          method_arn: methodArn,
        });
        throw new Error("Unauthorized");
      }

      const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
      logJson("INFO", "authorizer_demo_pass_claim_routed", {
        request_id: requestId,
        elapsed_ms: elapsedMs,
      });

      return buildPolicy("Allow", methodArn, "demo-pass-claim", {
        uid: "demo-pass-claim",
        auth_mode: "demo_pass_claim",
        issuer: "agrosmart-demo-pass",
      });
    }

    // 2. Fluxo Padrão JWT RS256 (Operador Titular e Usuário Teste via Custom Token)
    if (!hasValidJwtFormat(token)) {
      logJson("WARN", "authorizer_malformed_jwt_token", {
        request_id: requestId,
      });
      throw new Error("Unauthorized");
    }

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: PROJECT_ID,
      algorithms: ["RS256"],
      clockTolerance: 5,
    });

    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") {
      logJson("WARN", "authorizer_missing_exp_or_iat", { request_id: requestId });
      throw new Error("Unauthorized");
    }

    const rawUid = payload.user_id || payload.sub;
    const uid = typeof rawUid === "string" ? rawUid.trim() : "";

    if (!uid || uid === "user" || uid === "demo-pass-claim" || uid.length > 128) {
      logJson("WARN", "authorizer_invalid_uid_claim", { request_id: requestId });
      throw new Error("Unauthorized");
    }

    const demoSid =
      typeof payload.demo_sid === "string" && payload.demo_sid.trim()
        ? payload.demo_sid.trim().slice(0, 64)
        : "";
    const demoDeviceId =
      typeof payload.demo_device_id === "string" && payload.demo_device_id.trim()
        ? payload.demo_device_id.trim().slice(0, 80)
        : "";
    const isDemoBool = payload.is_demo === true;
    const isDemoClaim = isDemoBool ? "true" : "false";
    const tokenEmail =
      typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";

    // 3. Guarda Zero-Trust de Identidade (v5.28.2 - Fix P-2):
    // - Se for token Demo, exige obrigatoriamente demo_sid e demo_device_id.
    // - Se for token de Operador, exige que o e-mail pertença à whitelist do proprietário
    //   e que o e-mail esteja criptograficamente verificado (email_verified === true).
    if (isDemoBool) {
      if (!demoSid || !demoDeviceId) {
        logJson("WARN", "authorizer_demo_jwt_missing_claims", {
          request_id: requestId,
          user_id: uid,
          has_demo_sid: Boolean(demoSid),
          has_demo_device_id: Boolean(demoDeviceId),
        });
        throw new Error("Unauthorized");
      }
    } else {
      if (!tokenEmail || !ALLOWED_OWNER_EMAILS.has(tokenEmail)) {
        logJson("WARN", "authorizer_untrusted_operator_blocked", {
          request_id: requestId,
          user_id: uid,
        });
        throw new Error("Unauthorized");
      }
      if (payload.email_verified !== true) {
        logJson("WARN", "authorizer_owner_email_unverified", {
          request_id: requestId,
          user_id: uid,
        });
        throw new Error("Unauthorized");
      }
    }

    // 4. Firebase App Check (Fase 2C): atestado de origem do web app oficial
    const appCheck = await verifyAppCheckToken(rawAppCheck, isRequestEvent);
    logJson(appCheck.status === "valid" || appCheck.status === "off" ? "INFO" : "WARN", "authorizer_appcheck", {
      request_id: requestId,
      mode: APPCHECK_MODE,
      status: appCheck.status,
      reason: appCheck.reason,
      app: appCheck.app,
      route: routeForLog(methodArn),
      is_demo_token: isDemoBool,
    });
    if (APPCHECK_MODE === "enforce" && appCheck.status !== "valid") {
      logJson("WARN", "authorizer_appcheck_denied", {
        request_id: requestId,
        status: appCheck.status,
        reason: appCheck.reason,
        route: routeForLog(methodArn),
      });
      return buildPolicy("Deny", methodArn, uid, { appcheck: appCheck.status });
    }

    const resourceArn = resolveStageResourceArn(methodArn) || methodArn;
    const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;

    logJson("INFO", "authorizer_token_verified", {
      request_id: requestId,
      user_id: uid,
      is_demo_token: isDemoBool,
      has_demo_sid: Boolean(demoSid),
      demo_device_id: demoDeviceId || undefined,
      appcheck: appCheck.status,
      event_type: isRequestEvent ? "REQUEST" : "TOKEN",
      elapsed_ms: elapsedMs,
    });

    return buildPolicy("Allow", resourceArn, uid, {
      uid: String(uid),
      auth_mode: "firebase_jwt",
      issuer: String(payload.iss || ""),
      demo_sid: demoSid,
      demo_device_id: demoDeviceId,
      is_demo: isDemoClaim,
      appcheck: appCheck.status,
    });
  } catch (err) {
    const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
    logJson("WARN", "authorizer_token_rejected", {
      request_id: requestId,
      error: String(err?.message || err),
      elapsed_ms: elapsedMs,
    });
    throw new Error("Unauthorized");
  }
};

// ---------------------------------------------------------------------------------
// v5.33.0 — Aquecimento (EventBridge Scheduler a cada 5 min), 2026-11-23.
// So reage a {"agrosmart_warmup": true} no NIVEL MAIS ALTO do evento. Eventos do
// API Gateway (TOKEN/REQUEST) nunca trazem essa chave: a internet nao chega aqui,
// e este caminho nao autoriza nada (so devolve {warmup:"ok"}).
// Mantem a Lambda ligada e as chaves (JWKS) do Firebase Auth e do App Check frescas.
// ---------------------------------------------------------------------------------
export const handler = async (event, context) => {
  if (event && typeof event === "object" && !Array.isArray(event) && event.agrosmart_warmup === true) {
    const t0 = performance.now();
    const sets = [JWKS, APPCHECK_JWKS];
    const res = await Promise.allSettled(sets.map((ks) => (ks.fresh ? Promise.resolve("fresh") : ks.reload())));
    const falhas = res.filter((r) => r.status === "rejected").length;
    if (falhas > 0) {
      logJson("WARN", "warmup_jwks_reload_failed", { falhas });
    }
    return { warmup: "ok", jwks_falhas: falhas, ms: Math.round(performance.now() - t0) };
  }
  return agrosmartMainHandler(event, context);
};
