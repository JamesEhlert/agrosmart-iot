/**
 * =====================================================================================
 * ARQUIVO: src/pages/PublicAboutPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T23:50:00Z (UTC)
 * VERSÃO: v5.41.0
 * PROPÓSITO: Apresentação pública do projeto em `/sobre` (sem login), para enviar a
 *            recrutadores antes da entrevista. Reaproveita a página Sobre (100% estática:
 *            não lê banco, API nem telemetria) com um cabeçalho simples e o botão de login.
 * =====================================================================================
 */

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { LogIn, Sprout, UserCheck } from 'lucide-react';
import { AboutProjectPage } from './AboutProjectPage';
import { ThemeToggle } from '../shared/theme/ThemeToggle';
import { APP_VERSION_LABEL } from '../shared/config/appInfo';

export function PublicAboutPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = 'AgroSmart Precision IoT — Sobre o projeto';
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="min-h-screen min-h-dvh bg-canvas pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-line">
        <div className="max-w-6xl mx-auto px-4 lg:px-6 h-14 flex items-center justify-between gap-3">
          <Link to="/sobre" className="flex items-center gap-2.5 min-w-0" aria-label="AgroSmart Precision IoT, início da apresentação">
            <span className="p-1.5 rounded-xl bg-gradient-to-br from-brand to-brand-strong text-white">
              <Sprout className="w-5 h-5" />
            </span>
            <span className="text-sm font-extrabold text-ink truncate">AgroSmart Precision IoT</span>
          </Link>
          <nav className="flex items-center gap-2" aria-label="Ações">
            <ThemeToggle tone="onLight" />
            <a
              href="#contato"
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-brand-strong hover:bg-brand-tint transition"
            >
              <UserCheck className="w-4 h-4" />
              Pedir acesso de convidado
            </a>
            <Link
              to="/login"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-brand hover:bg-brand-strong text-white text-xs font-extrabold shadow-sm transition"
            >
              <LogIn className="w-4 h-4" />
              <span className="whitespace-nowrap">
                Entrar<span className="hidden sm:inline"> no painel</span>
              </span>
            </Link>
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 lg:px-6 py-6">
        <p className="mb-4 text-xs text-ink-muted text-center">
          Apresentação pública do projeto. Nenhum dado da estação é carregado nesta página.
        </p>
        <AboutProjectPage />
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="max-w-6xl mx-auto px-4 lg:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-ink-muted">
          <span>
            © 2026 James Rafael Ehlert Reinard · AgroSmart Precision IoT
          </span>
          <span className="font-mono">Web {APP_VERSION_LABEL}</span>
        </div>
      </footer>
    </div>
  );
}
