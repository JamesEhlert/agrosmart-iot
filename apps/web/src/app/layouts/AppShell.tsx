/**
 * =====================================================================================
 * ARQUIVO: src/app/layouts/AppShell.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T01:05:00-03:00
 * VERSÃO: v5.47.0 (celular: cabeçalho compacto e barra de 5 itens + Mais; título da aba,
 *          rolagem ao topo, foco no conteúdo e "Pular para o conteúdo"; proteção por tela)
 * PROPÓSITO: Layout Responsivo Executivo com Sidebar 100% Fixa (`lg:sticky lg:top-0
 *            lg:h-screen`), isolamento de montagem por estação (`key`) e acesso livre
 *            ao Guia & Simulador Gêmeo Digital (`/about`) mesmo sem placa vinculada.
 * CHANGELOG:
 * - v5.47.0: MOB-01/MOB-02 e itens da pesquisa "o que as IAs esquecem" (WEB-36..44).
 * - v5.39.0 (F1.4): menu "Guia & Simulador" passa a "Sobre o Projeto".
 * - v5.38.0 (F1.1): botão "Diagnóstico" do titular no cabeçalho (DiagnosticsLauncher).
 * - v5.36.0: item "Logs & Auditoria" (`/logs`) na barra lateral e na barra inferior;
 *            "Agenda & Auditoria" passa a se chamar "Agendamentos".
 * - v5.25.0: [Auditoria 05 - UI-01 e UI-02]
 *            1. Permite abrir a rota `/about` mesmo quando `hasDevices === false`;
 *            2. Monta `<Outlet />` dentro de um container com `key` vinculado a
 *               `user.uid` e `selectedDevice.id`, garantindo limpeza total de estado
 *               ao alternar entre estações A e B;
 *            3. Trata erros de leitura do documento da estação com mensagem clara.
 * =====================================================================================
 */

import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { NavLink, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import {
  LayoutDashboard,
  CalendarClock,
  LineChart,
  List,
  Settings,
  BookOpen,
  Sprout,
  ChevronDown,
  LogOut,
  Radio,
  PlusCircle,
  Cpu,
  ArrowUpCircle,
  Droplets,
  ShieldCheck,
  Lock,
  AlertTriangle,
  ScrollText,
  Search,
  MoreHorizontal,
} from 'lucide-react';
import { useAuth } from '../../features/auth/hooks/useAuth';
import { NotificationBell } from '../../features/notifications/components/NotificationBell';
import { ThemeToggle } from '../../shared/theme/ThemeToggle';
import { logoutUser } from '../../features/auth/api/authService';
import { useSelectedDevice } from '../../features/devices/hooks/useSelectedDevice';
import { DeviceSelectorModal } from '../../features/devices/components/DeviceSelectorModal';
import { LinkDeviceModal } from '../../features/devices/components/LinkDeviceModal';
import { AppFooter } from './AppFooter';
import { DiagnosticsLauncher } from './DiagnosticsLauncher';
import { preloadHandlers, preloadRoute } from '../router/lazyPages';
import { useConfirm } from '../../shared/ui/Feedback.providers';
import { CommandCenter, openCommandPalette } from '../../shared/command/CommandCenter';
import { OfflineBanner } from '../../shared/ui/OfflineBanner';
import { PageErrorBoundary } from './PageErrorBoundary';
import { MobileMoreSheet } from './MobileMoreSheet';
import { isMoreRoute, MOBILE_PRIMARY_ROUTES, pageTitle } from '../router/routeMeta';

const NAV_ITEMS = [
  { to: '/monitor', label: 'Monitoramento', shortLabel: 'Monitor', icon: LayoutDashboard },
  { to: '/charts', label: 'Gráficos Analíticos', shortLabel: 'Gráficos', icon: LineChart },
  { to: '/readings', label: 'Histórico de Leituras', shortLabel: 'Leituras', icon: List },
  { to: '/schedules', label: 'Agendamentos', shortLabel: 'Agenda', icon: CalendarClock },
  { to: '/logs', label: 'Logs & Auditoria', shortLabel: 'Logs', icon: ScrollText },
  { to: '/settings', label: 'Configurações & OTA', shortLabel: 'Config', icon: Settings },
  { to: '/about', label: 'Sobre o Projeto', shortLabel: 'Sobre', icon: BookOpen },
] as const;

/** v5.46.0: painéis de dados aproveitam telas grandes (até 1.440 px); o resto fica em 1.280 px. */
export const WIDE_ROUTES = new Set(['/monitor', '/charts']);

/** v5.45.0: iniciais para o avatar ("James Rafael Ehlert Reinard" -> "JR"). */
export function userInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
}

