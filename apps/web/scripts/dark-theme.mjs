/**
 * =====================================================================================
 * ARQUIVO: scripts/dark-theme.mjs
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-25T06:30:00Z (UTC)
 * VERSÃO: v5.42.0
 * PROPÓSITO: Gera a camada do tema escuro (src/app/styles/theme-dark.css) a partir das
 *            classes de cor que o site já usa (Tailwind: bg/text/border/from/via/to/ring/
 *            divide/fill/stroke, com cores hex ou da paleta, variantes hover/focus/…, e
 *            opacidade /NN). Cada cor clara vira a equivalente escura por PAPEL:
 *            fundo de página, cartão, painel, borda, texto principal/secundário, tons de
 *            destaque (verde, azul, âmbar, vermelho) clareados para contraste.
 *            Assim nenhuma tela precisou ser reescrita, e uma cor nova esquecida faz o
 *            teste `theme-dark` falhar (ele roda o gerador e compara com o arquivo salvo).
 *            Especificidade: `:where(.dark) .classe` pesa igual à classe clara e vem depois,
 *            então vence a clara; ajustes finos com `dark:` do Tailwind (peso maior) vencem esta camada.
 *            Uso: `npm run theme:dark` depois de mudar classes de cor.
 * =====================================================================================
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import colors from 'tailwindcss/colors.js';

const PALETTE = ['slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'];
const UTILS = 'bg|text|border|border-[trblxy]|from|via|to|ring|divide|outline|placeholder|fill|stroke|accent|decoration';
const COLOR = `\\[#[0-9a-fA-F]{3,8}\\]|white|black|(?:${PALETTE.join('|')})-(?:50|[1-9]00|950)`;
const TOKEN_RE = new RegExp(`(?<=^|[\\s'"\`{}(])((?:[a-z0-9-]+:)*(?:${UTILS})-(?:${COLOR})(?:/\\d{1,3})?)(?=$|[\\s'"\`{}),])`, 'g');

const SCREENS = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 };
const STATES = {
  hover: ':hover', focus: ':focus', 'focus-visible': ':focus-visible', 'focus-within': ':focus-within',
  active: ':active', disabled: ':disabled', first: ':first-child', last: ':last-child', odd: ':nth-child(odd)',
  even: ':nth-child(even)', checked: ':checked', open: '[open]', visited: ':visited', enabled: ':enabled',
};

// ---------- cores ----------
export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a };
}
function rgbToHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === R) h = ((G - B) / d) % 6; else if (max === G) h = (B - R) / d + 2; else h = (R - G) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s, l, chroma: d };
}
function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

/** Tons neutros conhecidos do design (papel → cor escura). */
const NEUTRAL_BG = {
  '#FFFFFF': '#161D25', // cartões
  '#F0F4F8': '#0D1218', '#F4F6F8': '#0D1218', // fundo da página
  '#FAFCFE': '#1A222B', '#FBFCFD': '#1A222B', '#F8FAFC': '#1A222B', '#F5F7F9': '#1A222B', '#F9FAFB': '#1A222B',
  '#EEF2F5': '#222C37', '#ECEFF1': '#222C37', '#F1F5F9': '#222C37', '#F3F4F6': '#222C37',
  '#E0E6ED': '#2A3643', '#E2E8F0': '#2A3643', '#E5E7EB': '#2A3643',
  '#CFD8DC': '#334150', '#CBD5E1': '#334150', '#D1D5DB': '#334150',
};

function isNeutral({ h, chroma }) {
  return chroma < 0.035 || (chroma < 0.13 && h >= 185 && h <= 235);
}

/** Cor escura para um papel (bg | text | border | stroke). Devolve null para "manter". */
export function darkColor(role, hex) {
  const rgb = hexToRgb(hex);
  const norm = normHex(hex);
  const hsl = rgbToHsl(rgb);
  const { h, s, l } = hsl;
  const neutral = isNeutral(hsl);
  if (role === 'bg') {
    if (neutral) {
      if (NEUTRAL_BG[norm]) return NEUTRAL_BG[norm];
      if (l > 0.9) return '#1C2530';
      if (l > 0.75) return '#2F3C4A';
      if (l > 0.4) return '#4A5868';
      return null; // fundos escuros (dicas, código) ficam
    }
    if (l >= 0.88) return hslToHex(h, Math.min(s, 0.5), 0.15);
    if (l >= 0.7) return hslToHex(h, Math.min(s, 0.45), 0.22);
    if (l >= 0.2) return hslToHex(h, s, Math.max(0.2, l * 0.92)); // botões sólidos: quase iguais
    return null;
  }
  if (role === 'text') {
    if (neutral) {
      if (l > 0.85) return null; // texto branco em botão colorido
      if (l < 0.3) return '#E6EDF3';
      if (l < 0.5) return '#C3CED8';
      return '#9AA7B2';
    }
    if (l < 0.62) return hslToHex(h, Math.min(s, 0.8), 0.72);
    return null;
  }
  // border, ring, outline, divide, decoration
  if (neutral) {
    if (l > 0.9) return '#26313D';
    if (l > 0.8) return '#33404E';
    if (l > 0.55) return '#4A5868';
    return null;
  }
  if (l >= 0.8) return hslToHex(h, Math.min(s, 0.45), 0.28);
  if (l >= 0.45) return hslToHex(h, Math.min(s, 0.6), 0.42);
  return null;
}

