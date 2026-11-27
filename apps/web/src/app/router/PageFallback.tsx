/**
 * ARQUIVO: src/app/router/PageFallback.tsx — v5.43.0
 * Esqueleto exibido enquanto a página é baixada (normalmente < 200 ms).
 * Mesmo formato das telas (título + cartões), para a troca não "pular".
 */
export function PageFallback() {
  return (
    <div role="status" aria-live="polite" className="space-y-5" data-testid="page-fallback">
      <span className="sr-only">Carregando a página…</span>
      <div className="h-7 w-56 rounded-lg bg-sunken skeleton-shimmer" />
      <div className="h-4 w-80 max-w-full rounded bg-sunken skeleton-shimmer" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
        <div className="h-32 rounded-2xl bg-surface border border-line" />
        <div className="h-32 rounded-2xl bg-surface border border-line" />
        <div className="h-32 rounded-2xl bg-surface border border-line" />
      </div>
      <div className="h-64 rounded-2xl bg-surface border border-line" />
    </div>
  );
}

/** Variante de tela cheia para as páginas fora do login (Sobre pública). */
export function FullPageFallback() {
  return (
    <div className="min-h-screen min-h-dvh bg-canvas p-6 md:p-10">
      <div className="max-w-5xl mx-auto"><PageFallback /></div>
    </div>
  );
}
