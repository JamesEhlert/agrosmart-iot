/**
 * =====================================================================================
 * ARQUIVO: src/app/router/appRouter.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T09:00:00Z (UTC)
 * VERSÃO: v5.43.0 (páginas sob demanda com pré-carga, esqueleto de página e 404)
 * PROPÓSITO: Roteador principal com rotas separadas para Gráficos (`/charts`),
 *            Histórico de Leituras (`/readings`) e Guia & Simulador (`/about`).
 * =====================================================================================
 */

import { Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Sprout } from 'lucide-react';
import { useAuth } from '../../features/auth/hooks/useAuth';
import { AppShell } from '../layouts/AppShell';
import { LoginPage } from '../../pages/LoginPage';
// v5.43.0: páginas sob demanda (cada uma num arquivo próprio, pré-carregadas pelo menu)
import {
  AboutProjectPage,
  ChartsPage,
  DesignSystemPage,
  LogsPage,
  MonitorPage,
  NotFoundPage,
  PublicAboutPage,
  ReadingsHistoryPage,
  SchedulesPage,
  SettingsPage,
} from './lazyPages';
import { FullPageFallback, PageFallback } from './PageFallback';

function SplashLoadingScreen() {
  return (
    <div className="min-h-screen min-h-dvh flex flex-col items-center justify-center bg-canvas">
      <div className="p-4 rounded-full bg-brand-soft/50 text-brand mb-4">
        <Sprout className="w-10 h-10" />
      </div>
      <h1 className="text-xl font-bold text-ink">AgroSmart V5</h1>
      <div className="mt-5 w-7 h-7 border-4 border-brand border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export function AppRouter() {
  const { user, isAuthLoading } = useAuth();

  // v5.43.0: com login confirmado, já baixa o Monitor (primeira tela) em paralelo.
  useEffect(() => {
    if (user) MonitorPage.preload().catch(() => { /* tenta de novo ao abrir */ });
  }, [user]);

  if (isAuthLoading) {
    return <SplashLoadingScreen />;
  }

  return (
    <BrowserRouter>
      {user ? (
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Navigate to="/monitor" replace />} />
            <Route path="/monitor" element={<Suspense fallback={<PageFallback />}><MonitorPage /></Suspense>} />
            <Route path="/charts" element={<Suspense fallback={<PageFallback />}><ChartsPage /></Suspense>} />
            <Route path="/readings" element={<Suspense fallback={<PageFallback />}><ReadingsHistoryPage /></Suspense>} />
            <Route path="/schedules" element={<Suspense fallback={<PageFallback />}><SchedulesPage /></Suspense>} />
            <Route path="/logs" element={<Suspense fallback={<PageFallback />}><LogsPage /></Suspense>} />
            <Route path="/settings" element={<Suspense fallback={<PageFallback />}><SettingsPage /></Suspense>} />
            <Route path="/about" element={<Suspense fallback={<PageFallback />}><AboutProjectPage /></Suspense>} />
            {/* v5.44.0: vitrine do design system */}
            <Route path="/design" element={<Suspense fallback={<PageFallback />}><DesignSystemPage /></Suspense>} />
            <Route path="/sobre" element={<Navigate to="/about" replace />} />
            <Route path="/history" element={<Navigate to="/charts" replace />} />
            <Route path="/login" element={<Navigate to="/monitor" replace />} />
            {/* v5.43.0: endereço inexistente mostra uma página 404 em vez de voltar ao Monitor calado */}
            <Route path="*" element={<Suspense fallback={<PageFallback />}><NotFoundPage /></Suspense>} />
          </Route>
        </Routes>
      ) : (
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          {/* v5.41.0: apresentação pública (estática, sem dados da estação) */}
          <Route path="/sobre" element={<Suspense fallback={<FullPageFallback />}><PublicAboutPage /></Suspense>} />
          <Route path="/about" element={<Navigate to="/sobre" replace />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      )}
    </BrowserRouter>
  );
}