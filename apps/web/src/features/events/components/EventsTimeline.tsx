/**
 * =====================================================================================
 * ARQUIVO: src/features/events/components/EventsTimeline.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T19:30:00Z (UTC)
 * VERSÃO: v5.37.0
 * PROPÓSITO: Linha do tempo paginada de auditoria, alertas de segurança e eventos OTA,
 *            agora como página própria "Logs & Auditoria".
 * CHANGELOG:
 * - v5.39.0 (F1.5): dica sob os filtros enquanto as categorias ainda não foram contadas.
 * - v5.37.0 (WEB-12): paginação de verdade (páginas de 50, Anterior/Próxima, "Página X de Y"),
 *            intervalo de datas ("Datas…", Este mês, Mês passado) e ordem Recentes/Antigos
 *            no servidor; filtro de categoria/busca sobre o período inteiro (varredura em
 *            lotes com progresso e contagem exata por categoria); busca exata por número
 *            de operação; rodapé claro. Motor em hooks/useLogBrowser.ts.
 * - v5.36.1: com filtro ativo e poucos resultados, procura sozinho em registros mais
 *            antigos (até 600 por vez) e mostra quantos foram verificados.
 * - v5.36.0: período filtrado no servidor (24 h / 7 dias / 30 dias / tudo), 9 categorias,
 *            busca por texto, seleção múltipla e exclusão (titular), limpeza de antigos,
 *            alerta de segurança com destaque vermelho (WEB-04) e cadeado nos alertas
 *            protegidos por 30 dias.
 * - v5.25.0: [Auditoria 03]
 *            1. Prioridade de estilo de falha (`log.type === 'error' || log.result === 'failed'`)
 *               avaliada ANTES de `ota_*` ou `config_*`, impedindo que erros OTA ou
 *               calibração inválida apareçam em verde;
 *            2. Fecha `selectedLog` automaticamente ao trocar de estação (`device.id`).
 * =====================================================================================
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CloudLightning,
  CloudRain,
  Droplets,
  Cpu,
  AlertCircle,
  SkipForward,
  Hand,
  Timer,
  CloudOff,
  Info,
  RefreshCw,
  ChevronRight,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  CalendarDays,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Sliders,
  RotateCcw,
  ShieldAlert,
  Monitor,
  ZapOff,
  Search,
  Lock,
  Trash2,
  Eraser,
  X,
} from 'lucide-react';
import { DeviceModel } from '../../devices/model/device.types';
import {
  countActivityLogsOlderThan,
  deleteActivityLogs,
  deleteActivityLogsOlderThan,
} from '../api/eventRepository';
import {
  ActivityLogModel,
  formatLogMessageDuration,
  PROTECTIVE_EVENT_REASONS,
} from '../model/event.types';
import {
  isDeletionProtected,
  isSecurityLog,
  LOG_CATEGORIES,
  LogCategoryKey,
  protectionDaysLeft,
} from '../model/logFilters';
import {
  CustomRangeInput,
  formatCount,
  LogOrder,
  LogRangeKey,
  RANGE_OPTIONS,
  resolveLogRange,
  SCAN_MAX_DOCS,
  serverRangeLabel,
  stationIsoDay,
  stationMonthBounds,
} from '../model/logQuery';
import { useLogBrowser } from '../hooks/useLogBrowser';
import { CleanupOlderModal, DeleteSelectedModal } from './LogMaintenanceModals';
import { formatWithDeviceTimezone } from '../../../shared/lib/formatters';
import { classifyAuditEvent, auditEventSource } from '../model/auditPresentation';
import { EventAuditModal } from './EventAuditModal';
import { scrollBehavior } from '../../../shared/lib/motion';

interface EventsTimelineProps {
  device: DeviceModel;
  /** Titular: pode selecionar e excluir. Demo: somente leitura. */
  canManage?: boolean;
}


