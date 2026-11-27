/**
 * =====================================================================================
 * ARQUIVO: src/shared/theme/ThemeProvider.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-25T06:30:00Z (UTC)
 * VERSÃO: v5.47.0 (troca de tema numa aba vale nas outras abas abertas)
 * PROPÓSITO: Contexto do tema. Segue o sistema no modo "Automático" (inclusive quando o
 *            usuário troca o tema do celular com o site aberto).
 * =====================================================================================
 */

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { applyTheme, isThemeMode, readStoredTheme, ResolvedTheme, resolveTheme, ThemeMode, THEME_STORAGE_KEY, DEFAULT_THEME_MODE, writeStoredTheme } from './theme';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({ mode: 'system', resolved: 'light', setMode: () => undefined });

function systemPrefersDark(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredTheme());
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return undefined;
    }
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq?.removeEventListener?.('change', onChange);
  }, []);

  // v5.47.0: outra aba trocou o tema -> esta aba acompanha (evento "storage" do navegador).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY && e.key !== null) return;
      setModeState(e.key === null ? DEFAULT_THEME_MODE : isThemeMode(e.newValue) ? e.newValue : DEFAULT_THEME_MODE);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const resolved = resolveTheme(mode, systemDark);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Liga a transição suave só depois da primeira pintura (a troca do usuário anima; a abertura não).
  useEffect(() => {
    const id = window.requestAnimationFrame(() => document.documentElement.classList.add('theme-ready'));
    return () => window.cancelAnimationFrame(id);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    writeStoredTheme(next);
    setModeState(next);
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
