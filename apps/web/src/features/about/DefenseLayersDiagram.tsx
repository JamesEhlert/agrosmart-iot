/**
 * =====================================================================================
 * ARQUIVO: src/features/about/DefenseLayersDiagram.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T23:50:00Z (UTC)
 * VERSÃO: v5.41.0
 * PROPÓSITO: "Defesa em camadas": o caminho de um comando do navegador até a válvula e o
 *            que cada camada confere. Um pulso desce de camada em camada (CSS leve, sem
 *            biblioteca); com "reduzir movimento" ligado no sistema, nada se move.
 * =====================================================================================
 */

import type { ReactNode } from 'react';
import type React from 'react';
import { Cloud, Cpu, Database, Globe, KeyRound, RadioTower, ServerCog } from 'lucide-react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

interface Layer {
  title: string;
  where: string;
  icon: ReactNode;
  color: string;
  /** Cor do texto (contraste AA sobre fundo claro). */
  ink: string;
  /** v5.42.0: cor do texto no tema escuro. */
  light: string;
  checks: string[];
}

export const DEFENSE_LAYERS: ReadonlyArray<Layer> = [
  {
    title: 'Navegador',
    where: 'Firebase Hosting',
    icon: <Globe className="w-4 h-4" />,
    color: '#1976D2',
    light: '#90CAF9',
    ink: '#0D47A1',
    checks: ['Política de conteúdo (CSP) e cabeçalhos de segurança', 'App Check contra robôs', 'Nenhum segredo no código do site'],
  },
  {
    title: 'Identidade',
    where: 'Firebase Authentication',
    icon: <KeyRound className="w-4 h-4" />,
    color: '#FF8F00',
    light: '#FFCC80',
    ink: '#8A4500',
    checks: ['Login Google para o titular', 'Passe temporário para convidados', 'Expiração e revogação a qualquer momento'],
  },
  {
    title: 'Porta de entrada',
    where: 'API Gateway + autorizador',
    icon: <ServerCog className="w-4 h-4" />,
    color: '#F57C00',
    light: '#FFB74D',
    ink: '#8F4200',
    checks: ['Token conferido em toda chamada', 'CORS só para o domínio oficial', 'Limite de pedidos por usuário'],
  },
  {
    title: 'Regras de negócio',
    where: 'Funções Lambda (Python)',
    icon: <Cloud className="w-4 h-4" />,
    color: '#E65100',
    light: '#FFAB91',
    ink: '#8F2F00',
    checks: ['Dono da estação conferido no servidor', 'Cada campo validado', 'Número único por comando', 'Permissões mínimas'],
  },
  {
    title: 'Dados',
    where: 'Firestore, DynamoDB e cofre de segredos',
    icon: <Database className="w-4 h-4" />,
    color: '#6A1B9A',
    light: '#CE93D8',
    ink: '#4A148C',
    checks: ['Regras do banco testadas em emulador', 'Auditoria que ninguém edita', 'Segredos criptografados na nuvem'],
  },
  {
    title: 'Mensageria IoT',
    where: 'AWS IoT Core (MQTT)',
    icon: <RadioTower className="w-4 h-4" />,
    color: '#00838F',
    light: '#80DEEA',
    ink: '#00525A',
    checks: ['TLS mútuo com certificado por estação', 'Cada estação só usa os próprios tópicos'],
  },
  {
    title: 'Estação',
    where: 'ESP32 + FreeRTOS',
    icon: <Cpu className="w-4 h-4" />,
    color: '#2E7D32',
    light: '#A5D6A7',
    ink: '#1B5E20',
    checks: ['Recusa comando velho, repetido ou forjado', 'Tempo máximo de válvula aberta', 'Só aceita firmware assinado', 'Válvula fechada ao religar'],
  },
];

export function DefenseLayersDiagram() {
  const reduced = usePrefersReducedMotion();
  return (
    <div data-testid="defense-layers">
      <div className="relative">
        <span aria-hidden="true" className="absolute left-[19px] top-5 bottom-5 border-l-2 border-dashed border-[#CFD8DC]" />
      <ol className="relative space-y-2.5" aria-label="Camadas de segurança, do navegador até a estação">
        {DEFENSE_LAYERS.map((l, i) => (
          <li key={l.title} className="relative flex gap-3 pl-0">
            <span
              className="relative z-10 shrink-0 w-10 h-10 rounded-xl text-white flex items-center justify-center shadow-sm"
              style={{ backgroundColor: l.color }}
              aria-hidden="true"
            >
              {!reduced && (
                <span
                  className="absolute inset-0 rounded-xl animate-ping"
                  style={{ backgroundColor: l.color, opacity: 0.35, animationDuration: '3.5s', animationDelay: `${i * 0.5}s` }}
                />
              )}
              <span className="relative">{l.icon}</span>
            </span>
            <div className="flex-1 min-w-0 rounded-xl border border-line bg-subtle px-3.5 py-2.5">
              <p className="text-sm font-extrabold text-ink">
                <span className="text-ink-muted font-bold mr-1.5">{i + 1}.</span>
                {l.title}
                <span className="ml-2 text-xs font-semibold text-ink-muted">{l.where}</span>
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {l.checks.map((c) => (
                  <span
                    key={c}
                    className="px-2 py-0.5 rounded-md text-xs font-semibold border text-[color:var(--chip-ink)] dark:text-[color:var(--chip-light)]"
                    style={{ ['--chip-ink' as string]: l.ink, ['--chip-light' as string]: l.light, borderColor: `${l.color}40`, backgroundColor: `${l.color}14` } as React.CSSProperties}
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ol>
      </div>
      <p className="mt-3 text-xs text-ink-muted leading-relaxed">
        Se uma camada falhar, a próxima ainda protege: por exemplo, mesmo que alguém esconda um botão na tela, o servidor confere a
        posse da estação; e mesmo que um comando forjado chegue à placa, ela o recusa e a nuvem registra um alerta.
      </p>
    </div>
  );
}
