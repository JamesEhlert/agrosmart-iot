/**
 * =====================================================================================
 * ARQUIVO: src/test/web_3c_item9.test.ts
 * PROJETO: AgroSmart Precision IoT V5 — Web
 * DATA: 2026-11-23 (UTC)
 * PROPÓSITO: Testes da Fase 3C, item 9 — alerta de comando não registrado, novos motivos
 *            e status OTA `verifying` (observação de 90 s).
 * =====================================================================================
 */
import { describe, expect, it } from 'vitest';
import { computeActiveOtaStep } from '../features/devices/model/device.schema';
import {
  parseActivityLogFromFirestore,
  translateEventReason,
  translateEventResult,
  translateEventSource,
  translateOtaStatus,
} from '../features/events/model/event.types';

const baseOta = {
  inProgress: false,
  awaitingReboot: false,
  targetVersion: '5.25.2',
  previousVersion: '5.25.1',
  verifiedFw: '5.25.1',
  error: null,
  lastCommandId: 'ota-3c-1',
  updatedAt: new Date(),
};

describe('Fase 3C item 9 — exibição web', () => {
  it('WEB-3C-01: ACK de comando não registrado vira alerta de segurança traduzido', () => {
    const log = parseActivityLogFromFirestore(
      {
        type: 'security_alert',
        source: 'unregistered',
        command_id: 't3c041703',
        message: '⚠ Comando não registrado no servidor: OFF',
        result: 'success',
        reason: 'manual_off',
        event_code: 'CMD_UNREGISTERED',
        details: { unregistered: true, result: 'success' },
      },
      'cmd-t3c041703',
    );
    expect(log.isUnregistered).toBe(true);
    expect(log.isSecurityOrAlert).toBe(true);
    expect(log.isManualCommand).toBe(false);
    expect(translateEventSource(log)).toBe('Não registrado no servidor (possível injeção)');
    expect(translateEventSource(log)).not.toBe('UNREGISTERED');
    expect(translateEventResult(log)).toBe(
      'Alerta de Segurança: executado pela estação sem registro no servidor',
    );
    expect(translateEventResult(log)).not.toBe('Concluído com Sucesso');
  });

  it('WEB-3C-02: comando manual registrado continua exatamente como antes', () => {
    const log = parseActivityLogFromFirestore(
      {
        type: 'command_execution',
        source: 'manual',
        command_id: 'app-1795409325751-083705',
        message: 'Irrigação encerrada manualmente',
        result: 'success',
        reason: 'manual_off',
      },
      'cmd-app-1795409325751-083705',
    );
    expect(log.isUnregistered).toBe(false);
    expect(log.isSecurityOrAlert).toBe(false);
    expect(translateEventSource(log)).toBe('Acionamento Manual (App / Web)');
    expect(translateEventResult(log)).toBe('Concluído com Sucesso');
  });

  it('WEB-3C-03: novos motivos são traduzidos e os de proteção física viram alerta', () => {
    const novos = [
      'ota_observing',
      'power_unstable',
      'power_loss_rollback',
      'failsafe_guard_timer',
      'valve_task_stall',
      'valve_guard_pending',
      'unregistered_command',
      'cancelled_by_off',
      'superseded_by_off',
      'valve_already_open',
    ];
    for (const r of novos) {
      expect(translateEventReason(r)).not.toBe(r);
    }
    for (const r of ['power_unstable', 'failsafe_guard_timer', 'valve_task_stall']) {
      const log = parseActivityLogFromFirestore(
        { type: 'command_execution', source: 'system', result: 'success', reason: r },
        'x-' + r,
      );
      expect(log.isSecurityOrAlert).toBe(true);
    }
  });

  it('WEB-3C-04: status verifying ativa a etapa 4; verified_online continua sucesso', () => {
    expect(
      computeActiveOtaStep({
        otaStatus: { ...baseOta, status: 'verifying', reason: 'ota_observing' },
      }),
    ).toEqual({ currentStep: 4, stateTone: 'active' });
    expect(
      computeActiveOtaStep({
        otaStatus: { ...baseOta, status: 'verified_online', reason: 'ota_updated', verifiedFw: '5.25.2' },
      }),
    ).toEqual({ currentStep: 4, stateTone: 'success' });
  });

  it('WEB-3C-05: translateOtaStatus traduz os status e não quebra com valores desconhecidos', () => {
    expect(translateOtaStatus('verifying')).toBe('Verificando');
    expect(translateOtaStatus('VERIFIED_ONLINE')).toBe('Verificado');
    expect(translateOtaStatus('started')).toBe('Baixando e validando');
    expect(translateOtaStatus('rolled_back')).toBe('Revertido');
    expect(translateOtaStatus('algo_novo')).toBe('ALGO_NOVO');
    expect(translateOtaStatus(null)).toBe('—');
  });
});
