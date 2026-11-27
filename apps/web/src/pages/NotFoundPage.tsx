/**
 * =====================================================================================
 * ARQUIVO: src/pages/NotFoundPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-26T00:00:00Z (UTC)
 * VERSÃO: v5.43.0
 * PROPÓSITO: Endereço que não existe. Antes o site voltava ao Monitor sem avisar;
 *            agora explica e oferece os caminhos principais. Não mostra o endereço
 *            digitado (evita refletir texto de terceiros na tela).
 * =====================================================================================
 */
import { Link } from 'react-router-dom';
import { Compass, LayoutDashboard, ScrollText, CalendarClock } from 'lucide-react';

const LINKS = [
  { to: '/monitor', label: 'Monitoramento', icon: LayoutDashboard },
  { to: '/schedules', label: 'Agendamentos', icon: CalendarClock },
  { to: '/logs', label: 'Logs & Auditoria', icon: ScrollText },
];

export function NotFoundPage() {
  return (
    <section className="max-w-xl mx-auto text-center py-14 px-4" aria-labelledby="nf-title" data-testid="not-found">
      <div className="mx-auto w-16 h-16 rounded-2xl bg-brand-tint text-brand flex items-center justify-center mb-5">
        <Compass className="w-8 h-8" aria-hidden="true" />
      </div>
      <p className="text-xs font-extrabold uppercase tracking-widest text-ink-muted">Erro 404</p>
      <h1 id="nf-title" className="mt-1 text-2xl font-extrabold text-ink">Esta página não existe</h1>
      <p className="mt-2 text-sm text-ink-muted">O endereço pode ter mudado ou ter sido digitado errado. Escolha para onde ir:</p>
      <nav className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3" aria-label="Caminhos principais">
        {LINKS.map(({ to, label, icon: Icon }) => (
          <Link key={to} to={to}
            className="flex flex-col items-center gap-2 px-4 py-4 rounded-2xl bg-surface border border-line text-sm font-bold text-ink hover:border-brand hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus transition">
            <Icon className="w-5 h-5" aria-hidden="true" />
            {label}
          </Link>
        ))}
      </nav>
    </section>
  );
}
