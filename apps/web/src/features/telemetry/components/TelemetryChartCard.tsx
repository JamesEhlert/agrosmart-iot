/**
 * =====================================================================================
 * ARQUIVO: src/features/telemetry/components/TelemetryChartCard.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T00:45:00-03:00
 * VERSÃO: v5.40.1
 * PROPÓSITO: Gráfico analítico multi-série renderizado em HTML5 Canvas via Apache ECharts.
 * CHANGELOG:
 * - v5.40.1: período inicial 6 h (antes 24 h).
 * - v5.25.0: [Auditorias 02 e 05]
 *            1. Corrigido desvio de 3h no filtro Calendário (`datetime-local`) usando
 *               conversores no fuso horário da estação;
 *            2. Validação explícita do intervalo customizado (sem fallback silencioso);
 *            3. Limpeza imediata de `chartItems` e `coverageMeta` ao trocar de estação,
 *               vinculando a exportação PNG à identidade `loadedDeviceId`;
 *            4. Exclusão de leituras com falha elétrica (`soilFault` / `!ahtOk`) das
 *               curvas e estatísticas, identificando que Mín/Méd/Máx são da amostra.
 * =====================================================================================
 */

import { useEffect, useMemo, useRef, useState } from 'react';
// v5.36.0 (WEB-05): ECharts modular — só linha, tooltip, legenda, grade e zoom (pacote ~3x menor).
import { useTheme } from '../../../shared/theme/ThemeProvider';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption, SeriesOption } from 'echarts';

echarts.use([LineChart, TooltipComponent, LegendComponent, GridComponent, DataZoomComponent, CanvasRenderer]);
import {
  Calendar,
  RefreshCw,
  Info,
  AlertTriangle,
  Check,
  BarChart3,
  Download,
  SlidersHorizontal,
} from 'lucide-react';
import { DeviceModel, SensorCapability } from '../../devices/model/device.types';
import { fetchTelemetryHistory } from '../api/telemetryApi';
import { TelemetryHistoryResponse, TelemetryModel } from '../model/telemetry.types';
import { AgroColors } from '../../../shared/theme/agroColors';
import {
  formatWithDeviceTimezone,
  parseDateTimeLocalInputValue,
  toDateTimeLocalInputValue,
} from '../../../shared/lib/formatters';

interface TelemetryChartCardProps {
  device: DeviceModel;
}

type PresetRangeKey = '6h' | '24h' | '7d' | 'custom';

interface SensorSeriesConfig {
  key: string;
  capability: SensorCapability;
  label: string;
  unit: string;
  color: string;
  defaultActive: boolean;
  isValidSample: (t: TelemetryModel) => boolean;
  getter: (t: TelemetryModel) => number;
}

/**
 * v5.44.0: cores das 6 séries com matizes bem separados (nenhum par parecido):
 * solo marrom, ar azul, temperatura laranja, luz dourado, chuva verde-azulado, UV roxo.
 */
export const CHART_SERIES_COLORS = {
  soil: AgroColors.sensorSoil,
  humidity: AgroColors.sensorHumidity,
  temp: AgroColors.sensorTemp,
  light: '#C0A000',
  rain: '#00897B',
  uv: AgroColors.sensorUv,
} as const;

const SENSOR_SERIES: SensorSeriesConfig[] = [
  {
    key: 'soil',
    capability: 'soil',
    label: 'Umidade do Solo',
    unit: '%',
    color: AgroColors.sensorSoil,
    defaultActive: true,
    isValidSample: (t) => !t.soilFault,
    getter: (t) => t.soilMoisture,
  },
  {
    key: 'air_hum',
    capability: 'air',
    label: 'Umidade do Ar',
    unit: '%',
    color: AgroColors.sensorHumidity,
    defaultActive: false,
    isValidSample: (t) => t.ahtOk,
    getter: (t) => t.airHumidity,
  },
  {
    key: 'temp',
    capability: 'air',
    label: 'Temperatura do Ar',
    unit: '°C',
    color: AgroColors.sensorTemp,
    defaultActive: false,
    isValidSample: (t) => t.ahtOk,
    getter: (t) => t.airTemp,
  },
  {
    key: 'light',
    capability: 'light',
    label: 'Luminosidade',
    unit: '%',
    // v5.44.0: dourado (antes laranja, quase igual à temperatura)
    color: CHART_SERIES_COLORS.light,
    defaultActive: false,
    isValidSample: () => true,
    getter: (t) => t.lightLevel,
  },
  {
    key: 'rain',
    capability: 'rain',
    label: 'Sensor de Chuva',
    unit: '%',
    // v5.44.0: verde-azulado (antes azul, quase igual à umidade do ar)
    color: CHART_SERIES_COLORS.rain,
    defaultActive: false,
    isValidSample: () => true,
    getter: (t) => t.rainPct,
  },
  {
    key: 'uv',
    capability: 'uv',
    label: 'Índice UV',
    unit: '',
    color: AgroColors.sensorUv,
    defaultActive: false,
    isValidSample: () => true,
    getter: (t) => t.uvIndex,
  },
];

