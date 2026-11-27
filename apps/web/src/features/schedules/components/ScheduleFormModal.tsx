/**
 * =====================================================================================
 * ARQUIVO: src/features/schedules/components/ScheduleFormModal.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1B — Teto 5 min na Demo)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T05:30:00Z (UTC)
 * VERSÃO: v5.30.0
 * PROPÓSITO: Modal unificado para Criação e Edição de rotinas de irrigação automática,
 *            respeitando o limite de 5 minutos para sessões Demo e 15 minutos para o
 *            Operador Titular.
 * CHANGELOG:
 * - v5.30.0:
 *   * Na sessão Demo (`isDemoUser`), limita o slider a `max={5}`, garante valor inicial
 *     <= 5 min, exibe "Limite do Usuário Teste: 5 min por agenda" e valida com
 *     `validateScheduleDurationForCaller` antes de persistir.
 *   * Mantém o teto de 15 minutos inalterado para o Operador Titular.
 * - v5.25.0: [Auditoria 03]
 *   * Inclui `deviceId` na reinicialização do rascunho e suporte a `Escape` / ARIA.
 * =====================================================================================
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Clock,
  Tag,
  Loader2,
  AlertCircle,
  Check,
} from 'lucide-react';
import { useAuth } from '../../auth/hooks/useAuth';
import {
  createDeviceSchedule,
  updateDeviceSchedule,
} from '../api/scheduleRepository';
import { validateScheduleDurationForCaller } from '../model/schedule.schema';
import {
  DEMO_MAX_SCHEDULE_DURATION_MIN,
  OWNER_MAX_SCHEDULE_DURATION_MIN,
  ScheduleModel,
  WEEKDAYS_LIST,
} from '../model/schedule.types';
import { Dialog, useConfirm } from '../../../shared/ui';
import { scheduleFormSnapshot, type ScheduleFormValues } from '../model/scheduleForm';

interface ScheduleFormModalProps {
  isOpen: boolean;
  deviceId: string;
  scheduleToEdit: ScheduleModel | null;
  /** v5.38.0: "Duplicar" — abre como NOVO agendamento já preenchido com esta rotina. */
  prefill?: ScheduleModel | null;
  onClose: () => void;
}

