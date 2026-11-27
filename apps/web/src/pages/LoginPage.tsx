/**
 * =====================================================================================
 * ARQUIVO: src/pages/LoginPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1C — Operador Somente Google)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T19:03:00Z (UTC)
 * VERSÃO: v5.41.0 (link "Conheça o projeto" para /sobre; versão real no rodapé)
 * PROPÓSITO: Página Executiva de Autenticação com 3 Modos:
 *            1. Operador (Login exclusivo via Google OAuth 2.0 validado no servidor);
 *            2. Usuário Teste (Validação Zero-Credential `AGRO-XXXX-XXXX` via rota
 *               dedicada `POST /demo/claim` + emissão de Custom Token JWT de Uso Único);
 *            3. Simulador de Onboarding Comercial (Demonstração de cadastro sem gravar
 *               contas avulsas no banco de dados de produção).
 * CHANGELOG:
 * - v5.31.0:
 *   * Remove formulário de e-mail/senha, botão "Esqueci minha senha" e constantes de
 *     e-mails reservados na aba de Operador, mantendo apenas "Entrar com Google".
 *   * Mantém inalteradas as abas `demo_token` e `signup_sim`.
 * - v5.27.1: Lê `?device=` da URL para suportar convites multi-estação (BUG-12).
 * =====================================================================================
 */

import React, { useEffect, useState } from 'react';
import {
  Sprout,
  Mail,
  User as UserIcon,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Cpu,
  Cloud,
  ShieldCheck,
  Activity,
  KeyRound,
  Info,
  BookOpen,
  ArrowRight,
} from 'lucide-react';
import {
  claimDemoPassAndLogin,
  loginWithGoogle,
  logoutUser,
  translateFirebaseAuthError,
} from '../features/auth/api/authService';
import { Link } from 'react-router-dom';
import { APP_VERSION_LABEL } from '../shared/config/appInfo';
import { pageTitle } from '../app/router/routeMeta';

const DEFAULT_STATION_ID = 'ESP32-AgroSmart-Station-V5';

type AuthTabMode = 'operator' | 'demo_token' | 'signup_sim';

function resolveTargetDeviceIdFromUrl(): { deviceId: string; hasUrlParam: boolean } {
  if (typeof window === 'undefined') {
    return { deviceId: DEFAULT_STATION_ID, hasUrlParam: false };
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('device')?.trim();
    if (fromQuery && /^[A-Za-z0-9:_-]{1,80}$/.test(fromQuery)) {
      return { deviceId: fromQuery, hasUrlParam: true };
    }
  } catch {
    // Ignora falha de URLSearchParams
  }
  return { deviceId: DEFAULT_STATION_ID, hasUrlParam: false };
}

