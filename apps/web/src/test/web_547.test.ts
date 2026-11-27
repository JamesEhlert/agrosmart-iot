/**
 * web_547.test.ts — v5.47.0 "o que as IAs esquecem" + casca do celular.
 * Cada teste trava um item da pesquisa de 26/11 (Chrome DevRel "Top 10 things AI gets wrong
 * in web development", checklists de código gerado por IA) para que ele não volte.
 * Caminhos sempre com '/' (T-08: no Windows o separador é '\').
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { openNativeModal } from '../shared/ui/Dialog';
import { supportsPopover, toastAnnouncement } from '../shared/ui/Feedback.providers';
import { readOnline } from '../shared/ui/OfflineBanner';
import { prefersReducedMotion, scrollBehavior } from '../shared/lib/motion';
import { isMoreRoute, MOBILE_MORE_ROUTES, MOBILE_PRIMARY_ROUTES, pageTitle, ROUTE_TITLES } from '../app/router/routeMeta';
import { isChunkLoadError } from '../app/layouts/PageErrorBoundary';
import { scheduleFormSnapshot } from '../features/schedules/model/scheduleForm';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const rel = (f: string) => relative(ROOT, f).split(sep).join('/');
function srcFiles(dir = resolve(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { if (n !== 'test') out.push(...srcFiles(p)); } else if (/\.(ts|tsx)$/.test(n)) out.push(p); }
  return out;
}
const tsx = () => srcFiles().filter((f) => f.endsWith('.tsx'));

/** Tag JSX completa a partir da posição (respeita chaves, ex.: onChange={(e) => ...}). */
function tagAt(s: string, start: number): string {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return s.slice(start, i);
  }
  return s.slice(start);
}

