/**
 * =====================================================================================
 * ARQUIVO: src/features/station-settings/components/OperationalSettingsCard.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T01:05:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Card de configurações operacionais no Cloud Firestore: Nome Amigável da
 *            Estação, Meta de Umidade do Solo (0..100%), Tempo de Rega Manual (1..15m)
 *            e Fuso Horário.
 * CHANGELOG:
 * - v5.25.0: [Auditorias 04 e 05]
 *            1. Suporte à prop `disabled` para desabilitar controles nativos no modo
 *               Recrutador (`isDemoUser`), impedindo navegação/submissão via teclado;
 *            2. Preserva valores de `targetMoisture` e `timezoneOffset` fora dos
 *               presets padrão.
 * =====================================================================================
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Sprout,
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Tag,
  Clock,
  Globe,
} from 'lucide-react';
import { DeviceModel } from '../../devices/model/device.types';
import { updateDeviceOperationalSettings } from '../../devices/api/deviceRepository';

interface OperationalSettingsCardProps {
  device: DeviceModel;
  disabled?: boolean;
}

const DEFAULT_TIMEZONES = [
  { offset: -3, label: 'UTC-3 (Horário de Brasília — SC / RS / SP)' },
  { offset: -4, label: 'UTC-4 (Amazonas / Mato Grosso)' },
  { offset: -2, label: 'UTC-2 (Fernando de Noronha)' },
  { offset: 0, label: 'UTC+0 (Tempo Universal Coordenado)' },
];

export function OperationalSettingsCard({
  device,
  disabled = false,
}: OperationalSettingsCardProps) {
  const [deviceName, setDeviceName] = useState(device.settings.deviceName);
  const [targetMoisture, setTargetMoisture] = useState(device.settings.targetMoisture);
  const [manualDuration, setManualDuration] = useState(device.settings.manualDuration);
  const [timezoneOffset, setTimezoneOffset] = useState(device.settings.timezoneOffset);

  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  useEffect(() => {
    setDeviceName(device.settings.deviceName);
    setTargetMoisture(device.settings.targetMoisture);
    setManualDuration(device.settings.manualDuration);
    setTimezoneOffset(device.settings.timezoneOffset);
    setFeedback(null);
  }, [
    device.id,
    device.settings.deviceName,
    device.settings.targetMoisture,
    device.settings.manualDuration,
    device.settings.timezoneOffset,
  ]);

  const timezoneOptions = useMemo(() => {
    if (DEFAULT_TIMEZONES.some((tz) => tz.offset === timezoneOffset)) {
      return DEFAULT_TIMEZONES;
    }
    const sign = timezoneOffset >= 0 ? `+${timezoneOffset}` : String(timezoneOffset);
    return [
      ...DEFAULT_TIMEZONES,
      { offset: timezoneOffset, label: `UTC${sign} (Fuso Personalizado)` },
    ];
  }, [timezoneOffset]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setFeedback(null);

    if (!deviceName.trim()) {
      setFeedback({ type: 'error', message: 'Informe um nome válido para a estação.' });
      return;
    }

    const originDeviceId = device.id;
    setIsSaving(true);
    try {
      await updateDeviceOperationalSettings(originDeviceId, {
        deviceName: deviceName.trim(),
        targetMoisture,
        manualDuration,
        timezoneOffset,
      });
      setFeedback({
        type: 'success',
        message: 'Parâmetros operacionais sincronizados no Cloud Firestore!',
      });
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        message: (err as Error)?.message || 'Falha ao salvar configurações.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="bg-surface rounded-2xl border border-line p-6 shadow-sm">
      <div className="flex items-center gap-3 border-b border-line pb-4 mb-5">
        <div className="p-2.5 rounded-xl bg-brand-soft/60 text-brand-strong">
          <Sprout className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-base font-extrabold text-ink">
            Parâmetros Operacionais de Irrigação
          </h2>
          <p className="text-xs text-ink-muted">
            Sincronizados em tempo real com o agendador AWS Lambda e o aplicativo Android
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Nome da Estação */}
          <div>
            <label
              htmlFor="op-device-name"
              className="block text-xs font-bold text-ink mb-1.5"
            >
              Nome Amigável da Estação
            </label>
            <div className="relative">
              <Tag className="w-4 h-4 text-ink-muted absolute left-3.5 top-3" />
              <input
                id="op-device-name"
                type="text"
                disabled={disabled || isSaving}
                maxLength={60}
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-line text-sm font-semibold focus:outline-none focus:border-brand disabled:bg-slate-100"
              />
            </div>
          </div>

          {/* Fuso Horário de Exibição */}
          <div>
            <label
              htmlFor="op-timezone-select"
              className="block text-xs font-bold text-ink mb-1.5"
            >
              Fuso Horário de Exibição da Estação
            </label>
            <div className="relative">
              <Globe className="w-4 h-4 text-ink-muted absolute left-3.5 top-3" />
              <select
                id="op-timezone-select"
                disabled={disabled || isSaving}
                value={timezoneOffset}
                onChange={(e) => setTimezoneOffset(Number(e.target.value))}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-line text-sm font-semibold bg-surface focus:outline-none focus:border-brand disabled:bg-slate-100"
              >
                {timezoneOptions.map((tz) => (
                  <option key={tz.offset} value={tz.offset}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Sliders de Meta de Umidade e Duração Manual */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 rounded-xl bg-sunken/60 border border-line space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="op-target-moisture"
                className="text-xs font-bold text-ink"
              >
                Meta de Umidade do Solo
              </label>
              <span className="px-2.5 py-0.5 rounded-full bg-brand-soft text-brand-strong text-xs font-extrabold">
                {targetMoisture}%
              </span>
            </div>
            <p className="text-xs text-ink-muted">
              Agendamentos são ignorados automaticamente se o solo já estiver ≥ {targetMoisture}%.
            </p>
            <input
              id="op-target-moisture"
              type="range"
              disabled={disabled || isSaving}
              min={0}
              max={100}
              step={1}
              value={targetMoisture}
              onChange={(e) => setTargetMoisture(Number(e.target.value))}
              className="w-full accent-[#2E7D32] cursor-pointer"
            />
          </div>

          <div className="p-4 rounded-xl bg-sunken/60 border border-line space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="op-manual-duration"
                className="text-xs font-bold text-ink flex items-center gap-1.5"
              >
                <Clock className="w-3.5 h-3.5 text-info" />
                Duração da Rega Manual
              </label>
              <span className="px-2.5 py-0.5 rounded-full bg-blue-100 text-info text-xs font-extrabold">
                {manualDuration} min
              </span>
            </div>
            <p className="text-xs text-ink-muted">
              Tempo padrão ao acionar o botão manual na aba Monitor (teto físico: 15 min).
            </p>
            <input
              id="op-manual-duration"
              type="range"
              disabled={disabled || isSaving}
              min={1}
              max={15}
              step={1}
              value={manualDuration}
              onChange={(e) => setManualDuration(Number(e.target.value))}
              className="w-full accent-[#1976D2] cursor-pointer"
            />
          </div>
        </div>

        {feedback && (
          <div
            role="status"
            aria-live="polite"
            className={`p-3.5 rounded-xl border flex items-center gap-2.5 text-xs font-semibold ${
              feedback.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-brand'
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

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={disabled || isSaving}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand hover:bg-brand-strong text-white text-xs font-extrabold shadow-sm transition disabled:opacity-50"
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            <span>Salvar parâmetros</span>
          </button>
        </div>
      </form>
    </div>
  );
}