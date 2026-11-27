/**
 * ARQUIVO: src/app/layouts/MobileMoreSheet.tsx — v5.47.0 (MOB-01, MOB-02)
 * Folha "Mais" do celular: as telas que não cabem na barra inferior (Leituras,
 * Configurações, Sobre), a aparência (tema), busca, diagnóstico do titular, nova estação
 * e "Encerrar sessão" (longe dos botões do dia a dia e sempre com confirmação).
 * Abre de baixo para cima (Dialog), fecha com o "voltar" do Android, Esc ou toque fora.
 */
import { NavLink } from 'react-router-dom';
import { Activity, BookOpen, List, LogOut, PlusCircle, Search, Settings } from 'lucide-react';
import { Dialog } from '../../shared/ui/Dialog';
import { Segmented } from '../../shared/ui/Chip';
import { useTheme } from '../../shared/theme/ThemeProvider';
import { THEME_LABEL, type ThemeMode } from '../../shared/theme/theme';
import { openCommandPalette } from '../../shared/command/CommandCenter';
import { preloadHandlers } from '../router/lazyPages';
import { diagnosticsAvailable, openDiagnostics } from './DiagnosticsLauncher';

const MORE_LINKS = [
  { to: '/readings', label: 'Leituras', hint: 'Histórico e CSV', icon: List },
  { to: '/settings', label: 'Configurações', hint: 'Estação, clima e OTA', icon: Settings },
  { to: '/about', label: 'Sobre', hint: 'Arquitetura e contato', icon: BookOpen },
] as const;

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = (['light', 'dark', 'system'] as const).map((m) => ({ value: m, label: THEME_LABEL[m] }));

export function MobileMoreSheet({ open, onClose, isDemoUser, displayName, roleLabel, initials, otaBadge, onLinkStation, onLogout }: {
  open: boolean;
  onClose: () => void;
  isDemoUser: boolean;
  displayName: string;
  roleLabel: string;
  initials: string;
  otaBadge: boolean;
  onLinkStation: () => void;
  onLogout: () => void;
}) {
  const { mode, setMode } = useTheme();
  const after = (fn: () => void) => () => { onClose(); window.setTimeout(fn, 0); };
  const action = 'w-full flex items-center gap-3 px-3.5 min-h-[48px] rounded-xl text-sm font-semibold text-ink hover:bg-sunken transition text-left';

  return (
    <Dialog open={open} onClose={onClose} title="Mais opções" description="Outras telas, aparência e conta">
      <nav aria-label="Outras telas" className="grid grid-cols-3 gap-2">
        {MORE_LINKS.map(({ to, label, hint, icon: Icon }) => (
          <NavLink key={to} to={to} onClick={onClose} {...preloadHandlers(to)} data-testid={`more-${to.slice(1)}`}
            className={({ isActive }) => `relative flex flex-col items-center justify-center gap-1 rounded-2xl border px-2 py-3 min-h-[88px] text-center transition ${
              isActive ? 'border-brand bg-brand-tint text-brand-strong' : 'border-line bg-subtle text-ink hover:border-brand'}`}>
            <Icon className="w-6 h-6" aria-hidden="true" />
            <span className="text-sm font-bold leading-tight">{label}</span>
            <span className="text-[11px] text-ink-muted leading-tight">{hint}</span>
            {to === '/settings' && otaBadge && (
              <span className="absolute -top-2 right-2 px-1.5 py-0.5 text-[11px] font-extrabold rounded-full bg-accent text-[#1B5E20]">OTA</span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-5">
        <p className="text-xs font-bold text-ink-muted mb-1.5">Aparência</p>
        <Segmented label="Tema do site" options={THEME_OPTIONS} value={mode} onChange={setMode} className="w-full [&>button]:flex-1 [&>button]:h-10" />
      </div>

      <div className="mt-4 space-y-1">
        <button type="button" className={action} onClick={after(openCommandPalette)}>
          <Search className="w-5 h-5 text-ink-muted" aria-hidden="true" /><span>Buscar telas e ações</span>
        </button>
        {diagnosticsAvailable(isDemoUser) && (
          <button type="button" className={action} onClick={after(openDiagnostics)}>
            <Activity className="w-5 h-5 text-ink-muted" aria-hidden="true" /><span>Registro de diagnóstico</span>
          </button>
        )}
        {!isDemoUser && (
          <button type="button" className={action} onClick={after(onLinkStation)}>
            <PlusCircle className="w-5 h-5 text-ink-muted" aria-hidden="true" /><span>Vincular outra estação</span>
          </button>
        )}
      </div>

      <div className="mt-4 pt-4 border-t border-line flex items-center gap-3">
        <span className="shrink-0 w-10 h-10 rounded-full bg-brand-tint text-brand-strong text-sm font-extrabold flex items-center justify-center" aria-hidden="true">{initials}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink truncate">{displayName}</p>
          <p className="text-xs text-ink-muted truncate">{roleLabel}</p>
        </div>
        <button type="button" onClick={after(onLogout)} data-testid="more-logout"
          className="shrink-0 inline-flex items-center gap-2 px-3.5 min-h-[44px] rounded-xl text-sm font-bold text-danger bg-red-50 border border-red-200 hover:bg-red-100 transition">
          <LogOut className="w-4 h-4" aria-hidden="true" /><span>Sair</span>
        </button>
      </div>
    </Dialog>
  );
}
