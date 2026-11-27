/**
 * =====================================================================================
 * ARQUIVO: src/app/App.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T05:30:00-03:00
 * VERSÃO: v5.47.0 (mensagem amigável; detalhe técnico recolhido; telas têm proteção própria)
 * PROPÓSITO: Componente raiz com ErrorBoundary global (impede tela em branco silenciosa
 *            exibindo diagnóstico técnico caso ocorra exceção de renderização).
 * =====================================================================================
 */

import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { AppProviders } from './providers/AppProviders';
import { AppRouter } from './router/appRouter';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class GlobalErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || String(error),
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen min-h-dvh flex items-center justify-center bg-canvas p-6" role="alert">
          <div className="max-w-md w-full bg-surface rounded-2xl border border-red-200 p-6 shadow-lg text-center">
            <div className="inline-flex p-3 rounded-full bg-red-50 text-danger mb-3">
              <AlertTriangle className="w-8 h-8" aria-hidden="true" />
            </div>
            <h1 className="text-lg font-bold text-ink">
              O site encontrou um problema
            </h1>
            <p className="text-sm text-ink-muted mt-2 leading-relaxed">
              Recarregue a página. A estação continua funcionando normalmente e nenhum comando foi enviado.
            </p>
            <details className="mt-3 text-left">
              <summary className="text-xs font-semibold text-ink-muted cursor-pointer">Detalhes técnicos</summary>
              <p className="mt-2 text-xs text-ink-muted break-words bg-sunken p-3 rounded-xl font-mono">
                {this.state.errorMessage.slice(0, 200)}
              </p>
            </details>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand text-white text-sm font-bold hover:bg-brand-strong transition"
            >
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
              <span>Recarregar página</span>
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <GlobalErrorBoundary>
      <AppProviders>
        <AppRouter />
      </AppProviders>
    </GlobalErrorBoundary>
  );
}