/**
 * =====================================================================================
 * ARQUIVO: src/features/auth/api/authService.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1C — Remocao de PII e /demo/claim)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T18:50:00Z (UTC)
 * VERSÃO: v5.31.0 (Autorizacao Server-Side via Sondagem Firestore + Rota /demo/claim)
 * PROPÓSITO: Serviço de autenticação Firebase Auth:
 *            1. Login do Operador Titular exclusivamente via Google OAuth 2.0, com
 *               autorização validada no servidor pelas Security Rules do Firestore
 *               (`verifyOperatorAccess` + `classifyOperatorProbe`), sem e-mails no bundle;
 *            2. Resgate Zero-Credential de Passe Temporário (`AGRO-XXXX-XXXX`) pela
 *               rota dedicada `POST /demo/claim` (sem cabeçalho `Authorization`).
 * CHANGELOG:
 * - v5.31.0:
 *   * Migra `claimDemoPassAndLogin` para `EnvConfig.aws.demoClaimEndpoint` sem enviar
 *     cabeçalho `Authorization` (apenas `Content-Type: application/json`).
 *   * Remove `ALLOWED_OPERATOR_EMAILS`, `isAuthorizedOperatorEmail`, `loginWithEmail`,
 *     `resetUserPassword` e todo e-mail pessoal do código e comentários.
 *   * Adiciona `classifyOperatorProbe` (função pura) e `verifyOperatorAccess(user)`.
 *   * Atualiza `loginWithGoogle` para tratar `operator`, `denied` (tenta apagar conta
 *     não autorizada + signOut) e `unavailable` (somente signOut, sem apagar conta).
 * - v5.27.1: Adicionados códigos `auth/invalid-custom-token`, `auth/custom-token-mismatch`
 *            e `auth/invalid-user-token` em `translateFirebaseAuthError` (BUG-13).
 * =====================================================================================
 */