export function normHex(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  return `#${h.slice(0, 6).toUpperCase()}`;
}

function resolveColor(colorPart) {
  if (colorPart.startsWith('[#')) return colorPart.slice(1, -1);
  if (colorPart === 'white') return '#FFFFFF';
  if (colorPart === 'black') return '#000000';
  const [name, shade] = colorPart.split('-');
  const v = colors[name]?.[shade];
  return typeof v === 'string' ? v : null;
}

function rgbStr(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

export function cssEscape(token) {
  return token.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/** Uma regra CSS (ou null se a cor fica igual / variante não suportada). */
export function ruleFor(token) {
  const parts = token.split(':');
  const utilPart = parts.pop();
  if (parts.includes('dark')) return { skip: 'dark' };
  let media = null;
  let pseudo = '';
  let groupHover = false;
  let peerChecked = false;
  let pseudoEl = '';
  let placeholder = false;
  for (const p of parts) {
    if (SCREENS[p]) media = SCREENS[p];
    else if (STATES[p]) pseudo += STATES[p];
    else if (p === 'group-hover') groupHover = true;
    else if (p === 'peer-checked') peerChecked = true;
    else if (p === 'after' || p === 'before') pseudoEl = `::${p}`;
    else if (p === 'placeholder') placeholder = true;
    else return { unsupported: p };
  }
  const m = new RegExp(`^(${UTILS})-(${COLOR})(?:/(\\d{1,3}))?$`).exec(utilPart);
  if (!m) return { unsupported: utilPart };
  const [, util, colorPart, op] = m;
  const hex = resolveColor(colorPart);
  if (!hex) return { unsupported: colorPart };
  const alpha = op ? Number(op) / 100 : hexToRgb(hex).a;
  // Sobreposições translúcidas brancas/pretas (vidro no cabeçalho, véu de modal) ficam.
  const upper = normHex(hex);
  if (util === 'accent') return { keep: true };
  if (pseudoEl && upper === '#FFFFFF') return { keep: true }; // bolinha branca de interruptor // controles nativos: cor da marca serve nos dois temas
  if (upper === '#FFFFFF' && util === 'bg' && alpha < 0.5) return { keep: true };
  if (upper === '#000000' && util === 'bg') return { keep: true };
  const role = util === 'bg' || util === 'from' || util === 'via' || util === 'to' ? 'bg'
    : util === 'text' || util === 'placeholder' || util === 'fill' || util === 'stroke' ? 'text' : 'border';
  let dark;
  if (upper === '#000000' && role !== 'bg') dark = '#FFFFFF'; // bordas/textos pretos translúcidos
  else dark = darkColor(role, hex.length === 9 ? hex.slice(0, 7) : hex);
  const hasVariant = Boolean(pseudo || pseudoEl || groupHover || peerChecked || media);
  // Variante (hover, foco, tela…) sem troca de cor: reafirma a cor original com a mesma força
  // da regra escura da classe base, senão o fundo escuro "venceria" o hover.
  if (!dark && hasVariant) dark = normHex(hex);
  if (!dark) return { keep: true };
  const c = rgbStr(dark, alpha);
  let decl;
  switch (util) {
    case 'bg': decl = `background-color:${c}`; break;
    case 'text': decl = `color:${c}`; break;
    case 'border': decl = `border-color:${c}`; break;
    case 'border-t': decl = `border-top-color:${c}`; break;
    case 'border-r': decl = `border-right-color:${c}`; break;
    case 'border-b': decl = `border-bottom-color:${c}`; break;
    case 'border-l': decl = `border-left-color:${c}`; break;
    case 'border-x': decl = `border-left-color:${c};border-right-color:${c}`; break;
    case 'border-y': decl = `border-top-color:${c};border-bottom-color:${c}`; break;
    case 'ring': decl = `--tw-ring-color:${c}`; break;
    case 'outline': decl = `outline-color:${c}`; break;
    case 'divide': decl = `border-color:${c}`; break;
    case 'placeholder': decl = `color:${c}`; placeholder = true; break;
    case 'fill': decl = `fill:${c}`; break;
    case 'stroke': decl = `stroke:${c}`; break;
    case 'accent': decl = `accent-color:${c}`; break;
    case 'decoration': decl = `text-decoration-color:${c}`; break;
    case 'from': decl = `--tw-gradient-from:${c} var(--tw-gradient-from-position);--tw-gradient-to:${rgbStr(dark, 0)} var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)`; break;
    case 'via': decl = `--tw-gradient-to:${rgbStr(dark, 0)} var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),${c} var(--tw-gradient-via-position),var(--tw-gradient-to)`; break;
    case 'to': decl = `--tw-gradient-to:${c} var(--tw-gradient-to-position)`; break;
    default: return { unsupported: util };
  }
  let sel = `:where(.dark) ${groupHover ? '.group:hover ' : ''}${peerChecked ? '.peer:checked ~ ' : ''}.${cssEscape(token)}${pseudo}${pseudoEl}`;
  if (util === 'divide') sel += ' > :not([hidden]) ~ :not([hidden])';
  if (placeholder) sel += '::placeholder';
  const rule = `${sel}{${decl}}`;
  return { rule: media ? `@media (min-width:${media}px){${rule}}` : rule, media };
}

// ---------- varredura ----------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'test') walk(p, out); }
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

export function collectTokens(srcDir) {
  const set = new Set();
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(TOKEN_RE)) set.add(m[1]);
  }
  return [...set].sort();
}

