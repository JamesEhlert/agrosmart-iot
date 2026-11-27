/**
 * scripts/check-budget.mjs — v5.43.0 — orçamento de peso do site.
 * Roda depois do `vite build` e FALHA (código 1) se o site engordar além do limite:
 *   - inicial: o que o navegador baixa antes da 1ª tela (index.html: script + modulepreload);
 *   - por página: cada arquivo sob demanda (menos os pacotes grandes conhecidos).
 * Tamanhos em gzip, como trafegam na rede.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUDGET_KB = { initial: 300, chunk: 60, css: 20 };
const KNOWN_BIG = /^vendor-(echarts|firebase|react)-/;

export function gzKB(buf) { return gzipSync(buf, { level: 9 }).length / 1024; }

export function analyze(dist) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const initialFiles = [...html.matchAll(/<(?:script[^>]+src|link[^>]+rel="modulepreload"[^>]+href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
  const assets = readdirSync(join(dist, 'assets'));
  const size = (f) => gzKB(readFileSync(join(dist, 'assets', f)));
  const initial = initialFiles.reduce((s, f) => s + size(f), 0);
  const chunks = assets.filter((f) => f.endsWith('.js') && !initialFiles.includes(f) && !KNOWN_BIG.test(f)).map((f) => ({ f, kb: size(f) }));
  const css = assets.filter((f) => f.endsWith('.css')).reduce((s, f) => s + size(f), 0);
  const problems = [];
  if (initial > BUDGET_KB.initial) problems.push(`inicial ${initial.toFixed(1)} KB > ${BUDGET_KB.initial} KB`);
  for (const c of chunks) if (c.kb > BUDGET_KB.chunk) problems.push(`${c.f} ${c.kb.toFixed(1)} KB > ${BUDGET_KB.chunk} KB`);
  if (css > BUDGET_KB.css) problems.push(`css ${css.toFixed(1)} KB > ${BUDGET_KB.css} KB`);
  return { initialFiles, initial, chunks, css, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'dist');
  if (!existsSync(join(dist, 'index.html'))) { console.error('budget: dist/index.html não existe (rode o build).'); process.exit(1); }
  const r = analyze(dist);
  const maior = [...r.chunks].sort((a, b) => b.kb - a.kb)[0];
  console.log(`budget: inicial ${r.initial.toFixed(1)} KB gzip (${r.initialFiles.length} arquivos; limite ${BUDGET_KB.initial}) | css ${r.css.toFixed(1)} KB | maior página ${maior ? `${maior.f} ${maior.kb.toFixed(1)} KB` : '-'} (limite ${BUDGET_KB.chunk})`);
  if (r.problems.length) { console.error('budget: ACIMA DO LIMITE -> ' + r.problems.join('; ')); process.exit(1); }
  console.log('budget: OK');
}
