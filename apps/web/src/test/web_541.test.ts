/**
 * Testes da 5.41.0: display e botões da estação (firmware 5.27.0 / SendCommand v5.38.0 /
 * AckToFirestore v5.33.0), categoria "Na estação" e página pública com contato protegido.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStationLocalControls, parseTelemetryItem } from '../features/telemetry/model/telemetry.schema';
import {
  describeDisplayState,
  describeLocalControlsSummary,
  formatDisplayLeft,
  readingAgeS,
} from '../features/telemetry/model/localControls';
import { buildLocalControlsConfigBody } from '../features/irrigation/api/commandApi';
import { friendlyLocalConfigError } from '../features/station-settings/components/LocalControlsCard';
import { parseActivityLogFromFirestore, translateEventSource } from '../features/events/model/event.types';
import { countByCategory, isLocalStationLog, LOG_CATEGORIES, matchesCategory } from '../features/events/model/logFilters';
import { DEFENSE_LAYERS } from '../features/about/DefenseLayersDiagram';
import { GLOSSARY } from '../shared/glossary';

describe('WEB-541 telemetria do display e dos botões', () => {
  it('WEB-541-01 firmware antigo (sem sys.disp) devolve null', () => {
    expect(parseStationLocalControls({ fw: '5.26.0' })).toBeNull();
    const t = parseTelemetryItem({ timestamp: 1_790_000_000, sensors: {}, sys: { fw: '5.26.0' } });
    expect(t.localControls).toBeNull();
  });
  it('WEB-541-02 lê disp, disp_def, disp_left_s, btn_min e btn_fault', () => {
    const lc = parseStationLocalControls({ disp: 1, disp_def: 0, disp_left_s: 240, btn_min: 7, btn_fault: 2 });
    expect(lc).toEqual({ displayOn: true, displayDefaultOn: false, displayLeftS: 240, btnIrrigMin: 7, btnFault: 2 });
  });
  it('WEB-541-03 valores estranhos não quebram a tela', () => {
    const lc = parseStationLocalControls({ disp: 0, disp_left_s: -5, btn_min: 99, btn_fault: 255 });
    expect(lc?.displayLeftS).toBe(0);
    expect(lc?.btnIrrigMin).toBeNull();
    expect(lc?.btnFault).toBe(3);
    expect(lc?.displayDefaultOn).toBe(true);
  });
  it('WEB-541-04 texto do estado desconta a idade da leitura', () => {
    const lc = { displayOn: true, displayDefaultOn: false, displayLeftS: 300, btnIrrigMin: 5, btnFault: 0 };
    expect(describeDisplayState(lc)).toBe('Ligada · apaga em ~5 min');
    expect(describeDisplayState(lc, 250)).toBe('Ligada · apaga em menos de 1 min');
    expect(describeDisplayState(lc, 400)).toBe('Apagando (prazo encerrado)');
    expect(describeDisplayState({ ...lc, displayOn: false })).toBe('Apagada');
    expect(describeDisplayState({ ...lc, displayLeftS: 0, displayDefaultOn: true })).toBe('Ligada');
    expect(describeDisplayState({ ...lc, displayLeftS: 3720 })).toBe('Ligada · apaga em ~1 h 02 min');
  });
  it('WEB-541-05 formatação e idade', () => {
    expect(formatDisplayLeft(45)).toBe('45 s');
    expect(formatDisplayLeft(245)).toBe('4 min 05 s');
    const now = Date.UTC(2026, 10, 24, 23, 0, 0);
    expect(readingAgeS(new Date(now - 30_000), now)).toBe(30);
    expect(readingAgeS(new Date(0), now)).toBe(0);
    expect(readingAgeS(null, now)).toBe(0);
  });
  it('WEB-541-06 resumo da saúde avisa botão travado', () => {
    const base = { displayOn: false, displayDefaultOn: false, displayLeftS: 0, btnIrrigMin: 5, btnFault: 0 };
    expect(describeLocalControlsSummary(base)).toEqual({
      tone: 'ok',
      text: 'Display: apagada · padrão apagada (acende pelo botão) · botão de irrigação: 5 min',
    });
    expect(describeLocalControlsSummary({ ...base, btnFault: 2 }).tone).toBe('warn');
    expect(describeLocalControlsSummary({ ...base, btnFault: 2 }).text).toContain('botão de irrigação travado');
    expect(describeLocalControlsSummary({ ...base, btnFault: 3 }).text).toContain('os dois botões travados');
  });
});

describe('WEB-541 pedido de ajuste (contrato da SendCommand v5.38.0)', () => {
  it('WEB-541-07 ligar por N min manda display_minutes; os outros modos não', () => {
    expect(buildLocalControlsConfigBody({ deviceId: 'D', commandId: 'cfg-1', displayMode: 'on', displayMinutes: 30 })).toEqual({
      device_id: 'D', action: 'config', duration: 0, command_id: 'cfg-1', display_mode: 'on', display_minutes: 30,
    });
    for (const m of ['off', 'default_on', 'default_off'] as const) {
      const b = buildLocalControlsConfigBody({ deviceId: 'D', commandId: 'cfg-2', displayMode: m, displayMinutes: 9 });
      expect(b.display_mode).toBe(m);
      expect(b).not.toHaveProperty('display_minutes');
    }
  });
  it('WEB-541-08 botão de irrigação vai sozinho, sem campos de calibração', () => {
    const b = buildLocalControlsConfigBody({ deviceId: 'D', commandId: 'cfg-3', btnIrrigMin: 7.9 });
    expect(b).toEqual({ device_id: 'D', action: 'config', duration: 0, command_id: 'cfg-3', btn_irrig_min: 7 });
    expect(b).not.toHaveProperty('telemetry_interval_ms');
    expect(b).not.toHaveProperty('soil_raw_dry');
  });
  it('WEB-541-09 mensagens de recusa amigáveis', () => {
    expect(friendlyLocalConfigError('nvs_write_error')).toContain('gravar');
    expect(friendlyLocalConfigError('btn_irrig_min_out_of_range')).toContain('faixa');
    expect(friendlyLocalConfigError(null)).toBe('sem detalhe.');
  });
});

describe('WEB-541 logs "Na estação"', () => {
  const local = parseActivityLogFromFirestore(
    {
      type: 'local_action', source: 'local_button', event_code: 'LOCAL_BUTTON',
      command_id: 'loc-0123456789ABCDEF-12-on', message: 'Irrigação ligada pelo botão da estação (5 min)',
      status: 'started', result: 'success', details: { local_kind: 'on' },
    },
    'h1',
  );
  const appDisplay = parseActivityLogFromFirestore(
    { type: 'command_execution', source: 'command', command_id: 'cfg-1-2', reason: 'display_updated', result: 'success', message: 'Display da estação ligado pelo aplicativo por 5 min' },
    'h2',
  );
  const manual = parseActivityLogFromFirestore({ type: 'command_execution', source: 'command', command_id: 'app-1-2', result: 'success', message: 'Irrigação' }, 'h3');
  it('WEB-541-10 categoria existe e reconhece o evento do botão', () => {
    expect(LOG_CATEGORIES.some((c) => c.key === 'local' && c.label === 'Botões da estação')).toBe(true);
    expect(isLocalStationLog(local)).toBe(true);
    expect(matchesCategory(local, 'local')).toBe(true);
    expect(matchesCategory(local, 'manual')).toBe(false);
    expect(matchesCategory(local, 'security')).toBe(false);
    expect(translateEventSource(local)).toBe('Botão físico da estação');
  });
  it('WEB-541-11 ajuste do display pelo site fica em "OTA e ajustes", não em "Manuais"', () => {
    expect(matchesCategory(appDisplay, 'ota_config')).toBe(true);
    expect(matchesCategory(appDisplay, 'manual')).toBe(false);
    expect(matchesCategory(appDisplay, 'local')).toBe(false);
    expect(matchesCategory(manual, 'manual')).toBe(true);
  });
  it('WEB-541-12 contagem por categoria inclui "Na estação"', () => {
    const c = countByCategory([local, appDisplay, manual]);
    expect(c.local).toBe(1);
    expect(c.all).toBe(3);
  });
});

describe('WEB-541 página pública e contato', () => {
  const contactSrc = readFileSync(resolve(__dirname, '../features/about/AuthorContact.tsx'), 'utf8');
  it('WEB-541-13 (5.48.0) e-mail e telefone saíram do site; contato pelo LinkedIn', () => {
    expect(contactSrc).not.toMatch(/mailto:|wa\.me|MAIL_PARTS|PHONE_REV|decodeContact/);
    expect(contactSrc).toContain('linkedin.com/in/');
    expect(contactSrc).toContain('sem relação com a empresa Agrosmart');
  });
  it('WEB-541-14 links externos abrem em nova aba sem vazar a origem', () => {
    const targets = contactSrc.match(/target="_blank"/g) ?? [];
    const rels = contactSrc.match(/rel="noopener noreferrer"/g) ?? [];
    expect(targets.length).toBeGreaterThan(0);
    expect(rels.length).toBe(targets.length);
    expect(contactSrc).not.toMatch(/http:\/\//);
  });
  it('WEB-541-15 página Sobre continua estática (sem banco, API ou telemetria)', () => {
    for (const f of ['../pages/AboutProjectPage.tsx', '../pages/PublicAboutPage.tsx', '../features/about/AuthorContact.tsx', '../features/about/DefenseLayersDiagram.tsx']) {
      const src = readFileSync(resolve(__dirname, f), 'utf8');
      const imports = src.split('\n').filter((l) => /^import |^\} from /.test(l)).join('\n');
      expect(imports).not.toMatch(/firebase|\/api\/|\/hooks\/|react-query|telemetry|devices/i);
      expect(src).not.toMatch(/useQuery|awsAuthenticatedFetch|useAuth\(|onSnapshot|getDocs/);
    }
  });
  it('WEB-541-16 rota pública /sobre existe só fora do login e o logado é redirecionado', () => {
    const router = readFileSync(resolve(__dirname, '../app/router/appRouter.tsx'), 'utf8');
    // v5.43.0: a página pública passou a ser carregada sob demanda (Suspense)
    expect(router).toContain('<Route path="/sobre" element={<Suspense fallback={<FullPageFallback />}><PublicAboutPage /></Suspense>} />');
    expect(router).toContain('<Route path="/sobre" element={<Navigate to="/about" replace />} />');
  });
  it('WEB-541-17 defesa em camadas cobre do navegador à estação', () => {
    expect(DEFENSE_LAYERS[0].title).toBe('Navegador');
    expect(DEFENSE_LAYERS[DEFENSE_LAYERS.length - 1].title).toBe('Estação');
    const all = DEFENSE_LAYERS.map((l) => `${l.where} ${l.checks.join(' ')}`).join(' ');
    expect(all).not.toMatch(/@|arn:|\b\d{12}\b|us-east-2/);
  });
  it('WEB-541-18 glossário ganhou os termos dos botões', () => {
    for (const k of ['displayEstacao', 'botaoFisico', 'eventoLocal', 'botaoTravado']) expect(GLOSSARY).toHaveProperty(k);
  });
});
