/**
 * =====================================================================================
 * ARQUIVO: src/features/schedules/model/schedule.types.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1B — Vagas e Limites Demo)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T05:20:00Z (UTC)
 * VERSÃO: v5.30.0
 * PROPÓSITO: Contratos TypeScript e limites operacionais para rotinas semanais de
 *            irrigação armazenadas em `devices/{deviceId}/schedules/{scheduleId}` no
 *            Cloud Firestore.
 * CHANGELOG:
 * - v5.30.0: Adiciona constantes `DEMO_MAX_SCHEDULES_PER_SESSION = 5`,
 *            `DEMO_MAX_SCHEDULE_DURATION_MIN = 5`, `OWNER_MAX_SCHEDULE_DURATION_MIN = 15`
 *            e o helper `buildDemoScheduleSlotIds(demoSid)` para alocação compatível
 *            com `firestore.rules` v5.30.0 (`demo-<sid>-0..4`).
 * - v5.29.0: Adicionado campo opcional `demoSessionId` (`demo_session_id`) para isolar
 *            agendamentos por sessão Demo e impedir reutilização entre sessões A e B (F1.3).
 * =====================================================================================
 */

/**
 * v5.38.0 (SCH-01): limite de agendamentos do titular por estação (antes 100). Cobre 2–3
 * regas por dia com folga. As agendas de sessões Demo não contam aqui (têm 5 vagas próprias).
 */
export const OWNER_MAX_SCHEDULES = 20;

/** Limite máximo de agendamentos simultâneos por sessão de Usuário Teste (Rules v5.30.0). */
export const DEMO_MAX_SCHEDULES_PER_SESSION = 5;

/** Duração máxima em minutos por agendamento criado ou editado em sessão Demo. */
export const DEMO_MAX_SCHEDULE_DURATION_MIN = 5;

/** Duração máxima em minutos por agendamento para o Operador Titular (limite embarcado). */
export const OWNER_MAX_SCHEDULE_DURATION_MIN = 15;

export interface ScheduleModel {
  id: string;
  label: string;
  time: string; // Formato "HH:mm" (00:00 a 23:59)
  days: number[]; // 1 = Segunda ... 7 = Domingo
  durationMinutes: number; // 1 a 15 minutos (máx. 5 na Demo)
  isEnabled: boolean;
  createdByDemo?: boolean;
  demoSessionId?: string | null;
}

export interface ScheduleFormInput {
  label: string;
  time: string;
  days: number[];
  durationMinutes: number;
  isEnabled: boolean;
  createdByDemo?: boolean;
  demoSessionId?: string | null;
}

export const WEEKDAYS_LIST: ReadonlyArray<{ day: number; short: string; full: string }> = [
  { day: 1, short: 'Seg', full: 'Segunda-feira' },
  { day: 2, short: 'Ter', full: 'Terça-feira' },
  { day: 3, short: 'Qua', full: 'Quarta-feira' },
  { day: 4, short: 'Qui', full: 'Quinta-feira' },
  { day: 5, short: 'Sex', full: 'Sexta-feira' },
  { day: 6, short: 'Sáb', full: 'Sábado' },
  { day: 7, short: 'Dom', full: 'Domingo' },
] as const;

/**
 * Gera os 5 identificadores determinísticos de vaga permitidos para a sessão Demo
 * pelas Security Rules v5.30.0 (`demo-<demoSid>-0` até `demo-<demoSid>-4`).
 */
export function buildDemoScheduleSlotIds(demoSid: string): string[] {
  const cleanSid = demoSid.trim();
  if (!cleanSid) {
    throw new Error('Identificador de sessão Demo inválido para alocação de agendamentos.');
  }
  return Array.from(
    { length: DEMO_MAX_SCHEDULES_PER_SESSION },
    (_, idx) => `demo-${cleanSid}-${idx}`,
  );
}

/**
 * Formata a lista numérica de dias da semana (1..7) em texto legível para os cards.
 */
export function formatScheduleDaysSummary(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return 'Todos os dias';
  if (
    sorted.length === 5 &&
    sorted[0] === 1 &&
    sorted[1] === 2 &&
    sorted[2] === 3 &&
    sorted[3] === 4 &&
    sorted[4] === 5
  ) {
    return 'Segunda a Sexta (Dias úteis)';
  }
  if (sorted.length === 2 && sorted[0] === 6 && sorted[1] === 7) {
    return 'Fim de semana (Sáb, Dom)';
  }

  return sorted
    .map((d) => WEEKDAYS_LIST.find((w) => w.day === d)?.short ?? String(d))
    .join(', ');
}