const lum = ([r, g, b]: number[]) => { const f = (x: number) => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('5.47.0 — janelas nativas e avisos', () => {
  it('WEB-547-01 Dialog abre como modal nativo; navegador antigo recebe o atributo open', () => {
    const calls: string[] = [];
    const modal = { open: false, setAttribute: (k: string) => calls.push(`attr:${k}`), showModal: () => calls.push('showModal') };
    expect(openNativeModal(modal)).toBe('modal');
    expect(openNativeModal({ open: true, setAttribute: () => undefined })).toBe('already');
    const old = { open: false, setAttribute: (k: string) => calls.push(`attr:${k}`) };
    expect(openNativeModal(old)).toBe('fallback');
    const broken = { open: false, setAttribute: (k: string) => calls.push(`attr:${k}`), showModal: () => { throw new Error('InvalidStateError'); } };
    expect(openNativeModal(broken)).toBe('fallback');
    expect(calls).toEqual(['showModal', 'attr:open', 'attr:open']);
  });

  it('WEB-547-02 Esc e "voltar" do Android são tratados na própria janela (empilhadas: fecha só a de cima)', () => {
    const d = read('src/shared/ui/Dialog.tsx');
    expect(d).toContain("dlg.addEventListener('keydown', onKey)");
    expect(d).toContain("dlg.addEventListener('cancel', onCancel)");
    expect(d).not.toContain("document.addEventListener('keydown'");
    expect(d).toContain('useLayoutEffect');
    // nenhum outro arquivo desenha janela modal com div própria (a gaveta de diagnóstico é a exceção)
    const own = tsx().filter((f) => /role="dialog"\s+aria-modal="true"/.test(read(rel(f)))).map(rel);
    expect(own).toEqual(['src/app/layouts/DiagnosticsLauncher.tsx']);
    // atalhos de teclado param com janela nativa aberta
    expect(read('src/shared/command/CommandCenter.tsx')).toContain("dialog[open]");
  });

  it('WEB-547-03 avisos ficam na camada de topo e o leitor de tela sempre os lê', () => {
    expect(supportsPopover({ showPopover: () => undefined })).toBe(true);
    expect(supportsPopover({})).toBe(false);
    expect(supportsPopover(null)).toBe(false);
    expect(toastAnnouncement({ tone: 'error', title: 'Falhou', message: 'Sem internet' })).toBe('Erro: Falhou. Sem internet');
    expect(toastAnnouncement({ tone: 'warning', title: 'Atenção agora' })).toBe('Atenção: Atenção agora');
    expect(toastAnnouncement({ tone: 'success', title: 'Salvo' })).toBe('Salvo');
    const f = read('src/shared/ui/Feedback.providers.tsx');
    expect(f).toContain("setAttribute('popover', 'manual')");
    expect(f).toMatch(/className="sr-only" aria-live="polite" role="status" data-testid="toast-live"/);
  });
});

describe('5.47.0 — troca de tela (SPA)', () => {
  it('WEB-547-04 toda rota tem nome na aba do navegador', () => {
    const router = read('src/app/router/appRouter.tsx');
    const paths = [...router.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]).filter((p) => !['/', '*', '/history'].includes(p));
    expect(paths.length).toBeGreaterThanOrEqual(10);
    for (const p of paths) expect(ROUTE_TITLES[p], p).toBeTruthy();
    expect(pageTitle('/monitor')).toBe('Monitoramento · AgroSmart Precision IoT');
    expect(pageTitle('/logs/')).toBe('Logs e auditoria · AgroSmart Precision IoT');
    expect(pageTitle('/qualquer')).toBe('Página não encontrada · AgroSmart Precision IoT');
    expect(read('src/pages/LoginPage.tsx')).toContain("document.title = pageTitle('/login')");
  });

  it('WEB-547-05 tela nova abre no topo, com foco no conteúdo e "Pular para o conteúdo"', () => {
    const s = read('src/app/layouts/AppShell.tsx');
    expect(s).toContain('document.title = pageTitle(pathname)');
    expect(s).toMatch(/if \(navType !== 'POP'\) window\.scrollTo\(\{ top: 0, left: 0 \}\)/);
    expect(s).toContain('mainRef.current?.focus({ preventScroll: true })');
    expect(s).toMatch(/<main id="conteudo" ref=\{mainRef\} tabIndex=\{-1\}/);
    const skip = s.indexOf('Pular para o conteúdo');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(s.indexOf('<aside')); // primeiro item do Tab
  });

  it('WEB-547-06 barra do celular com no máximo 5 itens e nenhuma tela perdida', () => {
    expect(MOBILE_PRIMARY_ROUTES.length + 1).toBeLessThanOrEqual(5);
    const shell = read('src/app/layouts/AppShell.tsx');
    const navRoutes = [...shell.matchAll(/\{ to: '([^']+)', label:/g)].map((m) => m[1]);
    expect([...MOBILE_PRIMARY_ROUTES, ...MOBILE_MORE_ROUTES].sort()).toEqual([...navRoutes].sort());
    expect(isMoreRoute('/settings')).toBe(true);
    expect(isMoreRoute('/monitor')).toBe(false);
    expect(shell).toContain('MOBILE_PRIMARY_ROUTES.map');
    expect(shell).toContain('data-testid="bottom-more"');
    expect(shell).toContain('pb-[env(safe-area-inset-bottom)]');
    // tema, diagnóstico e nova estação saem do cabeçalho do celular (ficam na folha "Mais")
    expect(shell).toContain('<div className="hidden lg:block"><ThemeToggle /></div>');
    expect(shell).toContain('buttonClassName="hidden lg:inline-flex"');
    expect(read('src/app/layouts/MobileMoreSheet.tsx')).toContain('<Segmented label="Tema do site"');
  });

  it('WEB-547-07 uma tela que quebra não derruba o site; erro sem detalhe interno', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    const s = read('src/app/layouts/AppShell.tsx');
    expect(s.match(/<PageErrorBoundary resetKey=\{location\.pathname\}>/g)?.length).toBe(2);
    const app = read('src/app/App.tsx');
    expect(app).toContain('<details');
    expect(app).not.toContain('Erro de Renderização Detectado');
  });
});

