/**
 * =====================================================================================
 * ARQUIVO: src/features/telemetry/components/TelemetryReadingsTable.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T21:30:00Z (UTC)
 * VERSÃO: v5.40.1
 * PROPÓSITO: Histórico de leituras do DynamoDB com período (atalhos ou datas), páginas de
 *            50 (Anterior/Próxima com o cursor assinado `next_token`) e exportação CSV do
 *            período inteiro (titular e Demo), protegida contra CSV injection.
 * CHANGELOG:
 * - v5.40.1: período inicial 1 h (antes 24 h).
 * - v5.39.1 (correção): a lista de páginas era recriada a cada render e disparava consultas
 *   em loop (≈ 25/s, 429 no API Gateway, "carregando" eterno). Agora: lista memorizada, uma
 *   consulta por página por vez, cancelamento só ao trocar de período e um disjuntor de
 *   consultas (no máximo 12 em 10 s) como rede de segurança.
 * - v5.39.0 (F1.3): período no servidor (1 h, 24 h, 7 dias, Tudo, Datas… até 90 dias);
 *   páginas de 50 com cache (voltar não lê de novo); estimativa de leituras pelo intervalo
 *   de envio; CSV do período com teto de 5.000 linhas, progresso e cancelamento; legenda
 *   que explica cada medida.
 * - v5.25.0: [Auditoria 02] CSV blindado (`escapeCsvCell`), isolamento por estação.
 * =====================================================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Thermometer,
  Droplets,
  Sprout,
  Sun,
  Sparkles,
  CloudRain,
  Cloud,
  RefreshCw,
  Cpu,
  AlertCircle,
  Database,
  LayoutGrid,
  Table,
  Download,
  Clock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Info,
  X,
} from 'lucide-react';
import { DeviceModel } from '../../devices/model/device.types';
import { fetchTelemetryHistory } from '../api/telemetryApi';
import { TelemetryModel } from '../model/telemetry.types';
import { formatWithDeviceTimezone } from '../../../shared/lib/formatters';
import { logWebDiagnostic } from '../../../shared/lib/diagnostics';
import { CustomRangeInput, formatCount, stationIsoDay } from '../../events/model/logQuery';
import {
  buildTelemetryCsv,
  CSV_BATCH,
  CSV_MAX_ROWS,
  csvFileName,
  estimateReadings,
  exportWindowOf,
  formatInterval,
  READINGS_PAGE_SIZE,
  READINGS_RANGES,
  ReadingsRangeKey,
  resolveReadingsWindow,
  typicalIntervalMs,
  createRequestBudget,
  friendlyReadingsError,
  READINGS_REQ_BUDGET,
  READINGS_REQ_WINDOW_MS,
} from '../model/readingsQuery';
import { scrollBehavior } from '../../../shared/lib/motion';

interface TelemetryReadingsTableProps {
  device: DeviceModel;
}

interface PageData {
  items: TelemetryModel[];
  nextToken: string | null;
}

const LEGEND: ReadonlyArray<{ icon: JSX.Element; name: string; text: string }> = [
  { icon: <Thermometer className="w-4 h-4 text-[#FB8C00]" />, name: 'Temperatura do ar', text: 'Sensor AHT, em °C. “ERRO I2C” = o sensor não respondeu naquela leitura.' },
  { icon: <Droplets className="w-4 h-4 text-[#1E88E5]" />, name: 'Umidade do ar', text: 'Sensor AHT, em %. Valores presos em 100% podem ser condensação no sensor.' },
  { icon: <Sprout className="w-4 h-4 text-[#6D4C41]" />, name: 'Umidade do solo', text: 'Sensor capacitivo calibrado entre “seco” (0%) e “encharcado” (100%). “FALHA” = leitura fora da faixa elétrica válida.' },
  { icon: <Sun className="w-4 h-4 text-amber-600" />, name: 'Luz solar', text: 'Luminosidade relativa, de 0% (escuro) a 100% (sol pleno).' },
  { icon: <Sparkles className="w-4 h-4 text-[#8E24AA]" />, name: 'Índice UV', text: 'Radiação ultravioleta na escala da OMS (0–2 baixo, 3–5 moderado, 6+ alto).' },
  { icon: <CloudRain className="w-4 h-4 text-info" />, name: 'Chuva', text: 'Quanto da placa de chuva está molhada. “Chuva ativa” = acima do limiar: a rega é bloqueada.' },
];

export function TelemetryReadingsTable({ device }: TelemetryReadingsTableProps) {
  const tzOffset = device.settings.timezoneOffset;

  // ---------- Período ----------
  // v5.40.1: abre em 1 h (≈ 120 leituras); 24 h fica a um clique.
  const [rangeKey, setRangeKey] = useState<ReadingsRangeKey>('1h');
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState<CustomRangeInput>(() => {
    const today = stationIsoDay(Date.now(), tzOffset);
    return { from: today, to: today };
  });
  const [customApplied, setCustomApplied] = useState<CustomRangeInput | null>(null);
  const [stamp, setStamp] = useState(0);

  const { window: win } = useMemo(
    () =>
      rangeKey === 'custom' && customApplied
        ? resolveReadingsWindow('custom', customApplied, tzOffset)
        : resolveReadingsWindow(rangeKey === 'custom' ? '1h' : rangeKey, { from: '', to: '' }, tzOffset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rangeKey, customApplied, tzOffset, stamp],
  );
  const draftCheck = useMemo(() => resolveReadingsWindow('custom', customDraft, tzOffset), [customDraft, tzOffset]);
  const queryKey = `${device.id}|${win.start?.getTime() ?? '-'}|${win.end?.getTime() ?? '-'}|${stamp}`;

  // ---------- Páginas (cache por consulta) ----------
  const [pagesState, setPagesState] = useState<{ key: string; list: PageData[] }>({ key: '', list: [] });
  // v5.39.1: memorizado. Antes, `[]` novo a cada render fazia o efeito de carga rodar
  // em loop (centenas de chamadas por segundo, 429 no API Gateway).
  const pages = useMemo(() => (pagesState.key === queryKey ? pagesState.list : []), [pagesState, queryKey]);
  const [pageIndex, setPageIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [showLegend, setShowLegend] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef<string>('');
  const budgetRef = useRef(createRequestBudget(READINGS_REQ_BUDGET, READINGS_REQ_WINDOW_MS));
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  const pagesRef = useRef(pagesState);
  pagesRef.current = pagesState;

  const loadPage = useCallback(
    async (i: number) => {
      const key = queryKey;
      const known = pagesRef.current.key === key ? pagesRef.current.list : [];
      if (known[i]) return;
      if (i > 0 && !known[i - 1]?.nextToken) return;
      const tag = `${key}#${i}`;
      if (inflightRef.current === tag) return; // a mesma página já está a caminho
      if (!budgetRef.current.allow(Date.now())) {
        // Disjuntor: nunca mais que N consultas em poucos segundos (protege a API e a cota).
        setErrorMsg('Muitas consultas seguidas. Aguarde alguns segundos e clique em “Atualizar”.');
        logWebDiagnostic('WARN', 'readings.request_budget_tripped', { device_id: device.id });
        return;
      }
      inflightRef.current = tag;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setIsLoading(true);
      setErrorMsg(null);
      try {
        const res = await fetchTelemetryHistory({
          deviceId: device.id,
          limit: READINGS_PAGE_SIZE,
          nextToken: i > 0 ? known[i - 1].nextToken : null,
          startDate: win.start ?? undefined,
          endDate: win.end ?? undefined,
          signal: controller.signal,
        });
        if (keyRef.current !== key) return;
        setPagesState((prev) => {
          const list = prev.key === key ? [...prev.list] : [];
          list[i] = { items: res.items, nextToken: res.nextToken };
          return { key, list };
        });
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError') return;
        if (keyRef.current === key) setErrorMsg(friendlyReadingsError(err));
      } finally {
        if (inflightRef.current === tag) inflightRef.current = '';
        if (keyRef.current === key) setIsLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryKey],
  );

  useEffect(() => {
    setPageIndex(0);
  }, [queryKey]);

  useEffect(() => {
    if (!pages[pageIndex] && !errorMsg) void loadPage(pageIndex);
  }, [pages, pageIndex, errorMsg, loadPage]);

  // Cancela a consulta em andamento só quando o período/estação muda (ou ao sair da tela).
  useEffect(
    () => () => {
      abortRef.current?.abort();
      inflightRef.current = '';
    },
    [queryKey],
  );

  const current = pages[pageIndex];
  const pageItems = current?.items ?? [];
  const firstNumber = pageIndex * READINGS_PAGE_SIZE + 1;
  const hasNext = Boolean(current?.nextToken);
  const interval = typicalIntervalMs(pages[0]?.items ?? []);
  const estimate = estimateReadings(win, interval);
  const estimatedPages = estimate !== null ? Math.max(1, Math.ceil(estimate / READINGS_PAGE_SIZE)) : null;

  const listTopRef = useRef<HTMLDivElement | null>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    listTopRef.current?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
  }, [pageIndex]);

  const chooseRange = (key: ReadingsRangeKey) => {
    setCustomOpen(false);
    setRangeKey(key);
    setStamp((s) => s + 1);
    setErrorMsg(null);
  };
  const applyCustom = () => {
    if (draftCheck.error) return;
    setCustomApplied({ ...customDraft });
    setRangeKey('custom');
    setStamp((s) => s + 1);
    setErrorMsg(null);
  };
  const refresh = () => {
    setErrorMsg(null);
    setStamp((s) => s + 1);
  };

  // ---------- Exportação CSV do período ----------
  const [exporting, setExporting] = useState<{ rows: number } | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);

  const exportCsv = async () => {
    const { start, end } = exportWindowOf(win);
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExporting({ rows: 0 });
    setExportNote(null);
    const started = performance.now();
    const rows: TelemetryModel[] = [];
    let token: string | null = null;
    try {
      do {
        const res = await fetchTelemetryHistory({
          deviceId: device.id,
          limit: Math.min(CSV_BATCH, CSV_MAX_ROWS - rows.length),
          nextToken: token,
          startDate: start,
          endDate: end,
          signal: controller.signal,
        });
        rows.push(...res.items);
        token = res.nextToken;
        setExporting({ rows: rows.length });
      } while (token && rows.length < CSV_MAX_ROWS);
      const truncated = Boolean(token);
      const csv = buildTelemetryCsv(rows.slice(0, CSV_MAX_ROWS), tzOffset);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = csvFileName(device.id, start, end);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      logWebDiagnostic('INFO', 'readings.csv.exported', {
        device_id: device.id,
        rows: Math.min(rows.length, CSV_MAX_ROWS),
        truncated,
        elapsed_ms: Math.round(performance.now() - started),
      });
      setExportNote(
        truncated
          ? `CSV gerado com as ${formatCount(CSV_MAX_ROWS)} leituras mais recentes do período (limite por arquivo). Use “Datas…” para exportar o restante.`
          : `CSV gerado com ${formatCount(rows.length)} leitura(s).`,
      );
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') setExportNote('Exportação cancelada.');
      else setExportNote((err as Error)?.message || 'Não foi possível gerar o CSV.');
    } finally {
      setExporting(null);
      exportAbortRef.current = null;
    }
  };

  const rangeLabel =
    rangeKey === 'custom' && customApplied
      ? `${customApplied.from.split('-').reverse().join('/')} a ${customApplied.to.split('-').reverse().join('/')}`
      : READINGS_RANGES.find((r) => r.key === rangeKey)?.label ?? '';

  return (
    <div className="space-y-4">
      {/* Barra superior: período, visão, CSV e atualizar */}
      <div className="bg-surface rounded-2xl border border-line p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2.5 rounded-xl bg-brand-soft/60 text-brand-strong shrink-0">
              <Database className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-extrabold text-ink">Leituras da estação · {rangeLabel}</h2>
              <p className="text-xs text-ink-muted">
                {interval ? `Envio ${formatInterval(interval)}` : 'Série temporal no DynamoDB'}
                {estimate !== null ? ` · ≈ ${formatCount(estimate)} leituras no período` : ''}
                <button
                  type="button"
                  onClick={() => setShowLegend((v) => !v)}
                  className="ml-2 inline-flex items-center gap-1 font-bold text-brand hover:underline"
                  aria-expanded={showLegend}
                >
                  <Info className="w-3.5 h-3.5" />O que significa cada medida?
                </button>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-xl bg-sunken p-1">
              <button
                type="button"
                aria-pressed={viewMode === 'cards'}
                onClick={() => setViewMode('cards')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                  viewMode === 'cards' ? 'bg-surface text-brand shadow-sm' : 'text-ink-muted hover:text-ink'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>Cartões</span>
              </button>
              <button
                type="button"
                aria-pressed={viewMode === 'table'}
                onClick={() => setViewMode('table')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                  viewMode === 'table' ? 'bg-surface text-brand shadow-sm' : 'text-ink-muted hover:text-ink'
                }`}
              >
                <Table className="w-3.5 h-3.5" />
                <span>Tabela</span>
              </button>
            </div>
            <button
              type="button"
              disabled={Boolean(exporting)}
              onClick={exportCsv}
              title={`Baixa as leituras do período (até ${formatCount(CSV_MAX_ROWS)} linhas) num arquivo CSV`}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-line bg-surface hover:bg-sunken text-xs font-bold text-ink transition disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5 text-brand" />
              <span>Exportar CSV do período</span>
            </button>
            <button
              type="button"
              disabled={isLoading}
              onClick={refresh}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-brand hover:bg-brand-strong text-xs font-bold text-white shadow-sm transition disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Atualizar</span>
            </button>
          </div>
        </div>

        <div className="flex rounded-xl bg-sunken p-1 w-full sm:w-fit" role="group" aria-label="Período">
          {READINGS_RANGES.map((r) => {
            const active = r.key === 'custom' ? rangeKey === 'custom' || customOpen : rangeKey === r.key && !customOpen;
            return (
              <button
                key={r.key}
                type="button"
                aria-pressed={active}
                onClick={() => (r.key === 'custom' ? setCustomOpen((o) => !o) : chooseRange(r.key))}
                className={`flex-1 sm:flex-none justify-center whitespace-nowrap px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-bold transition inline-flex items-center gap-1 ${
                  active ? 'bg-surface text-brand shadow-sm' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {r.key === 'custom' && <CalendarDays className="w-3.5 h-3.5" />}
                {r.label}
              </button>
            );
          })}
        </div>

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
              onClick={applyCustom}
              className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold hover:bg-brand-strong disabled:opacity-40"
            >
              Aplicar
            </button>
            <p className={`w-full text-xs ${draftCheck.error ? 'font-semibold text-danger' : 'text-ink-muted'}`}>
              {draftCheck.error ?? 'Dias inteiros no horário da estação; até 90 dias por vez.'}
            </p>
          </div>
        )}

        {showLegend && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 p-3 rounded-xl bg-subtle border border-line">
            {LEGEND.map((l) => (
              <div key={l.name} className="flex items-start gap-2 text-xs">
                <span className="mt-0.5">{l.icon}</span>
                <span>
                  <strong className="text-ink">{l.name}:</strong> <span className="text-ink-muted">{l.text}</span>
                </span>
              </div>
            ))}
            <p className="sm:col-span-2 lg:col-span-3 text-xs text-ink-muted">
              Os dados vêm do Amazon DynamoDB pela API protegida por login; a paginação usa um cursor assinado (HMAC-SHA256), que não pode ser
              alterado para ler dados de outra estação.
            </p>
          </div>
        )}
      </div>

      {exporting && (
        <div className="p-3 rounded-xl bg-sunken border border-line flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-ink-muted" role="status">
          <span className="inline-flex items-center gap-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            Gerando o CSV… {formatCount(exporting.rows)} leitura(s) lidas
          </span>
          <button
            type="button"
            onClick={() => exportAbortRef.current?.abort()}
            className="px-3 py-1.5 rounded-lg border border-line bg-surface text-ink hover:bg-subtle"
          >
            Cancelar
          </button>
        </div>
      )}
      {exportNote && !exporting && (
        <div className="p-3 rounded-xl bg-brand-soft/40 border border-brand/30 flex items-center justify-between gap-2 text-xs font-semibold text-brand-strong">
          <span>{exportNote}</span>
          <button type="button" aria-label="Fechar aviso" onClick={() => setExportNote(null)} className="p-1 rounded-md hover:bg-white/60">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {errorMsg && (
        <div className="p-4 rounded-2xl bg-red-50 border border-red-200 flex items-center gap-2.5 text-xs font-semibold text-danger">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      <div ref={listTopRef} className="scroll-mt-24" />

      {isLoading && pageItems.length === 0 ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-surface rounded-2xl border border-line p-4 animate-pulse space-y-3">
              <div className="h-4 w-1/3 rounded bg-sunken" />
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                {[0, 1, 2, 3, 4, 5].map((j) => (
                  <div key={j} className="h-12 rounded-xl bg-sunken" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : pageItems.length === 0 ? (
        <div className="bg-surface rounded-2xl border border-line p-12 text-center shadow-sm">
          <p className="text-sm font-bold text-ink">Nenhuma leitura neste período</p>
          <p className="text-xs text-ink-muted mt-1">Escolha um período maior ou confira se a estação está online.</p>
        </div>
      ) : viewMode === 'cards' ? (
        /* MODO 1: CARDS ESPAÇADOS E COLORIDOS */
        <div className="space-y-3">
          {pageItems.map((item, idx) => {
            const isEven = idx % 2 === 0;
            const leftBorderColor = item.soilFault
              ? 'border-l-danger'
              : item.rainDetected
                ? 'border-l-info'
                : 'border-l-brand';

            return (
              <div
                key={`${item.timestamp.getTime()}-${idx}`}
                className={`rounded-2xl border border-[#DAE2EA] border-l-4 ${leftBorderColor} p-3 sm:p-4 shadow-sm hover:shadow-md transition ${
                  isEven ? 'bg-surface' : 'bg-subtle'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2 mb-2 sm:pb-3 sm:mb-3 border-b border-[#E8EEF3]">
                  <div className="flex items-center gap-2.5">
                    <span className="px-2.5 py-1 rounded-lg bg-brand/10 text-brand-strong font-mono text-xs font-extrabold">
                      #{firstNumber + idx}
                    </span>
                    <div className="flex items-center gap-1.5 text-sm font-extrabold text-ink">
                      <Clock className="w-4 h-4 text-brand" />
                      <span>{formatWithDeviceTimezone(item.timestamp, tzOffset)}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {item.rainDetected && (
                      <span className="px-2.5 py-0.5 rounded-full bg-blue-100 text-info text-xs font-extrabold">
                        Chuva Ativa
                      </span>
                    )}
                    {item.fw && (
                      <span className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sunken text-ink-muted text-xs font-bold">
                        <Cpu className="w-3.5 h-3.5 text-brand" />v{item.fw}
                        {item.part ? ` (${item.part})` : ''}
                      </span>
                    )}
                  </div>
                </div>

                {/* Grid Interno dos 6 Sensores */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-2.5">
                  <div className="px-2.5 py-2 sm:p-2.5 rounded-xl bg-orange-50/70 border border-orange-200/60 flex items-center gap-2.5">
                    <div className="hidden sm:block p-2 rounded-lg bg-orange-100 text-warning">
                      <Thermometer className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-[11px] font-bold uppercase text-ink-muted block">
                        Temp. Ar
                      </span>
                      <span className="text-sm font-extrabold text-ink">
                        {item.ahtOk ? `${item.airTemp.toFixed(1)}°C` : 'ERRO I2C'}
                      </span>
                    </div>
                  </div>

                  <div className="px-2.5 py-2 sm:p-2.5 rounded-xl bg-sky-50/70 border border-sky-200/60 flex items-center gap-2.5">
                    <div className="hidden sm:block p-2 rounded-lg bg-sky-100 text-[#1E88E5]">
                      <Droplets className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-[11px] font-bold uppercase text-ink-muted block">
                        Umid. Ar
                      </span>
                      <span className="text-sm font-extrabold text-ink">
                        {item.ahtOk ? `${item.airHumidity.toFixed(0)}%` : 'ERRO I2C'}
                      </span>
                    </div>
                  </div>

                  <div
                    className={`px-2.5 py-2 sm:p-2.5 rounded-xl border flex items-center gap-2.5 ${
                      item.soilFault
                        ? 'bg-red-50 border-red-200'
                        : 'bg-amber-50/60 border-amber-200/70'
                    }`}
                  >
                    <div
                      className={`hidden sm:block p-2 rounded-lg ${
                        item.soilFault
                          ? 'bg-red-100 text-danger'
                          : 'bg-amber-100/80 text-[#6D4C41]'
                      }`}
                    >
                      <Sprout className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-[11px] font-bold uppercase text-ink-muted block">
                        Umid. Solo
                      </span>
                      <span
                        className={`text-sm font-extrabold ${
                          item.soilFault ? 'text-danger' : 'text-[#6D4C41]'
                        }`}
                      >
                        {item.soilFault ? 'FALHA' : `${item.soilMoisture.toFixed(0)}%`}
                      </span>
                    </div>
                  </div>

                  <div className="px-2.5 py-2 sm:p-2.5 rounded-xl bg-yellow-50/70 border border-yellow-200/70 flex items-center gap-2.5">
                    <div className="hidden sm:block p-2 rounded-lg bg-yellow-100 text-amber-600">
                      <Sun className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-[11px] font-bold uppercase text-ink-muted block">
                        Luz Solar
                      </span>
                      <span className="text-sm font-extrabold text-ink">
                        {item.lightLevel.toFixed(0)}%
                      </span>
                    </div>
                  </div>

                  <div className="px-2.5 py-2 sm:p-2.5 rounded-xl bg-purple-50/70 border border-purple-200/60 flex items-center gap-2.5">
                    <div className="hidden sm:block p-2 rounded-lg bg-purple-100 text-[#8E24AA]">
                      <Sparkles className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-[11px] font-bold uppercase text-ink-muted block">
                        Índice UV
                      </span>
                      <span className="text-sm font-extrabold text-ink">
                        UV {item.uvIndex.toFixed(1)}
                      </span>
                    </div>
                  </div>

                  <div
                    className={`px-2.5 py-2 sm:p-2.5 rounded-xl border flex items-center gap-2.5 ${
                      item.rainDetected
                        ? 'bg-blue-50 border-blue-200'
                        : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <div
                      className={`hidden sm:block p-2 rounded-lg ${
                        item.rainDetected
                          ? 'bg-blue-100 text-info'
                          : 'bg-slate-200/80 text-ink-muted'
                      }`}
                    >
                      {item.rainDetected ? (
                        <CloudRain className="w-4 h-4" />
                      ) : (
                        <Cloud className="w-4 h-4" />
                      )}
                    </div>
                    <div>
                      <span className="text-[11px] font-bold uppercase text-ink-muted block">
                        Chuva
                      </span>
                      <span
                        className={`text-sm font-extrabold ${
                          item.rainDetected ? 'text-info' : 'text-ink'
                        }`}
                      >
                        {item.rainPct}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* MODO 2: TABELA ZEBRA COM LINHAS ALTERNADAS */
        <div className="bg-surface rounded-2xl border border-line shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#1C252C] text-white text-xs font-bold uppercase tracking-wider">
                  <th className="py-3.5 px-4">#</th>
                  <th className="py-3.5 px-4">Data / Hora (Local)</th>
                  <th className="py-3.5 px-4" title="Temperatura do ar (sensor AHT)">Temp. Ar</th>
                  <th className="py-3.5 px-4">Umid. Ar</th>
                  <th className="py-3.5 px-4">Umid. Solo</th>
                  <th className="py-3.5 px-4">Luz</th>
                  <th className="py-3.5 px-4">Índice UV</th>
                  <th className="py-3.5 px-4">Chuva</th>
                  <th className="py-3.5 px-4">Firmware</th>
                </tr>
              </thead>
              <tbody className="text-xs">
                {pageItems.map((item, idx) => (
                  <tr
                    key={`${item.timestamp.getTime()}-${idx}`}
                    className={`border-b border-[#E0E6ED] transition hover:bg-[#C8E6C9]/25 ${
                      idx % 2 === 0 ? 'bg-surface' : 'bg-subtle'
                    }`}
                  >
                    <td className="py-3.5 px-4 font-mono font-bold text-ink-muted">
                      #{firstNumber + idx}
                    </td>
                    <td className="py-3.5 px-4 font-extrabold text-ink whitespace-nowrap">
                      {formatWithDeviceTimezone(item.timestamp, tzOffset)}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-bold text-warning">
                      {item.ahtOk ? `${item.airTemp.toFixed(1)}°C` : 'ERRO I2C'}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-bold text-info">
                      {item.ahtOk ? `${item.airHumidity.toFixed(0)}%` : 'ERRO I2C'}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-extrabold text-[#6D4C41]">
                      {item.soilFault ? 'FALHA' : `${item.soilMoisture.toFixed(0)}%`}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-bold text-amber-700">
                      {item.lightLevel.toFixed(0)}%
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-bold text-[#8E24AA]">
                      UV {item.uvIndex.toFixed(1)}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-bold text-ink-muted">
                      {item.rainPct}%
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-mono text-ink-muted">
                      {item.fw ? `v${item.fw} (${item.part ?? 'n/d'})` : '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}


      {/* Paginação */}
      {(pageItems.length > 0 || pageIndex > 0) && (
        <div className="bg-surface rounded-2xl border border-line p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs font-semibold text-ink-muted">
            Leituras {formatCount(firstNumber)}–{formatCount(firstNumber + pageItems.length - 1)} · {rangeLabel} · mais recentes primeiro
          </span>
          <nav className="flex items-center gap-1.5" aria-label="Paginação">
            <button
              type="button"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex(0)}
              aria-label="Primeira página"
              title="Primeira página"
              className="p-2 rounded-lg border border-line bg-surface text-ink hover:bg-sunken disabled:opacity-35"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-line bg-surface text-xs font-bold text-ink hover:bg-sunken disabled:opacity-35"
            >
              <ChevronLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Anterior</span>
            </button>
            <span className="px-2 text-xs font-bold text-ink whitespace-nowrap" aria-live="polite">
              Página {formatCount(pageIndex + 1)}
              {estimatedPages !== null ? ` de ≈ ${formatCount(Math.max(estimatedPages, pageIndex + 1))}` : ''}
            </span>
            <button
              type="button"
              disabled={!hasNext || isLoading}
              onClick={() => setPageIndex((p) => p + 1)}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-brand bg-surface text-xs font-bold text-brand hover:bg-brand-soft/30 disabled:opacity-35 disabled:border-line disabled:text-ink-muted"
            >
              <span className="hidden sm:inline">Próxima</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </nav>
        </div>
      )}
    </div>
  );
}
