/**
 * =====================================================================================
 * ARQUIVO: src/features/station-settings/components/NvsCalibrationCard.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T01:05:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Card de Calibração Remota de Hardware (`action: "config"` via MQTT AWS IoT)
 *            que grava na memória Flash NVS do ESP32 o intervalo de coleta (30s na
 *            bancada ou 10m/30m no campo) e os limites ADC 12-bit do sensor de solo.
 * CHANGELOG:
 * - v5.25.0: [Auditorias 04 e 05 - NVS-1]
 *            1. Verifica `ack.status === 'done' && ack.result !== 'failed'` e motivo
 *               antes de anunciar sucesso;
 *            2. Cancela espera de ACK e limpa mensagens ao trocar de estação (`device.id`);
 *            3. Suporte a `disabled` nativo para `isDemoUser` e preservação de intervalo
 *               personalizado fora dos 4 presets.
 * =====================================================================================
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sliders,
  Cpu,
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { DeviceModel } from '../../devices/model/device.types';
import {
  generateClientCommandId,
  sendHardwareConfigCommand,
  waitForCommandAck,
} from '../../irrigation/api/commandApi';
import { useConfirm } from '../../../shared/ui/Feedback.providers';

interface NvsCalibrationCardProps {
  device: DeviceModel;
  disabled?: boolean;
}

const INTERVAL_PRESETS = [
  { ms: 30000, label: '30 seg (Bancada / Stress Test)' },
  { ms: 60000, label: '1 min (Teste Rápido)' },
  { ms: 600000, label: '10 min (Modo Campo Padrão)' },
  { ms: 1800000, label: '30 min (Modo Campo Econômico)' },
] as const;

export function NvsCalibrationCard({
  device,
  disabled = false,
}: NvsCalibrationCardProps) {
  const confirm = useConfirm();
  const [intervalMs, setIntervalMs] = useState<number>(
    device.settings.telemetryIntervalMs || 30000,
  );
  const [soilDry, setSoilDry] = useState<number>(device.settings.soilRawDry || 3000);
  const [soilWet, setSoilWet] = useState<number>(device.settings.soilRawWet || 1200);

  const [phase, setPhase] = useState<'idle' | 'sending' | 'waiting_ack'>('idle');
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'warning' | 'error';
    message: string;
  } | null>(null);

  const opGenRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Reinicializa valores e cancela espera pendente ao trocar de estação
  useEffect(() => {
    opGenRef.current += 1;
    abortControllerRef.current?.abort();
    setPhase('idle');
    setFeedback(null);
    setIntervalMs(device.settings.telemetryIntervalMs || 30000);
    setSoilDry(device.settings.soilRawDry || 3000);
    setSoilWet(device.settings.soilRawWet || 1200);

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [device.id]);

  // Sincroniza quando novos valores confirmados chegam do Firestore em repouso
  useEffect(() => {
    if (phase === 'idle') {
      setIntervalMs(device.settings.telemetryIntervalMs || 30000);
      setSoilDry(device.settings.soilRawDry || 3000);
      setSoilWet(device.settings.soilRawWet || 1200);
    }
  }, [
    phase,
    device.settings.telemetryIntervalMs,
    device.settings.soilRawDry,
    device.settings.soilRawWet,
  ]);

  const intervalOptions = useMemo(() => {
    if (INTERVAL_PRESETS.some((p) => p.ms === intervalMs)) {
      return [...INTERVAL_PRESETS];
    }
    return [
      ...INTERVAL_PRESETS,
      {
        ms: intervalMs,
        label: `Personalizado (${Math.round(intervalMs / 1000)}s)`,
      },
    ];
  }, [intervalMs]);

  const handleSendNvsConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || phase !== 'idle') return;
    setFeedback(null);

    if (
      !Number.isFinite(soilDry) ||
      !Number.isFinite(soilWet) ||
      soilDry < 100 ||
      soilDry > 4080 ||
      soilWet < 100 ||
      soilWet > 4080
    ) {
      setFeedback({
        type: 'error',
        message: 'Os valores ADC de calibração devem estar dentro da faixa física (100 a 4080).',
      });
      return;
    }

    if (soilDry - soilWet < 100) {
      setFeedback({
        type: 'error',
        message: `Margem insuficiente: Solo Seco (${soilDry}) deve ser pelo menos 100 unidades maior que Solo Molhado (${soilWet}).`,
      });
      return;
    }

    // v5.46.0: gravar na memória da placa muda como a umidade do solo é calculada — perguntar antes
    const ok = await confirm({
      title: 'Gravar a calibração na estação?',
      message: `Intervalo ${Math.round(intervalMs / 1000)} s · solo seco ${soilDry} · solo molhado ${soilWet}. A placa passa a usar esses valores imediatamente e os guarda mesmo após reiniciar.`,
      confirmLabel: 'Gravar na estação',
      tone: 'primary',
    });
    if (!ok) return;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const currentGen = ++opGenRef.current;
    const targetDeviceId = device.id;
    const stableCmdId = generateClientCommandId('cfg');

    try {
      setPhase('sending');
      const res = await sendHardwareConfigCommand({
        deviceId: targetDeviceId,
        telemetryIntervalMs: intervalMs,
        soilRawDry: soilDry,
        soilRawWet: soilWet,
        commandId: stableCmdId,
        signal: controller.signal,
      });

      if (currentGen !== opGenRef.current) return;

      setPhase('waiting_ack');
      const ack = await waitForCommandAck({
        deviceId: targetDeviceId,
        commandId: res.commandId,
        targetStatuses: ['done', 'failed', 'error', 'publish_failed'],
        timeoutMs: 15_000,
        signal: controller.signal,
      });

      if (currentGen !== opGenRef.current) return;

      const isAccepted =
        ack.status === 'done' &&
        ack.result !== 'failed' &&
        ack.reason !== 'invalid_calibration';

      if (isAccepted) {
        setFeedback({
          type: 'success',
          message: `ACK recebido (${res.commandId}): a estação ESP32 confirmou a aplicação dos parâmetros (${Math.round(
            intervalMs / 1000,
          )}s | Seco ${soilDry} | Molhado ${soilWet}).`,
        });
      } else {
        setFeedback({
          type: 'error',
          message: `A estação recusou ou reportou falha na calibração (${
            ack.reason || ack.error || 'erro'
          }).`,
        });
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') return;
      if (currentGen !== opGenRef.current) return;

      const msg = (err as Error)?.message || '';
      if (msg === 'TIMEOUT_ACK') {
        setFeedback({
          type: 'warning',
          message: `Comando (${stableCmdId}) enviado ao broker MQTT, mas a estação não confirmou em 15s.`,
        });
      } else {
        setFeedback({
          type: 'error',
          message: msg || 'Falha ao enviar calibração remota NVS.',
        });
      }
    } finally {
      if (currentGen === opGenRef.current) {
        setPhase('idle');
      }
    }
  };

  const isBusy = phase !== 'idle';

  return (
    <div className="bg-surface rounded-2xl border border-line p-6 shadow-sm">
      <div className="flex items-center gap-3 border-b border-line pb-4 mb-5">
        <div className="p-2.5 rounded-xl bg-amber-100 text-warning">
          <Sliders className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-base font-extrabold text-ink">
            Calibração Remota de Hardware & Intervalo (Flash NVS ESP32)
          </h2>
          <p className="text-xs text-ink-muted">
            Envia comando MQTT <code>action: &quot;config&quot;</code> e desperta a telemetria
            imediatamente (Instant Wakeup v5.22.3)
          </p>
        </div>
      </div>

      <form onSubmit={handleSendNvsConfig} className="space-y-4">
        {/* Intervalo de Coleta */}
        <div>
          <span className="block text-xs font-bold text-ink mb-2">
            Frequência de Envio de Telemetria (Bancada vs. Campo)
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {intervalOptions.map((preset) => {
              const active = intervalMs === preset.ms;
              return (
                <button
                  key={preset.ms}
                  type="button"
                  disabled={disabled || isBusy}
                  aria-pressed={active}
                  onClick={() => setIntervalMs(preset.ms)}
                  className={`p-3 rounded-xl border text-left transition disabled:opacity-50 ${
                    active
                      ? 'bg-brand-soft/45 border-brand text-brand-strong font-extrabold'
                      : 'bg-sunken/60 border-line text-ink-muted hover:text-ink font-semibold'
                  }`}
                >
                  <span className="text-xs block">{preset.label}</span>
                  <span className="text-[11px] font-mono opacity-80">
                    {preset.ms.toLocaleString('pt-BR')} ms
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Limites ADC 12-bit do Sensor Capacitivo de Solo */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <div className="p-4 rounded-xl bg-sunken/60 border border-line">
            <label
              htmlFor="nvs-soil-dry"
              className="block text-xs font-bold text-ink mb-1"
            >
              ADC Solo 100% Seco (Ar Livre: 100..4080)
            </label>
            <input
              id="nvs-soil-dry"
              type="number"
              disabled={disabled || isBusy}
              min={100}
              max={4080}
              value={soilDry}
              onChange={(e) => setSoilDry(Number(e.target.value))}
              className="w-full px-3.5 py-2 rounded-lg border border-line bg-surface text-sm font-mono font-bold text-ink disabled:bg-slate-100"
            />
            <span className="text-xs text-ink-muted mt-1 block">
              Padrão de fábrica: 3000 (0% de umidade)
            </span>
          </div>

          <div className="p-4 rounded-xl bg-sunken/60 border border-line">
            <label
              htmlFor="nvs-soil-wet"
              className="block text-xs font-bold text-ink mb-1"
            >
              ADC Solo 100% Molhado (Saturado: 100..4080)
            </label>
            <input
              id="nvs-soil-wet"
              type="number"
              disabled={disabled || isBusy}
              min={100}
              max={4080}
              value={soilWet}
              onChange={(e) => setSoilWet(Number(e.target.value))}
              className="w-full px-3.5 py-2 rounded-lg border border-line bg-surface text-sm font-mono font-bold text-ink disabled:bg-slate-100"
            />
            <span className="text-xs text-ink-muted mt-1 block">
              Padrão de fábrica: 1200 (100% de umidade)
            </span>
          </div>
        </div>

        {feedback && (
          <div
            role="status"
            aria-live="polite"
            className={`p-3.5 rounded-xl border flex items-center gap-2.5 text-xs font-semibold ${
              feedback.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-brand'
                : feedback.type === 'warning'
                  ? 'bg-amber-50 border-amber-200 text-warning'
                  : 'bg-red-50 border-red-200 text-danger'
            }`}
          >
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{feedback.message}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          <span className="text-xs font-medium text-ink-muted flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5 text-brand" />
            Delta ADC atual: <strong>{soilDry - soilWet}</strong> (mínimo exigido: 100)
          </span>

          <button
            type="submit"
            disabled={disabled || isBusy || !device.isOnline}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#F57C00] hover:bg-amber-700 text-white text-xs font-extrabold shadow-sm transition disabled:opacity-50"
          >
            {isBusy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            <span>
              {phase === 'sending'
                ? 'Enviando para a nuvem…'
                : phase === 'waiting_ack'
                  ? 'Aguardando confirmação da estação…'
                  : 'Gravar calibração na estação'}
            </span>
          </button>
        </div>
      </form>
    </div>
  );
}