const MAX_CHART_POINTS = 180;
const SERVER_RANGE_LIMIT = 3000;

/** v5.42.0: cores de eixo, grade, texto e fundo por tema (as cores das séries não mudam). */
export const CHART_PALETTE = {
  light: { bg: '#FFFFFF', text: '#1C252C', muted: '#606F7B', axis: '#CBD5E1', grid: '#EEF2F5', border: '#E0E6ED', tooltipBg: 'rgba(28, 37, 44, 0.95)' },
  dark: { bg: '#161D25', text: '#E6EDF3', muted: '#9AA7B2', axis: '#334150', grid: '#222C37', border: '#2A3643', tooltipBg: 'rgba(13, 18, 24, 0.96)' },
} as const;

export function TelemetryChartCard({ device }: TelemetryChartCardProps) {
  const tzOffset = device.settings.timezoneOffset;

  // v5.40.1: abre em 6 h (≈ 720 leituras) em vez de 24 h (≈ 2.900): tela mais rápida e menos leitura no banco.
  const [preset, setPreset] = useState<PresetRangeKey>('6h');
  const [customStartLocal, setCustomStartLocal] = useState<string>(() =>
    toDateTimeLocalInputValue(new Date(Date.now() - 24 * 3600 * 1000), tzOffset),
  );
  const [customEndLocal, setCustomEndLocal] = useState<string>(() =>
    toDateTimeLocalInputValue(new Date(), tzOffset),
  );

  const availableSeries = useMemo(
    () =>
      SENSOR_SERIES.filter((s) =>
        device.settings.capabilities.includes(s.capability),
      ),
    [device.settings.capabilities],
  );

  const [activeKeys, setActiveKeys] = useState<string[]>(['soil']);
  const [autoScaleY, setAutoScaleY] = useState<boolean>(true);
  const [chartItems, setChartItems] = useState<TelemetryModel[]>([]);
  const [loadedDeviceId, setLoadedDeviceId] = useState<string | null>(null);
  const [coverageMeta, setCoverageMeta] = useState<{
    rawScannedCount: number;
    downsampled: boolean;
    partialWindow: boolean;
    coveredStartTs: number | null;
    coveredEndTs: number | null;
  } | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<echarts.EChartsType | null>(null);
  const reqGenerationRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const resolveWindowDates = (
    targetPreset: PresetRangeKey,
  ): { start: Date; end: Date } | { validationError: string } => {
    const now = new Date();
    if (targetPreset === '6h') {
      return { start: new Date(now.getTime() - 6 * 3600 * 1000), end: now };
    }
    if (targetPreset === '7d') {
      return { start: new Date(now.getTime() - 7 * 24 * 3600 * 1000), end: now };
    }
    if (targetPreset === 'custom') {
      const parsedStart = parseDateTimeLocalInputValue(customStartLocal, tzOffset);
      const parsedEnd = parseDateTimeLocalInputValue(customEndLocal, tzOffset);
      if (!parsedStart || !parsedEnd) {
        return {
          validationError:
            'Preencha as datas de início e fim completas no calendário.',
        };
      }
      const clampedEnd = parsedEnd > now ? now : parsedEnd;
      if (parsedStart >= clampedEnd) {
        return {
          validationError:
            'Período inválido: o horário inicial deve ser anterior ao horário final (no fuso da estação).',
        };
      }
      return { start: parsedStart, end: clampedEnd };
    }
    return { start: new Date(now.getTime() - 24 * 3600 * 1000), end: now };
  };

  const loadChartWindow = async (overridePreset?: PresetRangeKey) => {
    const activePreset = overridePreset ?? preset;
    const windowResult = resolveWindowDates(activePreset);

    if ('validationError' in windowResult) {
      setErrorMsg(windowResult.validationError);
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const currentGen = ++reqGenerationRef.current;
    const targetDeviceId = device.id;

    // Limpa resultados caso a estação tenha mudado para nunca misturar A e B
    if (loadedDeviceId !== targetDeviceId) {
      setChartItems([]);
      setCoverageMeta(null);
      setLoadedDeviceId(null);
    }

    setIsLoading(true);
    setErrorMsg(null);

    try {
      const res: TelemetryHistoryResponse = await fetchTelemetryHistory({
        deviceId: targetDeviceId,
        startDate: windowResult.start,
        endDate: windowResult.end,
        limit: SERVER_RANGE_LIMIT,
        downsample: MAX_CHART_POINTS,
        signal: controller.signal,
      });

      if (currentGen !== reqGenerationRef.current) {
        return;
      }

      const chronological = [...res.items].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
      );

      setChartItems(chronological);
      setLoadedDeviceId(targetDeviceId);
      setCoverageMeta({
        rawScannedCount: res.rawScannedCount,
        downsampled: res.downsampled,
        partialWindow: res.partialWindow,
        coveredStartTs: res.coveredStartTs,
        coveredEndTs: res.coveredEndTs,
      });
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') return;
      if (currentGen !== reqGenerationRef.current) return;
      setErrorMsg((err as Error)?.message || 'Falha ao consultar dados para o gráfico.');
      setChartItems([]);
      setCoverageMeta(null);
    } finally {
      if (currentGen === reqGenerationRef.current) {
        setIsLoading(false);
      }
    }
  };

  // Recarrega ao trocar de estação e limpa estado anterior imediatamente
  useEffect(() => {
    setChartItems([]);
    setCoverageMeta(null);
    setLoadedDeviceId(null);
    setCustomStartLocal(
      toDateTimeLocalInputValue(new Date(Date.now() - 24 * 3600 * 1000), tzOffset),
    );
    setCustomEndLocal(toDateTimeLocalInputValue(new Date(), tzOffset));
    loadChartWindow(preset);

    return () => {
      abortControllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id]);

  // v5.42.0: cores do gráfico seguem o tema (claro/escuro).
  const { resolved: themeResolved } = useTheme();
  const pal = CHART_PALETTE[themeResolved];

  // Inicializa o ECharts com ResizeObserver
  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;

    const instance = echarts.init(el, undefined, {
      renderer: 'canvas',
    });
    chartInstanceRef.current = instance;

    const resizeObserver = new ResizeObserver(() => {
      instance.resize();
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      instance.dispose();
      chartInstanceRef.current = null;
    };
  }, []);

  const isDataForCurrentDevice = loadedDeviceId === device.id;

  // Atualiza as curvas no Canvas sempre que os dados, sensores ou escala mudam
  useEffect(() => {
    const instance = chartInstanceRef.current;
    if (!instance) return;

    if (!isDataForCurrentDevice || chartItems.length === 0 || activeKeys.length === 0) {
      instance.clear();
      return;
    }

    const xLabels = chartItems.map((item) =>
      formatWithDeviceTimezone(item.timestamp, tzOffset, true),
    );

    const activeConfigs = availableSeries.filter((s) => activeKeys.includes(s.key));

    const seriesList: SeriesOption[] = activeConfigs.map((conf) => ({
      name: `${conf.label}${conf.unit ? ` (${conf.unit})` : ''}`,
      type: 'line' as const,
      smooth: 0.25,
      connectNulls: false,
      showSymbol: chartItems.length <= 45,
      symbolSize: 6,
      sampling: 'lttb' as const,
      lineStyle: {
        width: 3,
        color: conf.color,
      },
      itemStyle: {
        color: conf.color,
      },
      areaStyle:
        activeConfigs.length <= 2
          ? {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: `${conf.color}40` },
                { offset: 1, color: `${conf.color}05` },
              ]),
            }
          : undefined,
      data: chartItems.map((item) =>
        conf.isValidSample(item) ? Number(conf.getter(item).toFixed(2)) : null,
      ),
    }));

    const option: EChartsOption = {
      animationDuration: 450,
      tooltip: {
        trigger: 'axis',
        backgroundColor: pal.tooltipBg,
        borderColor: '#2E7D32',
        borderWidth: 1,
        padding: [10, 14],
        textStyle: {
          color: '#FFFFFF',
          fontSize: 12,
        },
      },
      legend: {
        top: 4,
        icon: 'roundRect',
        itemWidth: 14,
        itemHeight: 8,
        textStyle: {
          color: pal.text,
          fontWeight: 'bold' as const,
          fontSize: 12,
        },
      },
      grid: {
        left: '2%',
        right: '3%',
        top: 48,
        bottom: 72,
        containLabel: true,
      },
      xAxis: {
        type: 'category' as const,
        boundaryGap: false,
        data: xLabels,
        axisLabel: {
          color: pal.muted,
          fontSize: 11,
          formatter: (val: string) => {
            const parts = val.split('•');
            if (parts.length === 2) {
              const datePart = parts[0].trim().slice(0, 5);
              const timePart = parts[1].trim().slice(0, 5);
              return `${datePart} ${timePart}`;
            }
            return val;
          },
        },
        axisLine: {
          lineStyle: { color: pal.axis },
        },
      },
      yAxis: {
        type: 'value' as const,
        scale: autoScaleY,
        min: autoScaleY ? undefined : 0,
        splitLine: {
          lineStyle: { color: pal.grid, type: 'dashed' as const },
        },
        axisLabel: {
          color: pal.muted,
          fontSize: 11,
          fontWeight: 'bold' as const,
        },
      },
      dataZoom: [
        {
          type: 'inside' as const,
          start: 0,
          end: 100,
        },
        {
          type: 'slider' as const,
          start: 0,
          end: 100,
          height: 24,
          bottom: 12,
          borderColor: pal.border,
          textStyle: { color: pal.muted },
          fillerColor: 'rgba(46, 125, 50, 0.15)',
          handleStyle: {
            color: '#2E7D32',
          },
        },
      ],
      series: seriesList,
    };

    instance.setOption(option, true);
    window.requestAnimationFrame(() => {
      instance.resize();
    });
  }, [chartItems, activeKeys, autoScaleY, tzOffset, availableSeries, isDataForCurrentDevice, pal]);

  const summaryStats = useMemo(() => {
    if (!isDataForCurrentDevice || chartItems.length === 0) return [];
    return availableSeries
      .filter((s) => activeKeys.includes(s.key))
      .map((conf) => {
        const validItems = chartItems.filter((item) => conf.isValidSample(item));
        if (validItems.length === 0) {
          return {
            ...conf,
            last: 'FALHA',
            min: '--',
            avg: '--',
            max: '--',
            validCount: 0,
          };
        }
        let min = Infinity;
        let max = -Infinity;
        let sum = 0;
        for (const item of validItems) {
          const val = conf.getter(item);
          if (val < min) min = val;
          if (val > max) max = val;
          sum += val;
        }
        const lastVal = conf.getter(validItems[validItems.length - 1]);
        return {
          ...conf,
          last: lastVal.toFixed(1),
          min: min.toFixed(1),
          avg: (sum / validItems.length).toFixed(1),
          max: max.toFixed(1),
          validCount: validItems.length,
        };
      });
  }, [chartItems, activeKeys, availableSeries, isDataForCurrentDevice]);

  const toggleSensorKey = (key: string) => {
    setActiveKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const handleExportPng = () => {
    const instance = chartInstanceRef.current;
    if (!instance || !isDataForCurrentDevice) return;
    const dataUrl = instance.getDataURL({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: pal.bg,
    });
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `agrosmart-telemetria-${loadedDeviceId}-${preset}.png`;
    link.click();
  };

  const showCanvas =
    isDataForCurrentDevice &&
    chartItems.length > 0 &&
    activeKeys.length > 0 &&
    !errorMsg;

  return (
    <div className="bg-surface rounded-2xl border border-line p-5 shadow-sm space-y-4">
      {/* 1. Barra de Períodos, Escala e Exportação */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              { key: '6h', label: 'Últimas 6h' },
              { key: '24h', label: 'Últimas 24h' },
              { key: '7d', label: '7 Dias' },
              { key: 'custom', label: 'Calendário' },
            ] as const
          ).map((btn) => {
            const isSelected = preset === btn.key;
            return (
              <button
                key={btn.key}
                type="button"
                aria-pressed={isSelected}
                onClick={() => {
                  setPreset(btn.key);
                  if (btn.key !== 'custom') {
                    loadChartWindow(btn.key);
                  }
                }}
                className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-brand text-white shadow-sm'
                    : 'bg-sunken text-ink-muted hover:text-ink'
                }`}
              >
                {btn.key === 'custom' && <Calendar className="w-3.5 h-3.5" />}
                <span>{btn.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAutoScaleY((prev) => !prev)}
            title="Alternar entre foco nos picos (Escala Dinâmica) ou escala a partir do zero"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-line hover:bg-sunken text-xs font-bold text-ink transition"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-brand" />
            <span>{autoScaleY ? 'Escala Y: Dinâmica' : 'Escala Y: Base Zero'}</span>
          </button>

          {showCanvas && (
            <button
              type="button"
              onClick={handleExportPng}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-line hover:bg-sunken text-xs font-bold text-ink transition"
            >
              <Download className="w-3.5 h-3.5 text-brand" />
              <span>Baixar PNG</span>
            </button>
          )}

          <button
            type="button"
            disabled={isLoading}
            onClick={() => loadChartWindow()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-sunken hover:bg-brand-soft/50 text-xs font-bold text-brand transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Atualizar</span>
          </button>
        </div>
      </div>

      {preset === 'custom' && (
        <div className="p-3.5 rounded-xl bg-sunken/70 border border-line flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="chart-custom-start"
              className="block text-xs font-bold text-ink-muted mb-1"
            >
              Início (Fuso UTC{tzOffset >= 0 ? `+${tzOffset}` : tzOffset})
            </label>
            <input
              id="chart-custom-start"
              type="datetime-local"
              value={customStartLocal}
              onChange={(e) => setCustomStartLocal(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-line bg-surface text-xs font-semibold text-ink"
            />
          </div>
          <div>
            <label
              htmlFor="chart-custom-end"
              className="block text-xs font-bold text-ink-muted mb-1"
            >
              Fim (Fuso UTC{tzOffset >= 0 ? `+${tzOffset}` : tzOffset})
            </label>
            <input
              id="chart-custom-end"
              type="datetime-local"
              value={customEndLocal}
              onChange={(e) => setCustomEndLocal(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-line bg-surface text-xs font-semibold text-ink"
            />
          </div>
          <button
            type="button"
            onClick={() => loadChartWindow('custom')}
            className="px-4 py-1.5 rounded-lg bg-brand hover:bg-brand-strong text-white text-xs font-bold transition"
          >
            Aplicar Filtro
          </button>
        </div>
      )}

      {/* 2. Seletor de Séries dos Sensores */}
      <div className="flex flex-wrap items-center gap-2">
        {availableSeries.map((sensor) => {
          const isActive = activeKeys.includes(sensor.key);
          return (
            <button
              key={sensor.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => toggleSensorKey(sensor.key)}
              style={{
                borderColor: isActive ? sensor.color : pal.border,
                backgroundColor: isActive ? `${sensor.color}18` : pal.bg,
                color: isActive ? sensor.color : pal.muted,
              }}
              className="px-3.5 py-1.5 rounded-xl border text-xs font-bold transition inline-flex items-center gap-1.5 shadow-sm"
            >
              {isActive && <Check className="w-3.5 h-3.5" />}
              <span>
                {sensor.label} {sensor.unit ? `(${sensor.unit})` : ''}
              </span>
            </button>
          );
        })}
      </div>

      {/* 3. Barra de Transparência de Cobertura */}
      {isDataForCurrentDevice && coverageMeta && chartItems.length > 0 && (
        <div
          className={`p-3 rounded-xl border text-xs flex flex-wrap items-center justify-between gap-2 ${
            coverageMeta.partialWindow
              ? 'bg-amber-50 border-amber-200 text-warning'
              : 'bg-sunken/60 border-line text-ink-muted'
          }`}
        >
          <div className="flex items-center gap-2 font-semibold">
            {coverageMeta.partialWindow ? (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            ) : (
              <Info className="w-4 h-4 text-brand shrink-0" />
            )}
            <span>
              {coverageMeta.partialWindow
                ? `Janela parcial (alta frequência): varridos ${coverageMeta.rawScannedCount.toLocaleString('pt-BR')} registros mais recentes -> exibindo ${chartItems.length} pontos amostrados.`
                : `Cobertura completa: ${coverageMeta.rawScannedCount.toLocaleString('pt-BR')} leituras analisadas no DynamoDB (${
                    coverageMeta.downsampled
                      ? `amostradas em ${chartItems.length} pontos`
                      : `${chartItems.length} pontos exatos`
                  }).`}
            </span>
          </div>

          {coverageMeta.coveredStartTs && coverageMeta.coveredEndTs && (
            <span className="font-bold text-ink">
              Coberto:{' '}
              {formatWithDeviceTimezone(
                new Date(coverageMeta.coveredStartTs * 1000),
                tzOffset,
                false,
              )}{' '}
              até{' '}
              {formatWithDeviceTimezone(
                new Date(coverageMeta.coveredEndTs * 1000),
                tzOffset,
                false,
              )}
            </span>
          )}
        </div>
      )}

      {/* 4. Estatísticas Resumidas da Amostra Exibida */}
      {summaryStats.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {summaryStats.map((st) => (
            <div
              key={st.key}
              className="p-3.5 rounded-xl border flex flex-col justify-between gap-1.5"
              style={{
                backgroundColor: `${st.color}0D`,
                borderColor: `${st.color}38`,
              }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="text-xs font-extrabold flex items-center gap-1.5"
                  style={{ color: st.color }}
                >
                  <BarChart3 className="w-4 h-4" />
                  {st.label}
                </span>
                <span className="text-xs font-extrabold text-ink">
                  Último: {st.last}
                  {st.last !== 'FALHA' ? st.unit : ''}
                </span>
              </div>
              <div className="text-xs font-semibold text-ink-muted flex justify-between pt-1 border-t border-black/5">
                <span>
                  Mín (amostra):{' '}
                  <strong className="text-ink">
                    {st.min}
                    {st.min !== '--' ? st.unit : ''}
                  </strong>
                </span>
                <span>
                  Méd:{' '}
                  <strong className="text-ink">
                    {st.avg}
                    {st.avg !== '--' ? st.unit : ''}
                  </strong>
                </span>
                <span>
                  Máx:{' '}
                  <strong className="text-ink">
                    {st.max}
                    {st.max !== '--' ? st.unit : ''}
                  </strong>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 5. Container Sempre Montado com Dimensões Reais para o Canvas ECharts */}
      <div className="relative h-[420px] w-full rounded-xl border border-[#EEF2F5] bg-subtle p-2">
        <div
          ref={chartContainerRef}
          className={`w-full h-full transition-opacity duration-300 ${
            showCanvas ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        />

        {isLoading && (
          <div className="absolute inset-0 z-10 bg-white/85 backdrop-blur-sm flex flex-col items-center justify-center gap-2.5 rounded-xl">
            <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" />
            <span className="text-xs font-bold text-brand">
              Processando série temporal na AWS Lambda...
            </span>
          </div>
        )}

        {!isLoading && errorMsg && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-4">
            <p className="text-sm font-bold text-danger">{errorMsg}</p>
            <button
              type="button"
              onClick={() => loadChartWindow()}
              className="mt-3 px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold"
            >
              Tentar Novamente
            </button>
          </div>
        )}

        {!isLoading && !errorMsg && chartItems.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-4 text-ink-muted">
            <p className="text-sm font-bold text-ink">
              Sem leituras registradas neste período
            </p>
            <p className="text-xs mt-1">
              Selecione outro intervalo de tempo acima ou aguarde novas coletas da estação.
            </p>
          </div>
        )}

        {!isLoading && !errorMsg && chartItems.length > 0 && activeKeys.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-4 text-ink-muted">
            <p className="text-sm font-bold text-ink">
              Selecione ao menos um sensor acima para desenhar a curva
            </p>
          </div>
        )}
      </div>
    </div>
  );
}