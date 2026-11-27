/**
 * web_543.test.ts — v5.43.0 "Leve e legível"
 * Páginas sob demanda, recarga após deploy, 404, fontes no próprio site,
 * tamanho mínimo de texto, contraste e orçamento de peso.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ROUTE_PAGES, preloadHandlers, shouldReloadForChunkError } from '../app/router/lazyPages';
// @ts-expect-error módulo .mjs sem tipos
import { analyze, BUDGET_KB } from '../../scripts/check-budget.mjs';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

function srcFiles(dir = resolve(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'test') out.push(...srcFiles(p)); }
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('5.43.0 — páginas sob demanda e 404', () => {
  it('WEB-543-01 o roteador não importa páginas de forma fixa (só o Login)', () => {
    const router = read('src/app/router/appRouter.tsx');
    const fixed = [...router.matchAll(/^import .* from '\.\.\/\.\.\/pages\/(\w+)';$/gm)].map((m) => m[1]);
    expect(fixed).toEqual(['LoginPage']);
    expect(router).toContain("from './lazyPages'");
    expect(router).toMatch(/<Route path="\*" element={<Suspense fallback={<PageFallback \/>}><NotFoundPage \/><\/Suspense>} \/>/);
    expect(router).toContain('<Route path="/" element={<Navigate to="/monitor" replace />} />');
  });
  it('WEB-543-02 todo item do menu tem página sob demanda e pré-carga', () => {
    const shell = read('src/app/layouts/AppShell.tsx');
    const navTargets = [...shell.matchAll(/\{ to: '(\/[a-z]+)'/g)].map((m) => m[1]);
    expect(navTargets.length).toBeGreaterThanOrEqual(7);
    for (const to of navTargets) expect(ROUTE_PAGES).toHaveProperty(to);
    expect(shell.match(/\{\.\.\.preloadHandlers\(item\.to\)\}/g)?.length).toBe(2);
    expect(Object.keys(preloadHandlers('/logs')).sort()).toEqual(['onFocus', 'onMouseEnter', 'onTouchStart']);
  });
  it('WEB-543-03 aba antiga após deploy recarrega uma vez (no máximo a cada 60 s)', () => {
    const err = new TypeError('Failed to fetch dynamically imported module: https://x/assets/LogsPage-abc.js');
    expect(shouldReloadForChunkError(err, 100_000, null)).toBe(true);
    expect(shouldReloadForChunkError(err, 100_000, 90_000)).toBe(false);
    expect(shouldReloadForChunkError(err, 200_000, 90_000)).toBe(true);
    expect(shouldReloadForChunkError(new Error('Cannot read properties of undefined'), 100_000, null)).toBe(false);
  });
  it('WEB-543-04 a página 404 não reflete o endereço digitado', () => {
    const nf = read('src/pages/NotFoundPage.tsx');
    expect(nf).not.toMatch(/useLocation|location\.pathname|useParams/);
    expect(nf).toContain('Esta página não existe');
  });
});

describe('5.43.0 — fontes no próprio site', () => {
  it('WEB-543-05 sem Google Fonts no HTML e no CSP; fontes woff2 e licença presentes (5.45.0: Inter com hinting)', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    expect(html).toContain('<link rel="preload" href="/fonts/inter-hinted-regular.woff2" as="font" type="font/woff2" crossorigin />');
    const css = read('src/app/styles/globals.css');
    for (const peso of ['regular', 'medium', 'semibold', 'bold', 'extrabold']) {
      expect(css).toContain(`/fonts/inter-hinted-${peso}.woff2`);
      const b = readFileSync(resolve(ROOT, 'public/fonts', `inter-hinted-${peso}.woff2`));
      expect(b.subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(b.length).toBeLessThan(45 * 1024);
    }
    expect(existsSync(resolve(ROOT, 'public/fonts/LICENSE-Inter-OFL.txt'))).toBe(true);
  });
  it('WEB-543-06 CSP sem domínios de fonte externos; cache longo só para arquivos com hash', () => {
    const cfg = JSON.parse(read('firebase.json'));
    const headers = cfg.hosting.headers;
    const csp: string = headers[0].headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value;
    expect(csp).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    expect(csp).toContain("font-src 'self' data:");
    const cache = (src: string) => headers.find((h: { source: string }) => h.source === src)?.headers[0].value;
    expect(cache('/assets/**')).toBe('public, max-age=31536000, immutable');
    expect(cache('/fonts/**')).toBe('public, max-age=2592000');
    expect(headers.some((h: { source: string }) => h.source === '**/*.html' || h.source === '/index.html')).toBe(false);
  });
});

describe('5.43.0 — legibilidade e contraste', () => {
  it('WEB-543-07 nenhum texto menor que 11 px', () => {
    const bad = srcFiles().filter((f) => /text-\[(?:[0-9]|10)px\]/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
  it('WEB-543-08 cores de texto abaixo de 4,5:1 no fundo branco não voltam', () => {
    const banned = ['F57C00', 'E65100', '90A4AE', '94A3B8', 'B0BEC5', 'FB8C00'];
    const hits: string[] = [];
    for (const f of srcFiles()) {
      const src = readFileSync(f, 'utf8');
      for (const line of src.split('\n')) {
        for (const c of banned) {
          if (!line.includes(`text-[#${c}]`)) continue;
          // permitido só em ícone (componente com className) — ícone precisa de 3:1, não 4,5:1
          if (/<[A-Z]\w+ className="[^"]*text-\[#/.test(line) && !/<(p|span|td|div|strong|code|button|label|h\d)\b/.test(line)) continue;
          hits.push(`${f.replace(ROOT, '')}: ${c}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('5.43.0 — orçamento de peso', () => {
  it('WEB-543-09 calcula inicial, páginas e CSS e acusa excesso', () => {
    const d = mkdtempSync(join(tmpdir(), 'budget-'));
    mkdirSync(join(d, 'assets'));
    writeFileSync(join(d, 'index.html'), '<script type="module" crossorigin src="/assets/index-a.js"></script><link rel="modulepreload" crossorigin href="/assets/vendor-react-b.js">');
    const rnd = (n: number) => randomBytes(n);
    writeFileSync(join(d, 'assets', 'index-a.js'), rnd(2000));
    writeFileSync(join(d, 'assets', 'vendor-react-b.js'), rnd(2000));
    writeFileSync(join(d, 'assets', 'LogsPage-c.js'), rnd(1000));
    writeFileSync(join(d, 'assets', 'vendor-echarts-d.js'), rnd(500_000));
    writeFileSync(join(d, 'assets', 'index-e.css'), 'a{color:red}');
    const r = analyze(d);
    expect(r.initialFiles).toEqual(['index-a.js', 'vendor-react-b.js']);
    expect(r.chunks.map((c: { f: string }) => c.f)).toEqual(['LogsPage-c.js']);
    expect(r.problems).toEqual([]);
    writeFileSync(join(d, 'assets', 'LogsPage-c.js'), rnd(BUDGET_KB.chunk * 1024 * 3));
    expect(analyze(d).problems.join(' ')).toMatch(/LogsPage-c\.js/);
  });
});
