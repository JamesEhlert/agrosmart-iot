/**
 * =====================================================================================
 * ARQUIVO: src/test/web_e1.test.ts
 * PROJETO: AgroSmart Precision IoT V5 — Web
 * DATA: 2026-11-24 (UTC) — Fase 4.0-E E1 (web 5.35.0)
 * PROPOSITO: Mensagens claras para as proteções anti-rajada (firmware 5.26.0 e
 *            SendCommand 5.37.0), histórico sem "falha" falsa e cartão de proteções.
 * =====================================================================================
 */
import { describe, expect, it } from 'vitest';
import {
  isProtectiveRejection,
  parseAckRetryAfterSec,
  translateValveRejectionReason,
} from '../features/irrigation/model/command.types';
import {
  classifyValveCommandError,
  resolveTooManyRequestsMessage,
} from '../features/irrigation/hooks/useValveControl';
import { TooManyRequestsException } from '../shared/api/httpClient';
import {
  parseActivityLogFromFirestore,
  translateEventReason,
  translateEventResult,
  translateEventSource,
} from '../features/events/model/event.types';
import { parseStationProtections, parseTelemetryItem } from '../features/telemetry/model/telemetry.schema';
import { describeProtections } from '../features/telemetry/components/StationHealthCard';

describe('Fase 4.0-E E1 — mensagens das proteções', () => {
  it('WEB-E1-01: lê retry_after_s do ACK do firmware e ignora lixo', () => {
    expect(parseAckRetryAfterSec('retry_after_s=23')).toBe(23);
    expect(parseAckRetryAfterSec('x;retry_after_s=2')).toBe(2);
    expect(parseAckRetryAfterSec('retry_after_s=0')).toBeNull();
    expect(parseAckRetryAfterSec('retry_after_s=abc')).toBeNull();
    expect(parseAckRetryAfterSec(null)).toBeNull();
    expect(parseAckRetryAfterSec('retry_after_s=99999')).toBe(3600);
  });

  it('WEB-E1-02: rate_limited explica o motivo e mostra quanto falta', () => {
    const msg = translateValveRejectionReason('rate_limited', 23);
    expect(msg).toMatch(/Muitos acionamentos seguidos/);
    expect(msg).toMatch(/proteger a válvula e o relé/);
    expect(msg).toMatch(/aguarde 23 s/);
    expect(msg).toMatch(/Desligar continua liberado/);
    expect(translateValveRejectionReason('rate_limited')).toMatch(/aguarde alguns segundos/);
  });

  it('WEB-E1-03: valve_cooldown, ack_outbox_busy e device_rate_limited têm frase própria', () => {
    expect(translateValveRejectionReason('valve_cooldown', 2)).toMatch(/acabou de fechar.*aguarde 2 s/);
    expect(translateValveRejectionReason('ack_outbox_busy')).toMatch(/enviando as confirmações/);
    expect(translateValveRejectionReason('device_rate_limited', 30)).toMatch(/aguarde 30 s/);
    expect(translateValveRejectionReason('codigo_novo_xyz')).toMatch(/codigo_novo_xyz/);
  });

  it('WEB-E1-04: só os motivos de proteção são tratados como proteção', () => {
    for (const r of ['rate_limited', 'valve_cooldown', 'device_rate_limited', 'ack_outbox_busy', 'RATE_LIMITED']) {
      expect(isProtectiveRejection(r)).toBe(true);
    }
    for (const r of ['rain_interlock', 'ack_storage_unavailable', 'valve_not_on', '', null]) {
      expect(isProtectiveRejection(r)).toBe(false);
    }
  });

  it('WEB-E1-05: 429 do servidor (device_rate_limited) usa a frase do servidor e a contagem', () => {
    const err = new TooManyRequestsException(
      'Muitos acionamentos seguidos. Para proteger a válvula e o relé, aguarde 17 s para ligar de novo. Desligar continua liberado.',
      17,
      undefined,
      'device_rate_limited',
    );
    const out = classifyValveCommandError(err, false, false);
    expect(out.feedback.type).toBe('warning');
    expect(out.feedback.message).toMatch(/aguarde 17 s/);
    expect(out.cooldownSec).toBe(17);
    expect(out.shouldMarkUncertain).toBe(false);
  });

  it('WEB-E1-06: 429 do próprio API Gateway ("Too Many Requests") vira frase em português', () => {
    expect(resolveTooManyRequestsMessage(undefined, 'Too Many Requests', 5)).toBe(
      'Muitos pedidos em pouco tempo. Aguarde 5 s e tente de novo.',
    );
    expect(resolveTooManyRequestsMessage('demo_cooldown', '', 9)).toMatch(/Modo Usuário Teste: aguarde 9 s/);
    expect(resolveTooManyRequestsMessage('device_rate_limited', '', 30)).toMatch(/aguarde 30 s/);
  });
});

