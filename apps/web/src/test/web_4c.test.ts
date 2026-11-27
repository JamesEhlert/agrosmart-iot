/**
 * =====================================================================================
 * ARQUIVO: src/test/web_4c.test.ts
 * PROJETO: AgroSmart Precision IoT V5 — Web
 * DATA: 2026-11-23 (UTC) — Fase 4.0-C
 * PROPOSITO: Testes das regras visuais do botão minimalista da válvula.
 * =====================================================================================
 */
import { describe, expect, it } from 'vitest';
import {
  SILENT_COOLDOWN_MAX_SEC,
  ValveButtonInput,
  formatLatency,
  resolveValveButtonView,
  resolveValveStatusLine,
} from '../features/irrigation/components/valveControlView';

const base: ValveButtonInput = {
  isBusy: false,
  isOnline: true,
  otaActive: false,
  confirmationUncertain: false,
  isValveOpen: false,
  isValvePending: false,
  isLockedBySchedule: false,
  cooldownSec: 0,
  cooldownStartSec: 0,
  selectedMinutes: 1,
  remainingText: '--:--',
};

describe('Fase 4.0-C — botão minimalista da válvula', () => {
  it('WEB-4C-01: em repouso o botão é azul, inicia e mostra a duração', () => {
    const v = resolveValveButtonView(base);
    expect(v).toMatchObject({ tone: 'start', action: 'start', disabled: false, dimmed: false, label: 'Iniciar irrigação', detail: '1 min' });
  });

  it('WEB-4C-02: irrigando, o botão é vermelho, para e mostra o tempo restante', () => {
    const v = resolveValveButtonView({ ...base, isValveOpen: true, remainingText: '0m 42s' });
    expect(v).toMatchObject({ tone: 'stop', action: 'stop', disabled: false, label: 'Parar irrigação', detail: '0m 42s' });
    const s = resolveValveButtonView({ ...base, isValveOpen: true, isLockedBySchedule: true });
    expect(s.label).toBe('Parar irrigação agendada');
    expect(s.detail).toBeNull();
  });

  it('WEB-4C-03: durante TODA a espera (envio + ACK) o texto é o mesmo e o botão fica travado', () => {
    const a = resolveValveButtonView({ ...base, isBusy: true });
    const b = resolveValveButtonView({ ...base, isBusy: true, isValveOpen: true });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ tone: 'busy', label: 'Aguardando confirmação', disabled: true, dimmed: false, action: 'none', detail: null });
  });

  it('WEB-4C-04: a pausa curta pós-ACK é silenciosa (sem texto de contagem e sem desbotar), mas bloqueia o clique', () => {
    const afterOff = resolveValveButtonView({ ...base, cooldownSec: 1, cooldownStartSec: 1 });
    expect(afterOff).toMatchObject({ tone: 'start', label: 'Iniciar irrigação', disabled: true, dimmed: false });
    const afterOn = resolveValveButtonView({ ...base, isValveOpen: true, cooldownSec: 1, cooldownStartSec: 1 });
    expect(afterOn).toMatchObject({ tone: 'stop', disabled: true, dimmed: false });
    expect(SILENT_COOLDOWN_MAX_SEC).toBeGreaterThanOrEqual(1);
  });

  it('WEB-4C-05: pausa longa (ex.: limite de uso 60 s) mostra a contagem; a parada continua livre', () => {
    const v = resolveValveButtonView({ ...base, cooldownSec: 45, cooldownStartSec: 60 });
    expect(v).toMatchObject({ tone: 'cooldown', label: 'Disponível em', detail: '45 s', disabled: true });
    const stop = resolveValveButtonView({ ...base, isValveOpen: true, cooldownSec: 45, cooldownStartSec: 60 });
    expect(stop).toMatchObject({ tone: 'stop', action: 'stop', disabled: false });
  });

  it('WEB-4C-06: sem confirmação, o botão fica âmbar e oferece a parada de segurança', () => {
    const v = resolveValveButtonView({ ...base, confirmationUncertain: true });
    expect(v).toMatchObject({ tone: 'warning', action: 'stop', disabled: false, label: 'Enviar parada de segurança' });
  });

  it('WEB-4C-07: estação offline ou OTA => cinza, cadeado, desbotado e sem ação', () => {
    expect(resolveValveButtonView({ ...base, isOnline: false })).toMatchObject({ tone: 'locked', icon: 'lock', disabled: true, dimmed: true, action: 'none' });
    expect(resolveValveButtonView({ ...base, otaActive: true })).toMatchObject({ tone: 'locked', disabled: true, action: 'none' });
    const openOffline = resolveValveButtonView({ ...base, isOnline: false, isValveOpen: true });
    expect(openOffline).toMatchObject({ tone: 'stop', disabled: true, dimmed: true });
  });

  it('WEB-4C-08: reserva pendente => vermelho "Cancelar reserva"', () => {
    expect(resolveValveButtonView({ ...base, isValvePending: true })).toMatchObject({ tone: 'stop', action: 'stop', label: 'Cancelar reserva' });
  });

  it('WEB-4C-09: linha de status segue a prioridade offline > OTA > sem confirmação > erro > último ACK > padrão', () => {
    const st = { isBusy: false, isOnline: true, otaActive: false, confirmationUncertain: false, feedback: null, lastConfirmation: null };
    expect(resolveValveStatusLine(st).tone).toBe('neutral');
    expect(resolveValveStatusLine({ ...st, isOnline: false, confirmationUncertain: true }).tone).toBe('error');
    expect(resolveValveStatusLine({ ...st, otaActive: true, confirmationUncertain: true }).text).toMatch(/firmware/);
    expect(resolveValveStatusLine({ ...st, confirmationUncertain: true, feedback: { type: 'error', message: 'x' } }).text).toMatch(/não confirmou/);
    expect(resolveValveStatusLine({ ...st, feedback: { type: 'error', message: 'Falha X' } })).toEqual({ tone: 'error', text: 'Falha X' });
  });

  it('WEB-4C-10: sucesso não vira caixa: a linha mostra o último ACK com horário e latência', () => {
    const line = resolveValveStatusLine({
      isBusy: false, isOnline: true, otaActive: false, confirmationUncertain: false,
      feedback: { type: 'success', message: 'Irrigação encerrada.' },
      lastConfirmation: { action: 'parar', atMs: 0, latencyMs: 1812 },
      formatTime: () => '17:45:54',
    });
    expect(line).toEqual({ tone: 'success', text: 'Último comando (parar) confirmado pela estação às 17:45:54 · 1,8 s' });
    expect(formatLatency(2456)).toBe('2,5 s');
  });

  it('WEB-4C-11: durante a espera a linha NÃO troca para o aviso (fica estável)', () => {
    const before = resolveValveStatusLine({
      isBusy: false, isOnline: true, otaActive: false, confirmationUncertain: false, feedback: null,
      lastConfirmation: { action: 'ligar', atMs: 0, latencyMs: 1500 }, formatTime: () => 't',
    });
    const during = resolveValveStatusLine({
      isBusy: true, isOnline: true, otaActive: false, confirmationUncertain: true,
      feedback: { type: 'warning', message: 'w' },
      lastConfirmation: { action: 'ligar', atMs: 0, latencyMs: 1500 }, formatTime: () => 't',
    });
    expect(during).toEqual(before);
  });
});
