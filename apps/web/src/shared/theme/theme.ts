/**
 * =====================================================================================
 * ARQUIVO: src/shared/theme/theme.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-25T06:30:00Z (UTC)
 * VERSÃO: v5.42.0
 * PROPÓSITO: Regras do tema (claro, escuro, automático). A escolha fica só neste navegador
 *            (localStorage, com proteção contra bloqueio) e é aplicada na tag <html> pela
 *            classe `dark`. `public/theme-init.js` repete a mesma regra antes da primeira
 *            pintura, para a tela não piscar em branco ao abrir no modo escuro.
 * =====================================================================================
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/**
 * Padrão para quem nunca escolheu: claro (o visual aprovado). Trocar para 'system' depois de
 * conferir todas as telas no escuro. Manter igual em public/theme-init.js.
 */
export const DEFAULT_THEME_MODE: ThemeMode = 'light';

/** Mesma chave usada em public/theme-init.js (não mudar sem mudar lá). */
export const THEME_STORAGE_KEY = 'agrosmart.theme';

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system';
}

export function readStoredTheme(storage: Pick<Storage, 'getItem'> | null | undefined = safeStorage()): ThemeMode {
  try {
    const v = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeMode(v) ? v : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

export function writeStoredTheme(mode: ThemeMode, storage: Pick<Storage, 'setItem'> | null | undefined = safeStorage()): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* navegador sem armazenamento: o tema vale só nesta aba */
  }
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

/** Cor da barra do navegador no celular (meta theme-color). */
export const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#1B5E20', dark: '#0E141B' };

export function applyTheme(resolved: ResolvedTheme, doc: Document = document): void {
  const root = doc.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[resolved]);
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export const THEME_LABEL: Record<ThemeMode, string> = {
  light: 'Claro',
  dark: 'Escuro',
  system: 'Automático',
};
