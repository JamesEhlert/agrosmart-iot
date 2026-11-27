/**
 * =====================================================================================
 * ARQUIVO: src/features/schedules/model/schedule.schema.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1B — Validacao de Duracao Demo)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T05:20:00Z (UTC)
 * VERSÃO: v5.30.0
 * PROPÓSITO: Validação em runtime com Zod para criação e edição de agendamentos,
 *            garantindo conformidade estrita com `isValidSchedulePayload` de
 *            `firestore.rules` (v5.30.0).
 * CHANGELOG:
 * - v5.30.0: Mantém o teto geral de 15 min no schema e exporta
 *            `validateScheduleDurationForCaller(minutes, isDemo)` (teto de 5 min na Demo
 *            e 15 min no titular) para reutilização no formulário e no repositório.
 * - v5.29.0: Suporte a `demo_session_id` para vincular agendamentos criados em sessão
 *            Demo exclusivamente ao `demo_sid` da sessão ativa (F1.3).
 * =====================================================================================
 */

import { z } from 'zod';
import {
  DEMO_MAX_SCHEDULE_DURATION_MIN,
  OWNER_MAX_SCHEDULE_DURATION_MIN,
  ScheduleFormInput,
  ScheduleModel,
} from './schedule.types';

/**
 * Valida estritamente horas de 00 a 23 e minutos de 00 a 59, dias de 1 a 7 sem duplicatas
 * e duração física geral de 1 a 15 minutos.
 */
export const scheduleFormSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'Digite um nome para identificar o agendamento.')
    .max(80, 'O nome do agendamento deve ter no máximo 80 caracteres.'),
  time: z
    .string()
    .trim()
    .regex(
      /^([01][0-9]|2[0-3]):[0-5][0-9]$/,
      'Informe um horário válido entre 00:00 e 23:59.',
    ),
  days: z
    .array(z.number().int().min(1).max(7))
    .min(1, 'Selecione pelo menos um dia da semana.')
    .max(7, 'Máximo de 7 dias da semana.'),
  durationMinutes: z
    .number()
    .int()
    .min(1, 'A duração mínima é de 1 minuto.')
    .max(
      OWNER_MAX_SCHEDULE_DURATION_MIN,
      `Limite de segurança embarcado: máximo de ${OWNER_MAX_SCHEDULE_DURATION_MIN} minutos por ciclo.`,
    ),
  isEnabled: z.boolean(),
  createdByDemo: z.boolean().optional(),
  demoSessionId: z.string().trim().max(64).optional().nullable(),
});

/**
 * Valida a duração de um agendamento de acordo com o perfil do chamador:
 * - Usuário Teste (Demo): inteiro entre 1 e 5 minutos;
 * - Operador Titular: inteiro entre 1 e 15 minutos.
 * Lança `Error` com mensagem clara caso o limite seja violado.
 */
export function validateScheduleDurationForCaller(
  minutes: number,
  isDemo: boolean,
): number {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || !Number.isInteger(minutes)) {
    throw new Error('A duração do agendamento deve ser um número inteiro de minutos.');
  }
  if (minutes < 1) {
    throw new Error('A duração mínima é de 1 minuto.');
  }
  if (isDemo && minutes > DEMO_MAX_SCHEDULE_DURATION_MIN) {
    throw new Error(
      `Modo Usuário Teste: a duração máxima por agendamento é de ${DEMO_MAX_SCHEDULE_DURATION_MIN} minutos.`,
    );
  }
  if (minutes > OWNER_MAX_SCHEDULE_DURATION_MIN) {
    throw new Error(
      `Limite de segurança embarcado: máximo de ${OWNER_MAX_SCHEDULE_DURATION_MIN} minutos por ciclo.`,
    );
  }
  return minutes;
}

function parseSafeScheduleBool(val: unknown, fallback = true): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (clean === 'true' || clean === '1') return true;
    if (clean === 'false' || clean === '0') return false;
  }
  return fallback;
}

/**
 * Desserializa um documento da subcoleção `schedules` do Firestore.
 */
export function parseScheduleFromFirestore(
  data: Record<string, unknown> | undefined,
  docId: string,
): ScheduleModel {
  const raw = data ?? {};
  const rawDays = Array.isArray(raw.days) ? raw.days : [];
  const cleanDays = [
    ...new Set(
      rawDays
        .map((d) => Number(d))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7),
    ),
  ].sort((a, b) => a - b);

  const rawDur = Number(raw.duration_minutes ?? 5);
  const safeDur = Number.isFinite(rawDur) ? Math.trunc(rawDur) : 5;
  const demoSessionId =
    typeof raw.demo_session_id === 'string' && raw.demo_session_id.trim()
      ? raw.demo_session_id.trim()
      : null;

  return {
    id: docId,
    label:
      typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim()
        : 'Rotina Sem Nome',
    time:
      typeof raw.time === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(raw.time.trim())
        ? raw.time.trim()
        : '08:00',
    days: cleanDays,
    durationMinutes: Math.max(1, Math.min(OWNER_MAX_SCHEDULE_DURATION_MIN, safeDur)),
    isEnabled: parseSafeScheduleBool(raw.enabled, true),
    createdByDemo: parseSafeScheduleBool(raw.created_by_demo, false),
    demoSessionId,
  };
}

/**
 * Constrói o dicionário exigido pela função `isValidSchedulePayload` em `firestore.rules`.
 * Preserva as 5 chaves padrão para o Operador Titular (100% compatível com os testes WEB-UT)
 * e inclui `created_by_demo: true` + `demo_session_id` quando acionado por uma sessão Demo.
 */
export function toFirestoreSchedulePayload(input: ScheduleFormInput): {
  label: string;
  time: string;
  days: number[];
  duration_minutes: number;
  enabled: boolean;
  created_by_demo?: boolean;
  demo_session_id?: string;
} {
  const parsed = scheduleFormSchema.parse({
    ...input,
    days: [...new Set(input.days)].sort((a, b) => a - b),
  });

  const basePayload: {
    label: string;
    time: string;
    days: number[];
    duration_minutes: number;
    enabled: boolean;
    created_by_demo?: boolean;
    demo_session_id?: string;
  } = {
    label: parsed.label,
    time: parsed.time,
    days: parsed.days,
    duration_minutes: Math.trunc(parsed.durationMinutes),
    enabled: Boolean(parsed.isEnabled),
  };

  if (parsed.createdByDemo === true) {
    basePayload.created_by_demo = true;
    const cleanSid = typeof parsed.demoSessionId === 'string' ? parsed.demoSessionId.trim() : '';
    if (cleanSid) {
      basePayload.demo_session_id = cleanSid;
    }
  }

  return basePayload;
}
