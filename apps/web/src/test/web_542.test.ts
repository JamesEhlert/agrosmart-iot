/**
 * Testes da 5.42.0: tema escuro (regras + camada gerada em dia), central de notificações,
 * logs (período inicial 24 h, filtros novos, motivos traduzidos, linha do tempo dos botões).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error módulo .mjs sem tipos (script de geração)
import { darkColor, generateCss, ruleFor } from '../../scripts/dark-theme.mjs';
import { applyTheme, readStoredTheme, resolveTheme, THEME_STORAGE_KEY, writeStoredTheme, DEFAULT_THEME_MODE } from '../shared/theme/theme';
import {
  buildNotifications,
  loadReadState,
  pruneRead,
  saveReadState,
  unreadCount,
} from '../features/notifications/model/notifications';
import { parseActivityLogFromFirestore, translateEventReason, humanizeReasonCode } from '../features/events/model/event.types';
import { isDisplayLog, isIrrigationLog, isSkippedWateringLog, LOG_CATEGORIES, localEventKind, matchesCategory } from '../features/events/model/logFilters';
import { RANGE_OPTIONS } from '../features/events/model/logQuery';
import { terminalLabel } from '../features/events/components/OperationTimeline';

const ROOT = resolve(__dirname, '../..');

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('WEB-542 tema', () => {
  it('WEB-542-01 padrão claro, escolha salva e modo automático', () => {
    const s = memStorage();
    expect(DEFAULT_THEME_MODE).toBe('light');
    expect(readStoredTheme(s)).toBe('light');
    writeStoredTheme('dark', s);
    expect(s.m.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(readStoredTheme(s)).toBe('dark');
    s.setItem(THEME_STORAGE_KEY, 'roxo');
    expect(readStoredTheme(s)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
  it('WEB-542-02 armazenamento bloqueado não quebra', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readStoredTheme(bad)).toBe('light');
    expect(() => writeStoredTheme('dark', bad)).not.toThrow();
  });
  it('WEB-542-03 applyTheme liga a classe dark e a cor da barra', () => {
    const classes = new Set<string>();
    const attrs: Record<string, string> = {};
    const fake = {
      documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) }, style: {} as Record<string, string> },
      querySelector: () => ({ setAttribute: (k: string, v: string) => { attrs[k] = v; } }),
    } as unknown as Document;
    applyTheme('dark', fake);
    expect(classes.has('dark')).toBe(true);
    expect(attrs.content).toBe('#0E141B');
    expect((fake.documentElement.style as unknown as Record<string, string>).colorScheme).toBe('dark');
    applyTheme('light', fake);
    expect(classes.has('dark')).toBe(false);
  });
  it('WEB-542-04 camada escura está em dia com as classes do código (rode npm run theme:dark)', () => {
    const { css, unsupported } = generateCss(resolve(ROOT, 'src'));
    expect(unsupported).toEqual([]);
    // v5.43.0: ignora CRLF (o Git do Windows pode converter o arquivo ao fazer checkout)
    expect(readFileSync(resolve(ROOT, 'src/app/styles/theme-dark.css'), 'utf8').replace(/\r\n/g, '\n')).toBe(css);
  });
  it('WEB-542-05 papéis de cor: página, cartão, texto e destaques', () => {
    expect(darkColor('bg', '#FFFFFF')).toBe('#161D25');
    expect(darkColor('bg', '#F0F4F8')).toBe('#0D1218');
    expect(darkColor('text', '#1C252C')).toBe('#E6EDF3');
    expect(darkColor('text', '#FFFFFF')).toBeNull(); // texto branco em botão fica
    const green = darkColor('text', '#1B5E20')!;
    expect(parseInt(green.slice(1, 3), 16)).toBeGreaterThan(0x60); // verde clareado p/ contraste
    expect(ruleFor('bg-black/40')).toEqual({ keep: true }); // véu de modal fica
    expect(ruleFor('bg-white/10')).toEqual({ keep: true }); // vidro do cabeçalho fica
    expect(ruleFor('hover:bg-[#EEF2F5]').rule).toContain(':where(.dark) .hover\\:bg-\\[\\#EEF2F5\\]:hover');
    expect(ruleFor('dark:text-white')).toEqual({ skip: 'dark' });
  });
  it('WEB-542-06 script de tema antes da pintura existe e usa a mesma chave', () => {
    const js = readFileSync(resolve(ROOT, 'public/theme-init.js'), 'utf8');
    expect(js).toContain(THEME_STORAGE_KEY);
    expect(js).toContain(`var mode = '${DEFAULT_THEME_MODE}'`);
    expect(readFileSync(resolve(ROOT, 'index.html'), 'utf8')).toContain('<script src="/theme-init.js"></script>');
  });
});

const baseDevice = {
  id: 'D', isOnline: true, currentFw: '5.27.0', hasUpdateAvailable: false, availableOta: { version: null },
  otaStatus: { inProgress: false }, settings: { enableWeatherControl: true, latitude: 0, longitude: 0 },
} as never;

function log(data: Record<string, unknown>, id = 'h1', minutesAgo = 10) {
  return parseActivityLogFromFirestore({ timestamp: new Date(Date.now() - minutesAgo * 60_000), ...data }, id);
}

describe('WEB-542 notificações', () => {
  it('WEB-542-07 estação offline vem primeiro como crítica', () => {
    const list = buildNotifications({ device: { ...(baseDevice as object), isOnline: false } as never, telemetry: null, schedules: [], recentLogs: [], forecast: null, isDemo: false });
    expect(list[0].id).toBe('state:offline');
    expect(list[0].severity).toBe('critical');
  });
  it('WEB-542-08 firmware novo só para o titular', () => {
    const dev = { ...(baseDevice as object), hasUpdateAvailable: true, availableOta: { version: '5.28.0' } } as never;
    expect(buildNotifications({ device: dev, telemetry: null, schedules: [], recentLogs: [], forecast: null, isDemo: false }).some((n) => n.id === 'state:ota:5.28.0')).toBe(true);
    expect(buildNotifications({ device: dev, telemetry: null, schedules: [], recentLogs: [], forecast: null, isDemo: true }).some((n) => n.id.startsWith('state:ota'))).toBe(false);
  });
  it('WEB-542-09 sensores, botão travado e agendas sobrepostas/repetidas/sem dias', () => {
    const telemetry = { hardwareAlerts: ['Cartão MicroSD indisponível.'], localControls: { btnFault: 2 }, protections: null, timestamp: new Date() } as never;
    const schedules = [
      { id: 'a', label: 'Manhã', time: '06:00', days: [1, 2], durationMinutes: 10, isEnabled: true },
      { id: 'b', label: 'Manhã 2', time: '06:05', days: [1], durationMinutes: 5, isEnabled: true },
      { id: 'c', label: 'Cópia', time: '06:00', days: [2, 1], durationMinutes: 10, isEnabled: true },
      { id: 'd', label: 'Vazia', time: '20:00', days: [], durationMinutes: 5, isEnabled: true },
    ] as never;
    const ids = buildNotifications({ device: baseDevice, telemetry, schedules, recentLogs: [], forecast: null, isDemo: false }).map((n) => n.id);
    expect(ids.some((i) => i.startsWith('state:hw:'))).toBe(true);
    expect(ids).toContain('state:btn:2');
    expect(ids.some((i) => i.startsWith('state:conflict:'))).toBe(true);
    expect(ids.some((i) => i.startsWith('state:dup:'))).toBe(true);
    expect(ids).toContain('state:nodays:d');
  });
  it('WEB-542-10 previsão de chuva vira aviso (≥ 70% ou ≥ 5 mm)', () => {
    const forecast = { daily: [
      { dateStr: '2026-11-25', rainProbabilityMax: 40, precipitationSumMm: 1, weatherCode: 3, maxTemp: 0, minTemp: 0 },
      { dateStr: '2026-11-26', rainProbabilityMax: 85, precipitationSumMm: 8, weatherCode: 61, maxTemp: 0, minTemp: 0 },
    ] } as never;
    const list = buildNotifications({ device: baseDevice, telemetry: null, schedules: [], recentLogs: [], forecast, isDemo: false });
    expect(list.map((n) => n.id)).toEqual(['state:rain:2026-11-26']);
    expect(list[0].title).toContain('amanhã');
  });
  it('WEB-542-11 histórico de 24 h: rega pulada, falha, segurança; antigo fica de fora', () => {
    const logs = [
      log({ type: 'skipped', source: 'schedule', message: 'Rega pulada: chuva', reason: 'rain_forecast' }, 's1', 30),
      log({ type: 'command_execution', result: 'failed', reason: 'valve_not_on', message: 'Falhou' }, 'f1', 20),
      log({ type: 'security_alert', event_code: 'CMD_UNREGISTERED', message: 'Comando sem registro' }, 'x1', 5),
      log({ type: 'skipped', message: 'velho' }, 'old', 60 * 30),
    ];
    const list = buildNotifications({ device: baseDevice, telemetry: null, schedules: [], recentLogs: logs, forecast: null, isDemo: false });
    expect(list.map((n) => n.id)).toEqual(['log:x1', 'log:f1', 'log:s1']);
    expect(list[0].severity).toBe('critical');
  });
  it('WEB-542-12 lida por navegador; aviso que some e volta aparece de novo', () => {
    const s = memStorage();
    const list = buildNotifications({ device: { ...(baseDevice as object), isOnline: false } as never, telemetry: null, schedules: [], recentLogs: [], forecast: null, isDemo: false });
    saveReadState('D', { ids: ['state:offline'] }, s);
    const st = loadReadState('D', s);
    expect(unreadCount(list, st)).toBe(0);
    expect(pruneRead(st, []).ids).toEqual([]);
    expect(loadReadState('D', { getItem: () => '{lixo' })).toEqual({ ids: [] });
  });
});

describe('WEB-542 logs', () => {
  const disp = log({ type: 'local_action', source: 'local_button', command_id: 'loc-31775A8B7BFF3232-12-disp', reason: 'display_on', message: 'Display ligado pelo botão da estação' });
  const btnOn = log({ type: 'local_action', source: 'local_button', command_id: 'loc-31775A8B7BFF3232-15-on', reason: 'manual_off', message: 'Irrigação pelo botão da estação encerrada pelo aplicativo (1 min)' });
  const cfg = log({ type: 'command_execution', command_id: 'cfg-1-2', reason: 'display_updated', message: 'Display da estação configurado para ficar apagado (acende pelo botão)' });
  const sched = log({ type: 'command_execution', source: 'schedule', command_id: 'sched-8f5497035f410d32', reason: 'local_button_stop', message: 'Irrigação encerrada pelo botão da estação' });
  const skipped = log({ type: 'skipped', source: 'schedule', reason: 'soil_moisture_ok', message: 'Agenda bloqueada: solo úmido' });
  it('WEB-542-13 período inicial 24 h e opção de 1 h', () => {
    const src = readFileSync(resolve(ROOT, 'src/features/events/components/EventsTimeline.tsx'), 'utf8');
    expect(src).toContain("useState<LogRangeKey>('24h')");
    expect(RANGE_OPTIONS.map((r) => r.key)).toEqual(['1h', '24h', '7d', '30d', 'all', 'custom']);
  });
  it('WEB-542-14 filtros novos: Irrigações, Regas puladas, Botões, Display', () => {
    expect(LOG_CATEGORIES.map((c) => c.key)).toEqual(['all', 'irrigation', 'manual', 'schedule', 'skipped', 'local', 'display', 'demo', 'unconfirmed', 'failed', 'protection', 'ota_config', 'security']);
    expect(localEventKind(disp)).toBe('disp');
    expect(isDisplayLog(disp) && isDisplayLog(cfg)).toBe(true);
    expect(isDisplayLog(btnOn)).toBe(false);
    expect(isIrrigationLog(btnOn) && isIrrigationLog(sched)).toBe(true);
    expect(isIrrigationLog(disp) || isIrrigationLog(cfg) || isIrrigationLog(skipped)).toBe(false);
    expect(isSkippedWateringLog(skipped)).toBe(true);
    expect(matchesCategory(disp, 'local') && matchesCategory(btnOn, 'local')).toBe(true);
    expect(matchesCategory(cfg, 'local')).toBe(false);
  });
  it('WEB-542-15 motivos dos botões e do display traduzidos (nada de código cru)', () => {
    for (const r of ['display_on', 'display_off', 'display_updated', 'buttons_updated', 'local_button_stop', 'button_stuck', 'raining_now', 'btn_irrig_min_out_of_range']) {
      expect(translateEventReason(r)).not.toBe(r);
      expect(translateEventReason(r)).not.toMatch(/_/);
    }
    expect(humanizeReasonCode('valve_busy_x')).toBe('Valve busy x');
    expect(translateEventReason('algo_novo')).toBe('Algo novo');
  });
  it('WEB-542-16 linha do tempo: nome do momento final por motivo', () => {
    expect(terminalLabel('local_button_stop')).toBe('Parada no botão da estação');
    expect(terminalLabel('display_on')).toBe('Botão do display apertado');
    expect(terminalLabel('manual_off')).toBe('Parada pelo site');
    expect(terminalLabel(null)).toBe('Evento final');
  });
});