describe('5.47.0 — formulários e acessibilidade', () => {
  it('WEB-547-08 todo campo tem rótulo ligado (label for, label em volta ou aria-label)', () => {
    const faltando: string[] = [];
    for (const f of tsx()) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/<(input|select|textarea)\b/g)) {
        const tag = tagAt(s, m.index!);
        if (/type="hidden"/.test(tag) || /aria-label|aria-labelledby/.test(tag)) continue;
        const id = /\bid=["{]([^"}]+)/.exec(tag)?.[1];
        if (id && new RegExp(`htmlFor=["{]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(s)) continue;
        const before = s.slice(0, m.index);
        if ((before.match(/<label/g)?.length ?? 0) > (before.match(/<\/label>/g)?.length ?? 0)) continue;
        faltando.push(`${rel(f)}:${s.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(faltando).toEqual([]);
  });

  it('WEB-547-09 mensagens de erro de formulário são anunciadas e o código do convite ajuda o teclado', () => {
    for (const f of ['src/features/schedules/components/ScheduleFormModal.tsx', 'src/features/devices/components/LinkDeviceModal.tsx', 'src/pages/LoginPage.tsx']) {
      expect(read(f), f).toMatch(/role="alert" className="mb-[45] p-3/);
    }
    const login = read('src/pages/LoginPage.tsx');
    for (const a of ['id="login-invite"', 'htmlFor="login-invite"', 'autoCapitalize="characters"', 'spellCheck={false}', 'aria-describedby="login-invite-hint"', 'autoComplete="email"']) expect(login).toContain(a);
    expect(login).not.toContain('SIMULAR ATIVAÇÃO');
  });

  it('WEB-547-10 alterações não salvas no agendamento: pergunta antes de descartar', () => {
    const a = { label: 'Rega ', time: '06:00', days: [5, 1, 3], durationMinutes: 4, isEnabled: true };
    const b = { label: 'Rega', time: '06:00', days: [1, 3, 5], durationMinutes: 4, isEnabled: true };
    expect(scheduleFormSnapshot(a)).toBe(scheduleFormSnapshot(b));
    expect(scheduleFormSnapshot({ ...b, durationMinutes: 5 })).not.toBe(scheduleFormSnapshot(b));
    const s = read('src/features/schedules/components/ScheduleFormModal.tsx');
    expect(s).toContain('onClose={requestClose}');
    expect(s).toContain('onClick={requestClose}');
    expect(s).toContain("title: 'Descartar as alterações?'");
  });

  it('WEB-547-11 anel de foco com contraste >= 3:1 nos dois temas, também nos campos', () => {
    const css = read('src/app/styles/tokens.css');
    const [light, dark] = css.split('.dark {');
    const v = (block: string, k: string) => new RegExp(`--${k}: (\\d+) (\\d+) (\\d+);`).exec(block)!.slice(1).map(Number);
    for (const [nome, b] of [['claro', light], ['escuro', dark]] as const) {
      const ring = v(b, 'focus-ring');
      for (const bg of ['bg-surface', 'bg-canvas']) expect(contrast(ring, v(b, bg)), `${nome} ${bg}`).toBeGreaterThanOrEqual(3);
    }
    const g = read('src/app/styles/globals.css');
    expect(g).toMatch(/textarea:focus-visible \{\s*outline: 2px solid rgb\(var\(--focus-ring\)\) !important;/);
    expect(read('src/app/layouts/AppShell.tsx')).toContain('[--focus-ring:255_255_255]'); // branco sobre o cabeçalho verde
    expect(contrast([255, 255, 255], [46, 125, 50])).toBeGreaterThanOrEqual(3);
  });

  it('WEB-547-12 celular: sem zoom do iPhone nos campos, toque >= 44 px e áreas seguras', () => {
    const g = read('src/app/styles/globals.css');
    expect(g).toMatch(/@media \(pointer: coarse\) \{[\s\S]*font-size: max\(16px, 1em\) !important;[\s\S]*\.tap-target \{\s*min-width: 44px;\s*min-height: 44px;/);
    expect(read('src/shared/ui/Button.tsx')).toContain("'shrink-0 tap-target'");
    const html = read('index.html');
    expect(html).toContain('viewport-fit=cover');
    expect(html).not.toMatch(/maximum-scale|user-scalable=no/); // zoom do usuário nunca é bloqueado
    for (const f of tsx()) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/className="([^"]*\bmin-h-screen\b[^"]*)"/g)) expect(m[1], rel(f)).toContain('min-h-dvh');
    }
  });
});

describe('5.47.0 — movimento, tema, rede e fonte', () => {
  it('WEB-547-13 "reduzir movimento" vale também para rolagem suave e pulsos', () => {
    expect(scrollBehavior(true)).toBe('auto');
    expect(scrollBehavior(false)).toBe('smooth');
    expect(prefersReducedMotion(() => ({ matches: true }))).toBe(true);
    expect(prefersReducedMotion(() => { throw new Error('x'); })).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
    for (const f of srcFiles()) if (!rel(f).endsWith('shared/lib/motion.ts')) expect(readFileSync(f, 'utf8'), rel(f)).not.toContain("behavior: 'smooth'");
    expect(read('src/app/styles/globals.css')).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.animate-pulse,/);
  });

  it('WEB-547-14 tema: navegador sabe dos dois temas e as abas abertas acompanham a troca', () => {
    expect(read('index.html')).toContain('<meta name="color-scheme" content="light dark" />');
    const p = read('src/shared/theme/ThemeProvider.tsx');
    expect(p).toContain("window.addEventListener('storage', onStorage)");
    expect(p).toContain('THEME_STORAGE_KEY');
  });

  it('WEB-547-15 sem internet: faixa de aviso e comando nunca fica guardado para depois', () => {
    expect(readOnline({ onLine: false })).toBe(false);
    expect(readOnline({ onLine: true })).toBe(true);
    expect(readOnline(undefined)).toBe(true);
    expect(read('src/app/layouts/AppShell.tsx')).toContain('<OfflineBanner />');
    // mutação do TanStack Query fica "pausada" offline e dispara quando a rede volta:
    // para a válvula isso seria perigoso. Os comandos usam fetch direto (falha na hora).
    for (const f of srcFiles()) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/\buseMutation\(/);
  });

  it('WEB-547-16 fonte reserva com as medidas da Inter (texto não pula ao carregar)', () => {
    const g = read('src/app/styles/globals.css');
    expect(g).toMatch(/font-family: 'Inter Fallback';[\s\S]*size-adjust: 108\.2%;[\s\S]*ascent-override: 89\.5%;/);
    expect(g).toContain("font-family: 'Inter', 'Inter Fallback', system-ui");
  });
});

describe('5.47.0 — foco inicial das janelas', () => {
  const fake = (found: Record<string, string | null>) => ({
    querySelector: (sel: string) => {
      const key = sel.startsWith('input:not([disabled]):not([type="hidden"])') ? 'field' : 'focusable';
      return (found[key] ? { id: found[key] } : null) as unknown as Element;
    },
  });
  it('WEB-547-17 computador começa no 1º campo; celular no 1º botão (sem abrir o teclado sozinho)', async () => {
    const { pickInitialFocus } = await import('../shared/ui/Dialog');
    expect((pickInitialFocus(fake({ field: 'nome', focusable: 'fechar' }), false) as unknown as { id: string }).id).toBe('nome');
    expect((pickInitialFocus(fake({ field: 'nome', focusable: 'fechar' }), true) as unknown as { id: string }).id).toBe('fechar');
    expect((pickInitialFocus(fake({ field: null, focusable: 'fechar' }), false) as unknown as { id: string }).id).toBe('fechar');
    expect(pickInitialFocus(null, false)).toBeNull();
    expect(read('src/app/styles/globals.css')).toContain('html:has(dialog[open]) [data-toast-stack]');
  });
});