import { FirebaseError } from 'firebase/app';
import { getAppCheckHeaders } from '../../../shared/config/appCheck';
import {
  getAdditionalUserInfo,
  signInWithCustomToken,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import { doc, getDoc, getDocFromServer, serverTimestamp, setDoc } from 'firebase/firestore';
import { EnvConfig } from '../../../shared/config/env';
import {
  firebaseAuth,
  firestoreDb,
  googleAuthProvider,
} from '../../../shared/config/firebase';
import { logWebDiagnostic } from '../../../shared/lib/diagnostics';

const DEMO_PASS_REGEX = /^AGRO-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

export type OperatorProbeStatus = 'ok' | 'permission-denied' | 'error';
export type OperatorAccessResult = 'operator' | 'denied' | 'unavailable';

export interface OperatorProbeInput {
  isDemoClaim: boolean;
  hasGoogleProvider: boolean;
  probe: OperatorProbeStatus;
}

/**
 * Classifica o resultado da sondagem de acesso do Operador Titular em função pura,
 * seguindo a ordem estrita:
 *   1. Token Demo (`isDemoClaim`) -> `'denied'`;
 *   2. Sem provedor `google.com` -> `'denied'`;
 *   3. Sondagem `'ok'` -> `'operator'`;
 *   4. Sondagem `'permission-denied'` -> `'denied'`;
 *   5. Demais erros transitórios (`'error'`) -> `'unavailable'`.
 */
export function classifyOperatorProbe(
  input: OperatorProbeInput,
): OperatorAccessResult {
  if (input.isDemoClaim) {
    return 'denied';
  }
  if (!input.hasGoogleProvider) {
    return 'denied';
  }
  if (input.probe === 'ok') {
    return 'operator';
  }
  if (input.probe === 'permission-denied') {
    return 'denied';
  }
  return 'unavailable';
}

function isPermissionDeniedError(err: unknown): boolean {
  if (err instanceof FirebaseError) {
    return err.code === 'permission-denied' || err.code === 'firestore/permission-denied';
  }
  const code = String((err as { code?: string })?.code ?? '').trim().toLowerCase();
  return code === 'permission-denied' || code === 'firestore/permission-denied';
}

/**
 * Valida se o usuário autenticado é o Operador Titular delegando a decisão final às
 * Security Rules do Cloud Firestore (sondagem de leitura em `users/{uid}`).
 */
export async function verifyOperatorAccess(user: User): Promise<OperatorAccessResult> {
  let isDemoClaim = false;
  try {
    const tokenResult = await user.getIdTokenResult();
    isDemoClaim = tokenResult.claims?.is_demo === true;
  } catch {
    return 'unavailable';
  }

  const hasGoogleProvider = Array.isArray(user.providerData)
    ? user.providerData.some((entry) => entry?.providerId === 'google.com')
    : false;

  if (isDemoClaim || !hasGoogleProvider) {
    return classifyOperatorProbe({
      isDemoClaim,
      hasGoogleProvider,
      probe: 'permission-denied',
    });
  }

  let probe: OperatorProbeStatus = 'ok';
  try {
    await getDocFromServer(doc(firestoreDb, 'users', user.uid));
    probe = 'ok';
  } catch (err: unknown) {
    probe = isPermissionDeniedError(err) ? 'permission-denied' : 'error';
  }

  return classifyOperatorProbe({
    isDemoClaim,
    hasGoogleProvider,
    probe,
  });
}

/**
 * Garante a criação do documento `users/{uid}` no acesso do Operador Titular.
 * A autorização de escrita é garantida diretamente por `isTrustedOwnerAccount()`
 * nas Security Rules do Firestore.
 */
async function ensureUserDocumentExists(user: User, displayName?: string): Promise<void> {
  const userRef = doc(firestoreDb, 'users', user.uid);
  const snap = await getDoc(userRef);

  if (!snap.exists()) {
    await setDoc(userRef, {
      uid: user.uid,
      email: user.email ?? '',
      name: displayName?.trim() || user.displayName || 'Operador AgroSmart',
      created_at: serverTimestamp(),
      role: 'customer',
      my_devices: [],
    });
  }
}

/**
 * Realiza login federado via popup OAuth 2.0 do Google exclusivamente para o Operador Titular.
 * A autorização é verificada no servidor via `verifyOperatorAccess`:
 * - `'denied'`: remove a conta recém-criada (best-effort), desconecta e lança erro;
 * - `'unavailable'`: apenas desconecta (sem apagar a conta) e solicita nova tentativa;
 * - `'operator'`: garante o documento `users/{uid}` e conclui o login.
 */
export async function loginWithGoogle(): Promise<User> {
  const cred = await signInWithPopup(firebaseAuth, googleAuthProvider);
  const access = await verifyOperatorAccess(cred.user);

  if (access === 'denied') {
    logWebDiagnostic('WARN', 'auth.google.unauthorized_operator_blocked', {
      uid_prefix: cred.user.uid.slice(0, 8),
    });
    // Fase 1C: so apaga contas criadas por ESTE login; conta existente (ex.: titular) nunca e apagada
    if (getAdditionalUserInfo(cred)?.isNewUser === true) {
      try {
        await cred.user.delete();
      } catch {
        // Falha ao apagar: o signOut abaixo encerra a sessao de qualquer forma
      }
    }
    await signOut(firebaseAuth).catch(() => undefined);

    const err = new Error('Conta Google não autorizada para operação administrativa.') as Error & {
      code?: string;
    };
    err.code = 'auth/unauthorized-operator-email';
    throw err;
  }

  if (access === 'unavailable') {
    logWebDiagnostic('WARN', 'auth.google.operator_probe_unavailable', {
      uid_prefix: cred.user.uid.slice(0, 8),
    });
    await signOut(firebaseAuth).catch(() => undefined);
    throw new Error('Não foi possível verificar seu acesso agora. Tente novamente.');
  }

  await ensureUserDocumentExists(cred.user);
  return cred.user;
}

/**
 * Realiza o login Zero-Credential do Usuário Teste trocando o código de uso único
 * (`AGRO-XXXX-XXXX`) por um Custom Token JWT assinado pela AWS Lambda (`SendCommand`)
 * através da rota dedicada `POST /demo/claim` (sem cabeçalho `Authorization`).
 */
export async function claimDemoPassAndLogin(
  inviteCode: string,
  deviceId = 'ESP32-AgroSmart-Station-V5',
): Promise<User> {
  const cleanCode = inviteCode.trim().toUpperCase();
  const cleanDeviceId = deviceId.trim() || 'ESP32-AgroSmart-Station-V5';
  if (!DEMO_PASS_REGEX.test(cleanCode)) {
    throw new Error(
      'Digite um Código de Convite válido no formato AGRO-XXXX-XXXX fornecido pelo administrador.',
    );
  }

  logWebDiagnostic('INFO', 'auth.demo_pass.claim_start', {
    device_id: cleanDeviceId,
  });

  // Fase 2C.3: atestado do App Check (rota sem login; o servidor decide em modo log/enforce)
  const appCheckHeaders = await getAppCheckHeaders();
  const response = await fetch(EnvConfig.aws.demoClaimEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...appCheckHeaders,
    },
    body: JSON.stringify({
      device_id: cleanDeviceId,
      action: 'claim_demo_pass',
      demo_pass_token: cleanCode,
    }),
  });

  const rawText = await response.text();
  let parsed: Record<string, unknown> = {};
  if (rawText && rawText.trim()) {
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  if (!response.ok) {
    const serverMsg =
      (typeof parsed.message === 'string' && parsed.message.trim()) ||
      (typeof parsed.error === 'string' && parsed.error.trim()) ||
      'Código de Convite inválido, expirado ou já utilizado.';
    logWebDiagnostic('WARN', 'auth.demo_pass.claim_rejected', {
      device_id: cleanDeviceId,
      status_code: response.status,
      reason: serverMsg,
    });
    throw new Error(serverMsg);
  }

  const customToken =
    typeof parsed.custom_token === 'string' ? parsed.custom_token.trim() : '';
  const demoSessionId =
    typeof parsed.demo_session_id === 'string' ? parsed.demo_session_id.trim() : '';

  if (!customToken || !demoSessionId) {
    throw new Error('Resposta de autenticação incompleta recebida do servidor.');
  }

  try {
    sessionStorage.setItem('agrosmart_v5_demo_session_id', demoSessionId);
    sessionStorage.setItem('agrosmart_v5_demo_device_id', cleanDeviceId);
  } catch {
    // Ignora se sessionStorage estiver indisponível
  }

  const cred = await signInWithCustomToken(firebaseAuth, customToken);
  await cred.user.getIdToken(true);

  logWebDiagnostic('INFO', 'auth.demo_pass.claim_success', {
    device_id: cleanDeviceId,
    demo_session_id_prefix: `${demoSessionId.slice(0, 10)}...`,
  });

  return cred.user;
}

