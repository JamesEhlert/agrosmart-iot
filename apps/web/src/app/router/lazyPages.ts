/**
 * =====================================================================================
 * ARQUIVO: src/app/router/lazyPages.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-26T00:00:00Z (UTC)
 * VERSÃO: v5.43.0 (páginas sob demanda)
 * PROPÓSITO: Cada página vira um arquivo separado, baixado só quando é aberta.
 *            `preloadRoute('/logs')` adianta o download quando o mouse passa, o dedo
 *            toca ou o teclado foca o item do menu, então a troca de tela continua
 *            instantânea. Falha de rede ao pré-carregar é ignorada (a página tenta de
 *            novo ao abrir).
 * =====================================================================================
 */
import React from 'react';

type PageModule = { default: React.ComponentType };
export type PreloadablePage = React.LazyExoticComponent<React.ComponentType> & { preload: () => Promise<PageModule> };

const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch/i;
const RELOAD_KEY = 'agrosmart.chunkReloadAt';

/**
 * Depois de um deploy novo, uma aba antiga pode pedir um arquivo de página que não
 * existe mais. Nesse caso recarrega a página UMA vez (no máximo a cada 60 s) para
 * pegar a versão nova, em vez de mostrar a tela de erro.
 */
export function shouldReloadForChunkError(err: unknown, now: number, lastReloadAt: number | null): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return CHUNK_ERROR.test(msg) && (lastReloadAt === null || now - lastReloadAt > 60_000);
}

function reloadOnceIfStale(err: unknown): void {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY)) || null;
    if (shouldReloadForChunkError(err, Date.now(), last)) {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      window.location.reload();
    }
  } catch { /* sessionStorage indisponível: a tela de erro aparece normalmente */ }
}

function lazyPage(load: () => Promise<PageModule>): PreloadablePage {
  let pending: Promise<PageModule> | null = null;
  const once = () => {
    if (!pending) pending = load().catch((err) => { pending = null; throw err; });
    return pending;
  };
  const Comp = React.lazy(() => once().catch((err) => { reloadOnceIfStale(err); throw err; })) as PreloadablePage;
  Comp.preload = once;
  return Comp;
}

export const MonitorPage = lazyPage(() => import('../../pages/MonitorPage').then((m) => ({ default: m.MonitorPage })));
export const ChartsPage = lazyPage(() => import('../../pages/ChartsPage').then((m) => ({ default: m.ChartsPage })));
export const ReadingsHistoryPage = lazyPage(() => import('../../pages/ReadingsHistoryPage').then((m) => ({ default: m.ReadingsHistoryPage })));
export const SchedulesPage = lazyPage(() => import('../../pages/SchedulesPage').then((m) => ({ default: m.SchedulesPage })));
export const LogsPage = lazyPage(() => import('../../pages/LogsPage').then((m) => ({ default: m.LogsPage })));
export const SettingsPage = lazyPage(() => import('../../pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
export const AboutProjectPage = lazyPage(() => import('../../pages/AboutProjectPage').then((m) => ({ default: m.AboutProjectPage })));
export const PublicAboutPage = lazyPage(() => import('../../pages/PublicAboutPage').then((m) => ({ default: m.PublicAboutPage })));
export const DesignSystemPage = lazyPage(() => import('../../pages/DesignSystemPage').then((m) => ({ default: m.DesignSystemPage })));
export const NotFoundPage = lazyPage(() => import('../../pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));

export const ROUTE_PAGES: Record<string, PreloadablePage> = {
  '/monitor': MonitorPage,
  '/charts': ChartsPage,
  '/readings': ReadingsHistoryPage,
  '/schedules': SchedulesPage,
  '/logs': LogsPage,
  '/settings': SettingsPage,
  '/about': AboutProjectPage,
  '/sobre': PublicAboutPage,
  '/design': DesignSystemPage,
};

export function preloadRoute(path: string): void {
  const page = ROUTE_PAGES[path];
  if (page) page.preload().catch(() => { /* tenta de novo ao abrir */ });
}

/** Props para itens de menu: pré-carrega no mouse, no toque e no foco do teclado. */
export function preloadHandlers(path: string) {
  const go = () => preloadRoute(path);
  return { onMouseEnter: go, onFocus: go, onTouchStart: go };
}
