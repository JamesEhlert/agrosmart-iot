/**
 * ARQUIVO: src/app/router/routeMeta.ts — v5.47.0
 * Nome de cada tela (título da aba do navegador, histórico e leitor de tela) e quais telas
 * ficam na barra inferior do celular (no máximo 5 itens: 4 telas + "Mais").
 */
export const ROUTE_TITLES: Record<string, string> = {
  '/monitor': 'Monitoramento',
  '/charts': 'Gráficos analíticos',
  '/readings': 'Histórico de leituras',
  '/schedules': 'Agendamentos',
  '/logs': 'Logs e auditoria',
  '/settings': 'Configurações e OTA',
  '/about': 'Sobre o projeto',
  '/design': 'Design system',
  '/sobre': 'Sobre o projeto',
  '/login': 'Entrar',
};

export const APP_NAME = 'AgroSmart Precision IoT';

/** "Monitoramento · AgroSmart Precision IoT"; rota desconhecida = "Página não encontrada". */
export function pageTitle(pathname: string): string {
  const clean = pathname.replace(/\/+$/, '') || '/';
  const t = ROUTE_TITLES[clean];
  return t ? `${t} · ${APP_NAME}` : `Página não encontrada · ${APP_NAME}`;
}

/** Barra inferior do celular: as 4 telas mais usadas no campo. */
export const MOBILE_PRIMARY_ROUTES = ['/monitor', '/charts', '/schedules', '/logs'] as const;
/** Ficam na folha "Mais". */
export const MOBILE_MORE_ROUTES = ['/readings', '/settings', '/about'] as const;

/** O item "Mais" fica aceso quando a tela atual está dentro dele. */
export function isMoreRoute(pathname: string): boolean {
  return (MOBILE_MORE_ROUTES as readonly string[]).includes(pathname) || pathname === '/design';
}
