/**
 * =====================================================================================
 * ARQUIVO: src/app/providers/AppProviders.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1C — Probe Server-Side + Anti-PII)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T19:03:00Z (UTC)
 * VERSÃO: v5.31.0 (Sondagem de Operador com Cache por UID + Zero Heuristicas por E-mail)
 * PROPÓSITO: Provedores globais da aplicação Web:
 *            1. TanStack QueryClient (sem retry em 401/403 e limpeza no Logout);
 *            2. Contexto de Autenticação Firebase (`AuthContext`) com `onIdTokenChanged`,
 *               exposição de `demoSessionId` (claim `demo_sid`) e guarda Zero-Trust
 *               baseada em `verifyOperatorAccess` (cacheada por UID);
 *            3. Contexto Reativo de Estação Selecionada (`DeviceContext`), assinando
 *               `devices/{id}` para o titular e `devices/{id}/demo_view/current` para a
 *               sessão Demo, com logout imediato em `permission-denied` ou expiração.
 * CHANGELOG:
 * - v5.31.0:
 *   * Substitui `isAuthorizedOperatorEmail` por `verifyOperatorAccess` com cache por UID
 *     (evita leituras repetidas no Firestore durante renovação automática de token).
 *   * `denied` executa somente `signOut` (nunca apaga a conta); `unavailable` exibe
 *     estado de erro recuperável com botão "Tentar novamente" sem apagar dados.
 *   * Remove heurísticas por e-mail em `resolveIsDemoUser`, mantendo apenas a claim
 *     `is_demo` e o papel (`role`) gravado no Firestore.
 * - v5.29.1:
 *   * Corrige bug de loading infinito no dashboard ao renovar token no mesmo UID.
 * =====================================================================================
 */

import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onIdTokenChanged, User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../../shared/theme/ThemeProvider';
import { FeedbackProvider } from '../../shared/ui/Feedback.providers';
import { AlertCircle, LogOut, RefreshCw } from 'lucide-react';
import { firebaseAuth, firestoreDb } from '../../shared/config/firebase';
import { ApiException } from '../../shared/api/httpClient';
import {
  OperatorAccessResult,
  verifyOperatorAccess,
} from '../../features/auth/api/authService';
import { DeviceModel } from '../../features/devices/model/device.types';
import { subscribeToDeviceDocument } from '../../features/devices/api/deviceRepository';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 25_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiException && (error.statusCode === 401 || error.statusCode === 403)) {
          return false;
        }
        return failureCount < 1;
      },
    },
    mutations: {
      retry: 0,
    },
  },
});

export type UserRole = 'admin' | 'customer' | 'recruiter';

export interface AuthContextValue {
  user: User | null;
  isAuthLoading: boolean;
  userRole: UserRole;
  isDemoUser: boolean;
  demoSessionId: string | null;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  isAuthLoading: true,
  userRole: 'customer',
  isDemoUser: false,
  demoSessionId: null,
});

export interface DeviceContextValue {
  userDeviceIds: string[];
  selectedDeviceId: string | null;
  selectedDevice: DeviceModel | null;
  isLoadingDevices: boolean;
  deviceLoadError: string | null;
  selectDevice: (deviceId: string) => void;
}

export const DeviceContext = createContext<DeviceContextValue>({
  userDeviceIds: [],
  selectedDeviceId: null,
  selectedDevice: null,
  isLoadingDevices: true,
  deviceLoadError: null,
  selectDevice: () => undefined,
});

const SELECTED_DEVICE_STORAGE_PREFIX = 'agrosmart_v5_selected_device_id';

function readStoredDeviceId(uid: string): string | null {
  try {
    return (
      localStorage.getItem(`${SELECTED_DEVICE_STORAGE_PREFIX}:${uid}`) ||
      localStorage.getItem(SELECTED_DEVICE_STORAGE_PREFIX)
    );
  } catch {
    return null;
  }
}

function writeStoredDeviceId(uid: string, deviceId: string): void {
  try {
    localStorage.setItem(`${SELECTED_DEVICE_STORAGE_PREFIX}:${uid}`, deviceId);
    localStorage.setItem(SELECTED_DEVICE_STORAGE_PREFIX, deviceId);
  } catch {
    // Ignora se o navegador estiver com storage bloqueado
  }
}

