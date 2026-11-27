/**
 * =====================================================================================
 * ARQUIVO: src/shared/command/commands.ts — v5.46.0
 * Lógica pura (testada) da paleta de comandos e dos atalhos de teclado:
 *  - busca sem acento e sem diferenciar maiúsculas ("configuracoes" acha "Configurações");
 *  - atalhos em sequência estilo GitHub/Gmail: G e depois uma letra (G M = Monitor);
 *  - não dispara atalho de uma tecla enquanto a pessoa digita num campo.
 * =====================================================================================
 */
export interface CommandItem {
  id: string;
  label: string;
  group: 'Ir para' | 'Aparência' | 'Ações' | 'Ajuda';
  keywords?: string;
  shortcut?: string[];
}

export const NAV_SHORTCUTS: Record<string, string> = {
  m: '/monitor', g: '/charts', r: '/readings', a: '/schedules', l: '/logs', c: '/settings', s: '/about', d: '/design',
};

export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Pontua o quanto o texto combina com a busca (0 = não combina). */
export function matchScore(query: string, item: CommandItem): number {
  const q = normalize(query);
  if (!q) return 1;
  const label = normalize(item.label);
  const hay = `${label} ${normalize(item.keywords ?? '')}`;
  if (label.startsWith(q)) return 100 - label.length / 100;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 80;
  if (hay.includes(q)) return 60;
  // todas as palavras da busca aparecem em algum lugar
  const words = q.split(/\s+/);
  if (words.every((w) => hay.includes(w))) return 40;
  return 0;
}

export function filterCommands(query: string, items: CommandItem[]): CommandItem[] {
  return items
    .map((it, i) => ({ it, i, s: matchScore(query, it) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.it);
}

/** Alvo está num campo de texto? (aí atalhos de uma tecla não valem) */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return false;
  const node = el as HTMLElement;
  const tag = node.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true;
}

/**
 * Máquina dos atalhos em sequência. Recebe a tecla e se havia um "g" pendente;
 * devolve a ação e o novo estado. Exportado para teste.
 */
export function resolveSequence(key: string, pendingG: boolean): { route?: string; help?: boolean; pendingG: boolean } {
  const k = key.toLowerCase();
  if (pendingG) {
    const route = NAV_SHORTCUTS[k];
    return route ? { route, pendingG: false } : { pendingG: false };
  }
  if (key === '?') return { help: true, pendingG: false };
  if (k === 'g') return { pendingG: true };
  return { pendingG: false };
}

export const SHORTCUT_HELP: { keys: string[]; label: string }[] = [
  { keys: ['Ctrl', 'K'], label: 'Abrir a busca de comandos' },
  { keys: ['?'], label: 'Mostrar esta lista de atalhos' },
  { keys: ['G', 'M'], label: 'Ir para Monitoramento' },
  { keys: ['G', 'G'], label: 'Ir para Gráficos' },
  { keys: ['G', 'R'], label: 'Ir para Histórico de Leituras' },
  { keys: ['G', 'A'], label: 'Ir para Agendamentos' },
  { keys: ['G', 'L'], label: 'Ir para Logs & Auditoria' },
  { keys: ['G', 'C'], label: 'Ir para Configurações' },
  { keys: ['G', 'S'], label: 'Ir para Sobre o projeto' },
  { keys: ['G', 'D'], label: 'Ir para o Design system' },
  { keys: ['Tab'], label: 'Próximo botão ou campo (Shift+Tab volta)' },
  { keys: ['Esc'], label: 'Fechar janela, menu ou busca' },
];
