/**
 * =====================================================================================
 * ARQUIVO: src/features/about/CommandTimeline.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T22:30:00Z (UTC)
 * VERSÃO: v5.40.0
 * PROPÓSITO: Linha do tempo de um comando "ligar", do clique à tela (WEB-16), com as
 *            medianas medidas nos testes de ponta a ponta. Barra proporcional + cursor
 *            animado por CSS (parado com "reduzir movimento").
 * =====================================================================================
 */

import { usePrefersReducedMotion } from './usePrefersReducedMotion';

export const COMMAND_STEPS: ReadonlyArray<{ label: string; detail: string; ms: number; color: string }> = [
  { label: 'Site → nuvem', detail: 'navegador até a API (login conferido)', ms: 265, color: '#1976D2' },
  { label: 'SendCommand', detail: 'posse da estação, limites, registro e envio', ms: 300, color: '#1565C0' },
  { label: 'Nuvem → placa', detail: 'MQTT até a estação', ms: 200, color: '#00838F' },
  { label: 'Estação', detail: 'valida, abre a válvula (relé em ~40 ms) e grava o ACK', ms: 75, color: '#2E7D32' },
  { label: 'Placa → nuvem', detail: 'ACK pelo MQTT', ms: 155, color: '#558B2F' },
  { label: 'AckToFirestore', detail: 'atualiza comando e auditoria', ms: 270, color: '#F57C00' },
  { label: 'Firestore → tela', detail: 'atualização em tempo real no site', ms: 200, color: '#EF6C00' },
];

export function totalCommandMs(): number {
  return COMMAND_STEPS.reduce((a, s) => a + s.ms, 0);
}

export function CommandTimeline() {
  const reduced = usePrefersReducedMotion();
  const total = totalCommandMs();
  return (
    <div className="space-y-3">
      <style>{`@keyframes agro-sweep { from { left: 0% } to { left: 100% } }`}</style>
      <div className="relative h-10 rounded-xl overflow-hidden flex border border-line" role="img" aria-label={`Comando do clique à tela em cerca de ${(total / 1000).toFixed(1).replace('.', ',')} segundos`}>
        {COMMAND_STEPS.map((s) => (
          <div key={s.label} style={{ width: `${(s.ms / total) * 100}%`, background: s.color }} className="h-full flex items-center justify-center">
            <span className="text-[11px] font-extrabold text-white/95 truncate px-1">{s.ms} ms</span>
          </div>
        ))}
        {!reduced && (
          <span
            aria-hidden="true"
            className="absolute top-0 bottom-0 w-1 bg-surface shadow-[0_0_10px_rgba(255,255,255,0.9)]"
            style={{ animation: 'agro-sweep 3.2s linear infinite' }}
          />
        )}
      </div>
      <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {COMMAND_STEPS.map((s, i) => (
          <li key={s.label} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 w-5 h-5 rounded-full text-[11px] font-extrabold text-white flex items-center justify-center shrink-0" style={{ background: s.color }}>
              {i + 1}
            </span>
            <span>
              <strong className="text-ink">{s.label}</strong> <span className="text-ink-muted">· {s.ms} ms — {s.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-ink-muted">
        Medianas medidas em testes de ponta a ponta (nov/2026): cerca de {(total / 1000).toFixed(1).replace('.', ',')} s do clique à confirmação
        na tela. Cerca de 0,7 s é só a distância Brasil ↔ servidores nos EUA.
      </p>
    </div>
  );
}