function resolveIsDemoUser(
  firestoreRole?: string | null,
  hasDemoTokenClaim?: boolean,
): boolean {
  if (hasDemoTokenClaim) return true;
  const roleClean = (firestoreRole ?? '').trim().toLowerCase();
  return roleClean === 'recruiter' || roleClean === 'demo' || roleClean === 'tester';
}

function isFirestorePermissionDeniedError(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? '').toLowerCase();
  if (code === 'permission-denied' || code === 'firestore/permission-denied') {
    return true;
  }
  const msg = String((err as Error)?.message ?? '').toLowerCase();
  return msg.includes('missing or insufficient permissions') || msg.includes('permission-denied');
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true);
  const [authUnavailableError, setAuthUnavailableError] = useState<string | null>(null);
  const [isRetryingAuthProbe, setIsRetryingAuthProbe] = useState<boolean>(false);
  const [firestoreRole, setFirestoreRole] = useState<string | null>(null);
  const [jwtDemoSid, setJwtDemoSid] = useState<string | null>(null);
  const [jwtDemoDeviceId, setJwtDemoDeviceId] = useState<string | null>(null);
  const [hasDemoClaim, setHasDemoClaim] = useState<boolean>(false);

  const [userDeviceIds, setUserDeviceIds] = useState<string[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<DeviceModel | null>(null);
  const [isLoadingUserList, setIsLoadingUserList] = useState<boolean>(true);
  const [isLoadingDeviceDoc, setIsLoadingDeviceDoc] = useState<boolean>(false);
  const [deviceLoadError, setDeviceLoadError] = useState<string | null>(null);

  const authCheckSeqRef = useRef<number>(0);
  // Cache de sondagem de operador indexado por UID (evita leituras repetidas em token refresh)
  const operatorAccessCacheRef = useRef<Map<string, OperatorAccessResult>>(new Map());

  const userUid = user?.uid ?? null;
  const isDemoUser = useMemo(
    () => resolveIsDemoUser(firestoreRole, hasDemoClaim),
    [firestoreRole, hasDemoClaim],
  );

  const runAuthVerification = useCallback(
    async (
      currentUser: User,
      checkSeq: number,
      forceOperatorReprobe: boolean,
    ): Promise<void> => {
      try {
        const idTokenResult = await currentUser.getIdTokenResult();
        if (checkSeq !== authCheckSeqRef.current) return;

        const claims = idTokenResult.claims ?? {};
        const isDemo = claims.is_demo === true;
        const sid = typeof claims.demo_sid === 'string' ? claims.demo_sid.trim() : null;
        const claimedDevId =
          typeof claims.demo_device_id === 'string' && claims.demo_device_id.trim()
            ? claims.demo_device_id.trim()
            : null;

        if (isDemo) {
          const isValidDemoSession = Boolean(sid && claimedDevId);
          if (!isValidDemoSession) {
            setUser(null);
            setAuthUnavailableError(null);
            setHasDemoClaim(false);
            setJwtDemoSid(null);
            setJwtDemoDeviceId(null);
            setIsLoadingUserList(false);
            setIsLoadingDeviceDoc(false);
            firebaseAuth.signOut().catch(() => undefined);
            return;
          }

          setAuthUnavailableError(null);
          setHasDemoClaim(true);
          setJwtDemoSid(sid);
          setJwtDemoDeviceId(claimedDevId);
          setUser(currentUser);
          return;
        }

        const cachedResult = !forceOperatorReprobe
          ? operatorAccessCacheRef.current.get(currentUser.uid)
          : undefined;
        const access: OperatorAccessResult =
          cachedResult === 'operator'
            ? 'operator'
            : await verifyOperatorAccess(currentUser);

        if (checkSeq !== authCheckSeqRef.current) return;

        if (access === 'operator') {
          operatorAccessCacheRef.current.set(currentUser.uid, 'operator');
          setAuthUnavailableError(null);
          setHasDemoClaim(false);
          setJwtDemoSid(null);
          setJwtDemoDeviceId(null);
          setUser(currentUser);
          return;
        }

        if (access === 'denied') {
          // Fase 1C: `denied` faz somente signOut; nunca apaga a conta do Firebase Auth
          operatorAccessCacheRef.current.delete(currentUser.uid);
          setUser(null);
          setAuthUnavailableError(null);
          setHasDemoClaim(false);
          setJwtDemoSid(null);
          setJwtDemoDeviceId(null);
          setIsLoadingUserList(false);
          setIsLoadingDeviceDoc(false);
          firebaseAuth.signOut().catch(() => undefined);
          return;
        }

        // `unavailable`: mantém o usuário fora da área autenticada sem apagar nem deslogar,
        // oferecendo opção de tentar novamente quando a conectividade voltar.
        operatorAccessCacheRef.current.delete(currentUser.uid);
        setUser(null);
        setHasDemoClaim(false);
        setJwtDemoSid(null);
        setJwtDemoDeviceId(null);
        setIsLoadingUserList(false);
        setIsLoadingDeviceDoc(false);
        setAuthUnavailableError(
          'Não foi possível verificar seu acesso no servidor agora. Verifique sua conexão e tente novamente.',
        );
      } catch {
        if (checkSeq !== authCheckSeqRef.current) return;
        setUser(null);
        setHasDemoClaim(false);
        setJwtDemoSid(null);
        setJwtDemoDeviceId(null);
        setIsLoadingUserList(false);
        setIsLoadingDeviceDoc(false);
        setAuthUnavailableError(
          'Não foi possível verificar seu acesso no servidor agora. Verifique sua conexão e tente novamente.',
        );
      } finally {
        if (checkSeq === authCheckSeqRef.current) {
          setIsAuthLoading(false);
          setIsRetryingAuthProbe(false);
        }
      }
    },
    [],
  );

  // 1. Escuta mudanças de sessão e renovações de token JWT via onIdTokenChanged
  useEffect(() => {
    let previousUid: string | null = null;

    const unsubscribe = onIdTokenChanged(firebaseAuth, (currentUser) => {
      const checkSeq = ++authCheckSeqRef.current;
      const nextUid = currentUser?.uid ?? null;
      const uidChanged = previousUid !== nextUid;

      if (previousUid && uidChanged) {
        operatorAccessCacheRef.current.delete(previousUid);
        queryClient.clear();
        setAuthUnavailableError(null);
        setFirestoreRole(null);
        setJwtDemoSid(null);
        setJwtDemoDeviceId(null);
        setHasDemoClaim(false);
        setUserDeviceIds([]);
        setSelectedDeviceId(null);
        setSelectedDevice(null);
        setDeviceLoadError(null);
      }

      if (!currentUser) {
        previousUid = null;
        operatorAccessCacheRef.current.clear();
        setUser(null);
        setAuthUnavailableError(null);
        queryClient.clear();
        setFirestoreRole(null);
        setJwtDemoSid(null);
        setJwtDemoDeviceId(null);
        setHasDemoClaim(false);
        setUserDeviceIds([]);
        setSelectedDeviceId(null);
        setSelectedDevice(null);
        setIsLoadingUserList(false);
        setIsLoadingDeviceDoc(false);
        setDeviceLoadError(null);
        setIsAuthLoading(false);
        return;
      }

      // Só ativa loading da lista de estações quando o UID realmente muda (nunca em refresh de token)
      if (uidChanged) {
        setIsLoadingUserList(true);
      }
      previousUid = nextUid;

      void runAuthVerification(currentUser, checkSeq, false);
    });

    return () => unsubscribe();
  }, [runAuthVerification]);

  const handleRetryOperatorVerification = useCallback(() => {
    const currentUser = firebaseAuth.currentUser;
    if (!currentUser) {
      setAuthUnavailableError(null);
      return;
    }
    const checkSeq = ++authCheckSeqRef.current;
    operatorAccessCacheRef.current.delete(currentUser.uid);
    setIsRetryingAuthProbe(true);
    setAuthUnavailableError(null);
    void runAuthVerification(currentUser, checkSeq, true);
  }, [runAuthVerification]);

  const handleSignOutFromUnavailable = useCallback(() => {
    setAuthUnavailableError(null);
    firebaseAuth.signOut().catch(() => undefined);
  }, []);

  // 2. Listener unificado em `users/{uid}` (dispara somente quando userUid/claims demo mudam)
  useEffect(() => {
    if (!userUid) return;
    setIsLoadingUserList(true);

    const userRef = doc(firestoreDb, 'users', userUid);
    const unsubscribeUser = onSnapshot(
      userRef,
      (snap) => {
        if (!snap.exists()) {
          setFirestoreRole(hasDemoClaim ? 'recruiter' : 'customer');
          const fallbackIds = jwtDemoDeviceId ? [jwtDemoDeviceId] : [];
          setUserDeviceIds(fallbackIds);
          setSelectedDeviceId(fallbackIds[0] ?? null);
          setSelectedDevice(null);
          setIsLoadingUserList(false);
          return;
        }

        const data = snap.data();
        setFirestoreRole(typeof data?.role === 'string' ? data.role : 'customer');

        const rawList = data?.my_devices;
        const firestoreIds = Array.isArray(rawList)
          ? rawList.filter(
              (item): item is string =>
                typeof item === 'string' && item.trim().length > 0,
            )
          : [];

        const ids = jwtDemoDeviceId ? [jwtDemoDeviceId] : firestoreIds;
        setUserDeviceIds(ids);

        setSelectedDeviceId((prevSelected) => {
          if (ids.length === 0) return null;
          if (jwtDemoDeviceId) return jwtDemoDeviceId;
          if (prevSelected && ids.includes(prevSelected)) return prevSelected;

          const stored = readStoredDeviceId(userUid);
          if (stored && ids.includes(stored)) return stored;

          const firstId = ids[0];
          writeStoredDeviceId(userUid, firstId);
          return firstId;
        });

        setIsLoadingUserList(false);
      },
      () => {
        if (jwtDemoDeviceId) {
          setUserDeviceIds([jwtDemoDeviceId]);
          setSelectedDeviceId(jwtDemoDeviceId);
        }
        setIsLoadingUserList(false);
      },
    );

    return () => unsubscribeUser();
  }, [userUid, hasDemoClaim, jwtDemoDeviceId]);

  // 3. Escuta em tempo real `devices/{id}` (Titular) ou `devices/{id}/demo_view/current` (Demo)
  useEffect(() => {
    if (!userUid || !selectedDeviceId) {
      setSelectedDevice(null);
      setIsLoadingDeviceDoc(false);
      setDeviceLoadError(null);
      return;
    }

    setSelectedDevice((prev) => (prev?.id === selectedDeviceId ? prev : null));
    setIsLoadingDeviceDoc(true);
    setDeviceLoadError(null);

    const unsubscribeDevice = subscribeToDeviceDocument(
      selectedDeviceId,
      (deviceModel) => {
        setSelectedDevice(deviceModel);
        setIsLoadingDeviceDoc(false);
        setDeviceLoadError(null);
      },
      (err) => {
        setSelectedDevice(null);
        setIsLoadingDeviceDoc(false);

        // Quando o passe expira ou é revogado em private/demo_auth, o Firestore nega leitura imediatamente
        if (isFirestorePermissionDeniedError(err) && isDemoUser) {
          try {
            sessionStorage.removeItem('agrosmart_v5_demo_session_id');
            sessionStorage.removeItem('agrosmart_v5_demo_device_id');
            sessionStorage.setItem(
              'agrosmart_v5_demo_expired_notice',
              'Sua sessão de Usuário Teste expirou ou foi encerrada pelo administrador.',
            );
          } catch {
            // Ignora
          }
          firebaseAuth.signOut().catch(() => undefined);
          return;
        }

        setDeviceLoadError(
          err.message || `Não foi possível carregar os dados da estação ${selectedDeviceId}.`,
        );
      },
      { isDemoView: isDemoUser },
    );

    return () => unsubscribeDevice();
  }, [userUid, selectedDeviceId, isDemoUser]);

  const selectDevice = useCallback(
    (deviceId: string) => {
      if (userUid) {
        writeStoredDeviceId(userUid, deviceId);
      }
      setSelectedDevice((prev) => (prev?.id === deviceId ? prev : null));
      setSelectedDeviceId(deviceId);
    },
    [userUid],
  );

  // 4. Guarda local de expiração da sessão Zero-Credential
  const hasSelectedDeviceLoaded = Boolean(selectedDevice);
  const demoExpiresEpoch = selectedDevice?.settings.demoExpiresEpoch ?? null;
  const demoPassClaimed = Boolean(selectedDevice?.settings.demoPassClaimed);

  useEffect(() => {
    if (!userUid || !isDemoUser || !hasSelectedDeviceLoaded) return;

    const checkPassValidity = () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const isExpired = !demoExpiresEpoch || nowSec >= expiresEpochSafe(demoExpiresEpoch);
      const isSessionInvalid = !demoPassClaimed || !jwtDemoSid;

      if (isExpired || isSessionInvalid) {
        try {
          sessionStorage.removeItem('agrosmart_v5_demo_session_id');
          sessionStorage.removeItem('agrosmart_v5_demo_device_id');
          sessionStorage.setItem(
            'agrosmart_v5_demo_expired_notice',
            isExpired
              ? 'O tempo do seu acesso de Usuário Teste expirou.'
              : 'Sua sessão de Usuário Teste foi encerrada ou substituída por um novo código gerado pelo administrador.',
          );
        } catch {
          // Ignora se sessionStorage estiver indisponível
        }
        firebaseAuth.signOut().catch(() => undefined);
      }
    };

    checkPassValidity();
    const timer = window.setInterval(checkPassValidity, 5000);
    return () => window.clearInterval(timer);
  }, [
    userUid,
    isDemoUser,
    hasSelectedDeviceLoaded,
    demoExpiresEpoch,
    demoPassClaimed,
    jwtDemoSid,
  ]);

  const userRole: UserRole = useMemo(() => {
    if (isDemoUser) return 'recruiter';
    if ((firestoreRole ?? '').trim().toLowerCase() === 'admin') return 'admin';
    return 'customer';
  }, [isDemoUser, firestoreRole]);

  const isLoadingDevices =
    isLoadingUserList || (Boolean(selectedDeviceId) && isLoadingDeviceDoc && !selectedDevice);

  const authValue = useMemo(
    () => ({
      user,
      isAuthLoading,
      userRole,
      isDemoUser,
      demoSessionId: jwtDemoSid,
    }),
    [user, isAuthLoading, userRole, isDemoUser, jwtDemoSid],
  );

  const deviceValue = useMemo(
    () => ({
      userDeviceIds,
      selectedDeviceId,
      selectedDevice,
      isLoadingDevices,
      deviceLoadError,
      selectDevice,
    }),
    [
      userDeviceIds,
      selectedDeviceId,
      selectedDevice,
      isLoadingDevices,
      deviceLoadError,
      selectDevice,
    ],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {/* v5.46.0: confirmações e avisos flutuantes do site inteiro */}
        <FeedbackProvider>
      <AuthContext.Provider value={authValue}>
        <DeviceContext.Provider value={deviceValue}>
          {authUnavailableError ? (
            <div className="min-h-screen min-h-dvh flex items-center justify-center bg-canvas p-6">
              <div className="max-w-md w-full bg-surface rounded-3xl border border-line p-6 sm:p-8 shadow-xl space-y-5 text-center">
                <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-100 text-warning flex items-center justify-center">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <div className="space-y-1.5">
                  <h1 className="text-lg font-extrabold text-ink">
                    Verificação Temporariamente Indisponível
                  </h1>
                  <p className="text-xs text-ink-muted leading-relaxed">
                    {authUnavailableError}
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2.5 justify-center">
                  <button
                    type="button"
                    disabled={isRetryingAuthProbe}
                    onClick={handleRetryOperatorVerification}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-brand hover:bg-brand-strong text-white text-xs font-extrabold shadow-sm transition disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`w-4 h-4 ${isRetryingAuthProbe ? 'animate-spin' : ''}`}
                    />
                    <span>{isRetryingAuthProbe ? 'Verificando...' : 'Tentar novamente'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isRetryingAuthProbe}
                    onClick={handleSignOutFromUnavailable}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-line hover:bg-sunken text-ink-muted text-xs font-bold transition disabled:opacity-50"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Voltar ao login</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            children
          )}
        </DeviceContext.Provider>
      </AuthContext.Provider>
      </FeedbackProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function expiresEpochSafe(val: number | null): number {
  return typeof val === 'number' && Number.isFinite(val) ? val : 0;
}