/**
 * Pares "fundo vivo + texto escuro" escritos juntos (ex.: selo verde-neon com texto verde
 * escuro): no escuro o fundo continua vivo, então o texto deve continuar escuro.
 */
export function collectSolidPairs(srcDir) {
  const pairs = new Set();
  const LIT = /(['"`])([^'"`\n]{3,600}?)\1/g;
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(LIT)) {
      const toks = m[2].split(/\s+/);
      const bgs = toks.filter((x) => /^bg-/.test(x) && isVividBg(x));
      const txts = toks.filter((x) => /^text-/.test(x) && isDarkText(x));
      for (const b of bgs) for (const c of txts) pairs.add(`${b}|${c}`);
    }
  }
  return [...pairs].sort();
}

function colorOfToken(tok, prefix) {
  const m = new RegExp(`^${prefix}-(${COLOR})(?:/(\\d{1,3}))?$`).exec(tok);
  if (!m) return null;
  const hex = resolveColor(m[1]);
  return hex ? normHex(hex) : null;
}
function isVividBg(tok) {
  const hex = colorOfToken(tok, 'bg');
  if (!hex) return false;
  const hsl = rgbToHsl(hexToRgb(hex));
  return !isNeutral(hsl) && hsl.l >= 0.35 && hsl.l < 0.75 && hsl.s > 0.5;
}
function isDarkText(tok) {
  const hex = colorOfToken(tok, 'text');
  if (!hex) return false;
  return rgbToHsl(hexToRgb(hex)).l < 0.4;
}

export function generateCss(srcDir) {
  const tokens = collectTokens(srcDir);
  const base = [];
  const medias = [];
  const unsupported = [];
  for (const t of tokens) {
    const r = ruleFor(t);
    if (r.unsupported) unsupported.push(`${t} (${r.unsupported})`);
    else if (r.rule) (r.media ? medias : base).push(r.rule);
  }
  // Degradês na ordem do Tailwind (from → via → to), senão o `via` apagaria a cor final.
  const gradRank = (rule) => (/ \.(?:[a-z0-9-]+\\:)*from-/.test(rule) ? 1 : / \.(?:[a-z0-9-]+\\:)*via-/.test(rule) ? 2 : / \.(?:[a-z0-9-]+\\:)*to-/.test(rule) ? 3 : 0);
  base.sort((a, b) => gradRank(a) - gradRank(b));
  medias.sort((a, b) => gradRank(a) - gradRank(b));
  const pairRules = collectSolidPairs(srcDir).map((p) => {
    const [b, c] = p.split('|');
    return `:where(.dark) .${cssEscape(b)}.${cssEscape(c)}{color:${rgbStr(colorOfToken(c, 'text'), 1)}}`;
  });
  base.push(...pairRules);
  const header = '/* GERADO por scripts/dark-theme.mjs (npm run theme:dark). Não editar à mão. */\n';
  // Variantes com estado/tela vêm depois das simples para vencer no mesmo nível de especificidade.
  return { css: header + base.join('\n') + '\n' + medias.join('\n') + '\n', tokens, unsupported };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { css, tokens, unsupported } = generateCss(join(root, 'src'));
  const outFile = join(root, 'src/app/styles/theme-dark.css');
  writeFileSync(outFile, css);
  console.log(`theme-dark.css: ${tokens.length} classes de cor, ${css.split('\n').length - 2} regras -> ${relative(root, outFile)}`);
  if (unsupported.length) {
    console.log('Sem suporte (revise):');
    for (const u of unsupported) console.log('  ' + u);
    process.exitCode = 1;
  }
}
