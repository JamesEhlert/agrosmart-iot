import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// v5.44.0: paleta central (tokens) antes do Tailwind
import './app/styles/tokens.css';
import './app/styles/globals.css';
// v5.42.0: camada do tema escuro (gerada; precisa vir depois do Tailwind).
import './app/styles/theme-dark.css';
import App from './app/App';
import { installGlobalDiagnostics } from './shared/lib/diagnostics';

// Fase 4.0-B: erros globais, rede, visibilidade e tempos de carregamento no registro.
installGlobalDiagnostics();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);