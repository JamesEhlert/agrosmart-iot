/**
 * Testes da 5.40.0: glossário do ícone ⓘ (WEB-15), idade relativa e linha do tempo do
 * comando (WEB-16).
 */
import { describe, expect, it } from 'vitest';
import { GLOSSARY } from '../shared/glossary';
import { formatAge } from '../shared/lib/relativeTime';
import { COMMAND_STEPS, totalCommandMs } from '../features/about/CommandTimeline';

describe('WEB-540 glossário', () => {
  const entries = Object.entries(GLOSSARY);
  it('WEB-540-01 todo termo tem título e texto curto (até 220 caracteres)', () => {
    expect(entries.length).toBeGreaterThanOrEqual(25);
    for (const [, v] of entries) {
      expect(v.term.length).toBeGreaterThan(2);
      expect(v.text.length).toBeGreaterThan(20);
      expect(v.text.length).toBeLessThanOrEqual(220);
    }
  });
  it('WEB-540-02 nenhum identificador interno (e-mail, ARN, conta, IP)', () => {
    const all = entries.map(([, v]) => `${v.term} ${v.text}`).join(' ');
    expect(all).not.toMatch(/@|arn:|\b\d{12}\b|\b\d{1,3}(\.\d{1,3}){3}\b|us-east-2/);
  });
  it('WEB-540-03 termos essenciais para leigos estão presentes', () => {
    for (const k of ['ack', 'operacao', 'ota', 'rssi', 'semConfirmacao', 'alertaSeguranca']) expect(GLOSSARY).toHaveProperty(k);
  });
});

describe('WEB-540 tempo relativo e comando', () => {
  const now = Date.UTC(2026, 10, 24, 22, 0, 0);
  it('WEB-540-04 idade da última leitura', () => {
    expect(formatAge(new Date(now - 25_000), now)).toBe('há 25 s');
    expect(formatAge(new Date(now - 3 * 60_000), now)).toBe('há 3 min');
    expect(formatAge(new Date(now - 5 * 3600_000), now)).toBe('há 5 h');
    expect(formatAge(new Date(now - 4 * 86400_000), now)).toBe('há 4 dias');
    expect(formatAge(null, now)).toBe('sem dados');
  });
  it('WEB-540-05 linha do tempo do comando soma as medianas medidas (≈ 1,5 s)', () => {
    expect(COMMAND_STEPS).toHaveLength(7);
    expect(totalCommandMs()).toBe(1465);
  });
});
