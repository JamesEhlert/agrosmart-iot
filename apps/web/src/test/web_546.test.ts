/**
 * web_546.test.ts — v5.46.0 acabamento profissional: paleta de comandos e atalhos,
 * confirmações (encerrar sessão e outras ações), avisos flutuantes, janelas no Dialog,
 * cabeçalho único de página e telas largas.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { filterCommands, isTypingTarget, matchScore, normalize, resolveSequence, NAV_SHORTCUTS, SHORTCUT_HELP, type CommandItem } from '../shared/command/commands';
import { toastDuration } from '../shared/ui';
import { WIDE_ROUTES } from '../app/layouts/AppShell';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
function srcFiles(dir = resolve(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { if (n !== 'test') out.push(...srcFiles(p)); } else if (/\.(ts|tsx)$/.test(n)) out.push(p); }
  return out;
}

const ITEMS: CommandItem[] = [
  { id: 'a', label: 'Monitoramento', group: 'Ir para', keywords: 'inicio painel' },
  { id: 'b', label: 'Configurações & OTA', group: 'Ir para', keywords: 'firmware calibracao' },
  { id: 'c', label: 'Tema escuro', group: 'Aparência', keywords: 'lua noite' },
  { id: 'd', label: 'Logs & Auditoria', group: 'Ir para', keywords: 'eventos ack' },
];

describe('5.46.0 — paleta de comandos e atalhos', () => {
  it('WEB-546-01 busca ignora acentos e maiúsculas e ordena pelo melhor resultado', () => {
    expect(normalize('  Configurações ')).toBe('configuracoes');
    expect(filterCommands('config', ITEMS)[0].id).toBe('b');
    expect(filterCommands('CONFIGURACOES', ITEMS)[0].id).toBe('b');
    expect(filterCommands('noite', ITEMS).map((i) => i.id)).toEqual(['c']);
    expect(filterCommands('firmware', ITEMS)[0].id).toBe('b');
    expect(filterCommands('xyz', ITEMS)).toEqual([]);
    expect(filterCommands('', ITEMS)).toHaveLength(4);
    expect(matchScore('mon', ITEMS[0])).toBeGreaterThan(matchScore('painel', ITEMS[0]));
  });
  it('WEB-546-02 atalhos em sequência: G e depois a letra; ? abre a ajuda', () => {
    expect(resolveSequence('g', false)).toEqual({ pendingG: true });
    expect(resolveSequence('m', true)).toEqual({ route: '/monitor', pendingG: false });
    expect(resolveSequence('L', true)).toEqual({ route: '/logs', pendingG: false });
    expect(resolveSequence('x', true)).toEqual({ pendingG: false });
    expect(resolveSequence('m', false)).toEqual({ pendingG: false });
    expect(resolveSequence('?', false)).toEqual({ help: true, pendingG: false });
    // a lista de ajuda cobre todas as rotas dos atalhos
    for (const [k] of Object.entries(NAV_SHORTCUTS)) expect(SHORTCUT_HELP.some((s) => s.keys[0] === 'G' && s.keys[1] === k.toUpperCase())).toBe(true);
  });
  it('WEB-546-03 atalho de uma tecla não dispara enquanto se digita num campo', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
  it('WEB-546-04 paleta montada no AppShell e acessível pelo botão Buscar (Ctrl+K)', () => {
    const shell = read('src/app/layouts/AppShell.tsx');
    expect(shell).toContain('<CommandCenter />');
    expect(shell).toContain('aria-keyshortcuts="Control+K"');
    const cc = read('src/shared/command/CommandCenter.tsx');
    for (const s of ["e.key.toLowerCase() === 'k'", 'role="combobox"', 'role="listbox"', 'aria-activedescendant']) expect(cc).toContain(s);
  });
});

describe('5.46.0 — confirmações e avisos', () => {
  it('WEB-546-05 encerrar sessão sempre pergunta antes (barra lateral e celular)', () => {
    const shell = read('src/app/layouts/AppShell.tsx');
    // 5.47.0: no celular o "Sair" foi para a folha "Mais" (onLogout={askLogout})
    expect(shell.match(/onClick=\{askLogout\}/g)?.length).toBe(1);
    expect(shell).toContain('onLogout={askLogout}');
    const more = read('src/app/layouts/MobileMoreSheet.tsx');
    expect(more).toContain('onClick={after(onLogout)}');
    expect(more).not.toContain('logoutUser');
    expect(shell).not.toMatch(/onClick=\{\(\) => \{\s*logoutUser\(\)/);
    expect(shell).toContain("title: 'Encerrar a sessão?'");
  });
  it('WEB-546-06 sem window.confirm no site; ações sensíveis usam a confirmação padrão', () => {
    for (const f of srcFiles()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/window\.confirm\(/);
    const uses: Record<string, number> = {
      'src/pages/SettingsPage.tsx': 1,
      'src/features/schedules/components/ScheduleList.tsx': 1,
      'src/features/station-settings/components/DemoAccessManagerCard.tsx': 2,
      'src/features/station-settings/components/NvsCalibrationCard.tsx': 1,
    };
    for (const [f, n] of Object.entries(uses)) expect((read(f).match(/await confirm\(\{/g) ?? []).length, f).toBe(n);
  });
  it('WEB-546-07 avisos flutuantes: erro fica mais tempo; teto de 12 s', () => {
    expect(toastDuration('success', 'ok')).toBe(3500);
    expect(toastDuration('error', 'falhou')).toBe(7000);
    expect(toastDuration('info', 'x'.repeat(1000))).toBe(12000);
    expect(read('src/shared/ui/Feedback.providers.tsx')).toContain('aria-live="polite"');
    expect(read('src/app/providers/AppProviders.tsx')).toContain('<FeedbackProvider>');
  });
});

describe('5.46.0 — janelas, cabeçalhos e largura', () => {
  it('WEB-546-08 só o Dialog (e a gaveta de diagnóstico) desenham fundo de janela', () => {
    // caminho relativo com barras normais (no Windows o separador é \\)
    const own = srcFiles().filter((f) => readFileSync(f, 'utf8').includes('fixed inset-0')).map((f) => relative(ROOT, f).split(sep).join('/'));
    expect(own.sort()).toEqual(['src/app/layouts/DiagnosticsLauncher.tsx', 'src/shared/ui/Dialog.tsx']);
  });
  it('WEB-546-09 cabeçalho padrão nas telas principais', () => {
    for (const p of ['MonitorPage', 'ChartsPage', 'ReadingsHistoryPage', 'SchedulesPage', 'LogsPage', 'SettingsPage']) {
      expect(read(`src/pages/${p}.tsx`), p).toContain('<PageHeader');
    }
  });
  it('WEB-546-10 Monitor e Gráficos usam até 1.440 px; demais telas 1.280 px', () => {
    expect([...WIDE_ROUTES].sort()).toEqual(['/charts', '/monitor']);
    expect(read('src/app/layouts/AppShell.tsx')).toContain("max-w-[1440px]");
  });
});