/**
 * v5.47.0: o que um site de uma página só (SPA) precisa fazer a cada troca de tela e as IAs
 * costumam esquecer: (1) título da aba com o nome da tela; (2) voltar ao topo (antes a tela
 * nova abria no meio, na altura em que a anterior estava); (3) levar o foco ao conteúdo,
 * para teclado e leitor de tela "chegarem" na tela nova. Voltar/avançar do navegador
 * (POP) mantém a posição.
 */
function useRouteChangeEffects(mainRef: RefObject<HTMLElement>) {
  const { pathname } = useLocation();
  const navType = useNavigationType();
  const first = useRef(true);
  useEffect(() => {
    document.title = pageTitle(pathname);
  }, [pathname]);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (navType !== 'POP') window.scrollTo({ top: 0, left: 0 });
    mainRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
}

export function AppShell() {
  const { user, isDemoUser } = useAuth();
  const location = useLocation();
  const confirm = useConfirm();
  const mainRef = useRef<HTMLElement>(null);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  useRouteChangeEffects(mainRef);

  // v5.46.0: encerrar a sessão sempre pergunta antes (o botão fica perto de outros e é fácil
  // tocar sem querer). Para o convidado, lembra que precisará do código do passe de novo.
  const askLogout = async () => {
    const ok = await confirm({
      title: 'Encerrar a sessão?',
      message: isDemoUser
        ? 'Para entrar de novo você vai precisar do código do passe de convidado (se ele ainda estiver válido).'
        : 'Você sairá da conta Google neste navegador. A estação continua funcionando normalmente.',
      confirmLabel: 'Encerrar sessão',
      tone: 'danger',
    });
    if (ok) logoutUser().catch(() => undefined);
  };

  // v5.43.0: com a tela aberta e o navegador ocioso, baixa as outras páginas em segundo
  // plano (trocar de aba fica instantâneo). Respeita "economia de dados" e rede 2G.
  useEffect(() => {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } };
    if (nav.connection?.saveData || /(^|-)2g$/.test(nav.connection?.effectiveType ?? '')) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const run = () => ['/schedules', '/logs', '/settings', '/readings', '/charts', '/about'].forEach(preloadRoute);
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(run, { timeout: 8000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(run, 4000);
    return () => window.clearTimeout(id);
  }, []);
  const {
    userDeviceIds,
    selectedDeviceId,
    selectedDevice,
    isLoadingDevices,
    deviceLoadError,
    selectDevice,
  } = useSelectedDevice();

  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);

  const hasDevices = userDeviceIds.length > 0;
  const displayName = isDemoUser ? 'Usuário Teste' : (user?.displayName || 'Operador AgroSmart');
  const roleLabel = isDemoUser ? 'Convidado · passe temporário' : 'Titular · conta Google';
  const skipToContent = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    mainRef.current?.focus();
    mainRef.current?.scrollIntoView({ block: 'start' });
  };
  const isAboutRoute = location.pathname === '/about';

  return (
    <div className="min-h-screen min-h-dvh flex items-start bg-canvas text-ink pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {/* v5.47.0: primeiro item do Tab — pula o menu e vai direto ao conteúdo */}
      <a href="#conteudo" onClick={skipToContent} data-testid="skip-link"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[90] focus:px-4 focus:py-2.5 focus:rounded-xl focus:bg-surface focus:text-ink focus:text-sm focus:font-bold focus:shadow-xl focus:border focus:border-line">
        Pular para o conteúdo
      </a>
      {/* 1. SIDEBAR 100% FIXA NA TELA PARA DESKTOP (`lg:sticky lg:top-0 lg:h-screen`) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-72 lg:sticky lg:top-0 lg:h-screen lg:h-dvh bg-surface border-r border-line shrink-0 shadow-sm z-30">
        <div className="h-20 px-6 flex items-center gap-3.5 border-b border-line shrink-0">
          <div className="p-2.5 rounded-2xl bg-gradient-to-br from-brand to-brand-strong text-white shadow-md">
            <Sprout className="w-6 h-6" />
          </div>
          <div>
            <span className="font-extrabold text-lg text-ink tracking-tight block leading-none">
              AgroSmart V5
            </span>
            <span className="text-xs font-semibold text-brand uppercase tracking-wider mt-1 block">
              Precision IoT Cloud
            </span>
          </div>
        </div>

        <div className="px-5 pt-5 pb-2 shrink-0">
          <span className="text-[11px] font-extrabold uppercase tracking-widest text-ink-muted">
            Navegação Principal
          </span>
        </div>

        <nav aria-label="Navegação principal" className="flex-1 px-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const showOtaBadge =
              item.to === '/settings' && selectedDevice?.hasUpdateAvailable;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                {...preloadHandlers(item.to)}
                className={({ isActive }) =>
                  `flex items-center justify-between px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${
                    isActive
                      ? 'bg-gradient-to-r from-brand to-brand-strong text-white shadow-md'
                      : 'text-ink-muted hover:bg-sunken hover:text-ink'
                  }`
                }
              >
                <div className="flex items-center gap-3">
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </div>
                {showOtaBadge && (
                  <span className="px-2 py-0.5 text-[11px] font-extrabold rounded-full bg-[#00E676] text-[#1B5E20] shadow-sm">
                    OTA
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="p-4 border-t border-line space-y-2.5 bg-subtle shrink-0">
          {isDemoUser ? (
            <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-300 flex items-center gap-2">
              <Lock className="w-4 h-4 text-warning shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-extrabold text-warning truncate">
                  Modo Usuário Teste
                </p>
                <p className="text-[11px] text-ink-muted truncate">
                  Exclusões e OTA bloqueados
                </p>
              </div>
            </div>
          ) : (
            <div className="p-2.5 rounded-xl bg-emerald-50/80 border border-emerald-200/80 flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 text-brand shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-bold text-brand-strong truncate">
                  Segurança Zero-Trust Ativa
                </p>
                <p className="text-[11px] text-ink-muted truncate">
                  JWT RS256 + mTLS X.509
                </p>
              </div>
            </div>
          )}

          {/* v5.45.0 (WEB-31): sem e-mail na tela (aparece em compartilhamento de tela);
              mostra iniciais, nome e o papel da conta. */}
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-surface border border-line shadow-sm">
            <span className="shrink-0 w-8 h-8 rounded-full bg-brand-tint text-brand-strong text-xs font-extrabold flex items-center justify-center" aria-hidden="true">
              {userInitials(displayName)}
            </span>
            <div className="min-w-0">
              <p className="text-xs font-extrabold text-ink truncate">
                {displayName}
              </p>
              <p className="text-xs text-ink-muted truncate">{roleLabel}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={askLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-danger bg-red-50/70 hover:bg-red-100 border border-red-200/60 transition"
          >
            <LogOut className="w-4 h-4" />
            <span>Encerrar sessão</span>
          </button>
        </div>
      </aside>

      {/* 2. COLUNA CENTRAL + TOP HEADER + CONTEÚDO + FOOTER */}
      <div className="flex-1 flex flex-col min-h-screen min-h-dvh min-w-0 pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-0">
        {/* v5.47.0 (MOB-01): 56 px no celular (estação + status numa linha, sino e mais nada);
            tema, diagnóstico e sair ficam na folha "Mais". Anel de foco branco sobre o verde. */}
        <header className="h-14 lg:h-20 [--focus-ring:255_255_255] bg-gradient-to-r from-brand-strong via-brand to-brand-strong dark:from-[#0F2E13] dark:via-[#17421C] dark:to-[#0F2E13] dark:border-b dark:border-white/10 text-white px-3 sm:px-4 lg:px-8 gap-2 flex items-center justify-between shadow-md sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            {hasDevices && selectedDevice ? (
              <button
                type="button"
                onClick={() => setIsSelectorOpen(true)}
                aria-label={`Estação ${selectedDevice.settings.deviceName}, ${selectedDevice.isOnline ? 'online' : 'offline'}. Trocar de estação`}
                className="flex items-center gap-2 sm:gap-3.5 px-3 py-1.5 sm:px-4 sm:py-2 rounded-xl sm:rounded-2xl bg-black/20 hover:bg-black/30 border border-white/20 transition text-left min-w-0 shadow-sm"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span aria-hidden="true" className={`sm:hidden shrink-0 w-2.5 h-2.5 rounded-full ${selectedDevice.isOnline ? 'bg-[#00E676]' : 'bg-[#FF5252]'}`} />
                    <span className="font-extrabold text-sm sm:text-base truncate">
                      {selectedDevice.settings.deviceName}
                    </span>
                    {selectedDevice.currentFw && (
                      <span className="hidden 2xl:inline-flex shrink-0 whitespace-nowrap items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-bold bg-white/15 text-white border border-white/15">
                        <Cpu className="w-3 h-3" />v{selectedDevice.currentFw}
                        {selectedDevice.currentPartition
                          ? ` (${selectedDevice.currentPartition})`
                          : ''}
                      </span>
                    )}
                  </div>
                  <div className="hidden sm:flex items-center gap-2 text-xs text-white/90 mt-0.5">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        selectedDevice.isOnline
                          ? 'bg-[#00E676] shadow-[0_0_8px_#00E676]'
                          : 'bg-[#FF5252]'
                      }`}
                    />
                    <span className="truncate font-medium">
                      {selectedDevice.id} •{' '}
                      <strong>{selectedDevice.isOnline ? 'Online' : 'Offline'}</strong>
                    </span>
                  </div>
                </div>
                <ChevronDown className="w-4 h-4 text-white/85 shrink-0" />
              </button>
            ) : (
              <div className="flex items-center gap-2.5">
                <Sprout className="w-6 h-6 text-[#00E676]" />
                <span className="font-extrabold text-lg">AgroSmart V5</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            {selectedDevice?.state.valveOpen && (
              <NavLink
                to="/monitor"
                aria-label="Irrigação em curso"
                title="Irrigação em curso"
                className="sm:hidden inline-flex items-center justify-center w-10 h-10 rounded-xl bg-blue-500 text-white shadow-sm motion-safe:animate-pulse"
              >
                <Droplets className="w-5 h-5" aria-hidden="true" />
              </NavLink>
            )}
            {selectedDevice?.state.valveOpen && (
              <NavLink
                to="/monitor"
                className="hidden sm:inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-blue-500 text-white font-extrabold text-xs shadow-sm animate-pulse"
              >
                <Droplets className="w-4 h-4" />
                <span>Irrigação em curso</span>
              </NavLink>
            )}

            {selectedDevice?.hasUpdateAvailable && (
              <NavLink
                to="/settings"
                className="hidden md:inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#00E676] hover:bg-[#00C853] text-[#1B5E20] dark:text-[#1B5E20] font-extrabold text-xs shadow-sm transition"
              >
                <ArrowUpCircle className="w-4 h-4" />
                <span>Atualizar para v{selectedDevice.availableOta.version}</span>
              </NavLink>
            )}

            {/* v5.42.0: central de notificações e tema (sempre visíveis, no celular também) */}
            {/* v5.46.0: busca de comandos (Ctrl+K) */}
            <button
              type="button"
              onClick={openCommandPalette}
              title="Buscar telas e ações (Ctrl+K)"
              aria-label="Buscar telas e ações (Ctrl+K)"
              aria-keyshortcuts="Control+K"
              className="hidden lg:inline-flex items-center gap-2 h-10 pl-3 pr-2 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white/90 text-xs font-semibold transition"
              data-testid="open-command-palette"
            >
              <Search className="w-4 h-4" aria-hidden="true" />
              <span>Buscar</span>
              <span className="ml-2 px-1.5 py-0.5 rounded-md bg-black/20 text-[11px] font-bold tracking-wide">Ctrl K</span>
            </button>
            {selectedDevice && <NotificationBell device={selectedDevice} isDemo={isDemoUser} />}
            <div className="hidden lg:block"><ThemeToggle /></div>

            <DiagnosticsLauncher isDemoUser={isDemoUser} buttonClassName="hidden lg:inline-flex" />

            {!isDemoUser && (
              <button
                type="button"
                onClick={() => setIsLinkModalOpen(true)}
                title="Vincular outra estação ESP32"
                className="hidden lg:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/15 hover:bg-white/25 border border-white/20 text-white text-xs font-bold transition"
              >
                <PlusCircle className="w-4 h-4" />
                <span className="hidden xl:inline">Nova Estação</span>
              </button>
            )}

          </div>
        </header>

        <OfflineBanner />

        <main id="conteudo" ref={mainRef} tabIndex={-1} className={`flex-1 outline-none ${WIDE_ROUTES.has(location.pathname) ? 'max-w-[1440px]' : 'max-w-7xl'} w-full mx-auto p-4 lg:p-6 2xl:px-8`}>
          {isAboutRoute ? (
            /* A página Sobre o Projeto funciona mesmo sem placa vinculada */
            <PageErrorBoundary resetKey={location.pathname}>
              <div key={location.pathname} className="anim-page"><Outlet /></div>
            </PageErrorBoundary>
          ) : isLoadingDevices ? (
            <div className="h-64 flex flex-col items-center justify-center gap-3">
              <div className="w-9 h-9 border-4 border-brand border-t-transparent rounded-full animate-spin" />
              <span className="text-xs font-bold text-ink-muted">
                Sincronizando estação IoT ({selectedDeviceId ?? 'perfil'}) no Cloud Firestore...
              </span>
            </div>
          ) : deviceLoadError ? (
            <div className="bg-surface rounded-3xl border border-red-200 p-8 text-center max-w-md mx-auto mt-12 shadow-md">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-50 text-danger mb-3">
                <AlertTriangle className="w-8 h-8" />
              </div>
              <h2 className="text-lg font-extrabold text-ink">
                Falha ao carregar estação
              </h2>
              <p className="text-xs text-ink-muted mt-2 leading-relaxed">
                {deviceLoadError}
              </p>
              {userDeviceIds.length > 1 && (
                <button
                  type="button"
                  onClick={() => setIsSelectorOpen(true)}
                  className="mt-5 px-5 py-2.5 rounded-xl bg-brand text-white text-xs font-bold"
                >
                  Selecionar Outra Estação
                </button>
              )}
            </div>
          ) : !hasDevices ? (
            <div className="bg-surface rounded-3xl border border-line p-10 text-center max-w-md mx-auto mt-12 shadow-md">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-brand-soft/50 text-brand mb-4">
                <Radio className="w-10 h-10" />
              </div>
              <h2 className="text-xl font-extrabold text-ink">
                Nenhuma estação vinculada
              </h2>
              <p className="text-sm text-ink-muted mt-2 leading-relaxed">
                Adicione o ID Serial da sua placa ESP32 para monitorar sensores em tempo real ou
                explore o Simulador Gêmeo Digital.
              </p>
              <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
                {!isDemoUser && (
                  <button
                    type="button"
                    onClick={() => setIsLinkModalOpen(true)}
                    className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-brand hover:bg-brand-strong text-white font-bold text-xs shadow-md transition"
                  >
                    <PlusCircle className="w-4 h-4" />
                    <span>Vincular Estação Agora</span>
                  </button>
                )}
                <NavLink
                  to="/about"
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-brand text-brand hover:bg-brand-soft/30 font-bold text-xs transition"
                >
                  <BookOpen className="w-4 h-4" />
                  <span>Conhecer o projeto</span>
                </NavLink>
              </div>
            </div>
          ) : (
            /* Chave por UID e Estação garante remontagem limpa na troca de dispositivo */
            <div key={`${user?.uid ?? 'anon'}-${selectedDevice?.id ?? 'none'}`}>
              {/* v5.45.0: entrada suave a cada troca de página (some com "reduzir movimento") */}
              <PageErrorBoundary resetKey={location.pathname}>
                <div key={location.pathname} className="anim-page"><Outlet /></div>
              </PageErrorBoundary>
            </div>
          )}
        </main>

        <AppFooter device={selectedDevice} />
      </div>

      {/* 3. BARRA INFERIOR PARA CELULAR (< 1024px) — v5.47.0 (MOB-02): 4 telas + "Mais"
          (antes 7 itens espremidos). Ícone 24 px, texto 12 px, toque >= 48 px, área segura. */}
      <nav aria-label="Navegação principal" data-testid="bottom-nav"
        className="lg:hidden fixed bottom-0 inset-x-0 bg-surface border-t border-line flex items-stretch justify-around z-30 shadow-lg h-[calc(4rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        {MOBILE_PRIMARY_ROUTES.map((to) => {
          const item = NAV_ITEMS.find((n) => n.to === to)!;
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              {...preloadHandlers(item.to)}
              className={({ isActive }) =>
                `group flex flex-col items-center justify-center flex-1 min-w-0 gap-0.5 text-xs leading-tight transition ${
                  isActive ? 'text-brand-strong font-bold' : 'text-ink-muted font-semibold'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span className={`flex items-center justify-center w-14 h-8 rounded-full transition ${isActive ? 'bg-brand-tint' : ''}`}>
                    <Icon className="w-6 h-6" aria-hidden="true" />
                  </span>
                  <span>{item.shortLabel}</span>
                </>
              )}
            </NavLink>
          );
        })}
        <button
          type="button"
          onClick={() => setIsMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={isMoreOpen}
          data-testid="bottom-more"
          className={`relative flex flex-col items-center justify-center flex-1 min-w-0 gap-0.5 text-xs leading-tight transition ${
            isMoreRoute(location.pathname) ? 'text-brand-strong font-bold' : 'text-ink-muted font-semibold'
          }`}
        >
          <span className={`flex items-center justify-center w-14 h-8 rounded-full transition ${isMoreRoute(location.pathname) ? 'bg-brand-tint' : ''}`}>
            <MoreHorizontal className="w-6 h-6" aria-hidden="true" />
          </span>
          <span>Mais</span>
          {selectedDevice?.hasUpdateAvailable && (
            <span className="absolute top-1.5 right-[calc(50%-1.5rem)] w-2.5 h-2.5 rounded-full bg-accent ring-2 ring-white" aria-label="Atualização de firmware disponível" />
          )}
        </button>
      </nav>

      <MobileMoreSheet
        open={isMoreOpen}
        onClose={() => setIsMoreOpen(false)}
        isDemoUser={isDemoUser}
        displayName={displayName}
        roleLabel={roleLabel}
        initials={userInitials(displayName)}
        otaBadge={!!selectedDevice?.hasUpdateAvailable}
        onLinkStation={() => setIsLinkModalOpen(true)}
        onLogout={askLogout}
      />

      {/* v5.46.0: paleta de comandos, atalhos G+letra e lista de atalhos (?) */}
      <CommandCenter />

      <DeviceSelectorModal
        isOpen={isSelectorOpen}
        userDevices={userDeviceIds}
        selectedDeviceId={selectedDeviceId}
        canLinkDevice={!isDemoUser}
        onSelectDevice={selectDevice}
        onOpenLinkModal={() => setIsLinkModalOpen(true)}
        onClose={() => setIsSelectorOpen(false)}
      />

      {!isDemoUser && (
        <LinkDeviceModal
          isOpen={isLinkModalOpen}
          onClose={() => setIsLinkModalOpen(false)}
          onLinked={(newId) => selectDevice(newId)}
        />
      )}
    </div>
  );
}