/**
 * =====================================================================================
 * ARQUIVO: src/features/station-settings/components/WeatherGpsCard.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T01:05:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Configuração de Inteligência Climática Hiperlocal (Open-Meteo 3h) e
 *            captura de coordenadas GPS pelo navegador (com atalhos para SC e RS).
 * CHANGELOG:
 * - v5.25.0: [Auditorias 04 e 05 - GPS-1 / GPS-2]
 *            1. Rejeita campos vazios (`latStr.trim() === ''`) antes de converter para
 *               `Number`, impedindo gravar `0` por acidente;
 *            2. Exige coordenadas diferentes de `(0, 0)` quando a IA Climática for
 *               ativada;
 *            3. Protege o callback de geolocalização do navegador com geração de
 *               operação para não sobrescrever outra estação ou edições manuais;
 *            4. Suporte a `disabled` nativo para contas de demonstração (`isDemoUser`).
 * =====================================================================================
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  CloudRain,
  MapPin,
  Navigation,
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { DeviceModel } from '../../devices/model/device.types';
import { updateDeviceOperationalSettings } from '../../devices/api/deviceRepository';

interface WeatherGpsCardProps {
  device: DeviceModel;
  disabled?: boolean;
}

const CITY_PRESETS = [
  { label: 'Florianópolis / SC', lat: -27.5954, lon: -48.548 },
  { label: 'Itajaí / SC', lat: -26.9078, lon: -48.6619 },
  { label: 'Porto Alegre / RS', lat: -30.0346, lon: -51.2177 },
] as const;

export function WeatherGpsCard({ device, disabled = false }: WeatherGpsCardProps) {
  const [enableWeather, setEnableWeather] = useState(
    device.settings.enableWeatherControl,
  );
  const [latStr, setLatStr] = useState(String(device.settings.latitude));
  const [lonStr, setLonStr] = useState(String(device.settings.longitude));

  const [isLocating, setIsLocating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const gpsRequestGenRef = useRef<number>(0);

  useEffect(() => {
    gpsRequestGenRef.current += 1;
    setIsLocating(false);
    setEnableWeather(device.settings.enableWeatherControl);
    setLatStr(String(device.settings.latitude));
    setLonStr(String(device.settings.longitude));
    setFeedback(null);
  }, [
    device.id,
    device.settings.enableWeatherControl,
    device.settings.latitude,
    device.settings.longitude,
  ]);

  const handleBrowserGps = () => {
    if (disabled) return;
    setFeedback(null);
    if (!('geolocation' in navigator)) {
      setFeedback({
        type: 'error',
        message: 'Este navegador não suporta geolocalização HTML5.',
      });
      return;
    }

    const currentGen = ++gpsRequestGenRef.current;
    setIsLocating(true);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (currentGen !== gpsRequestGenRef.current) return;
        setLatStr(pos.coords.latitude.toFixed(5));
        setLonStr(pos.coords.longitude.toFixed(5));
        setIsLocating(false);
        setFeedback({
          type: 'success',
          message:
            'Posição deste aparelho capturada como rascunho! Clique em Salvar Clima & GPS para confirmar.',
        });
      },
      (err) => {
        if (currentGen !== gpsRequestGenRef.current) return;
        setIsLocating(false);
        setFeedback({
          type: 'error',
          message: `Não foi possível obter a posição do navegador (${err.message}). Use um atalho ou digite manualmente.`,
        });
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setFeedback(null);

    const cleanLat = latStr.trim();
    const cleanLon = lonStr.trim();

    if (!cleanLat || !cleanLon) {
      setFeedback({
        type: 'error',
        message: 'Preencha ambos os campos de Latitude e Longitude antes de salvar.',
      });
      return;
    }

    const parsedLat = Number(cleanLat);
    const parsedLon = Number(cleanLon);

    if (
      !Number.isFinite(parsedLat) ||
      !Number.isFinite(parsedLon) ||
      parsedLat < -90 ||
      parsedLat > 90 ||
      parsedLon < -180 ||
      parsedLon > 180
    ) {
      setFeedback({
        type: 'error',
        message: 'Informe coordenadas GPS válidas (Latitude -90..90 e Longitude -180..180).',
      });
      return;
    }

    if (enableWeather && parsedLat === 0 && parsedLon === 0) {
      setFeedback({
        type: 'error',
        message:
          'Para ativar a Inteligência Climática Open-Meteo, informe coordenadas GPS reais diferentes de (0, 0).',
      });
      return;
    }

    const originDeviceId = device.id;
    setIsSaving(true);
    try {
      await updateDeviceOperationalSettings(originDeviceId, {
        enableWeatherControl: enableWeather,
        latitude: parsedLat,
        longitude: parsedLon,
      });
      setFeedback({
        type: 'success',
        message: 'Configuração de Inteligência Climática e GPS salva no Cloud Firestore!',
      });
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        message: (err as Error)?.message || 'Erro ao salvar coordenadas GPS.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const isDirtyToggle = enableWeather !== device.settings.enableWeatherControl;

  return (
    <div className="bg-surface rounded-2xl border border-line p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-line pb-4 mb-5">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2.5 rounded-xl bg-blue-100 text-info">
            <CloudRain className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-extrabold text-ink">
              Clima e localização (Open-Meteo, 3 h)
            </h2>
            <p className="text-xs text-ink-muted">
              Suspende agendamentos automaticamente se a previsão indicar ≥ 70% de chance de chuva
            </p>
          </div>
        </div>

        <label className="inline-flex items-center gap-2 cursor-pointer shrink-0">
          <span className="text-xs font-bold text-ink">
            {enableWeather ? 'IA Climática Ativa' : 'Desativada'}
            {isDirtyToggle ? ' (não salvo)' : ''}
          </span>
          <input
            type="checkbox"
            disabled={disabled || isSaving}
            checked={enableWeather}
            onChange={(e) => setEnableWeather(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-slate-300 rounded-full peer peer-checked:bg-[#2E7D32] relative after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5" />
        </label>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="gps-lat-input"
              className="block text-xs font-bold text-ink mb-1.5"
            >
              Latitude ( Decimal )
            </label>
            <div className="relative">
              <MapPin className="w-4 h-4 text-ink-muted absolute left-3.5 top-3" />
              <input
                id="gps-lat-input"
                type="number"
                step="any"
                disabled={disabled || isSaving}
                value={latStr}
                onChange={(e) => {
                  gpsRequestGenRef.current += 1;
                  setIsLocating(false);
                  setLatStr(e.target.value);
                }}
                placeholder="-27.5954"
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-line text-sm font-mono font-bold focus:outline-none focus:border-brand disabled:bg-slate-100"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="gps-lon-input"
              className="block text-xs font-bold text-ink mb-1.5"
            >
              Longitude ( Decimal )
            </label>
            <div className="relative">
              <MapPin className="w-4 h-4 text-ink-muted absolute left-3.5 top-3" />
              <input
                id="gps-lon-input"
                type="number"
                step="any"
                disabled={disabled || isSaving}
                value={lonStr}
                onChange={(e) => {
                  gpsRequestGenRef.current += 1;
                  setIsLocating(false);
                  setLonStr(e.target.value);
                }}
                placeholder="-48.5480"
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-line text-sm font-mono font-bold focus:outline-none focus:border-brand disabled:bg-slate-100"
              />
            </div>
          </div>
        </div>

        {/* Botão de Captura GPS do Aparelho + Atalhos Regionais */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="button"
            disabled={disabled || isLocating || isSaving}
            onClick={handleBrowserGps}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-info text-info hover:bg-blue-50 text-xs font-bold transition disabled:opacity-50"
          >
            {isLocating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Navigation className="w-4 h-4" />
            )}
            <span>Usar Posição Deste Aparelho (GPS)</span>
          </button>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-ink-muted mr-1">
              Atalhos rápidos:
            </span>
            {CITY_PRESETS.map((city) => (
              <button
                key={city.label}
                type="button"
                disabled={disabled || isSaving}
                onClick={() => {
                  gpsRequestGenRef.current += 1;
                  setIsLocating(false);
                  setLatStr(String(city.lat));
                  setLonStr(String(city.lon));
                  setEnableWeather(true);
                }}
                className="px-2.5 py-1 rounded-lg bg-sunken hover:bg-brand-soft/60 text-xs font-bold text-ink transition disabled:opacity-50"
              >
                {city.label}
              </button>
            ))}
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

        <div className="flex justify-end pt-2">
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
            <span>Salvar clima e GPS</span>
          </button>
        </div>
      </form>
    </div>
  );
}