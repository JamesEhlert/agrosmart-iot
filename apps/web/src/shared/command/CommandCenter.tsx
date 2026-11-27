/**
 * =====================================================================================
 * ARQUIVO: src/shared/command/CommandCenter.tsx — v5.46.0
 * Paleta de comandos (Ctrl+K / ⌘K), atalhos em sequência (G M, G L…) e a lista de atalhos
 * (tecla ?). Sem biblioteca: usa o Dialog acessível do design system e o padrão ARIA
 * "combobox + listbox" (setas ↑ ↓, Enter executa, Esc fecha).
 * =====================================================================================
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { cn } from '../ui/cn';
import { useTheme } from '../theme/ThemeProvider';
import { useToast } from '../ui/Feedback.providers';
import { filterCommands, isTypingTarget, resolveSequence, SHORTCUT_HELP, type CommandItem } from './commands';

const NAV: (CommandItem & { to: string })[] = [
  { id: 'nav-monitor', label: 'Monitoramento', group: 'Ir para', to: '/monitor', keywords: 'inicio painel sensores valvula irrigar', shortcut: ['G', 'M'] },
  { id: 'nav-charts', label: 'Gráficos analíticos', group: 'Ir para', to: '/charts', keywords: 'grafico historico tendencia', shortcut: ['G', 'G'] },
  { id: 'nav-readings', label: 'Histórico de leituras', group: 'Ir para', to: '/readings', keywords: 'leituras csv exportar tabela', shortcut: ['G', 'R'] },
  { id: 'nav-schedules', label: 'Agendamentos', group: 'Ir para', to: '/schedules', keywords: 'agenda rotina horario rega', shortcut: ['G', 'A'] },
  { id: 'nav-logs', label: 'Logs & Auditoria', group: 'Ir para', to: '/logs', keywords: 'eventos historico ack comandos', shortcut: ['G', 'L'] },
  { id: 'nav-settings', label: 'Configurações & OTA', group: 'Ir para', to: '/settings', keywords: 'firmware atualizar calibracao display botoes passe convidado', shortcut: ['G', 'C'] },
  { id: 'nav-about', label: 'Sobre o projeto', group: 'Ir para', to: '/about', keywords: 'arquitetura seguranca contato', shortcut: ['G', 'S'] },
  { id: 'nav-design', label: 'Design system', group: 'Ir para', to: '/design', keywords: 'cores componentes paleta', shortcut: ['G', 'D'] },
];

const EXTRA: CommandItem[] = [
  { id: 'theme-light', label: 'Tema claro', group: 'Aparência', keywords: 'sol branco' },
  { id: 'theme-dark', label: 'Tema escuro', group: 'Aparência', keywords: 'lua noite preto' },
  { id: 'theme-system', label: 'Tema automático (segue o sistema)', group: 'Aparência', keywords: 'sistema' },
  { id: 'refresh', label: 'Atualizar dados da tela', group: 'Ações', keywords: 'recarregar sincronizar' },
  { id: 'help', label: 'Ver atalhos de teclado', group: 'Ajuda', keywords: 'teclado ajuda', shortcut: ['?'] },
];

export function Kbd({ children }: { children: string }) {
  return <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-md border border-line bg-subtle text-[11px] font-bold text-ink-muted font-sans">{children}</kbd>;
}

/** Abre a paleta a partir de qualquer botão (ex.: o "Buscar" do cabeçalho). */
export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent('agrosmart:command-palette'));
}

export function CommandCenter() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { setMode } = useTheme();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingG = useRef(false);
  const gTimer = useRef<number | undefined>(undefined);

  const all = useMemo<CommandItem[]>(() => [...NAV, ...EXTRA], []);
  const results = useMemo(() => filterCommands(query, all), [query, all]);

  useEffect(() => {
    const openPalette = () => { setQuery(''); setActive(0); setHelp(false); setOpen(true); };
    const onKey = (e: KeyboardEvent) => {
      // janela aberta (nativa desde a 5.47.0, ou a gaveta de diagnóstico): atalhos param,
      // inclusive Ctrl+K (a paleta não abre por cima de uma confirmação, por exemplo)
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const r = resolveSequence(e.key, pendingG.current);
      window.clearTimeout(gTimer.current);
      pendingG.current = r.pendingG;
      if (r.pendingG) gTimer.current = window.setTimeout(() => { pendingG.current = false; }, 1200);
      if (r.route) { e.preventDefault(); navigate(r.route); }
      if (r.help) { e.preventDefault(); setHelp(true); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('agrosmart:command-palette', openPalette);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('agrosmart:command-palette', openPalette); };
  }, [navigate]);

  const run = (item: CommandItem) => {
    setOpen(false);
    const nav = NAV.find((n) => n.id === item.id);
    if (nav) { navigate(nav.to); return; }
    if (item.id === 'theme-light') setMode('light');
    if (item.id === 'theme-dark') setMode('dark');
    if (item.id === 'theme-system') setMode('system');
    if (item.id === 'refresh') { qc.invalidateQueries().catch(() => undefined); toast({ tone: 'info', title: 'Atualizando os dados da tela…' }); }
    if (item.id === 'help') setHelp(true);
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === 'Enter' && results[active]) { e.preventDefault(); run(results[active]); }
  };

  let lastGroup = '';
  return (
    <>
      <Dialog open={open} onClose={() => setOpen(false)} title="Buscar e navegar" description="Digite o nome de uma tela ou ação. ↑ ↓ para escolher, Enter para abrir." initialFocus={inputRef}>
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onInputKey}
            placeholder="Ex.: logs, agenda, tema escuro…"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-list"
            aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
            aria-label="Buscar comando"
            className="w-full h-11 pl-9 pr-3 rounded-xl border border-line bg-subtle text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-[#2E7D32]/40"
            data-testid="command-input"
          />
        </div>
        <ul id="cmd-list" role="listbox" aria-label="Resultados" className="max-h-[50vh] overflow-y-auto -mx-1">
          {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-ink-muted">Nada encontrado para “{query}”.</li>}
          {results.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <li key={it.id} role="presentation">
                {header && <p className="px-3 pt-2 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-ink-muted">{header}</p>}
                <div
                  id={`cmd-${it.id}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(it)}
                  className={cn('mx-1 flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm',
                    i === active ? 'bg-brand-tint text-brand-strong font-bold' : 'text-ink')}
                >
                  <span>{it.label}</span>
                  {it.shortcut && <span className="flex gap-1 shrink-0">{it.shortcut.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </Dialog>

      <Dialog open={help} onClose={() => setHelp(false)} title="Atalhos de teclado" description="Use o sistema inteiro sem mouse." size="md">
        <ul className="divide-y divide-line">
          {SHORTCUT_HELP.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-4 py-2.5 text-sm text-ink">
              <span>{s.label}</span>
              <span className="flex items-center gap-1 shrink-0">
                {s.keys.map((k, i) => <span key={k + i} className="flex items-center gap-1">{i > 0 && s.keys.length === 2 && s.keys[0] === 'G' && <span className="text-xs text-ink-muted">depois</span>}<Kbd>{k}</Kbd></span>)}
              </span>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