export function ScheduleFormModal({
  isOpen,
  deviceId,
  scheduleToEdit,
  prefill = null,
  onClose,
}: ScheduleFormModalProps) {
  const { isDemoUser } = useAuth();
  const confirm = useConfirm();
  const initialSnap = useRef('');
  const isEditing = Boolean(scheduleToEdit);
  const maxDurationMinutes = isDemoUser
    ? DEMO_MAX_SCHEDULE_DURATION_MIN
    : OWNER_MAX_SCHEDULE_DURATION_MIN;

  const [label, setLabel] = useState('');
  const [time, setTime] = useState('08:00');
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [durationMinutes, setDurationMinutes] = useState<number>(
    Math.min(5, maxDurationMinutes),
  );
  const [isEnabled, setIsEnabled] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setErrorMsg(null);
    let v: ScheduleFormValues;
    if (scheduleToEdit) {
      v = { label: scheduleToEdit.label, time: scheduleToEdit.time, days: [...scheduleToEdit.days],
        durationMinutes: Math.max(1, Math.min(maxDurationMinutes, scheduleToEdit.durationMinutes)), isEnabled: scheduleToEdit.isEnabled };
    } else if (prefill) {
      v = { label: `${prefill.label} (cópia)`.slice(0, 80), time: prefill.time, days: [...prefill.days],
        durationMinutes: Math.max(1, Math.min(maxDurationMinutes, prefill.durationMinutes)), isEnabled: true };
    } else {
      v = { label: '', time: '08:00', days: [1, 2, 3, 4, 5], durationMinutes: Math.min(5, maxDurationMinutes), isEnabled: true };
    }
    setLabel(v.label);
    setTime(v.time);
    setSelectedDays(v.days);
    setDurationMinutes(v.durationMinutes);
    setIsEnabled(v.isEnabled);
    initialSnap.current = scheduleFormSnapshot(v);
  }, [isOpen, scheduleToEdit, prefill, deviceId, maxDurationMinutes]);

  // v5.47.0: fechar com alterações não salvas pergunta antes (Esc, clique fora, X, voltar).
  const requestClose = async () => {
    const dirty = scheduleFormSnapshot({ label, time, days: selectedDays, durationMinutes, isEnabled }) !== initialSnap.current;
    if (dirty) {
      const ok = await confirm({
        title: 'Descartar as alterações?',
        message: 'O que você mudou neste agendamento ainda não foi salvo.',
        confirmLabel: 'Descartar',
        cancelLabel: 'Continuar editando',
        tone: 'danger',
      });
      if (!ok) return;
    }
    onClose();
  };

  if (!isOpen) return null;

  const toggleDay = (day: number) => {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  };

  const applyPresetDays = (preset: number[]) => {
    setSelectedDays(preset);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!label.trim()) {
      setErrorMsg('Digite um nome para identificar a rotina de irrigação.');
      return;
    }
    if (selectedDays.length === 0) {
      setErrorMsg('Selecione pelo menos um dia da semana.');
      return;
    }

    let validatedDuration: number;
    try {
      validatedDuration = validateScheduleDurationForCaller(durationMinutes, isDemoUser);
    } catch (durErr: unknown) {
      setErrorMsg((durErr as Error)?.message || 'Duração inválida para o agendamento.');
      return;
    }

    const originDeviceId = deviceId;
    setIsSaving(true);
    try {
      const formPayload = {
        label: label.trim(),
        time,
        days: selectedDays,
        durationMinutes: validatedDuration,
        isEnabled,
      };

      if (isEditing && scheduleToEdit) {
        await updateDeviceSchedule(originDeviceId, scheduleToEdit.id, formPayload);
      } else {
        await createDeviceSchedule(originDeviceId, formPayload);
      }
      onClose();
    } catch (err: unknown) {
      const zodIssues = (err as { issues?: Array<{ message: string }> })?.issues;
      if (Array.isArray(zodIssues) && zodIssues.length > 0) {
        setErrorMsg(zodIssues[0].message);
      } else {
        setErrorMsg((err as Error)?.message || 'Falha ao salvar agendamento.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  // v5.46.0: janela padrão do design system; enquanto salva, não fecha por Esc nem clique fora
  return (
    <Dialog
      open
      onClose={requestClose}
      dismissible={!isSaving}
      eyebrow={isEditing ? 'Editar rotina' : 'Nova rotina'}
      title={isEditing ? 'Editar agendamento' : 'Novo agendamento'}
      description={<>Estação <strong>{deviceId}</strong> · horário de Brasília (UTC-3)</>}
    >
      <div>
        {errorMsg && (
          <div role="alert" className="mb-4 p-3.5 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs font-semibold text-danger">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* 1. Nome da Rotina */}
          <div>
            <label htmlFor="schedule-label-input" className="block text-xs font-bold text-ink mb-1.5">
              Nome da Rotina
            </label>
            <div className="relative">
              <Tag className="w-4 h-4 text-ink-muted absolute left-3.5 top-3" />
              <input
                id="schedule-label-input"
                type="text"
                maxLength={80}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ex: Irrigação Matinal da Horta"
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-line text-sm focus:outline-none focus:border-brand focus:ring-2 focus:ring-[#2E7D32]/15"
              />
            </div>
          </div>

          {/* 2. Horário de Início e Status Ativo/Pausado */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-3.5 rounded-xl bg-sunken/60 border border-line">
              <label htmlFor="schedule-time-input" className="block text-xs font-bold text-ink mb-1">
                Horário de Disparo (24h)
              </label>
              <div className="flex items-center gap-2 mt-1.5">
                <Clock className="w-4 h-4 text-brand" />
                <input
                  id="schedule-time-input"
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="flex-1 px-3 py-1.5 rounded-lg border border-line bg-surface text-base font-extrabold text-brand-strong focus:outline-none focus:border-brand"
                />
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-sunken/60 border border-line flex flex-col justify-between">
              <span className="text-xs font-bold text-ink">
                Status da Rotina
              </span>
              <label className="inline-flex items-center justify-between cursor-pointer mt-2">
                <span className="text-xs font-semibold text-ink-muted">
                  {isEnabled ? 'Ativo (Executar)' : 'Pausado'}
                </span>
                <input
                  type="checkbox"
                  checked={isEnabled}
                  onChange={(e) => setIsEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-10 h-5 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:bg-[#2E7D32] relative after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5" />
              </label>
            </div>
          </div>

          {/* 3. Dias da Semana + Atalhos Rápidos */}
          <div className="p-4 rounded-xl bg-sunken/50 border border-line space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-ink">
                Dias da Semana
              </span>
              <span className="text-xs font-bold text-brand">
                {selectedDays.length} selecionado(s)
              </span>
            </div>

            <div className="grid grid-cols-7 gap-1.5">
              {WEEKDAYS_LIST.map((w) => {
                const active = selectedDays.includes(w.day);
                return (
                  <button
                    key={w.day}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleDay(w.day)}
                    className={`py-2 rounded-xl text-xs font-bold border transition flex flex-col items-center justify-center gap-0.5 ${
                      active
                        ? 'bg-brand border-brand text-white shadow-xs'
                        : 'bg-surface border-line text-ink-muted hover:text-ink'
                    }`}
                  >
                    <span>{w.short}</span>
                    {active && <Check className="w-3 h-3" />}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-line">
              <button
                type="button"
                onClick={() => applyPresetDays([1, 2, 3, 4, 5, 6, 7])}
                className="px-2.5 py-1 rounded-lg bg-surface border border-line hover:border-brand text-xs font-semibold text-ink"
              >
                Todos os dias
              </button>
              <button
                type="button"
                onClick={() => applyPresetDays([1, 2, 3, 4, 5])}
                className="px-2.5 py-1 rounded-lg bg-surface border border-line hover:border-brand text-xs font-semibold text-ink"
              >
                Seg a Sex
              </button>
              <button
                type="button"
                onClick={() => applyPresetDays([6, 7])}
                className="px-2.5 py-1 rounded-lg bg-surface border border-line hover:border-brand text-xs font-semibold text-ink"
              >
                Fim de semana
              </button>
              <button
                type="button"
                onClick={() => applyPresetDays([])}
                className="px-2.5 py-1 rounded-lg bg-surface border border-line hover:border-red-300 text-xs font-semibold text-danger"
              >
                Limpar
              </button>
            </div>
          </div>

          {/* 4. Duração da Irrigação (1 a 5 min na Demo | 1 a 15 min para Titular) */}
          <div className="p-4 rounded-xl bg-sunken/50 border border-line space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <label htmlFor="schedule-duration-range" className="text-xs font-bold text-ink block">
                  Duração da Irrigação
                </label>
                <span className="text-xs text-ink-muted">
                  {isDemoUser
                    ? `Limite do Usuário Teste: ${DEMO_MAX_SCHEDULE_DURATION_MIN} min por agenda`
                    : `Limite físico de segurança no FreeRTOS: máximo de ${OWNER_MAX_SCHEDULE_DURATION_MIN} minutos`}
                </span>
              </div>
              <span className="px-3 py-1 rounded-full bg-brand-soft/70 text-brand-strong text-xs font-extrabold">
                {durationMinutes} min
              </span>
            </div>

            <input
              id="schedule-duration-range"
              type="range"
              min={1}
              max={maxDurationMinutes}
              step={1}
              value={durationMinutes}
              onChange={(e) =>
                setDurationMinutes(
                  Math.max(1, Math.min(maxDurationMinutes, Number(e.target.value))),
                )
              }
              className="w-full accent-[#2E7D32] cursor-pointer"
            />
            {isDemoUser ? (
              <div className="flex justify-between text-[11px] font-semibold text-ink-muted">
                <span>1 min</span>
                <span>2 min</span>
                <span>3 min</span>
                <span>4 min</span>
                <span>5 min (Máx)</span>
              </div>
            ) : (
              <div className="flex justify-between text-[11px] font-semibold text-ink-muted">
                <span>1 min</span>
                <span>5 min</span>
                <span>10 min</span>
                <span>15 min (Máx)</span>
              </div>
            )}
          </div>

          {/* Botões de Ação */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
            <button
              type="button"
              onClick={requestClose}
              className="px-4 py-2.5 rounded-xl text-xs font-bold text-ink-muted hover:bg-sunken"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className={`px-5 py-2.5 rounded-xl text-xs font-bold text-white transition flex items-center gap-2 disabled:opacity-50 ${
                isEditing
                  ? 'bg-[#F57C00] hover:bg-amber-700'
                  : 'bg-brand hover:bg-brand-strong'
              }`}
            >
              {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{isEditing ? 'Salvar alterações' : 'Criar agendamento'}</span>
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
