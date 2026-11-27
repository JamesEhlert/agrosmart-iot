/**
 * web_545.test.ts — v5.45.0: fontes nítidas (Inter com hinting), movimento leve,
 * janelas no design system, privacidade na barra lateral e telas largas.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInitials } from '../app/layouts/AppShell';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

describe('5.45.0 — fontes', () => {
  it('WEB-545-01 Inter estática com hinting nos 5 pesos usados; sem a fonte variável sem hinting', () => {
    const css = read('src/app/styles/globals.css');
    const pesos: [number, string][] = [[400, 'regular'], [500, 'medium'], [600, 'semibold'], [700, 'bold'], [800, 'extrabold']];
    for (const [w, n] of pesos) expect(css).toMatch(new RegExp(`font-weight: ${w};\\s*font-display: swap;\\s*src: url\\('/fonts/inter-hinted-${n}\\.woff2'\\)`));
    expect(css).not.toContain('inter-latin-var');
    expect(existsSync(resolve(ROOT, 'public/fonts/inter-latin-var.woff2'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'public/fonts/jetbrains-mono-latin-var.woff2'))).toBe(false);
    // tabela de instruções de hinting (fpgm) presente no arquivo: procura a marca dentro do woff2 não dá
    // (é comprimido), então confere o tamanho típico de arquivo estático com hinting (~35–40 KB).
    const b = readFileSync(resolve(ROOT, 'public/fonts/inter-hinted-regular.woff2'));
    expect(b.length).toBeGreaterThan(30 * 1024);
  });
  it('WEB-545-02 monoespaçada é a do sistema (sem download)', () => {
    const css = read('src/app/styles/globals.css');
    expect(css).toMatch(/font-family: ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas/);
    expect(css).not.toContain("'JetBrains Mono'");
    const html = read('index.html');
    expect(html).toContain('/fonts/inter-hinted-regular.woff2');
    expect(html).toContain('/fonts/inter-hinted-bold.woff2');
  });
});

describe('5.45.0 — movimento e janelas', () => {
  it('WEB-545-03 animações só em CSS e desligadas com "reduzir movimento"', () => {
    const css = read('src/app/styles/globals.css');
    for (const k of ['pageIn', 'popIn', 'sheetUp', 'shimmer']) expect(css).toContain(`@keyframes ${k}`);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.anim-page, \.anim-pop, \.anim-sheet, \.skeleton-shimmer \{ animation: none !important; \}/);
    expect(read('src/app/layouts/AppShell.tsx')).toContain('<div key={location.pathname} className="anim-page"><Outlet /></div>');
  });
  it('WEB-545-04 Dialog não reinicia o foco quando a tela recria o onClose', () => {
    const d = read('src/shared/ui/Dialog.tsx');
    expect(d).toContain('closeRef.current = onClose;');
    // 5.47.0: dismissible também em ref; o efeito depende só de "open"
    expect(d).toContain('dismissRef.current = dismissible;');
    expect(d).toMatch(/\}, \[open\]\);/);
    expect(d).toContain('eyebrow');
  });
  it('WEB-545-05 cinco janelas migradas para o Dialog (sem fundo/esc próprios)', () => {
    for (const f of [
      'src/features/events/components/EventAuditModal.tsx',
      'src/features/weather/components/WeatherForecastModal.tsx',
      'src/features/telemetry/components/FreeRtosInspectModal.tsx',
      'src/features/devices/components/DeviceSelectorModal.tsx',
      'src/features/devices/components/LinkDeviceModal.tsx',
    ]) {
      const src = read(f);
      expect(src, f).toContain('<Dialog');
      expect(src, f).not.toContain('fixed inset-0');
      expect(src, f).not.toMatch(/e\.key === 'Escape'/);
    }
  });
});

describe('5.45.0 — barra lateral e largura', () => {
  it('WEB-545-06 e-mail do titular não aparece na barra lateral; avatar com iniciais', () => {
    const shell = read('src/app/layouts/AppShell.tsx');
    expect(shell).not.toContain('{user?.email}');
    expect(userInitials('James Rafael Ehlert Reinard')).toBe('JR');
    expect(userInitials('Usuário Teste')).toBe('UT');
    expect(userInitials('  ')).toBe('?');
  });
  it('WEB-545-07 conteúdo aproveita telas largas (até 1280 px) e rodapé alinhado', () => {
    // 5.46.0: Monitor/Gráficos vão a 1.440 px; o resto continua em max-w-7xl
    expect(read('src/app/layouts/AppShell.tsx')).toMatch(/<main [^>]*className=\{`flex-1 .*max-w-7xl/);
    expect(read('src/app/layouts/AppFooter.tsx')).toContain('max-w-7xl');
  });
});