describe('Fase 4.0-E E1 — histórico de eventos', () => {
  const rejected = (reason: string) =>
    parseActivityLogFromFirestore(
      {
        type: 'command_execution',
        source: 'manual',
        command_id: 'app-1795400000000-000001',
        message: 'Comando recusado pela estação',
        result: 'failed',
        reason,
      },
      'x',
    );

  it('WEB-E1-07: recusa anti-rajada aparece como proteção, não como falha', () => {
    const log = rejected('rate_limited');
    expect(translateEventResult(log)).toBe('Recusado pela proteção da estação');
    expect(translateEventReason('rate_limited')).toMatch(/até 6, depois 1 a cada 30 s/);
    expect(translateEventReason('valve_cooldown')).toMatch(/2 s/);
    expect(translateEventReason('device_rate_limited')).toMatch(/servidor/);
  });

  it('WEB-E1-08: falha real continua sendo falha', () => {
    expect(translateEventResult(rejected('valve_not_on'))).toBe('Interrompido / Falha na Execução');
  });

  it('WEB-E1-09: comando de OTA não aparece como "Acionamento Manual"', () => {
    const ota = parseActivityLogFromFirestore(
      { type: 'command_execution', source: 'manual', command_id: 'app-1', message: 'x', result: 'success', reason: 'ota_rebooting' },
      'o',
    );
    expect(translateEventSource(ota)).toBe('Atualização de Firmware (OTA)');
    const valve = parseActivityLogFromFirestore(
      { type: 'command_execution', source: 'manual', command_id: 'app-2', message: 'x', result: 'success', reason: 'manual_off' },
      'v',
    );
    expect(translateEventSource(valve)).toBe('Acionamento Manual (App / Web)');
  });
});

describe('Fase 4.0-E E1 — cartão de proteções', () => {
  const sys526 = {
    fw: '5.26.0', ack_outbox_used: 2, ack_outbox_pending: 0, ack_outbox_fault: false,
    flood_rejects: 7, cmd_rejected: 7, ack_write_fail: 0, ack_abandoned: 0, ack_repaired: 0, nvs_free: 412,
  };

  it('WEB-E1-10: firmware 5.26.0 mostra vagas, recusas e NVS', () => {
    const p = parseStationProtections(sys526);
    expect(p).not.toBeNull();
    const d = describeProtections(p!);
    expect(d.tone).toBe('ok');
    expect(d.items).toContain('Confirmações: 6 de 8 vagas livres');
    expect(d.items).toContain('Anti-rajada: 7 LIGAR recusado(s) desde o boot');
    expect(d.items).toContain('NVS: 412 entradas livres');
  });

  it('WEB-E1-11: falha de memória de ACK vira alerta; firmware antigo não mostra o cartão', () => {
    const d = describeProtections(parseStationProtections({ ...sys526, ack_outbox_fault: true, ack_write_fail: 3 })!);
    expect(d.tone).toBe('alert');
    expect(d.items[0]).toMatch(/LIGAR bloqueado por segurança/);
    expect(parseStationProtections({ fw: '5.25.2', heap: 60000 })).toBeNull();
    const item = parseTelemetryItem({ timestamp: 1795400000, sensors: {}, sys: { fw: '5.25.2' } });
    expect(item.protections).toBeNull();
  });
});