export function LoginPage() {
  const initialTarget = resolveTargetDeviceIdFromUrl();
  const [mode, setMode] = useState<AuthTabMode>(
    initialTarget.hasUrlParam ? 'demo_token' : 'operator',
  );

  // Estado do Passe Temporário de Uso Único (AGRO-XXXX-XXXX) para Usuário Teste
  const [inviteToken, setInviteToken] = useState('');
  const [targetDeviceId] = useState<string>(initialTarget.deviceId);

  // Estado do Simulador de Onboarding Comercial (Não grava no banco)
  const [simName, setSimName] = useState('');
  const [simEmail, setSimEmail] = useState('');
  const [simSerial, setSimSerial] = useState('ESP32-AgroSmart-Station-V5');
  const [simCompleted, setSimCompleted] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  // v5.47.0: título da aba ("Entrar · AgroSmart Precision IoT")
  useEffect(() => {
    document.title = pageTitle('/login');
  }, []);

  useEffect(() => {
    try {
      const expiredNotice = sessionStorage.getItem('agrosmart_v5_demo_expired_notice');
      if (expiredNotice) {
        sessionStorage.removeItem('agrosmart_v5_demo_expired_notice');
        setMode('demo_token');
        setErrorMsg(expiredNotice);
      }
    } catch {
      // Ignora caso sessionStorage esteja bloqueado
    }
  }, []);

  const handleDemoTokenLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);

    const cleanToken = inviteToken.trim().toUpperCase();
    if (!cleanToken) {
      setErrorMsg(
        'Digite o Código Temporário de Uso Único (ex.: AGRO-XXXX-XXXX) fornecido pelo administrador.',
      );
      return;
    }

    setIsLoading(true);
    try {
      await claimDemoPassAndLogin(cleanToken, targetDeviceId);
    } catch (err) {
      await logoutUser().catch(() => undefined);
      setErrorMsg(translateFirebaseAuthError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSimulatedSignup = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);

    if (!simName.trim() || !simEmail.trim() || !simSerial.trim()) {
      setErrorMsg('Preencha os campos acima para testar a simulação de onboarding.');
      return;
    }
    setSimCompleted(true);
  };

  const handleGoogleLogin = async () => {
    setErrorMsg(null);
    setInfoMsg(null);
    setIsLoading(true);
    try {
      await loginWithGoogle();
    } catch (err) {
      setErrorMsg(translateFirebaseAuthError(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen min-h-dvh flex flex-col lg:flex-row bg-canvas pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {/* COLUNA ESQUERDA (HERO EXECUTIVO PARA DESKTOP) */}
      <div className="hidden lg:flex lg:w-7/12 bg-gradient-to-br from-[#0D3314] via-brand-strong to-brand text-white p-12 xl:p-16 flex-col justify-between relative overflow-hidden">
        <div className="relative z-10">
          <div className="inline-flex items-center gap-3 px-4 py-2 rounded-2xl bg-white/10 border border-white/20 backdrop-blur-sm">
            <Sprout className="w-6 h-6 text-[#00E676]" />
            <span className="font-extrabold text-sm tracking-wide">
              AGROSMART PRECISION IOT V5
            </span>
          </div>

          <h1 className="text-4xl xl:text-5xl font-extrabold tracking-tight leading-tight mt-8">
            Irrigação Autônoma de Precisão & Telemetria Multi-Cloud.
          </h1>
          <p className="text-base text-emerald-100/90 mt-4 max-w-xl leading-relaxed">
            Centro de comando web em tempo real integrado à estação física ESP32 (FreeRTOS),
            Amazon Web Services (IoT Core, DynamoDB, S3, Lambda) e Google Cloud Firestore.
          </p>

          <div className="grid grid-cols-2 gap-4 mt-10 max-w-2xl">
            <div className="p-4 rounded-2xl bg-black/20 border border-white/15 backdrop-blur-sm">
              <div className="flex items-center gap-2.5 text-[#00E676] font-bold text-sm mb-1">
                <Cpu className="w-4 h-4" />
                <span>Edge Computing FreeRTOS</span>
              </div>
              <p className="text-xs text-emerald-100/80 leading-relaxed">
                4 Tasks concorrentes, fila offline WAL em MicroSD, Edge Rain Interlock (&lt;600ms) e
                particionamento Dual-Bank OTA.
              </p>
            </div>

            <div className="p-4 rounded-2xl bg-black/20 border border-white/15 backdrop-blur-sm">
              <div className="flex items-center gap-2.5 text-[#00E676] font-bold text-sm mb-1">
                <Cloud className="w-4 h-4" />
                <span>AWS Serverless Data Plane</span>
              </div>
              <p className="text-xs text-emerald-100/80 leading-relaxed">
                Ingestão mTLS X.509 direta no DynamoDB, paginação assinada HMAC-SHA256 e cofre OTA
                privado no Amazon S3.
              </p>
            </div>

            <div className="p-4 rounded-2xl bg-black/20 border border-white/15 backdrop-blur-sm">
              <div className="flex items-center gap-2.5 text-[#00E676] font-bold text-sm mb-1">
                <ShieldCheck className="w-4 h-4" />
                <span>Transações ACID & Zero-Trust</span>
              </div>
              <p className="text-xs text-emerald-100/80 leading-relaxed">
                Locks transacionais no Firestore contra acionamentos concorrentes e validação JWT
                RS256 via JWKS.
              </p>
            </div>

            <div className="p-4 rounded-2xl bg-black/20 border border-white/15 backdrop-blur-sm">
              <div className="flex items-center gap-2.5 text-[#00E676] font-bold text-sm mb-1">
                <Activity className="w-4 h-4" />
                <span>Gráficos Canvas & IA Climática</span>
              </div>
              <p className="text-xs text-emerald-100/80 leading-relaxed">
                Visualização de séries temporais com downsampling server-side e bloqueio preventivo
                de chuva via Open-Meteo 3h.
              </p>
            </div>
          </div>
        </div>

        <div className="relative z-10 pt-8 border-t border-white/15 flex items-center justify-between text-xs text-emerald-100/80">
          <span>Arquitetura e Engenharia: James Rafael Ehlert Reinard</span>
          <span className="font-mono font-bold text-white">Web {APP_VERSION_LABEL}</span>
        </div>
      </div>

      {/* COLUNA DIREITA (FORMULÁRIO DE AUTENTICAÇÃO) */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10">
        <div className="max-w-md w-full">
          <div className="text-center lg:text-left mb-6">
            <div className="lg:hidden inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-brand to-brand-strong text-white mb-3 shadow-md">
              <Sprout className="w-9 h-9" />
            </div>
            <h2 className="text-2xl font-extrabold text-ink">
              {mode === 'operator'
                ? 'Acessar Painel de Controle'
                : mode === 'demo_token'
                  ? 'Acesso Temporário — Usuário Teste'
                  : 'Simulador de Onboarding Comercial'}
            </h2>
            <p className="text-xs font-medium text-ink-muted mt-1">
              Autenticação federada sincronizada com o ecossistema AgroSmart V5
            </p>
          </div>

          {/* v5.41.0: apresentação pública do projeto, sem login */}
          <Link
            to="/sobre"
            data-testid="login-about-link"
            className="group mb-5 flex items-center gap-3 rounded-2xl border border-brand-soft bg-gradient-to-r from-[#F1F8E9] to-white px-4 py-3 hover:border-brand hover:shadow-sm transition"
          >
            <span className="p-2 rounded-xl bg-brand text-white shrink-0">
              <BookOpen className="w-4 h-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-extrabold text-ink">Conheça o projeto</span>
              <span className="block text-xs text-ink-muted">Arquitetura, segurança, diagramas e contato. Sem precisar entrar.</span>
            </span>
            <ArrowRight className="w-4 h-4 text-brand shrink-0 transition group-hover:translate-x-0.5" />
          </Link>

          <div className="bg-surface rounded-3xl border border-line p-6 sm:p-8 shadow-xl">
            {/* Seletor de 3 Abas: Operador | Usuário Teste | Onboarding (Simulação) */}
            <div className="grid grid-cols-3 rounded-xl bg-sunken p-1 mb-6 gap-1">
              <button
                type="button"
                onClick={() => {
                  setMode('operator');
                  setErrorMsg(null);
                  setInfoMsg(null);
                }}
                className={`py-2 text-xs font-extrabold rounded-lg transition ${
                  mode === 'operator'
                    ? 'bg-surface text-brand shadow-sm'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                Operador
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('demo_token');
                  setErrorMsg(null);
                  setInfoMsg(null);
                }}
                className={`py-2 text-xs font-extrabold rounded-lg transition ${
                  mode === 'demo_token'
                    ? 'bg-surface text-brand shadow-sm'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                Usuário Teste
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('signup_sim');
                  setSimCompleted(false);
                  setErrorMsg(null);
                  setInfoMsg(null);
                }}
                className={`py-2 text-xs font-extrabold rounded-lg transition ${
                  mode === 'signup_sim'
                    ? 'bg-surface text-brand shadow-sm'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                Novo Cliente
              </button>
            </div>

            {errorMsg && (
              <div role="alert" className="mb-5 p-3.5 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs font-semibold text-danger">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            {infoMsg && (
              <div role="status" className="mb-5 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 flex items-start gap-2.5 text-xs font-semibold text-brand">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{infoMsg}</span>
              </div>
            )}

            {/* ================================================================= */}
            {/* MODO 1: LOGIN DO OPERADOR TITULAR (SOMENTE GOOGLE OAUTH 2.0)      */}
            {/* ================================================================= */}
            {mode === 'operator' && (
              <div className="space-y-5">
                <div className="p-3.5 rounded-2xl bg-sunken/70 border border-line text-xs text-ink-muted leading-relaxed">
                  Acesso administrativo protegido por autenticação federada{' '}
                  <strong className="text-ink">Google OAuth 2.0</strong> com validação de
                  autorização no servidor.
                </div>

                <button
                  type="button"
                  disabled={isLoading}
                  onClick={handleGoogleLogin}
                  className="w-full py-3.5 px-4 rounded-xl border border-line bg-surface hover:bg-sunken/70 text-ink font-extrabold text-sm shadow-sm transition flex items-center justify-center gap-2.5 disabled:opacity-50"
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-brand" />
                  ) : (
                    <svg className="w-4 h-4" viewBox="0 0 24 24">
                      <path
                        fill="#4285F4"
                        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                      />
                    </svg>
                  )}
                  <span>Entrar com Google</span>
                </button>

                <div className="pt-1 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('demo_token');
                      setErrorMsg(null);
                      setInfoMsg(null);
                    }}
                    className="text-xs font-bold text-info hover:underline"
                  >
                    É recrutador ou avaliador? Entrar como Usuário Teste (Token)
                  </button>
                </div>
              </div>
            )}

            {/* ================================================================= */}
            {/* MODO 2: ACESSO ZERO-CREDENTIAL DE USUÁRIO TESTE (SHA-256 + JWT)   */}
            {/* ================================================================= */}
            {mode === 'demo_token' && (
              <form onSubmit={handleDemoTokenLogin} className="space-y-4">
                <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-xs text-brand-strong space-y-1">
                  <div className="font-extrabold flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 shrink-0" />
                    <span>Acesso Zero-Credential Protegido por SHA-256 (Uso Único)</span>
                  </div>
                  <p className="text-ink leading-relaxed">
                    Para acessar a estação <code>{targetDeviceId}</code> no{' '}
                    <strong>Modo Usuário Teste</strong>, digite abaixo o código temporário de uso
                    único (ex.: <code>AGRO-XXXX-XXXX</code>) fornecido por{' '}
                    <strong>James Rafael</strong>.
                  </p>
                </div>

                <div>
                  <label htmlFor="login-invite" className="block text-xs font-bold text-ink mb-1.5">
                    Código Temporário de Usuário Teste
                  </label>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 text-brand absolute left-3.5 top-3" />
                    <input
                      id="login-invite"
                      type="text"
                      maxLength={14}
                      autoComplete="off"
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                      enterKeyHint="go"
                      aria-describedby="login-invite-hint"
                      aria-invalid={mode === 'demo_token' && !!errorMsg ? true : undefined}
                      value={inviteToken}
                      onChange={(e) => setInviteToken(e.target.value.toUpperCase())}
                      placeholder="AGRO-XXXX-XXXX"
                      className="w-full pl-10 pr-4 py-2.5 rounded-xl border-2 border-brand/40 font-mono font-extrabold text-base uppercase tracking-widest text-brand-strong focus:outline-none focus:border-brand"
                    />
                  </div>
                  <p id="login-invite-hint" className="mt-1.5 text-xs text-ink-muted">Formato AGRO-XXXX-XXXX (letras e números, como no convite).</p>
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-brand to-brand-strong hover:opacity-95 text-white font-extrabold text-sm shadow-md transition flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>Validar código e entrar</span>
                </button>
              </form>
            )}

            {/* ================================================================= */}
            {/* MODO 3: SIMULADOR DE ONBOARDING COMERCIAL (SEM GRAVAR NO BANCO)   */}
            {/* ================================================================= */}
            {mode === 'signup_sim' && (
              <div className="space-y-4">
                <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-xs text-ink space-y-1">
                  <div className="font-extrabold text-warning flex items-center gap-1.5">
                    <Info className="w-4 h-4 shrink-0" />
                    <span>Modo Demonstração de Onboarding (Sem Escrita no Banco)</span>
                  </div>
                  <p className="leading-relaxed text-ink-muted">
                    Como este ambiente controla um protótipo físico real em bancada/jardim, o
                    cadastro público está em <strong>modo simulação</strong> para demonstrar o
                    fluxo comercial de ativação de uma estação IoT.
                  </p>
                </div>

                {simCompleted ? (
                  <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 space-y-3 text-xs">
                    <div className="flex items-center gap-2 text-sm font-extrabold text-brand-strong">
                      <CheckCircle2 className="w-5 h-5 text-brand" />
                      <span>Simulação de Onboarding Concluída!</span>
                    </div>
                    <p className="text-ink leading-relaxed">
                      Em produção comercial, o produtor <strong>{simName}</strong> ({simEmail})
                      teria sua conta provisionada com estas 3 etapas automáticas:
                    </p>
                    <ol className="list-decimal list-inside space-y-1 text-ink-muted font-medium">
                      <li>
                        Criação do perfil Multi-Tenant <code>users/&#123;uid&#125;</code> com{' '}
                        <code>role: &quot;customer&quot;</code>;
                      </li>
                      <li>
                        Reivindicação atômica do hardware <code>{simSerial}</code> via código de
                        pareamento gravado na fábrica;
                      </li>
                      <li>
                        Isolamento imediato de telemetria e comandos via regras Zero-Trust.
                      </li>
                    </ol>
                    <button
                      type="button"
                      onClick={() => setMode('demo_token')}
                      className="w-full py-2.5 rounded-xl bg-brand text-white font-extrabold text-xs"
                    >
                      Ir para Acesso de Usuário Teste
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleSimulatedSignup} className="space-y-3.5">
                    <div>
                      <label htmlFor="sim-name" className="block text-xs font-bold text-ink mb-1">
                        Nome do Produtor / Fazenda (Simulado)
                      </label>
                      <div className="relative">
                        <UserIcon className="w-4 h-4 text-ink-muted absolute left-3.5 top-3" />
                        <input
                          id="sim-name"
                          type="text"
                          autoComplete="organization"
                          value={simName}
                          onChange={(e) => setSimName(e.target.value)}
                          placeholder="Ex: Fazenda Santa Clara"
                          className="w-full pl-10 pr-4 py-2 rounded-xl border border-line text-sm"
                        />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="sim-email" className="block text-xs font-bold text-ink mb-1">
                        E-mail Corporativo (Simulado)
                      </label>
                      <div className="relative">
                        <Mail className="w-4 h-4 text-ink-muted absolute left-3.5 top-3" />
                        <input
                          id="sim-email"
                          type="email"
                          autoComplete="email"
                          inputMode="email"
                          value={simEmail}
                          onChange={(e) => setSimEmail(e.target.value)}
                          placeholder="contato@fazenda.com.br"
                          className="w-full pl-10 pr-4 py-2 rounded-xl border border-line text-sm"
                        />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="sim-serial" className="block text-xs font-bold text-ink mb-1">
                        ID Serial da Caixa AgroSmart (Thing Name)
                      </label>
                      <div className="relative">
                        <Cpu className="w-4 h-4 text-ink-muted absolute left-3.5 top-3" />
                        <input
                          id="sim-serial"
                          type="text"
                          autoComplete="off"
                          autoCapitalize="characters"
                          spellCheck={false}
                          value={simSerial}
                          onChange={(e) => setSimSerial(e.target.value)}
                          className="w-full pl-10 pr-4 py-2 rounded-xl border border-line text-sm font-mono"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      className="w-full py-3 rounded-xl bg-info hover:bg-blue-800 text-white font-extrabold text-xs shadow-md transition"
                    >
                      Simular ativação de novo cliente
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