/**
 * Encerra a sessão ativa no Firebase Auth e limpa metadados temporários de teste.
 */
export async function logoutUser(): Promise<void> {
  try {
    sessionStorage.removeItem('agrosmart_v5_demo_session_id');
    sessionStorage.removeItem('agrosmart_v5_demo_device_id');
  } catch {
    // Ignora
  }
  await signOut(firebaseAuth);
}

/**
 * Traduz códigos de erro do Firebase Auth para mensagens claras em português brasileiro.
 */
export function translateFirebaseAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/admin-restricted-operation':
    case 'auth/unauthorized-operator-email':
      return 'Acesso administrativo exclusivo do proprietário (James Rafael). Se você é um recrutador ou avaliador, selecione a aba "Usuário Teste" e informe seu código AGRO-XXXX-XXXX.';
    case 'auth/invalid-email':
      return 'O formato do e-mail digitado é inválido.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'E-mail ou senha incorretos. Verifique seus dados.';
    case 'auth/invalid-custom-token':
    case 'auth/custom-token-mismatch':
    case 'auth/invalid-user-token':
      return 'O código de acesso expirou ou é inválido. Solicite um novo código ao administrador.';
    case 'auth/email-already-in-use':
      return 'Este e-mail já está cadastrado em outra conta.';
    case 'auth/weak-password':
      return 'A senha escolhida é muito fraca (use pelo menos 6 caracteres).';
    case 'auth/user-disabled':
      return 'Esta conta de usuário foi desativada.';
    case 'auth/too-many-requests':
      return 'Muitas tentativas seguidas. Aguarde alguns instantes e tente novamente.';
    case 'auth/popup-closed-by-user':
      return 'A janela de login com o Google foi fechada antes de concluir.';
    case 'auth/network-request-failed':
      return 'Sem conexão com a internet. Verifique sua rede.';
    default:
      return (err as Error)?.message || 'Não foi possível concluir a autenticação.';
  }
}