function getEventBadgeStyle(log: ActivityLogModel): {
  bg: string;
  text: string;
  icon: React.ReactNode;
} {
  const r = (log.reason ?? '').toLowerCase();

  // v5.36.0 (WEB-04): comando sem registro no servidor = alerta de segurança em vermelho.
  if (isSecurityLog(log)) {
    return { bg: 'bg-red-100', text: 'text-danger', icon: <ShieldAlert className="w-4 h-4" /> };
  }

  const classification = classifyAuditEvent(log);
  switch (classification) {
    case 'unconfirmed':
      return { bg: 'bg-amber-100', text: 'text-amber-800', icon: <AlertCircle className="w-4 h-4" /> };
    case 'weather_sensor':
      return { bg: 'bg-blue-100', text: 'text-blue-800', icon: <CloudRain className="w-4 h-4" /> };
    case 'weather_forecast':
      return { bg: 'bg-amber-100', text: 'text-amber-800', icon: <CloudOff className="w-4 h-4" /> };
    case 'wet_soil':
      return { bg: 'bg-amber-100', text: 'text-amber-800', icon: <Droplets className="w-4 h-4" /> };
    case 'waiting':
    case 'started':
      return { bg: 'bg-blue-100', text: 'text-blue-800', icon: <Timer className="w-4 h-4" /> };
  }

  if (r === 'ota_rollback') {
    return {
      bg: 'bg-red-100',
      text: 'text-danger',
      icon: <RotateCcw className="w-4 h-4" />,
    };
  }
  // AGRO_E1: recusa de proteção (anti-rajada etc.) é aviso, não falha da estação.
  if (PROTECTIVE_EVENT_REASONS.has(r)) {
    return {
      bg: 'bg-amber-100',
      text: 'text-warning',
      icon: <ShieldAlert className="w-4 h-4" />,
    };
  }
  // Avalia falha ou erro ANTES dos prefixos de família (OTA/Config) para nunca pintar falha de verde
  if (
    log.type === 'error' ||
    log.result === 'failed' ||
    r === 'invalid_calibration' ||
    r === 'ota_hash_mismatch' ||
    r === 'ota_http_failed' ||
    r === 'ota_flash_error'
  ) {
    return {
      bg: 'bg-red-100',
      text: 'text-danger',
      icon: <AlertCircle className="w-4 h-4" />,
    };
  }
  if (r === 'rain_interlock') {
    return {
      bg: 'bg-amber-100',
      text: 'text-warning',
      icon: <CloudLightning className="w-4 h-4" />,
    };
  }
  if (r === 'power_loss_reset' || r === 'ota_power_loss') {
    return {
      bg: 'bg-amber-100',
      text: 'text-warning',
      icon: <ZapOff className="w-4 h-4" />,
    };
  }
  // v5.41.0: botões físicos da estação (irrigação e display) e ajustes do display.
  if (log.type === 'local_action' || log.source === 'local_button') {
    return {
      bg: 'bg-[#E0F2F1]',
      text: 'text-[#00695C]',
      icon: (log.details?.local_kind === 'disp') ? <Monitor className="w-4 h-4" /> : <Hand className="w-4 h-4" />,
    };
  }
  if (r === 'display_updated' || r === 'buttons_updated' || r === 'local_config_updated') {
    return {
      bg: 'bg-brand-soft/60',
      text: 'text-brand-strong',
      icon: <Monitor className="w-4 h-4" />,
    };
  }
  if (r === 'config_updated') {
    return {
      bg: 'bg-brand-soft/60',
      text: 'text-brand-strong',
      icon: <Sliders className="w-4 h-4" />,
    };
  }
  if (r.startsWith('ota_') || log.type === 'ota_verification') {
    return {
      bg: 'bg-brand-soft/60',
      text: 'text-brand-strong',
      icon: <Cpu className="w-4 h-4" />,
    };
  }
  if (log.type === 'skipped') {
    return {
      bg: 'bg-amber-100',
      text: 'text-warning',
      icon: <SkipForward className="w-4 h-4" />,
    };
  }
  if (log.isManualCommand) {
    return {
      bg: 'bg-blue-100',
      text: 'text-info',
      icon: <Hand className="w-4 h-4" />,
    };
  }
  if (log.isFromSchedule) {
    return {
      bg: 'bg-emerald-100',
      text: 'text-brand',
      icon: <Timer className="w-4 h-4" />,
    };
  }
  if (log.source === 'weather_ai') {
    return {
      bg: 'bg-amber-100',
      text: 'text-warning',
      icon: <CloudOff className="w-4 h-4" />,
    };
  }

  return {
    bg: 'bg-sunken',
    text: 'text-ink-muted',
    icon: <Info className="w-4 h-4" />,
  };
}

