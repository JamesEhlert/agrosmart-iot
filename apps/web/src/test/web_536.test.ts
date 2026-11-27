/**
 * =====================================================================================
 * ARQUIVO: src/test/web_536.test.ts
 * PROJETO: AgroSmart Precision IoT V5 — Web
 * DATA: 2026-11-24 (UTC) — web 5.36.0
 * PROPOSITO: Página "Logs & Auditoria": filtros, busca, proteção de exclusão (espelho da
 *            regra do Firestore v5.32.0), exclusão adaptativa em lotes e itens do backlog
 *            WEB-01, WEB-04, WEB-08/10 e WEB-09.
 * =====================================================================================
 */
import { describe, expect, it } from 'vitest';
import {
  parseActivityLogFromFirestore,
  translateEventReason,
  translateEventSource,
} from '../features/events/model/event.types';
import { auditEventResult, classifyAuditEvent } from '../features/events/model/auditPresentation';
import {
  countByCategory,
  isDeletionProtected,
  isSecurityLog,
  matchesCategory,
  matchesSearch,
  periodStart,
  protectionDaysLeft,
  runAdaptiveDeletion,
} from '../features/events/model/logFilters';
import {
  classifyValveCommandError,
  valveExceptionLogLevel,
} from '../features/irrigation/hooks/useValveControl';
import { TooManyRequestsException } from '../shared/api/httpClient';

const NOW = Date.UTC(2026, 10, 24, 9, 0, 0);
const DAY = 86400000;
const ts = (msAgo: number) => ({ toDate: () => new Date(NOW - msAgo) });

function log(raw: Record<string, unknown>, id = 'h1') {
  return parseActivityLogFromFirestore(raw, id);
}

const manual = log({ type: 'command_execution', source: 'manual', command_id: 'app-1-2', result: 'success', reason: 'manual_off', message: 'Rega concluída', timestamp: ts(DAY) }, 'm1');
const demo = log({ type: 'command_execution', source: 'manual', command_id: 'demo-abc', result: 'success', message: 'Rega da demo', timestamp: ts(DAY) }, 'd1');
const sched = log({ type: 'command_execution', source: 'schedule', schedule_id: 's1', schedule_label: 'Manhã', command_id: 'sched-1', result: 'success', message: 'Agenda executada', timestamp: ts(DAY) }, 's1');
const unconfirmed = log({ type: 'command_execution', source: 'manual', command_id: 'app-9', status: 'unconfirmed', reason: 'no_ack_timeout', event_code: 'CMD_NO_ACK_TIMEOUT', message: 'Sem confirmação da estação: o comando expirou sem resposta.', timestamp: ts(DAY) }, 'u1');
const failed = log({ type: 'command_execution', source: 'manual', command_id: 'app-8', result: 'failed', reason: 'valve_not_on', message: 'Falhou', timestamp: ts(DAY) }, 'f1');
const rateLimited = log({ type: 'command_execution', source: 'manual', command_id: 'app-7', result: 'failed', reason: 'rate_limited', message: 'Recusado', timestamp: ts(DAY) }, 'r1');
const rain = log({ type: 'skipped', source: 'weather_ai', message: 'Ignorado: sensor físico detectou chuva', timestamp: ts(DAY) }, 'w1');
const ota = log({ type: 'command_execution', source: 'manual', command_id: 'app-ota', reason: 'ota_updated', result: 'success', message: 'OTA', timestamp: ts(DAY) }, 'o1');
const secRecent = log({ type: 'security_alert', source: 'unregistered', command_id: 'x-1', event_code: 'CMD_UNREGISTERED', message: '⚠ Comando não registrado', timestamp: ts(2 * DAY) }, 'sec1');
const secOld = log({ type: 'security_alert', source: 'unregistered', command_id: 'x-2', message: '⚠ Comando não registrado antigo', timestamp: ts(40 * DAY) }, 'sec2');
const secNoDate = log({ type: 'security_alert', source: 'unregistered', message: 'sem data' }, 'sec3');

