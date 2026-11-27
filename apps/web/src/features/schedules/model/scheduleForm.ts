/**
 * ARQUIVO: src/features/schedules/model/scheduleForm.ts — v5.47.0
 * "Foto" dos campos do formulário de agendamento, para saber se há alteração não salva
 * (os dias valem em qualquer ordem; espaços nas pontas do nome não contam).
 */
export interface ScheduleFormValues { label: string; time: string; days: number[]; durationMinutes: number; isEnabled: boolean }

export function scheduleFormSnapshot(v: ScheduleFormValues): string {
  return JSON.stringify([v.label.trim(), v.time, [...v.days].sort((a, b) => a - b), v.durationMinutes, v.isEnabled]);
}