const CHIP_ALERT: ReadonlySet<LogCategoryKey> = new Set<LogCategoryKey>(['security', 'failed', 'unconfirmed']);

export function EventsTimeline({ device, canManage = false }: EventsTimelineProps) {
  const tzOffset = device.settings.timezoneOffset;

  // ---------- Filtros ----------
  const [rangeChoice, setRangeChoice] = useState<LogRangeKey>('24h');
  const [customDraft, setCustomDraft] = useState<CustomRangeInput>(() => {
    const today = stationIsoDay(Date.now(), tzOffset);
    return { from: today, to: today };
  });
  const [customApplied, setCustomApplied] = useState<CustomRangeInput | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [rangeStamp, setRangeStamp] = useState(0);
  const [order, setOrder] = useState<LogOrder>('desc');
  const [category, setCategory] = useState<LogCategoryKey>('all');
  const [searchDraft, setSearchDraft] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  // Busca aplicada 350 ms depois da última tecla (não refiltra a cada letra).
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchDraft), 350);
    return () => window.clearTimeout(t);
  }, [searchDraft]);

  // Intervalo resolvido UMA vez por escolha (atalhos contam a partir do clique).
  const { range } = useMemo(
    () =>
      rangeChoice === 'custom' && customApplied
        ? resolveLogRange('custom', customApplied, tzOffset)
        : resolveLogRange(rangeChoice === 'custom' ? '24h' : rangeChoice, { from: '', to: '' }, tzOffset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rangeChoice, customApplied, tzOffset, rangeStamp],
  );
  const draftCheck = useMemo(() => resolveLogRange('custom', customDraft, tzOffset), [customDraft, tzOffset]);

  const browser = useLogBrowser({
    deviceId: device.id,
    range,
    order,
    category,
    search,
  });

  // ---------- Seleção (vale entre páginas; limpa quando o intervalo muda) ----------
  const [selected, setSelected] = useState<Map<string, ActivityLogModel>>(new Map());
  const [selectedLog, setSelectedLog] = useState<ActivityLogModel | null>(null);
  const [modal, setModal] = useState<'none' | 'delete' | 'cleanup'>('none');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setSelected(new Map());
    setSelectedLog(null);
  }, [device.id, range]);

  const listTopRef = useRef<HTMLDivElement | null>(null);
  const firstPageRender = useRef(true);
  useEffect(() => {
    if (firstPageRender.current) {
      firstPageRender.current = false;
      return;
    }
    listTopRef.current?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
  }, [browser.pageIndex]);

  const nowMs = Date.now();
  const selectedLogs = useMemo(() => [...selected.values()], [selected]);
  const selectedProtected = selectedLogs.filter((l) => isDeletionProtected(l, nowMs)).length;
  const selectableVisible = browser.items.filter((l) => !isDeletionProtected(l, nowMs));
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((l) => selected.has(l.id));

  const toggleOne = (log: ActivityLogModel) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(log.id)) next.delete(log.id);
      else next.set(log.id, log);
      return next;
    });

  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (allVisibleSelected) selectableVisible.forEach((l) => next.delete(l.id));
      else selectableVisible.forEach((l) => next.set(l.id, l));
      return next;
    });

  const chooseRange = (key: LogRangeKey) => {
    setCustomOpen(false);
    setRangeChoice(key);
    setRangeStamp((s) => s + 1);
  };

  const applyCustom = (value: CustomRangeInput) => {
    setCustomDraft(value);
    if (resolveLogRange('custom', value, tzOffset).error) return;
    setCustomApplied({ ...value });
    setRangeChoice('custom');
    setRangeStamp((s) => s + 1);
  };

  const clearFilters = () => {
    setCategory('all');
    setSearchDraft('');
    setSearch('');
  };

  const activeCategory = LOG_CATEGORIES.find((c) => c.key === category);
  const rangeLabel =
    rangeChoice === 'custom' && customApplied
      ? `${customApplied.from ? customApplied.from.split('-').reverse().join('/') : 'início'} a ${
          customApplied.to ? customApplied.to.split('-').reverse().join('/') : 'hoje'
        }`
      : RANGE_OPTIONS.find((o) => o.key === rangeChoice)?.label ?? '';
  const orderLabel = order === 'desc' ? 'mais recentes primeiro' : 'mais antigos primeiro';

  // ---------- Rodapé ----------
  let footerText = '';
  if (browser.mode === 'server') {
    footerText = `${serverRangeLabel(browser.pageIndex, browser.items.length, browser.total)} · ${rangeLabel} · ${orderLabel}`;
  } else if (browser.mode === 'scan') {
    const what = category !== 'all' ? activeCategory?.label ?? 'Filtro' : 'Busca';
    const verified = browser.scanRunning
      ? `verificando ${formatCount(browser.scanned)}${browser.total !== null ? ` de ${formatCount(browser.total)}` : ''}`
      : `em ${formatCount(browser.scanned)} registro(s) do período`;
    footerText = `${what}: ${formatCount(browser.matchCount ?? 0)} encontrado(s) ${verified} · ${rangeLabel}`;
  } else {
    footerText = `${formatCount(browser.matchCount ?? 0)} registro(s) da operação ${browser.operationId} (todo o histórico)`;
  }
  const pageLabel =
    browser.pageCount !== null
      ? `Página ${formatCount(browser.pageIndex + 1)} de ${formatCount(browser.pageCount)}`
      : `Página ${formatCount(browser.pageIndex + 1)}`;
  const showPager = browser.items.length > 0 || browser.pageIndex > 0;
  const canJumpLast = browser.mode !== 'server' && browser.pageCount !== null && browser.pageIndex < browser.pageCount - 1;

  const scanProgressPct =
    browser.total && browser.total > 0 ? Math.min(100, Math.round((browser.scanned / browser.total) * 100)) : null;

  return (
    <div className="bg-surface rounded-2xl border border-line shadow-sm overflow-hidden">
      {/* 1. Período, ordem, busca e atualizar */}
      <div className="p-4 border-b border-line space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <div className="flex w-full sm:w-auto rounded-xl bg-sunken p-1" role="group" aria-label="Período">
              {RANGE_OPTIONS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  aria-pressed={p.key === 'custom' ? rangeChoice === 'custom' || customOpen : rangeChoice === p.key && !customOpen}
                  aria-expanded={p.key === 'custom' ? customOpen : undefined}
                  onClick={() => (p.key === 'custom' ? setCustomOpen((o) => !o) : chooseRange(p.key))}
                  className={`flex-1 sm:flex-none justify-center whitespace-nowrap px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-bold transition inline-flex items-center gap-1 ${
                    (p.key === 'custom' ? rangeChoice === 'custom' || customOpen : rangeChoice === p.key && !customOpen) ? 'bg-surface text-brand shadow-sm' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {p.key === 'custom' && <CalendarDays className="w-3.5 h-3.5" />}
                  {p.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setOrder((o) => (o === 'desc' ? 'asc' : 'desc'))}
              title="Inverter a ordem"
              aria-label={`Ordem: ${orderLabel}. Clique para inverter.`}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-line hover:bg-sunken text-xs font-bold text-ink transition"
            >
              {order === 'desc' ? <ArrowDownWideNarrow className="w-3.5 h-3.5" /> : <ArrowUpNarrowWide className="w-3.5 h-3.5" />}
              {order === 'desc' ? 'Mais recentes' : 'Mais antigos'}
            </button>
          </div>

          <div className="flex flex-1 min-w-[220px] max-w-md items-center gap-2">
            <label className="relative flex-1">
              <span className="sr-only">Buscar por mensagem, motivo ou número da operação</span>
              <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                inputMode="search"
                enterKeyHint="search"
                autoComplete="off"
                value={searchDraft}
                maxLength={120}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setSearch(searchDraft);
                }}
                placeholder="Buscar: mensagem, motivo ou nº da operação"
                className="w-full pl-9 pr-8 py-2 rounded-xl border border-line text-xs focus:outline-none focus:border-brand"
              />
              {searchDraft && (
                <button
                  type="button"
                  aria-label="Limpar busca"
                  onClick={() => {
                    setSearchDraft('');
                    setSearch('');
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-ink-muted hover:bg-sunken"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </label>
            <button
              type="button"
              disabled={browser.loading}
              onClick={browser.refresh}
              aria-label="Atualizar registros"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-line hover:bg-sunken text-xs font-bold text-brand transition disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${browser.loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Atualizar</span>
            </button>
          </div>
        </div>

        {/* 1b. Intervalo personalizado (dias inteiros no fuso da estação) */}
        {customOpen && (
          <div className="flex flex-wrap items-end gap-2 p-3 rounded-xl bg-sunken/70 border border-line">
            <label className="text-xs font-bold text-ink-muted">
              De
              <input
                type="date"
                value={customDraft.from}
                max={customDraft.to || undefined}
                onChange={(e) => setCustomDraft((d) => ({ ...d, from: e.target.value }))}
                className="block mt-1 px-2.5 py-1.5 rounded-lg border border-line bg-surface text-xs text-ink focus:outline-none focus:border-brand"
              />
            </label>
            <label className="text-xs font-bold text-ink-muted">
              Até
              <input
                type="date"
                value={customDraft.to}
                min={customDraft.from || undefined}
                onChange={(e) => setCustomDraft((d) => ({ ...d, to: e.target.value }))}
                className="block mt-1 px-2.5 py-1.5 rounded-lg border border-line bg-surface text-xs text-ink focus:outline-none focus:border-brand"
              />
            </label>
            <button
              type="button"
              disabled={Boolean(draftCheck.error)}
              onClick={() => applyCustom(customDraft)}
              className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold hover:bg-brand-strong disabled:opacity-40"
            >
              Aplicar
            </button>
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: 'Este mês', delta: 0 },
                { label: 'Mês passado', delta: -1 },
              ].map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => applyCustom(stationMonthBounds(Date.now(), tzOffset, q.delta))}
                  className="px-3 py-2 rounded-xl border border-line bg-surface text-xs font-bold text-ink-muted hover:text-ink"
                >
                  {q.label}
                </button>
              ))}
            </div>
            {draftCheck.error && <p className="w-full text-xs font-semibold text-danger">{draftCheck.error}</p>}
            {!draftCheck.error && (
              <p className="w-full text-xs text-ink-muted">Dias inteiros no horário da estação; deixe um campo vazio para não limitar aquele lado.</p>
            )}
          </div>
        )}

        {/* 2. Categorias (rolagem horizontal no celular) */}
        <div className="-mx-1 px-1 flex gap-2 overflow-x-auto md:overflow-visible md:flex-wrap pb-1" role="group" aria-label="Categorias">
          {LOG_CATEGORIES.map((chip) => {
            const isSelected = category === chip.key;
            const n =
              browser.mode === 'operation'
                ? null
                : chip.key === 'all' && !search.trim()
                ? browser.total
                : browser.categoryCounts
                  ? browser.categoryCounts[chip.key]
                  : null;
            const partial = chip.key !== 'all' && browser.categoryCounts !== null && !browser.scanDone;
            const isAlert = CHIP_ALERT.has(chip.key);
            return (
              <button
                key={chip.key}
                type="button"
                title={chip.key === 'all' ? 'Todos os registros do período' : chip.hint}
                aria-pressed={isSelected && browser.mode !== 'operation'}
                disabled={browser.mode === 'operation'}
                onClick={() => setCategory(chip.key)}
                className={`shrink-0 px-3 py-1.5 rounded-xl text-xs font-bold transition border disabled:opacity-40 ${
                  isSelected && browser.mode !== 'operation'
                    ? 'bg-brand-soft/80 text-brand-strong border-brand'
                    : 'bg-sunken text-ink-muted border-transparent hover:text-ink'
                }`}
              >
                {chip.label}
                {n !== null && n !== undefined && (
                  <span
                    className={`ml-1.5 px-1.5 py-0.5 rounded-md text-[11px] ${
                      isAlert && n > 0 ? 'bg-red-100 text-danger' : 'bg-white/70 text-ink-muted'
                    }`}
                  >
                    {formatCount(n)}
                    {partial ? '+' : ''}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {browser.categoryCounts === null && browser.mode === 'server' && (
          <p className="text-xs text-ink-muted">Escolha uma categoria para ver quantos registros de cada tipo há no período.</p>
        )}

        {/* 3. Barra de seleção e manutenção (somente titular) */}
        {canManage && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <label className="inline-flex items-center gap-2 text-xs font-bold text-ink cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-4 h-4 accent-[#2E7D32]"
                checked={allVisibleSelected}
                disabled={selectableVisible.length === 0}
                onChange={toggleAllVisible}
              />
              <span>
                Selecionar esta página
                {selected.size > 0 && <span className="ml-1.5 text-brand">· {formatCount(selected.size)} selecionado(s)</span>}
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {selected.size > 0 && (
                <button
                  type="button"
                  onClick={() => setSelected(new Map())}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold text-ink-muted hover:bg-sunken"
                >
                  Limpar seleção
                </button>
              )}
              <button
                type="button"
                disabled={selected.size === 0}
                onClick={() => setModal('delete')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-danger text-white text-xs font-bold hover:bg-danger-strong disabled:opacity-35"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Excluir selecionados
              </button>
              <button
                type="button"
                onClick={() => setModal('cleanup')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-danger/40 text-danger text-xs font-bold hover:bg-[#FFEBEE]"
              >
                <Eraser className="w-3.5 h-3.5" />
                Limpar antigos…
              </button>
            </div>
          </div>
        )}
      </div>

      <div ref={listTopRef} className="scroll-mt-24" />

      {notice && (
        <div className="mx-4 mt-4 p-3 rounded-xl bg-brand-soft/40 border border-brand/30 flex items-center justify-between gap-2 text-xs font-semibold text-brand-strong">
          <span>{notice}</span>
          <button type="button" aria-label="Fechar aviso" onClick={() => setNotice(null)} className="p-1 rounded-md hover:bg-white/60">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {browser.error && (
        <div className="m-4 p-3.5 rounded-xl bg-red-50 border border-red-200 flex items-center gap-2.5 text-xs font-semibold text-danger">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{browser.error}</span>
        </div>
      )}

      {browser.mode === 'scan' && browser.scanRunning && (
        <div className="mx-4 mt-4 p-3 rounded-xl bg-sunken border border-line space-y-2" role="status">
          <div className="flex items-center justify-between gap-2 text-xs font-semibold text-ink-muted">
            <span className="inline-flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              Verificando os registros do período para aplicar o filtro…
            </span>
            <span>
              {formatCount(browser.scanned)}
              {browser.total !== null ? ` de ${formatCount(browser.total)}` : ''}
            </span>
          </div>
          {scanProgressPct !== null && (
            <div className="h-1.5 rounded-full bg-surface overflow-hidden">
              <div className="h-full bg-brand transition-all" style={{ width: `${scanProgressPct}%` }} />
            </div>
          )}
        </div>
      )}

      {browser.mode === 'scan' && browser.scanCapped && (
        <div className="mx-4 mt-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs font-semibold text-warning-strong">
          Este período tem mais de {formatCount(SCAN_MAX_DOCS)} registros: o filtro considerou só os{' '}
          {formatCount(SCAN_MAX_DOCS)} mais recentes. Use “Datas…” para escolher um intervalo menor.
        </div>
      )}

      {browser.mode === 'operation' && (
        <div className="mx-4 mt-4 p-3 rounded-xl bg-info-tint border border-info-soft text-xs font-semibold text-info-strong">
          Busca exata pela operação <span className="font-mono">{browser.operationId}</span> em todo o histórico (ignora período e categoria).
        </div>
      )}

      {/* 4. Lista */}
      {browser.loading && browser.items.length === 0 ? (
        <div className="divide-y divide-line" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="px-5 py-4 flex items-start gap-3.5 animate-pulse">
              <div className="w-9 h-9 rounded-full bg-sunken" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-3/4 rounded bg-sunken" />
                <div className="h-3 w-1/2 rounded bg-sunken" />
              </div>
            </div>
          ))}
        </div>
      ) : browser.items.length === 0 ? (
        <div className="p-12 text-center space-y-3">
          <p className="text-sm font-bold text-ink">Nenhum registro encontrado</p>
          <p className="text-xs text-ink-muted">
            {browser.mode === 'server'
              ? 'Não há registros neste período. Tente um período maior.'
              : browser.mode === 'operation'
                ? 'Nenhum registro com esse número de operação.'
                : `Nenhum registro do período combina com ${activeCategory?.label ?? 'o filtro'}${search.trim() ? ' e a busca' : ''}.`}
          </p>
          {(category !== 'all' || searchDraft) && (
            <button
              type="button"
              onClick={clearFilters}
              className="px-4 py-2 rounded-xl border border-line text-xs font-bold text-brand hover:bg-sunken"
            >
              Limpar filtros
            </button>
          )}
        </div>
      ) : (
        <ul className={`divide-y divide-[#E0E6ED] transition-opacity ${browser.loading && browser.mode === 'server' ? 'opacity-60' : ''}`}>
          {browser.items.map((log) => {
            const badge = getEventBadgeStyle(log);
            const security = isSecurityLog(log);
            const locked = isDeletionProtected(log, nowMs);
            const checked = selected.has(log.id);
            return (
              <li
                key={log.id}
                className={`flex items-stretch transition ${
                  checked ? 'bg-brand-soft/25' : security ? 'bg-red-50/50' : ''
                } ${security ? 'shadow-[inset_4px_0_0_#D32F2F]' : ''}`}
              >
                {canManage && (
                  <div className="pl-4 flex items-center">
                    {locked ? (
                      <span
                        className="w-4 h-4 inline-flex items-center justify-center text-ink-muted"
                        title={`Alerta de segurança protegido contra exclusão por mais ${protectionDaysLeft(log, nowMs)} dia(s)`}
                      >
                        <Lock className="w-3.5 h-3.5" />
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        aria-label="Selecionar registro"
                        className="w-4 h-4 accent-[#2E7D32] cursor-pointer"
                        checked={checked}
                        onChange={() => toggleOne(log)}
                      />
                    )}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedLog(log)}
                  className="flex-1 min-w-0 px-4 py-3.5 hover:bg-sunken/50 transition flex items-center justify-between gap-4 text-left"
                >
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div className={`p-2.5 rounded-full shrink-0 mt-0.5 ${badge.bg} ${badge.text}`}>{badge.icon}</div>
                    <div className="min-w-0">
                      {security && (
                        <span className="inline-block mb-1 px-2 py-0.5 rounded-md bg-danger text-white text-[11px] font-extrabold uppercase tracking-wide">
                          Alerta de segurança
                        </span>
                      )}
                      <p className="text-sm font-bold text-ink line-clamp-2">{formatLogMessageDuration(log.message)}</p>
                      <p className="text-xs text-ink-muted mt-0.5">
                        {log.deviceEventAt ? 'Horário da estação · ' : 'Registro no servidor · '}
                        {formatWithDeviceTimezone(log.deviceEventAt ?? log.timestamp, tzOffset)} • {auditEventSource(log)}
                      </p>
                      {log.scheduleLabel && (
                        <p className="mt-1 truncate text-xs text-ink" title={log.scheduleLabel}>
                          <span className="text-ink-muted">Agenda: </span>
                          <span className="font-semibold">{log.scheduleLabel}</span>
                        </p>
                      )}
                      {log.commandId && (
                        <p className="mt-1 text-[11px] font-mono text-ink-muted truncate">Operação {log.commandId}</p>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-ink-muted shrink-0" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* 5. Paginação */}
      {showPager && (
        <div className="p-4 border-t border-line bg-sunken/30 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs font-semibold text-ink-muted">{footerText}</span>
          <nav className="flex items-center gap-1.5" aria-label="Paginação">
            <button
              type="button"
              disabled={!browser.hasPrev}
              onClick={() => browser.goToPage(0)}
              aria-label="Primeira página"
              title="Primeira página"
              className="p-2 rounded-lg border border-line bg-surface text-ink hover:bg-sunken disabled:opacity-35"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              disabled={!browser.hasPrev}
              onClick={() => browser.goToPage(browser.pageIndex - 1)}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-line bg-surface text-xs font-bold text-ink hover:bg-sunken disabled:opacity-35"
            >
              <ChevronLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Anterior</span>
            </button>
            <span className="px-2 text-xs font-bold text-ink whitespace-nowrap" aria-live="polite">
              {pageLabel}
            </span>
            <button
              type="button"
              disabled={!browser.hasNext || (browser.loading && browser.mode === 'server')}
              onClick={() => browser.goToPage(browser.pageIndex + 1)}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-brand bg-surface text-xs font-bold text-brand hover:bg-brand-soft/30 disabled:opacity-35 disabled:border-line disabled:text-ink-muted"
            >
              <span className="hidden sm:inline">Próxima</span>
              <ChevronRight className="w-4 h-4" />
            </button>
            {browser.mode !== 'server' && (
              <button
                type="button"
                disabled={!canJumpLast}
                onClick={() => browser.pageCount !== null && browser.goToPage(browser.pageCount - 1)}
                aria-label="Última página"
                title="Última página"
                className="p-2 rounded-lg border border-line bg-surface text-ink hover:bg-sunken disabled:opacity-35"
              >
                <ChevronsRight className="w-4 h-4" />
              </button>
            )}
          </nav>
        </div>
      )}

      <EventAuditModal deviceId={device.id} log={selectedLog} timezoneOffset={tzOffset} onClose={() => setSelectedLog(null)} />

      {canManage && modal === 'delete' && (
        <DeleteSelectedModal
          count={selectedLogs.length}
          protectedCount={selectedProtected}
          onClose={() => setModal('none')}
          onConfirm={async (onProgress) => {
            const res = await deleteActivityLogs(device.id, selectedLogs, onProgress);
            browser.removeLocally(res.deletedIds);
            setSelected((prev) => {
              const next = new Map(prev);
              res.deletedIds.forEach((id) => next.delete(id));
              return next;
            });
            setNotice(`${formatCount(res.deleted)} registro(s) excluído(s).`);
            return res;
          }}
        />
      )}

      {canManage && modal === 'cleanup' && (
        <CleanupOlderModal
          onClose={() => setModal('none')}
          countOlderThan={(days) => countActivityLogsOlderThan(device.id, new Date(Date.now() - days * 86400000))}
          onConfirm={async (days, onProgress) => {
            const res = await deleteActivityLogsOlderThan(device.id, new Date(Date.now() - days * 86400000), onProgress);
            setNotice(`Limpeza concluída: ${formatCount(res.deleted)} registro(s) com mais de ${days} dias excluído(s).`);
            setSelected(new Map());
            browser.refresh();
            return res;
          }}
        />
      )}
    </div>
  );
}