describe('web 5.36.0 — categorias e busca', () => {
  it('cada categoria pega os registros certos', () => {
    expect(matchesCategory(manual, 'manual')).toBe(true);
    expect(matchesCategory(demo, 'manual')).toBe(false);
    expect(matchesCategory(demo, 'demo')).toBe(true);
    expect(matchesCategory(sched, 'schedule')).toBe(true);
    expect(matchesCategory(unconfirmed, 'unconfirmed')).toBe(true);
    expect(matchesCategory(failed, 'failed')).toBe(true);
    expect(matchesCategory(rateLimited, 'failed')).toBe(false);
    expect(matchesCategory(rateLimited, 'protection')).toBe(true);
    expect(matchesCategory(rain, 'protection')).toBe(true);
    expect(matchesCategory(ota, 'ota_config')).toBe(true);
    expect(matchesCategory(ota, 'manual')).toBe(false);
    expect(matchesCategory(secRecent, 'security')).toBe(true);
    expect(matchesCategory(manual, 'security')).toBe(false);
  });

  it('contagem por categoria', () => {
    const c = countByCategory([manual, demo, sched, unconfirmed, failed, rateLimited, rain, ota, secRecent]);
    expect(c.all).toBe(9);
    expect(c.security).toBe(1);
    expect(c.demo).toBe(1);
    expect(c.unconfirmed).toBe(1);
  });

  it('busca ignora acentos e maiúsculas e procura no command_id', () => {
    expect(matchesSearch(unconfirmed, 'sem confirmacao')).toBe(true);
    expect(matchesSearch(manual, 'APP-1')).toBe(true);
    expect(matchesSearch(sched, 'manha')).toBe(true);
    expect(matchesSearch(manual, 'inexistente')).toBe(false);
    expect(matchesSearch(manual, '   ')).toBe(true);
  });

  it('período', () => {
    expect(periodStart('all', NOW)).toBeNull();
    expect(periodStart('24h', NOW)?.getTime()).toBe(NOW - DAY);
    expect(periodStart('30d', NOW)?.getTime()).toBe(NOW - 30 * DAY);
  });
});

describe('web 5.36.0 — proteção de exclusão (espelho da regra v5.32.0)', () => {
  it('alerta de segurança recente ou sem data é protegido; antigo e comuns não', () => {
    expect(isSecurityLog(secRecent)).toBe(true);
    expect(isDeletionProtected(secRecent, NOW)).toBe(true);
    expect(isDeletionProtected(secNoDate, NOW)).toBe(true);
    expect(isDeletionProtected(secOld, NOW)).toBe(false);
    expect(isDeletionProtected(manual, NOW)).toBe(false);
    expect(protectionDaysLeft(secRecent, NOW)).toBe(28);
  });
});

describe('web 5.36.0 — exclusão adaptativa em lotes', () => {
  it('divide o lote recusado e isola só o item negado', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `id${i}`);
    const commits: string[][] = [];
    const res = await runAdaptiveDeletion(
      ids,
      async (chunk) => {
        commits.push(chunk);
        if (chunk.includes('id7')) throw new Error('permission-denied');
      },
      { initialBatch: 4 },
    );
    expect(res.denied).toEqual(['id7']);
    expect(res.deleted.sort()).toEqual(ids.filter((i) => i !== 'id7').sort());
    expect(commits.every((c) => c.length <= 4)).toBe(true);
  });

  it('informa o progresso e para quando cancelado', async () => {
    const seen: number[] = [];
    const ctrl = new AbortController();
    const res = await runAdaptiveDeletion(
      ['a', 'b', 'c'],
      async () => {
        ctrl.abort();
      },
      { initialBatch: 1, onProgress: (d) => seen.push(d), signal: ctrl.signal },
    );
    expect(res.deleted).toEqual(['a']);
    expect(seen).toEqual([1]);
  });
});

describe('web 5.36.0 — itens do backlog', () => {
  it('WEB-01: comando de convidado aparece como Demonstração', () => {
    expect(translateEventSource(demo)).toBe('Demonstração (convidado)');
    expect(translateEventSource(manual)).toBe('Acionamento Manual (App / Web)');
  });

  it('WEB-09: comando manual sem confirmação vira "Sem confirmação da estação"', () => {
    expect(classifyAuditEvent(unconfirmed)).toBe('unconfirmed');
    expect(auditEventResult(unconfirmed)).toBe('Sem confirmação da estação');
    expect(translateEventReason('no_ack_timeout')).toMatch(/não confirmou/);
    expect(classifyAuditEvent(manual)).toBe('default');
  });

  it('WEB-08/10: recusa 429 e falta de confirmação são AVISO; erro genérico é ERRO', () => {
    const r429 = classifyValveCommandError(new TooManyRequestsException('Aguarde', 20, undefined, 'device_rate_limited'), false, false);
    expect(valveExceptionLogLevel(r429)).toBe('WARN');
    const timeout = classifyValveCommandError(new Error('TIMEOUT_ACK'), false, true);
    expect(valveExceptionLogLevel(timeout)).toBe('WARN');
    expect(valveExceptionLogLevel({ shouldMarkUncertain: true, feedback: { type: 'error', message: 'x' } })).toBe('ERROR');
  });
});
