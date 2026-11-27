/**
 * =====================================================================================
 * ARQUIVO: src/features/telemetry/model/localControls.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T23:50:00Z (UTC)
 * VERSÃO: v5.41.0
 * PROPÓSITO: Textos do display e dos botões da estação (firmware 5.27.0), usados no cartão
 *            de Configurações e na Saúde da estação.
 * =====================================================================================
 */

import { StationLocalControls } from './telemetry.types';

/** "4 min 05 s" / "1 h 02 min" para o tempo até a tela apagar. */
export function formatDisplayLeft(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min ${String(r).padStart(2, '0')} s`;
}

/**
 * Texto do estado atual da tela. `ageS` = idade da leitura (o prazo é descontado), para não
 * prometer "apaga em 5 min" com base numa leitura de minutos atrás.
 */
export function describeDisplayState(lc: StationLocalControls, ageS: number = 0): string {
  if (!lc.displayOn) return 'Apagada';
  if (lc.displayLeftS <= 0) return 'Ligada';
  const left = lc.displayLeftS - Math.max(0, ageS);
  if (left <= 0) return lc.displayDefaultOn ? 'Ligada' : 'Apagando (prazo encerrado)';
  if (left < 60) return 'Ligada · apaga em menos de 1 min';
  return `Ligada · apaga em ~${formatDisplayLeft(Math.max(1, Math.round(left / 60)) * 60).replace(/ 00 s$/, '').replace(/ 00 min$/, '')}`;
}

/** Idade (s) de uma leitura; 0 se a data for inválida ou do futuro. */
export function readingAgeS(readingAt: Date | null | undefined, nowMs: number = Date.now()): number {
  const t = readingAt?.getTime();
  if (typeof t !== 'number' || Number.isNaN(t) || t <= 0) return 0;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/** Linha curta para a Saúde da estação. */
export function describeLocalControlsSummary(
  lc: StationLocalControls,
  ageS: number = 0,
): { tone: 'ok' | 'warn'; text: string } {
  const parts = [`Display: ${describeDisplayState(lc, ageS).toLowerCase()}`];
  parts.push(lc.displayDefaultOn ? 'padrão sempre ligada' : 'padrão apagada (acende pelo botão)');
  if (lc.btnIrrigMin) parts.push(`botão de irrigação: ${lc.btnIrrigMin} min`);
  if (lc.btnFault > 0) {
    const which = lc.btnFault === 3 ? 'os dois botões travados' : lc.btnFault & 2 ? 'botão de irrigação travado' : 'botão do display travado';
    return { tone: 'warn', text: `${parts.join(' · ')} · ${which} (ignorado pela estação)` };
  }
  return { tone: 'ok', text: parts.join(' · ') };
}
