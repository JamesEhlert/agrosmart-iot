/**
 * =====================================================================================
 * ARQUIVO: src/features/schedules/components/ScheduleList.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T20:30:00Z (UTC)
 * VERSÃO: v5.38.0
 * PROPÓSITO: Agendamentos semanais da estação em tempo real: resumo, filtros, ordem pela
 *            próxima execução, visão semanal, conflitos, duplicar e pausar/ativar todas,
 *            com as proteções da Demo compatíveis com `firestore.rules`.
 * CHANGELOG:
 * - v5.38.0 (F1.2 / SCH-01): resumo (ativas, próxima rega, minutos por semana, limite);
 *   filtros Todas/Ativas/Pausadas e busca; ordem "Próxima execução" ou "Horário"; visão
 *   Lista/Semana; aviso de regas sobrepostas; "Duplicar"; "Pausar todas"/"Ativar todas"
 *   (titular); limite do titular 20; exclusão com confirmação própria (sem window.confirm).
 * - v5.30.0: contador X/5 da Demo, exclusão só das agendas da própria sessão, isolamento
 *   por sessão.
 * =====================================================================================
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Clock,
  Plus,
  Edit3,
  Trash2,
  CalendarClock,
  Droplets,
  AlertCircle,
  AlertTriangle,
  Lock,
  ShieldCheck,
  Copy,
  Search,
  X,
  List as ListIcon,
  CalendarDays,
  PauseCircle,
  PlayCircle,
  Timer,
} from 'lucide-react';
import { useAuth } from '../../auth/hooks/useAuth';
import { DeviceModel } from '../../devices/model/device.types';
import {
  deleteDeviceSchedule,
  subscribeToDeviceSchedules,
  toggleDeviceScheduleEnabled,
} from '../api/scheduleRepository';
import {
  DEMO_MAX_SCHEDULES_PER_SESSION,
  formatScheduleDaysSummary,
  OWNER_MAX_SCHEDULES,
  ScheduleModel,
  WEEKDAYS_LIST,
} from '../model/schedule.types';
import {
  countOwnerSchedules,
  filterSchedules,
  findConflicts,
  formatNextRunDay,
  formatRelative,
  minutesPerWeekday,
  nextRunOf,
  parseHHMM,
  ScheduleSortMode,
  ScheduleStatusFilter,
  sortSchedules,
  stationClock,
} from '../model/scheduleInsights';
import { ScheduleFormModal } from './ScheduleFormModal';
import { InfoTip } from '../../../shared/ui/InfoTip';
import { Button, Dialog } from '../../../shared/ui';
import { useConfirm } from '../../../shared/ui/Feedback.providers';

interface ScheduleListProps {
  device: DeviceModel;
}

type ViewMode = 'list' | 'week';

/** Relógio que avança a cada minuto (próxima execução sempre atual). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function formatMinutes(total: number): string {
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function ScheduleList({ device }: ScheduleListProps) {
  const confirm = useConfirm();
  const { isDemoUser, demoSessionId } = useAuth();
  const tz = device.settings.timezoneOffset;
  const nowMs = useMinuteClock();

  const [schedules, setSchedules] = useState<ScheduleModel[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleModel | null>(null);
  const [prefillSchedule, setPrefillSchedule] = useState<ScheduleModel | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduleModel | null>(null);
  const [bulkBusy, setBulkBusy] = useState<boolean>(false);

  const [status, setStatus] = useState<ScheduleStatusFilter>('all');
  const [query, setQuery] = useState<string>('');
  const [sortMode, setSortMode] = useState<ScheduleSortMode>('next');
  const [view, setView] = useState<ViewMode>('list');

  useEffect(() => {
    setSchedules([]);
    setIsModalOpen(false);
    setEditingSchedule(null);
    setPrefillSchedule(null);
    setIsLoading(true);
    setErrorMsg(null);

    const unsubscribe = subscribeToDeviceSchedules(
      device.id,
      (items) => {
        setSchedules(items);
        setIsLoading(false);
      },
      (err) => {
        setErrorMsg(err.message || 'Falha ao escutar agendamentos no Firestore.');
        setIsLoading(false);
      },
    );

    return () => unsubscribe();
  }, [device.id]);

  const isScheduleEditableByCaller = (sched: ScheduleModel): boolean => {
    if (!isDemoUser) return true;
    return Boolean(sched.createdByDemo && demoSessionId && sched.demoSessionId === demoSessionId);
  };

  const demoSessionScheduleCount = isDemoUser
    ? schedules.filter((s) => Boolean(s.createdByDemo && demoSessionId && s.demoSessionId === demoSessionId)).length
    : 0;
  const ownerCount = countOwnerSchedules(schedules);

  const isDemoSlotLimitReached = isDemoUser && demoSessionScheduleCount >= DEMO_MAX_SCHEDULES_PER_SESSION;
  const isOwnerLimitReached = !isDemoUser && ownerCount >= OWNER_MAX_SCHEDULES;
  const createBlocked = isDemoSlotLimitReached || isOwnerLimitReached;
  const limitText = isDemoUser
    ? `Limite de ${DEMO_MAX_SCHEDULES_PER_SESSION} agendamentos nesta sessão atingido. Exclua um dos seus para criar outro.`
    : `Limite de ${OWNER_MAX_SCHEDULES} agendamentos atingido. Exclua ou reaproveite uma rotina para criar outra.`;

  // ---------- Derivados ----------
  const conflicts = useMemo(() => findConflicts(schedules), [schedules]);
  const perDay = useMemo(() => minutesPerWeekday(schedules), [schedules]);
  const weeklyMinutes = perDay.reduce((a, b) => a + b, 0);
  const activeCount = schedules.filter((s) => s.isEnabled).length;
  const pausedCount = schedules.length - activeCount;
  const nextOverall = useMemo(() => {
    let best: { s: ScheduleModel; run: NonNullable<ReturnType<typeof nextRunOf>> } | null = null;
    for (const s of schedules) {
      const run = nextRunOf(s, nowMs, tz);
      if (run && (!best || run.inMinutes < best.run.inMinutes)) best = { s, run };
    }
    return best;
  }, [schedules, nowMs, tz]);

  const visible = useMemo(
    () => sortSchedules(filterSchedules(schedules, status, query), sortMode, nowMs, tz),
    [schedules, status, query, sortMode, nowMs, tz],
  );
  const labelOf = (id: string) => schedules.find((s) => s.id === id)?.label ?? 'outra rotina';
  const today = stationClock(nowMs, tz).weekday;

  // ---------- Ações ----------
  const blockedMessage = (sched: ScheduleModel, action: 'toggle' | 'edit' | 'delete') => {
    const fromOld = sched.createdByDemo;
    if (action === 'toggle') {
      return fromOld
        ? 'Modo Usuário Teste: esta rotina pertence a uma sessão de teste anterior e está protegida. Crie um "Novo agendamento" para testar.'
        : 'Modo Usuário Teste: as rotinas do administrador são protegidas. Crie um "Novo agendamento" para testar ativar, pausar e editar.';
    }
    if (action === 'edit') {
      return fromOld
        ? 'Modo Usuário Teste: rotinas de sessões anteriores são protegidas contra edição. Crie um "Novo agendamento".'
        : 'Modo Usuário Teste: as rotinas do administrador são protegidas contra edição. Crie um "Novo agendamento" para testar.';
    }
    return fromOld
      ? 'Modo Usuário Teste: rotinas de sessões anteriores são protegidas. Você pode excluir só as criadas nesta sessão.'
      : 'Modo Usuário Teste: as rotinas do administrador são protegidas. Você pode excluir só as criadas nesta sessão.';
  };

  const openCreate = (prefill: ScheduleModel | null = null) => {
    setErrorMsg(null);
    if (createBlocked) {
      setErrorMsg(limitText);
      return;
    }
    setEditingSchedule(null);
    setPrefillSchedule(prefill);
    setIsModalOpen(true);
  };

  const handleToggle = async (sched: ScheduleModel) => {
    setErrorMsg(null);
    if (!isScheduleEditableByCaller(sched)) {
      setErrorMsg(blockedMessage(sched, 'toggle'));
      return;
    }
    try {
      await toggleDeviceScheduleEnabled(device.id, sched.id, !sched.isEnabled);
    } catch (err: unknown) {
      setErrorMsg((err as Error)?.message || 'Não foi possível alterar o status da rotina.');
    }
  };

  const handleEditClick = (sched: ScheduleModel) => {
    setErrorMsg(null);
    if (!isScheduleEditableByCaller(sched)) {
      setErrorMsg(blockedMessage(sched, 'edit'));
      return;
    }
    setPrefillSchedule(null);
    setEditingSchedule(sched);
    setIsModalOpen(true);
  };

  const askDelete = (sched: ScheduleModel) => {
    setErrorMsg(null);
    if (!isScheduleEditableByCaller(sched)) {
      setErrorMsg(blockedMessage(sched, 'delete'));
      return;
    }
    setPendingDelete(sched);
  };

  const confirmDelete = async () => {
    const sched = pendingDelete;
    if (!sched) return;
    setPendingDelete(null);
    try {
      await deleteDeviceSchedule(device.id, sched.id);
      setNotice(`Agendamento "${sched.label}" excluído.`);
    } catch (err: unknown) {
      setErrorMsg((err as Error)?.message || 'Falha ao excluir agendamento.');
    }
  };

  /** Titular: pausa ou ativa todas as rotinas de uma vez (ex.: férias, época de chuva). */
  const bulkSet = async (enabled: boolean) => {
    const targets = schedules.filter((s) => s.isEnabled !== enabled && isScheduleEditableByCaller(s));
    if (targets.length === 0) return;
    // v5.46.0: ação em lote pergunta antes (mexe em várias rotinas de uma vez)
    const ok = await confirm({
      title: enabled ? `Ativar ${targets.length} agendamento(s)?` : `Pausar ${targets.length} agendamento(s)?`,
      message: enabled
        ? 'As rotinas voltam a irrigar nos horários programados (a IA climática continua pulando regas com chuva prevista).'
        : 'Nenhuma dessas rotinas vai irrigar até você ativá-las de novo. A irrigação manual continua disponível.',
      confirmLabel: enabled ? 'Ativar todas' : 'Pausar todas',
      tone: enabled ? 'primary' : 'danger',
    });
    if (!ok) return;
    setBulkBusy(true);
    setErrorMsg(null);
    let failed = 0;
    for (const s of targets) {
      try {
        await toggleDeviceScheduleEnabled(device.id, s.id, enabled);
      } catch {
        failed += 1;
      }
    }
    setBulkBusy(false);
    setNotice(
      failed
        ? `${targets.length - failed} de ${targets.length} rotina(s) ${enabled ? 'ativadas' : 'pausadas'}; ${failed} falharam.`
        : `${targets.length} rotina(s) ${enabled ? 'ativadas' : 'pausadas'}.`,
    );
  };

  // ---------- Componentes internos ----------
  const statusChips: Array<{ key: ScheduleStatusFilter; label: string; n: number }> = [
    { key: 'all', label: 'Todas', n: schedules.length },
    { key: 'active', label: 'Ativas', n: activeCount },
    { key: 'paused', label: 'Pausadas', n: pausedCount },
  ];

  const renderCard = (sched: ScheduleModel) => {
    const isProtected = !isScheduleEditableByCaller(sched);
    const isFromOtherDemoSession = Boolean(isDemoUser && sched.createdByDemo && isProtected);
    const run = nextRunOf(sched, nowMs, tz);
    const conflictWith = conflicts.get(sched.id) ?? [];
    return (
      <div
        key={sched.id}
        className={`bg-white rounded-2xl border p-3.5 sm:p-5 shadow-sm transition flex flex-col justify-between gap-3 sm:gap-4 ${
          conflictWith.length > 0 ? 'border-amber-300' : 'border-line'
        } ${sched.isEnabled ? '' : 'bg-slate-50/70'}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 sm:gap-3.5 min-w-0">
            <div
              className={`px-2.5 py-1.5 sm:px-3.5 sm:py-2 rounded-xl font-extrabold text-base sm:text-xl tracking-tight tabular-nums shrink-0 flex items-center gap-1.5 ${
                sched.isEnabled ? 'bg-brand-soft/55 text-brand-strong' : 'bg-sunken text-ink-muted'
              }`}
            >
              <Clock className="hidden sm:block w-4 h-4" />
              <span>{sched.time}</span>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <h3 className={`text-sm font-bold truncate ${sched.isEnabled ? 'text-ink' : 'text-ink-muted'}`}>{sched.label}</h3>
                <span
                  className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                    sched.isEnabled ? 'bg-emerald-100 text-brand' : 'bg-slate-200 text-ink-muted'
                  }`}
                >
                  {sched.isEnabled ? 'Ativa' : 'Pausada'}
                </span>
                {sched.createdByDemo ? (
                  <span
                    className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                      isFromOtherDemoSession ? 'bg-slate-200 text-ink-muted' : 'bg-amber-100 text-warning'
                    }`}
                  >
                    {isFromOtherDemoSession ? 'Sessão anterior' : 'Sessão teste'}
                  </span>
                ) : (
                  isDemoUser && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-50 text-info">
                      <ShieldCheck className="w-3 h-3" />
                      Fixa do admin
                    </span>
                  )
                )}
              </div>
              <p className="text-xs text-ink-muted mt-0.5 truncate">{formatScheduleDaysSummary(sched.days)}</p>
              <p className={`text-xs mt-0.5 font-semibold ${run ? 'text-brand-strong' : 'text-ink-muted'}`}>
                {run ? `Próxima: ${formatNextRunDay(run, nowMs, tz)} · ${formatRelative(run.inMinutes)}` : 'Não será executada'}
              </p>
            </div>
          </div>

          <label
            onClick={() => {
              if (isProtected) handleToggle(sched);
            }}
            className={`inline-flex items-center shrink-0 ${isProtected ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
            title={isProtected ? 'Rotina protegida no Modo Teste' : sched.isEnabled ? 'Pausar rotina' : 'Ativar rotina'}
          >
            <input
              type="checkbox"
              checked={sched.isEnabled}
              disabled={isProtected}
              onChange={() => handleToggle(sched)}
              className="sr-only peer"
              aria-label={sched.isEnabled ? `Pausar ${sched.label}` : `Ativar ${sched.label}`}
            />
            <div className="w-10 h-5 bg-slate-300 rounded-full peer peer-checked:bg-[#2E7D32] relative after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5" />
          </label>
        </div>

        {conflictWith.length > 0 && (
          <p className="flex items-start gap-1.5 text-xs font-semibold text-warning-strong bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>
              Sobrepõe com {conflictWith.map(labelOf).join(', ')} em algum dia: a segunda rega pode começar com a válvula ainda aberta.{' '}
              <InfoTip k="sobreposicao" align="right" />
            </span>
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-line">
          <div className="flex items-center gap-1">
            {WEEKDAYS_LIST.map((w) => {
              const active = sched.days.includes(w.day);
              return (
                <span
                  key={w.day}
                  title={w.full}
                  className={`w-6 h-6 rounded-lg text-[11px] font-bold flex items-center justify-center ${
                    active ? (sched.isEnabled ? 'bg-brand text-white' : 'bg-slate-400 text-white') : 'bg-sunken text-ink-muted'
                  } ${w.day === today ? 'ring-2 ring-offset-1 ring-[#2E7D32]/40' : ''}`}
                >
                  {w.short[0]}
                </span>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-50 text-info text-xs font-bold">
              <Droplets className="w-3.5 h-3.5" />
              {sched.durationMinutes} min
            </span>
            {!isProtected && (
              <button
                type="button"
                onClick={() => openCreate(sched)}
                disabled={createBlocked}
                title={createBlocked ? limitText : 'Duplicar (abre um novo agendamento já preenchido)'}
                aria-label={`Duplicar agendamento ${sched.label}`}
                className="p-2 rounded-lg border border-line text-ink-muted hover:text-ink hover:bg-sunken transition disabled:opacity-40"
              >
                <Copy className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => handleEditClick(sched)}
              title={isProtected ? 'Rotina protegida (crie um novo agendamento nesta sessão para testar a edição)' : 'Editar agendamento'}
              aria-label={`Editar agendamento ${sched.label}`}
              className={`p-2 rounded-lg border transition ${
                isProtected
                  ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'border-line text-ink-muted hover:text-ink hover:bg-sunken'
              }`}
            >
              {isProtected ? <Lock className="w-4 h-4" /> : <Edit3 className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => askDelete(sched)}
              title={isProtected ? 'Rotina protegida (no Modo Teste você exclui só as criadas nesta sessão)' : 'Excluir agendamento'}
              aria-label={`Excluir agendamento ${sched.label}`}
              className={`p-2 rounded-lg border transition ${
                isProtected ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed' : 'border-line text-danger hover:bg-red-50'
              }`}
            >
              {isProtected ? <Lock className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderWeek = () => (
    <div className="bg-surface rounded-2xl border border-line shadow-sm overflow-x-auto">
      <div className="grid grid-cols-7 min-w-[760px] divide-x divide-line">
        {WEEKDAYS_LIST.map((w, idx) => {
          const items = visible
            .filter((s) => s.days.includes(w.day))
            .sort((a, b) => (parseHHMM(a.time) ?? 0) - (parseHHMM(b.time) ?? 0));
          const isToday = w.day === today;
          return (
            <div key={w.day} className={isToday ? 'bg-brand-soft/15' : ''}>
              <div className={`px-3 py-2.5 border-b border-[#E0E6ED] ${isToday ? 'bg-brand-soft/50' : 'bg-sunken/60'}`}>
                <p className={`text-xs font-extrabold ${isToday ? 'text-brand-strong' : 'text-ink'}`}>
                  {w.short}
                  {isToday && <span className="ml-1.5 text-[11px] font-bold uppercase">hoje</span>}
                </p>
                <p className="text-[11px] font-semibold text-ink-muted">{perDay[idx] ? `${formatMinutes(perDay[idx])} de rega` : 'sem rega'}</p>
              </div>
              <div className="p-2 space-y-1.5 min-h-[120px]">
                {items.length === 0 && <p className="text-[11px] text-center text-[#78909C] pt-6">—</p>}
                {items.map((s) => {
                  const conflict = (conflicts.get(s.id) ?? []).length > 0;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleEditClick(s)}
                      title={`${s.label} · ${s.time} · ${s.durationMinutes} min${s.isEnabled ? '' : ' · pausada'}${conflict ? ' · sobreposta' : ''}`}
                      className={`w-full text-left rounded-lg px-2 py-1.5 border text-xs leading-tight transition hover:shadow-sm ${
                        !s.isEnabled
                          ? 'bg-slate-50 border-slate-200 text-ink-muted'
                          : conflict
                            ? 'bg-amber-50 border-amber-300 text-warning-strong'
                            : 'bg-brand-soft/45 border-brand/25 text-brand-strong'
                      }`}
                    >
                      <span className="font-extrabold">{s.time}</span>
                      <span className="opacity-80"> · {s.durationMinutes} min</span>
                      <span className="block truncate font-semibold">{s.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* 1. Resumo */}
      <div className="bg-surface rounded-2xl border border-line p-4 shadow-sm space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-sm font-bold text-ink">Rotinas semanais programadas</h2>
            <p className="text-xs text-ink-muted">
              Conferidas a cada minuto na nuvem, no horário da estação ·{' '}
              {device.settings.enableWeatherControl ? 'IA climática ativa (pula a rega se houver chuva prevista)' : 'IA climática desativada'}{' '}
              <InfoTip k="iaClimatica" />
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              disabled={createBlocked}
              title={createBlocked ? limitText : 'Criar novo agendamento'}
              onClick={() => openCreate(null)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand hover:bg-brand-strong text-white text-xs font-bold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="w-4 h-4" />
              <span>Novo agendamento</span>
            </button>
            {createBlocked && <span className="text-xs font-semibold text-warning text-right max-w-[260px]">{limitText}</span>}
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-xl bg-sunken/70 p-3">
            <p className="text-xs font-bold text-ink-muted">Ativas</p>
            <p className="text-lg font-extrabold text-ink">
              {activeCount}
              <span className="text-xs font-bold text-ink-muted"> de {schedules.length}</span>
            </p>
          </div>
          <div className="rounded-xl bg-brand-soft/40 p-3 col-span-2 lg:col-span-1 order-first lg:order-none">
            <p className="text-xs font-bold text-brand-strong inline-flex items-center gap-1">
              <Timer className="w-3.5 h-3.5" /> Próxima rega <InfoTip k="proximaRega" align="left" />
            </p>
            {nextOverall ? (
              <>
                <p className="text-lg font-extrabold text-brand-strong leading-tight">{formatNextRunDay(nextOverall.run, nowMs, tz)}</p>
                <p className="text-xs font-semibold text-brand-strong/80 truncate">
                  {nextOverall.s.label} · {formatRelative(nextOverall.run.inMinutes)}
                </p>
              </>
            ) : (
              <p className="text-sm font-bold text-ink-muted">Nenhuma rotina ativa</p>
            )}
          </div>
          <div className="rounded-xl bg-sunken/70 p-3">
            <p className="text-xs font-bold text-ink-muted">Rega por semana</p>
            <p className="text-lg font-extrabold text-ink">{formatMinutes(weeklyMinutes)}</p>
          </div>
          <div className="rounded-xl bg-sunken/70 p-3 col-span-2 lg:col-span-1">
            <p className="text-xs font-bold text-ink-muted">
              {isDemoUser ? 'Suas vagas nesta sessão' : 'Limite da estação'} <InfoTip k="limiteAgendas" align="right" />
            </p>
            <p className={`text-lg font-extrabold ${createBlocked ? 'text-warning' : 'text-ink'}`}>
              {isDemoUser ? demoSessionScheduleCount : ownerCount}
              <span className="text-xs font-bold text-ink-muted"> / {isDemoUser ? DEMO_MAX_SCHEDULES_PER_SESSION : OWNER_MAX_SCHEDULES}</span>
            </p>
          </div>
        </div>
      </div>

      {/* 2. Filtros e visão */}
      {schedules.length > 0 && (
        <div className="bg-surface rounded-2xl border border-line p-3 shadow-sm flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 w-full sm:w-auto">
            <div className="flex rounded-xl bg-sunken p-1 overflow-x-auto max-w-full" role="group" aria-label="Situação">
              {statusChips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={status === c.key}
                  onClick={() => setStatus(c.key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition whitespace-nowrap ${
                    status === c.key ? 'bg-surface text-brand shadow-sm' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {c.label} <span className="opacity-70">{c.n}</span>
                </button>
              ))}
            </div>
            <label className="relative w-full sm:w-auto">
              <span className="sr-only">Buscar rotina por nome ou horário</span>
              <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                inputMode="search"
                autoComplete="off"
                maxLength={80}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por nome ou horário"
                className="w-full sm:w-56 pl-9 pr-8 py-2 rounded-xl border border-line text-xs focus:outline-none focus:border-brand"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Limpar busca"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-ink-muted hover:bg-sunken"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between sm:justify-end gap-2 w-full sm:w-auto">
            {view === 'list' && (
              <label className="text-xs font-bold text-ink-muted inline-flex items-center gap-1.5">
                Ordem
                <select
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as ScheduleSortMode)}
                  className="px-2.5 py-1.5 rounded-lg border border-line bg-surface text-xs font-bold text-ink focus:outline-none focus:border-brand"
                >
                  <option value="next">Próxima execução</option>
                  <option value="time">Horário do dia</option>
                </select>
              </label>
            )}
            <div className="flex rounded-xl bg-sunken p-1" role="group" aria-label="Visualização">
              {(
                [
                  { key: 'list', label: 'Lista', icon: <ListIcon className="w-3.5 h-3.5" /> },
                  { key: 'week', label: 'Semana', icon: <CalendarDays className="w-3.5 h-3.5" /> },
                ] as const
              ).map((v) => (
                <button
                  key={v.key}
                  type="button"
                  aria-pressed={view === v.key}
                  onClick={() => setView(v.key)}
                  className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                    view === v.key ? 'bg-surface text-brand shadow-sm' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {v.icon}
                  {v.label}
                </button>
              ))}
            </div>
            {!isDemoUser && (
              <>
                {activeCount > 0 && (
                  <button
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => bulkSet(false)}
                    title="Pausa todas as rotinas (ex.: férias ou época de chuva). Dá para ativar de novo depois."
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-line text-xs font-bold text-ink-muted hover:text-ink hover:bg-sunken disabled:opacity-50"
                  >
                    <PauseCircle className="w-3.5 h-3.5" />
                    Pausar todas
                  </button>
                )}
                {pausedCount > 0 && (
                  <button
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => bulkSet(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-brand/40 text-xs font-bold text-brand hover:bg-brand-soft/30 disabled:opacity-50"
                  >
                    <PlayCircle className="w-3.5 h-3.5" />
                    Ativar todas
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {notice && (
        <div className="p-3 rounded-xl bg-brand-soft/40 border border-brand/30 flex items-center justify-between gap-2 text-xs font-semibold text-brand-strong">
          <span>{notice}</span>
          <button type="button" aria-label="Fechar aviso" onClick={() => setNotice(null)} className="p-1 rounded-md hover:bg-white/60">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {errorMsg && (
        <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-center gap-2.5 text-xs font-semibold text-warning">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {conflicts.size > 0 && (
        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-center gap-2.5 text-xs font-semibold text-warning-strong">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            {conflicts.size} rotina(s) ativas se sobrepõem em algum dia. Ajuste o horário ou a duração para uma rega não começar durante a outra.
          </span>
        </div>
      )}

      {/* 3. Conteúdo */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-surface rounded-2xl border border-line p-5 animate-pulse space-y-3">
              <div className="flex gap-3">
                <div className="w-24 h-10 rounded-xl bg-sunken" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-2/3 rounded bg-sunken" />
                  <div className="h-3 w-1/2 rounded bg-sunken" />
                </div>
              </div>
              <div className="h-6 rounded bg-sunken" />
            </div>
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <div className="bg-surface rounded-2xl border border-line p-10 text-center shadow-sm">
          <div className="inline-flex p-4 rounded-full bg-brand-soft/40 text-brand mb-3">
            <CalendarClock className="w-9 h-9" />
          </div>
          <h3 className="text-base font-bold text-ink">Nenhuma rotina automática cadastrada</h3>
          <p className="text-xs text-ink-muted mt-1 max-w-md mx-auto leading-relaxed">
            Programe horários e dias da semana para o AgroSmart irrigar sozinho quando o solo estiver abaixo da meta de
            umidade ({device.settings.targetMoisture}%).
          </p>
          <button
            type="button"
            disabled={createBlocked}
            onClick={() => openCreate(null)}
            className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand hover:bg-brand-strong text-white text-xs font-bold transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            <span>Criar primeiro agendamento</span>
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-surface rounded-2xl border border-line p-10 text-center shadow-sm space-y-3">
          <p className="text-sm font-bold text-ink">Nenhuma rotina combina com o filtro</p>
          <button
            type="button"
            onClick={() => {
              setStatus('all');
              setQuery('');
            }}
            className="px-4 py-2 rounded-xl border border-line text-xs font-bold text-brand hover:bg-sunken"
          >
            Limpar filtros
          </button>
        </div>
      ) : view === 'week' ? (
        renderWeek()
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{visible.map(renderCard)}</div>
      )}

      {/* Confirmação de exclusão — v5.46.0: janela padrão (foco preso, Esc, folha no celular) */}
      <Dialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        size="sm"
        title="Excluir agendamento?"
        footer={<>
          <Button variant="ghost" onClick={() => setPendingDelete(null)}>Cancelar</Button>
          <Button variant="danger" icon={<Trash2 className="w-4 h-4" />} onClick={confirmDelete}>Excluir</Button>
        </>}
      >
        {pendingDelete && (
          <p className="text-sm text-ink leading-relaxed">
            “{pendingDelete.label}” às {pendingDelete.time} ({formatScheduleDaysSummary(pendingDelete.days)}). Esta ação não pode ser desfeita;
            para parar só por um tempo, use “Pausar”.
          </p>
        )}
      </Dialog>

      <ScheduleFormModal
        isOpen={isModalOpen}
        deviceId={device.id}
        scheduleToEdit={editingSchedule}
        prefill={prefillSchedule}
        onClose={() => setIsModalOpen(false)}
      />
    </div>
  );
}
