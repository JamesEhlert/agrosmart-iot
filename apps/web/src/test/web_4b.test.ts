/**
 * =====================================================================================
 * ARQUIVO: src/test/web_4b.test.ts
 * PROJETO: AgroSmart Precision IoT V5 — Web
 * DATA: 2026-11-23 (UTC) — Fase 4.0-B
 * PROPOSITO: Testes do botão guiado pelo ACK e do registro de diagnóstico profissional.
 * =====================================================================================
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACK_STATE_OVERRIDE_MS,
  ACK_TIMEOUT_MS,
  POST_CONFIRM_GUARD_SECONDS,
  classifyValveCommandError,
  resolveEffectiveValveOpen,
  shouldShowUnconfirmedBanner,
} from '../features/irrigation/hooks/useValveControl';
import { ConflictException } from '../shared/api/httpClient';
import {
  buildDiagnosticsJsonl,
  buildExportFileName,
  clearWebDiagnostics,
  compactUtc,
  getActiveTestRunId,
  getDiagnosticsSummary,
  logWebDiagnostic,
  sanitizeTestLabel,
  setTestLabel,
} from '../shared/lib/diagnostics';
import { APP_VERSION, APP_VERSION_LABEL } from '../shared/config/appInfo';
import pkg from '../../package.json';

// Token FALSO montado em tempo de execucao: nao e segredo e assim o gitleaks nao o
// confunde com um JWT real no codigo-fonte.
const FAKE_JWT = ['eyJ' + 'hbGciOiJSUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijk'].join('.');

describe('Fase 4.0-B — botão da válvula guiado pelo ACK', () => {
  it('WEB-4B-01: aviso "não confirmado" NUNCA aparece durante o envio ou a espera do ACK', () => {
    expect(shouldShowUnconfirmedBanner(true, 'sending_http')).toBe(false);
    expect(shouldShowUnconfirmedBanner(true, 'waiting_ack')).toBe(false);
    expect(shouldShowUnconfirmedBanner(true, 'idle')).toBe(true);
    expect(shouldShowUnconfirmedBanner(false, 'idle')).toBe(false);
  });

  it('WEB-4B-02: pausa pós-confirmação de 1 s (era 3 s) e prazo de ACK de 20 s', () => {
    expect(POST_CONFIRM_GUARD_SECONDS).toBe(1);
    expect(ACK_TIMEOUT_MS).toBe(20_000);
  });

  it('WEB-4B-03: timeout de ACK marca incerteza, sem pausa extra (a parada fica liberada)', () => {
    const out = classifyValveCommandError(new Error('TIMEOUT_ACK'), false, true);
    expect(out.shouldMarkUncertain).toBe(true);
    expect(out.cooldownSec).toBeUndefined();
    expect(out.feedback.message).toMatch(/20 s/);
  });

  it('WEB-4B-04: conflito (409) usa a pausa curta de 1 s', () => {
    const out = classifyValveCommandError(new ConflictException('Conflito'), false, false);
    expect(out.cooldownSec).toBe(1);
  });

  it('WEB-4B-05: resultado do ACK prevalece até o Firestore refletir; depois vale o Firestore', () => {
    const t0 = 1_000_000;
    const off = { open: false, untilMs: t0 + ACK_STATE_OVERRIDE_MS, setAtMs: t0, endsAtMs: null, commandId: 'app-1' };
    // Firestore ainda diz "aberta": a tela mostra "fechada" (ACK confirmado)
    expect(resolveEffectiveValveOpen(true, off, t0 + 500)).toEqual({ open: false, overrideActive: true });
    // Firestore alcançou: sem sobreposição
    expect(resolveEffectiveValveOpen(false, off, t0 + 900)).toEqual({ open: false, overrideActive: false });
    // Passou o limite e o Firestore discorda: vale o Firestore (fonte da verdade)
    expect(resolveEffectiveValveOpen(true, off, t0 + ACK_STATE_OVERRIDE_MS + 1)).toEqual({ open: true, overrideActive: false });
    // Sem ACK recente: vale o Firestore
    expect(resolveEffectiveValveOpen(true, null, t0)).toEqual({ open: true, overrideActive: false });
  });
});

describe('Fase 4.0-B — registro de diagnóstico', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setTestLabel('');
    clearWebDiagnostics();
  });

  it('WEB-4B-06: versão do web vem do package.json (sem número fixo no código)', () => {
    expect(APP_VERSION).toBe((pkg as { version: string }).version);
    expect(APP_VERSION_LABEL).toBe(`v${APP_VERSION}`);
  });

  it('WEB-4B-07: cada registro tem sessão automática, seq crescente e fw_web correto', () => {
    logWebDiagnostic('INFO', 'teste.um', {});
    logWebDiagnostic('WARN', 'teste.dois', {});
    const lines = buildDiagnosticsJsonl().trim().split('\n').map((l) => JSON.parse(l));
    const recs = lines.slice(1);
    const s = getDiagnosticsSummary();
    expect(s.sessionId).toMatch(/^W[0-9A-F]{6}$/);
    expect(recs.every((r) => r.session_id === s.sessionId)).toBe(true);
    const seqs = recs.map((r) => r.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(recs.every((r) => r.fw_web === APP_VERSION_LABEL)).toBe(true);
  });

  it('WEB-4B-08: "Novo teste" inicia outra sessão e zera a contagem', () => {
    const before = getDiagnosticsSummary().sessionId;
    logWebDiagnostic('ERROR', 'teste.erro', {});
    clearWebDiagnostics();
    const after = getDiagnosticsSummary();
    expect(after.sessionId).not.toBe(before);
    expect(after.total).toBe(1); // só o diagnostics.buffer_cleared
    expect(after.counts.ERROR).toBe(0);
  });

  it('WEB-4B-09: nome do arquivo único, com UTC, sessão e rótulo opcional', () => {
    const at = new Date('2026-11-23T20:30:15.123Z');
    const sid = getDiagnosticsSummary().sessionId;
    expect(buildExportFileName(at)).toBe(`agrosmart-web-log_20261123T203015Z_${sid}.jsonl`);
    setTestLabel('teste velocidade!');
    expect(buildExportFileName(at)).toBe(`agrosmart-web-log_20261123T203015Z_${sid}_teste-velocidade.jsonl`);
    expect(compactUtc(at)).toBe('20261123T203015Z');
  });

  it('WEB-4B-10: rótulo é sanitizado e vira o test_run_id; sem rótulo, usa a sessão', () => {
    expect(sanitizeTestLabel('  a/b c?d  ')).toBe('ab-cd');
    expect(sanitizeTestLabel('x'.repeat(50))).toHaveLength(32);
    expect(getActiveTestRunId()).toBe(getDiagnosticsSummary().sessionId);
    setTestLabel('E2E-01');
    expect(getActiveTestRunId()).toBe('E2E-01');
  });

  it('WEB-4B-11: exportação começa com cabeçalho (versão, build, contagens) e não vaza segredos', () => {
    logWebDiagnostic('INFO', 'teste.segredo', {
      authorization: `Bearer ${FAKE_JWT}`,
      note: 'passe AGRO-7K9M-X4P2 usado',
      appcheck_token: 'valor-que-nao-pode-sair',
    });
    const text = buildDiagnosticsJsonl();
    const header = JSON.parse(text.split('\n')[0]);
    expect(header.event_name).toBe('diagnostics.export_header');
    expect(header.fw_web).toBe(APP_VERSION_LABEL);
    expect(header.counts.INFO).toBeGreaterThanOrEqual(2);
    expect(header.records).toBe(getDiagnosticsSummary().total);
    expect(text).not.toContain('AGRO-7K9M-X4P2');
    expect(text).not.toContain('valor-que-nao-pode-sair');
    expect(text).not.toMatch(/eyJhbGciOiJSUzI1NiJ9\.eyJ/);
  });
});
