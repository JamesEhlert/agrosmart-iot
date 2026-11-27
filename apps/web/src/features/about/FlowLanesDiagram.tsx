/**
 * =====================================================================================
 * ARQUIVO: src/features/about/FlowLanesDiagram.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T22:30:00Z (UTC)
 * VERSÃO: v5.40.0
 * PROPÓSITO: Diagrama animado da arquitetura em "raias" (WEB-16): cada raia é um fluxo
 *            (telemetria, comando, confirmação, agenda) e pontos coloridos percorrem o
 *            caminho. SVG puro + animateMotion: sem biblioteca, poucos KB. Com "reduzir
 *            movimento" ligado no sistema, mostra setas paradas. Caixas clicáveis.
 * =====================================================================================
 */

import { useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

type NodeKey =
  | 'esp'
  | 'iot'
  | 'rule'
  | 'ddb'
  | 'api'
  | 'web'
  | 'send'
  | 'ack'
  | 'fs'
  | 'eb'
  | 'sched';

const NODE_INFO: Record<NodeKey, { title: string; text: string }> = {
  esp: { title: 'Estação ESP32', text: 'Mede os sensores, controla a válvula e guarda leituras no cartão SD quando a internet cai. Confirma cada comando (ACK) e tem tempo máximo de rega na própria placa.' },
  iot: { title: 'AWS IoT Core', text: 'Servidor MQTT da AWS. A estação entra com um certificado só dela (TLS mútuo) e só pode publicar nos próprios tópicos; ela não consegue publicar comandos.' },
  rule: { title: 'Regra do IoT Core', text: 'Recebe cada leitura e grava direto no banco de séries temporais, sem servidor intermediário.' },
  ddb: { title: 'DynamoDB', text: 'Banco das leituras, organizado por estação e data. Consultas por período, paginadas com cursor assinado.' },
  api: { title: 'API Gateway + autorizador', text: 'Porta de entrada da API. Confere o login do Firebase em toda chamada e limita a quantidade de pedidos.' },
  web: { title: 'Aplicação web', text: 'React + TypeScript. Mostra os dados em tempo real, envia comandos e gera gráficos e CSV.' },
  send: { title: 'Função SendCommand', text: 'Confere se o usuário é dono da estação, aplica limites, registra o comando com um número único e o publica para a estação.' },
  ack: { title: 'Função AckToFirestore', text: 'Recebe a confirmação da estação, atualiza o comando e grava a auditoria. Comando desconhecido vira alerta de segurança.' },
  fs: { title: 'Cloud Firestore', text: 'Banco em tempo real do site: estado da estação, comandos, histórico e agendas, protegido por regras testadas.' },
  eb: { title: 'EventBridge Scheduler', text: 'Relógio da nuvem: dispara a verificação das agendas a cada minuto.' },
  sched: { title: 'Função Scheduler_Logic', text: 'Confere as agendas no horário da estação, a previsão do tempo e a umidade do solo; envia a rega ou registra por que pulou.' },
};

interface Lane {
  key: string;
  title: string;
  color: string;
  reverse?: boolean;
  dur: number;
  nodes: NodeKey[];
}

const LANES: Lane[] = [
  { key: 'tel', title: 'Telemetria', color: '#2E7D32', dur: 6, nodes: ['esp', 'iot', 'rule', 'ddb', 'web'] },
  { key: 'cmd', title: 'Comando do site', color: '#1976D2', reverse: true, dur: 5, nodes: ['esp', 'iot', 'send', 'api', 'web'] },
  { key: 'ack', title: 'Confirmação (ACK)', color: '#F57C00', dur: 5, nodes: ['esp', 'iot', 'ack', 'fs', 'web'] },
  { key: 'agenda', title: 'Agenda automática', color: '#7B1FA2', reverse: true, dur: 6, nodes: ['esp', 'iot', 'sched', 'eb', 'fs'] },
];

const SHORT: Record<NodeKey, string> = {
  esp: 'Estação ESP32',
  iot: 'AWS IoT Core',
  rule: 'Regra IoT',
  ddb: 'DynamoDB',
  api: 'API Gateway',
  web: 'Site (React)',
  send: 'SendCommand',
  ack: 'AckToFirestore',
  fs: 'Firestore',
  eb: 'EventBridge',
  sched: 'Scheduler',
};

const W = 1000;
const LANE_H = 86;
const BOX_W = 150;
const BOX_H = 40;
const COLS = [20, 225, 430, 635, 840];
const TOP = 30;

export function FlowLanesDiagram() {
  const reduced = usePrefersReducedMotion();
  const [selected, setSelected] = useState<NodeKey>('esp');
  const height = TOP + LANES.length * LANE_H;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-line bg-subtle">
        <svg viewBox={`0 0 ${W} ${height}`} className="min-w-[720px] w-full h-auto" role="img" aria-labelledby="flow-title flow-desc">
          <title id="flow-title">Fluxos de dados do AgroSmart</title>
          <desc id="flow-desc">
            Quatro fluxos: telemetria da estação até o site; comando do site até a estação; confirmação da estação até o site; agenda
            automática da nuvem até a estação.
          </desc>
          {['Campo', 'Conexão', 'Processamento', 'Dados / serviço', 'Usuário'].map((h, i) => (
            <text key={h} x={COLS[i] + BOX_W / 2} y={18} textAnchor="middle" className="fill-[#90A4AE]" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>
              {h.toUpperCase()}
            </text>
          ))}
          {LANES.map((lane, li) => {
            const cy = TOP + li * LANE_H + LANE_H / 2 + 4;
            const x0 = COLS[0] + BOX_W / 2;
            const x1 = COLS[4] + BOX_W / 2;
            const d = lane.reverse ? `M${x1},${cy} L${x0},${cy}` : `M${x0},${cy} L${x1},${cy}`;
            return (
              <g key={lane.key}>
                <text x={COLS[0]} y={cy - BOX_H / 2 - 8} style={{ fontSize: 11, fontWeight: 800 }} fill={lane.color}>
                  {lane.title}
                  {lane.reverse ? ' ←' : ' →'}
                </text>
                <path d={d} stroke={lane.color} strokeOpacity={0.35} strokeWidth={3} strokeDasharray="6 6" fill="none" />
                {!reduced &&
                  [0, 1, 2].map((k) => (
                    <circle key={k} r={5} fill={lane.color}>
                      <animateMotion dur={`${lane.dur}s`} begin={`${(k * lane.dur) / 3}s`} repeatCount="indefinite" path={d} />
                    </circle>
                  ))}
                {lane.nodes.map((n, ni) => {
                  const x = COLS[ni];
                  const active = selected === n;
                  return (
                    <g
                      key={`${lane.key}-${n}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${SHORT[n]}: ver detalhes`}
                      onClick={() => setSelected(n)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelected(n);
                        }
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      <rect
                        x={x}
                        y={cy - BOX_H / 2}
                        width={BOX_W}
                        height={BOX_H}
                        rx={10}
                        fill={active ? lane.color : '#FFFFFF'}
                        style={active ? undefined : { fill: 'var(--diagram-box, #FFFFFF)' }}
                        stroke={lane.color}
                        strokeWidth={active ? 2 : 1.5}
                      />
                      <text
                        x={x + BOX_W / 2}
                        y={cy + 4}
                        textAnchor="middle"
                        fill={active ? '#FFFFFF' : '#1C252C'}
                        style={{ fontSize: 12.5, fontWeight: 700, ...(active ? {} : { fill: 'var(--diagram-ink, #1C252C)' }) }}
                      >
                        {SHORT[n]}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="rounded-xl bg-surface border border-line p-3.5" aria-live="polite">
        <p className="text-sm font-extrabold text-ink">{NODE_INFO[selected].title}</p>
        <p className="text-xs text-ink-muted mt-1 leading-relaxed">{NODE_INFO[selected].text}</p>
        <p className="text-xs text-ink-muted mt-2">Clique numa caixa do diagrama para ver o que ela faz.</p>
      </div>
    </div>
  );
}
