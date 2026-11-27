/**
 * ARQUIVO: src/app/layouts/PageErrorBoundary.tsx — v5.47.0
 * Proteção POR TELA: se uma página quebrar (erro de programa ou arquivo que não baixou por
 * falta de internet), só aquela área mostra o aviso; o menu, o cabeçalho e as outras telas
 * continuam funcionando. Trocar de tela limpa o erro. A mensagem é amigável e não mostra
 * detalhes internos (endereços, pilha); o detalhe vai para o registro de diagnóstico.
 */
import React from 'react';
import { AlertTriangle, RotateCcw, WifiOff } from 'lucide-react';
import { logWebDiagnostic } from '../../shared/lib/diagnostics';

const CHUNK_RE = /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|error loading dynamically/i;

/** O erro é "não consegui baixar a tela" (internet ou versão nova publicada)? Exportado para teste. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? '');
  return CHUNK_RE.test(msg);
}

interface Props { resetKey: string; children: React.ReactNode }
interface State { error: unknown | null }

export class PageErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    const e = error instanceof Error ? error : new Error(String(error));
    logWebDiagnostic('ERROR', 'ui.page.crash', { route: this.props.resetKey, name: e.name, message: e.message.slice(0, 300), chunk: isChunkLoadError(e) });
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkLoadError(error);
    return (
      <div role="alert" data-testid="page-error" className="max-w-lg mx-auto mt-10 bg-surface rounded-2xl border border-line p-6 sm:p-8 text-center shadow-sm">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-50 text-warning mb-3">
          {chunk ? <WifiOff className="w-7 h-7" aria-hidden="true" /> : <AlertTriangle className="w-7 h-7" aria-hidden="true" />}
        </div>
        <h2 className="text-lg font-extrabold text-ink">{chunk ? 'Não foi possível abrir esta tela' : 'Esta tela encontrou um problema'}</h2>
        <p className="text-sm text-ink-muted mt-2 leading-relaxed">
          {chunk
            ? 'O arquivo da tela não baixou. Confira a internet e tente de novo; se o site acabou de ser atualizado, recarregar resolve.'
            : 'O restante do sistema continua funcionando. Tente abrir a tela de novo ou escolha outra no menu. A estação não é afetada.'}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={() => (chunk ? window.location.reload() : this.setState({ error: null }))}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand hover:bg-brand-strong text-white text-sm font-bold transition">
            <RotateCcw className="w-4 h-4" aria-hidden="true" />
            <span>{chunk ? 'Recarregar' : 'Tentar de novo'}</span>
          </button>
        </div>
      </div>
    );
  }
}
