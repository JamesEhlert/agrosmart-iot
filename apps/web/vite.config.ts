/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Versao unica do web (package.json) e instante do build, injetados no bundle (Fase 4.0-B).
const pkgVersion = String(
  (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version?: string })
    .version ?? '0.0.0',
);

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __APP_BUILD_UTC__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
    open: true,
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // v5.36.0 (WEB-05): ECharts modular; o pacote do gráfico só baixa na página de gráficos.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](echarts|zrender)[\\/]/.test(id)) return 'vendor-echarts';
          if (/[\\/]node_modules[\\/](@firebase|firebase)[\\/]/.test(id)) return 'vendor-firebase';
          // v5.43.0: ícones num pacote só (as páginas sob demanda reusam sem dezenas de arquivos minúsculos)
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons';
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|@tanstack|scheduler)[\\/]/.test(id)) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
  test: {
    // rules-tests/ roda no emulador do Firestore (Cloud Shell), nao no vitest do web
    exclude: ['**/node_modules/**', '**/dist/**', 'rules-tests/**'],
  },
});