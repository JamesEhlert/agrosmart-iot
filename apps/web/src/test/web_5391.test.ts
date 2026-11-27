/**
 * Testes da correção 5.39.1: disjuntor de consultas do Histórico de Leituras e mensagens
 * amigáveis (o 5.39.0 entrava em loop: ~500 consultas em 20 s e 429 no API Gateway).
 */
import { describe, expect, it } from 'vitest';
import {
  createRequestBudget,
  friendlyReadingsError,
  READINGS_REQ_BUDGET,
  READINGS_REQ_WINDOW_MS,
} from '../features/telemetry/model/readingsQuery';

describe('WEB-5391 disjuntor de consultas', () => {
  it('WEB-5391-01 libera até 12 consultas em 10 s e bloqueia a 13ª', () => {
    const b = createRequestBudget(READINGS_REQ_BUDGET, READINGS_REQ_WINDOW_MS);
    const t0 = 1_000_000;
    for (let i = 0; i < 12; i += 1) expect(b.allow(t0 + i * 10)).toBe(true);
    expect(b.allow(t0 + 200)).toBe(false);
  });
  it('WEB-5391-02 volta a liberar depois que a janela passa', () => {
    const b = createRequestBudget(2, 1000);
    expect(b.allow(0)).toBe(true);
    expect(b.allow(10)).toBe(true);
    expect(b.allow(20)).toBe(false);
    expect(b.allow(1005)).toBe(true);
  });
  it('WEB-5391-03 mensagens amigáveis sem detalhes internos', () => {
    expect(friendlyReadingsError({ status: 429 })).toMatch(/Muitas consultas/);
    expect(friendlyReadingsError(new Error('Too Many Requests'))).toMatch(/Muitas consultas/);
    expect(friendlyReadingsError({ status: 403 })).toMatch(/sessão/);
    expect(friendlyReadingsError(new Error('boto3 stack trace xyz'))).not.toMatch(/boto3/);
  });
});
