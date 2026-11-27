/**
 * web_544.test.ts — v5.44.0 design system: tokens, contraste AA, componentes base,
 * cores distintas no gráfico, vitrine /design e trava contra cor solta nova.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BUTTON_VARIANTS, nextSegmentIndex, trapFocusTarget, BADGE_TONES } from '../shared/ui';
import { CHART_SERIES_COLORS } from '../features/telemetry/components/TelemetryChartCard';
import { ROUTE_PAGES } from '../app/router/lazyPages';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const TOKENS_CSS = read('src/app/styles/tokens.css');
const [LIGHT, DARK] = TOKENS_CSS.split('.dark {');
const vars = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z-]+): (\d+) (\d+) (\d+);/g)].map((m) => [m[1], [+m[2], +m[3], +m[4]] as [number, number, number]]));
const lum = ([r, g, b]: number[]) => { const f = (x: number) => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function srcFiles(dir = resolve(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { if (n !== 'test') out.push(...srcFiles(p)); } else if (/\.(ts|tsx)$/.test(n)) out.push(p); }
  return out;
}

describe('5.44.0 — paleta central (tokens)', () => {
  const light = vars(LIGHT); const dark = vars(DARK);
  it('WEB-544-01 todo token tem versão clara e escura e está no Tailwind', () => {
    const tw = read('tailwind.config.js');
    expect(Object.keys(light).length).toBeGreaterThanOrEqual(25);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    for (const k of Object.keys(light)) expect(tw).toContain(`var(--${k}) / <alpha-value>`);
    expect(light['bg-brand']).toEqual([46, 125, 50]); // verde da marca preservado
    expect(light['bg-surface']).toEqual([255, 255, 255]);
  });
  it('WEB-544-02 todo texto da paleta passa no contraste AA (4,5:1) nos fundos claros e escuros', () => {
    const backs = ['bg-surface', 'bg-canvas', 'bg-sunken', 'bg-subtle'];
    for (const [nome, v] of [['claro', light], ['escuro', dark]] as const) {
      for (const t of Object.keys(v).filter((k) => k.startsWith('tx-'))) {
        for (const b of backs) expect(contrast(v[t], v[b]), `${nome} ${t} sobre ${b}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('WEB-544-03 tokens.css é importado antes do Tailwind', () => {
    const main = read('src/main.tsx');
    expect(main.indexOf("./app/styles/tokens.css")).toBeGreaterThan(-1);
    expect(main.indexOf("./app/styles/tokens.css")).toBeLessThan(main.indexOf("./app/styles/globals.css"));
  });
  it('WEB-544-04 trava: cor solta nas telas não pode aumentar (5.46.0: ≤ 120; restam cores decorativas da página Sobre, dos sensores e das redes sociais)', () => {
    let n = 0;
    for (const f of srcFiles()) n += (readFileSync(f, 'utf8').match(/(?<![\w-])(?:[a-z0-9-]+:)*(?:bg|text|border|from|via|to|divide)(?:-[trblxy])?-\[#[0-9A-Fa-f]{6}\]/g) ?? []).length;
    expect(n).toBeLessThanOrEqual(120);
  });
});

describe('5.44.0 — componentes base', () => {
  it('WEB-544-05 botões e selos usam só a paleta (sem hex solto)', () => {
    for (const cls of [...Object.values(BUTTON_VARIANTS), ...Object.values(BADGE_TONES)]) expect(cls).not.toMatch(/\[#/);
    expect(BUTTON_VARIANTS.primary).toContain('bg-brand');
    expect(BUTTON_VARIANTS.water).toContain('bg-info');
  });
  it('WEB-544-06 escolha única navega por setas (circular, Home/End)', () => {
    expect(nextSegmentIndex(0, 'ArrowRight', 3)).toBe(1);
    expect(nextSegmentIndex(2, 'ArrowRight', 3)).toBe(0);
    expect(nextSegmentIndex(0, 'ArrowLeft', 3)).toBe(2);
    expect(nextSegmentIndex(1, 'End', 3)).toBe(2);
    expect(nextSegmentIndex(1, 'a', 3)).toBe(1);
  });
  it('WEB-544-07 janela prende o foco (Tab no último volta ao primeiro; Shift+Tab no primeiro vai ao último)', () => {
    expect(trapFocusTarget(2, 3, false)).toBe(0);
    expect(trapFocusTarget(0, 3, true)).toBe(2);
    expect(trapFocusTarget(-1, 3, true)).toBe(2);
    expect(trapFocusTarget(1, 3, false)).toBeNull();
    expect(trapFocusTarget(0, 0, false)).toBeNull();
    const dlg = read('src/shared/ui/Dialog.tsx');
    // v5.47.0: janela nativa (<dialog> + showModal) no lugar de div com role="dialog"
    for (const s of ['<dialog', 'showModal', 'aria-modal="true"', 'aria-labelledby', "e.key === 'Escape'", 'document.body.style.overflow']) expect(dlg).toContain(s);
  });
  it('WEB-544-08 vitrine /design é sob demanda, estática e linkada no rodapé', () => {
    expect(ROUTE_PAGES).toHaveProperty('/design');
    expect(read('src/app/router/appRouter.tsx')).toContain('<Route path="/design"');
    expect(read('src/app/layouts/AppFooter.tsx')).toContain('to="/design"');
    const page = read('src/pages/DesignSystemPage.tsx');
    expect(page).not.toMatch(/useQuery|onSnapshot|getDocs|awsAuthenticatedFetch|firebase/);
  });
});

describe('5.44.0 — correções vistas nos prints', () => {
  it('WEB-544-09 as 6 séries do gráfico são bem diferentes entre si (distância de cor ΔE ≥ 30)', () => {
    const lab = (h: string) => {
      const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const [r, g, b] = [1, 3, 5].map((i) => f(parseInt(h.slice(i, i + 2), 16) / 255));
      const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
      const q = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
      return [116 * q(Y) - 16, 500 * (q(X) - q(Y)), 200 * (q(Y) - q(Z))];
    };
    const entries = Object.entries(CHART_SERIES_COLORS);
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const [a, b] = [lab(entries[i][1]), lab(entries[j][1])];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), `${entries[i][0]} x ${entries[j][0]}`).toBeGreaterThanOrEqual(30);
    }
  });
  it('WEB-544-10 botões sem CAIXA ALTA e OTA mostra versão instalada', () => {
    const all = srcFiles().map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const s of ['SALVAR CLIMA & GPS', 'GERAR NOVO PASSE TEMPORÁRIO', 'VALIDAR CÓDIGO E ACESSAR ESTAÇÃO', 'CRIAR AGENDAMENTO', 'GRAVAR CALIBRAÇÃO NA FLASH NVS']) expect(all).not.toContain(s);
    expect(read('src/features/firmware-update/components/OtaExecutivePanel.tsx')).toContain('instalada`');
  });
  it('WEB-544-11 botão Topo: só ícone no celular, acima da barra de navegação, com nome acessível', () => {
    const f = read('src/app/layouts/AppFooter.tsx');
    expect(f).toContain('aria-label="Voltar ao topo da página"');
    expect(f).toContain('bottom-[88px]');
    expect(f).toContain('<span className="hidden lg:inline">Topo</span>');
  });
});
