/**
 * ARQUIVO: src/shared/ui/PageHeader.tsx — v5.46.0 (design system)
 * Cabeçalho único de página: ícone, título, descrição curta, a estação ativa e as ações
 * à direita (quebram para baixo no celular). Mesmo visual em todas as telas.
 */
import type { ReactNode } from 'react';

export function PageHeader({ icon, title, description, station, actions }: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  station?: { name: string; id: string } | null;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col md:flex-row md:items-center justify-between gap-3" data-testid="page-header">
      <div className="flex items-center gap-3.5 min-w-0">
        <div className="shrink-0 w-11 h-11 rounded-2xl bg-brand-tint text-brand flex items-center justify-center shadow-sm" aria-hidden="true">{icon}</div>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-ink leading-tight">{title}</h1>
          {(description || station) && (
            <p className="mt-0.5 text-sm text-ink-muted leading-snug">
              {description}
              {description && station && <span aria-hidden="true"> · </span>}
              {station && <span>Estação <strong className="font-semibold text-ink">{station.name}</strong></span>}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 md:justify-end shrink-0">{actions}</div>}
    </header>
  );
}
