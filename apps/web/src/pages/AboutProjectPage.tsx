/**
 * =====================================================================================
 * ARQUIVO: src/pages/AboutProjectPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T21:30:00Z (UTC)
 * VERSÃO: v5.41.0
 * PROPÓSITO: Página "Sobre o Projeto" (F1.4): o que é o AgroSmart, como funciona,
 *            arquitetura em 4 camadas, fluxos principais, segurança, robustez, hardware,
 *            dados e tecnologias. Pensada para titular, convidados e recrutadores.
 *            Não publica identificadores internos (contas, ARNs, e-mails, UIDs, IPs,
 *            regras completas, limiares de alarme, nomes de chaves).
 * CHANGELOG:
 * - v5.41.0: página também pública (`/sobre`, sem login); defesa em camadas (diagrama),
 *   decisões de engenharia, fluxo do botão físico da estação e autor/contato. Nada removido.
 * - v5.40.0 (WEB-16): diagrama animado dos fluxos (raias, SVG leve e clicável), linha do
 *   tempo de um comando com tempos medidos, modelo de dados em diagrama, linha do tempo do
 *   projeto, "Como foi testado" e próximos passos em Agora / Próximo / Futuro.
 * - v5.39.0 (F1.4): substitui o antigo "Guia & Simulador" (o simulador foi removido).
 * =====================================================================================
 */

import { ReactNode } from 'react';
import {
  Sprout,
  Cpu,
  Cloud,
  Flame,
  MonitorSmartphone,
  ArrowRight,
  ArrowDown,
  ShieldCheck,
  Zap,
  Database,
  CalendarClock,
  Download,
  UserCheck,
  Hand,
  Activity,
  HardDrive,
  Droplets,
  Thermometer,
  Sun,
  CloudRain,
  Sparkles,
  Lock,
  RefreshCw,
  CheckCircle2,
  Layers,
  Map as MapIcon,
  Timer,
  FlaskConical,
  History,
  Rocket,
  Telescope,
  Hourglass,
  Lightbulb,
  Contact,
  MousePointerClick,
  Github,
} from 'lucide-react';
import { FlowLanesDiagram } from '../features/about/FlowLanesDiagram';
import { CommandTimeline } from '../features/about/CommandTimeline';
import { DefenseLayersDiagram } from '../features/about/DefenseLayersDiagram';
import { AuthorContact } from '../features/about/AuthorContact';

const SECTIONS = [
  { id: 'visao', label: 'Visão geral' },
  { id: 'como', label: 'Como funciona' },
  { id: 'arquitetura', label: 'Arquitetura' },
  { id: 'diagrama', label: 'Fluxos animados' },
  { id: 'comando', label: 'Um comando' },
  { id: 'fluxos', label: 'Fluxos' },
  { id: 'seguranca', label: 'Segurança' },
  { id: 'robustez', label: 'Robustez' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'dados', label: 'Dados' },
  { id: 'decisoes', label: 'Decisões de engenharia' },
  { id: 'testes', label: 'Como foi testado' },
  { id: 'historia', label: 'Linha do tempo' },
  { id: 'stack', label: 'Tecnologias' },
  { id: 'roadmap', label: 'Próximos passos' },
  { id: 'contato', label: 'Contato' },
] as const;

function Section({ id, title, icon, children }: { id: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 bg-surface rounded-2xl border border-line p-5 lg:p-6 shadow-sm space-y-4">
      <h2 className="flex items-center gap-2.5 text-base font-extrabold text-ink">
        <span className="p-2 rounded-xl bg-brand-soft/60 text-brand-strong">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return <span className="inline-flex px-2.5 py-1 rounded-lg bg-sunken text-xs font-bold text-ink">{children}</span>;
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm text-ink-soft leading-relaxed">
      <CheckCircle2 className="w-4 h-4 text-brand shrink-0 mt-0.5" />
      <span>{children}</span>
    </li>
  );
}

const LAYERS: ReadonlyArray<{ title: string; subtitle: string; icon: ReactNode; tone: string; items: string[] }> = [
  {
    title: 'Estação ESP32',
    subtitle: 'Campo / bancada',
    icon: <Cpu className="w-5 h-5" />,
    tone: 'from-brand to-brand-strong',
    items: ['6 medições + válvula', 'FreeRTOS com tarefas separadas', 'Fila no cartão SD (offline)', 'OTA assinado com rollback'],
  },
  {
    title: 'Nuvem AWS',
    subtitle: 'Processamento',
    icon: <Cloud className="w-5 h-5" />,
    tone: 'from-[#F57C00] to-[#E65100]',
    items: ['IoT Core (MQTT com certificado)', 'API Gateway + autorizador', '5 funções Lambda (Python)', 'DynamoDB, S3, Scheduler'],
  },
  {
    title: 'Firebase',
    subtitle: 'Identidade e tempo real',
    icon: <Flame className="w-5 h-5" />,
    tone: 'from-[#FFA000] to-[#FF6F00]',
    items: ['Login Google (titular)', 'Passe temporário (convidados)', 'Firestore com regras testadas', 'Hosting com CSP'],
  },
  {
    title: 'Aplicação web',
    subtitle: 'Você está aqui',
    icon: <MonitorSmartphone className="w-5 h-5" />,
    tone: 'from-[#1976D2] to-[#0D47A1]',
    items: ['React + TypeScript', 'Atualização em tempo real', 'Gráficos e exportação', 'Funciona no celular'],
  },
];

const FLOWS: ReadonlyArray<{ title: string; icon: ReactNode; steps: string[]; note: string }> = [
  {
    title: 'Ligar a irrigação pelo site',
    icon: <Hand className="w-4 h-4" />,
    steps: [
      'Clique no botão',
      'API confere login e posse da estação',
      'Comando com número único (command_id)',
      'MQTT até a estação',
      'Válvula abre e a estação confirma (ACK)',
      'Tela atualiza em tempo real',
    ],
    note: 'Cerca de 1,2 a 1,5 s do clique à confirmação na tela. Repetir o mesmo command_id não abre a válvula duas vezes (idempotência).',
  },
  {
    title: 'Botão físico na estação',
    icon: <MousePointerClick className="w-4 h-4" />,
    steps: [
      'Segurar o botão por 1 s',
      'Mesmas proteções do site',
      'Evento com número único na memória da placa',
      'MQTT até a nuvem',
      'Nuvem registra e devolve um recibo',
      'Placa libera a vaga',
    ],
    note: 'Sem internet, o evento espera na memória e chega uma única vez quando a conexão volta. Pela internet ninguém consegue forjar um aperto: a placa recusa esse tipo de número vindo de fora.',
  },
  {
    title: 'Telemetria',
    icon: <Activity className="w-4 h-4" />,
    steps: ['Leitura dos sensores', 'Fila no cartão SD', 'MQTT', 'Regra do IoT Core', 'DynamoDB', 'Gráficos e histórico'],
    note: 'Se a internet cair, as leituras ficam no cartão SD e são reenviadas na volta, sem perder nem duplicar (testado com o roteador desligado).',
  },
  {
    title: 'Agendamentos',
    icon: <CalendarClock className="w-4 h-4" />,
    steps: ['Verificação a cada minuto', 'Confere a agenda no horário da estação', 'Confere chuva e umidade do solo', 'Envia o comando ou registra o motivo de pular'],
    note: 'Cada execução tem um identificador derivado da agenda e do horário: disparos duplicados no mesmo minuto não regam duas vezes.',
  },
  {
    title: 'Atualização de firmware (OTA)',
    icon: <Download className="w-4 h-4" />,
    steps: ['Versão assinada no computador do titular', 'Publicação na nuvem', 'Estação confere a assinatura antes de baixar', 'Confere de novo antes de gravar', 'Observa 90 s antes de aprovar'],
    note: 'A assinatura é conferida em 5 pontos. Se a versão nova falhar, a placa volta sozinha para a anterior (rollback).',
  },
  {
    title: 'Acesso de convidado (Demo)',
    icon: <UserCheck className="w-4 h-4" />,
    steps: ['Titular gera um passe com validade', 'Convidado entra sem conta Google', 'Sessão isolada e limitada', 'Expira ou é revogada a qualquer momento'],
    note: 'O convidado pode ligar a válvula por pouco tempo e criar até 5 agendas na sessão; não vê dados pessoais e não altera o que é do titular.',
  },
];

const DECISIONS: ReadonlyArray<{ problem: string; decision: string; why: string }> = [
  {
    problem: 'Rede instável pode entregar o mesmo comando duas vezes',
    decision: 'Cada comando tem um número único (command_id) e a placa lembra dos últimos',
    why: 'Repetir o pedido não abre a válvula de novo (idempotência). Vale para o site, as agendas e os botões.',
  },
  {
    problem: 'A segurança da válvula não pode depender da internet',
    decision: 'Tempo máximo e estado seguro decididos na própria placa',
    why: 'Se a nuvem ou o Wi-Fi caírem com a válvula aberta, ela fecha sozinha no prazo. Ao religar, começa fechada.',
  },
  {
    problem: 'Leituras e confirmações não podem se perder num reinício',
    decision: 'Fila no cartão SD e confirmações gravadas na memória permanente',
    why: 'A placa só apaga o que a nuvem confirmou ter recebido. Reenvio sem duplicar.',
  },
  {
    problem: 'Dados ao vivo e séries longas têm perfis diferentes',
    decision: 'Firestore para estado e auditoria; DynamoDB para as leituras',
    why: 'Tempo real com regras de acesso no site, e consultas por período baratas para milhares de leituras.',
  },
  {
    problem: 'Atualizar a placa pela internet abre uma porta de ataque',
    decision: 'Firmware assinado digitalmente, com a chave guardada fora da nuvem',
    why: 'A placa recusa qualquer versão sem a assinatura do autor e volta à anterior se a nova falhar.',
  },
  {
    problem: 'Recrutadores precisam testar sem riscos',
    decision: 'Passe de convidado com sessão isolada, validade e limites',
    why: 'O convidado aciona a válvula de verdade, mas não vê dados pessoais nem altera o que é do titular.',
  },
  {
    problem: 'O projeto precisa caber no nível gratuito da nuvem',
    decision: 'Consultas leves por padrão: páginas de 50 itens e períodos curtos',
    why: 'O site abre com 1 a 6 horas de dados; períodos longos só quando pedidos, com limite por consulta.',
  },
  {
    problem: 'Código feito com apoio de IA pode esconder falhas',
    decision: 'Revisão de segurança em camadas, testes automáticos e mudanças pequenas',
    why: 'Cada versão passa por testes, conferência de segredos e backup antes de ir ao ar, com caminho de volta.',
  },
];

const SENSORS: ReadonlyArray<{ icon: ReactNode; name: string; text: string }> = [
  { icon: <Thermometer className="w-4 h-4 text-[#FB8C00]" />, name: 'Temperatura e umidade do ar', text: 'sensor digital (I²C)' },
  { icon: <Sprout className="w-4 h-4 text-[#6D4C41]" />, name: 'Umidade do solo', text: 'sensor capacitivo calibrado (seco/encharcado)' },
  { icon: <Sun className="w-4 h-4 text-amber-600" />, name: 'Luminosidade', text: 'luz relativa de 0 a 100%' },
  { icon: <Sparkles className="w-4 h-4 text-[#8E24AA]" />, name: 'Índice UV', text: 'escala da OMS' },
  { icon: <CloudRain className="w-4 h-4 text-info" />, name: 'Chuva', text: 'placa resistiva; bloqueia a rega quando molhada' },
  { icon: <Droplets className="w-4 h-4 text-[#1E88E5]" />, name: 'Válvula solenoide', text: 'acionada por relé; estado seguro = fechada' },
];

const STACK: ReadonlyArray<{ group: string; items: string[] }> = [
  { group: 'Firmware', items: ['ESP32', 'C++ / Arduino', 'FreeRTOS', 'PlatformIO', 'MQTT + TLS mútuo', 'NVS', 'microSD'] },
  { group: 'Nuvem', items: ['AWS IoT Core', 'API Gateway', 'Lambda (Python)', 'DynamoDB', 'S3', 'EventBridge Scheduler', 'SSM Parameter Store', 'CloudWatch', 'CloudTrail'] },
  { group: 'Firebase', items: ['Authentication', 'Cloud Firestore', 'Hosting', 'App Check (reCAPTCHA Enterprise)'] },
  { group: 'Web', items: ['React 18', 'TypeScript', 'Vite', 'Tailwind CSS', 'TanStack Query', 'Apache ECharts', 'Zod', 'Vitest'] },
];

const TEST_STATS: ReadonlyArray<{ value: string; label: string; text: string }> = [
  { value: '270', label: 'testes automáticos do site', text: 'Regras de tela, filtros, CSV, agendas e proteções, rodados a cada versão.' },
  { value: '51', label: 'testes das regras do banco', text: 'Titular, convidado, intruso e anônimo, no emulador do Firestore, antes de publicar.' },
  { value: '12/12', label: 'testes de injeção MQTT', text: 'Comandos forjados, repetidos e acima do limite: todos tratados como esperado.' },
  { value: '0', label: 'leituras perdidas', text: 'Internet desligada por 7 minutos: a fila no cartão SD reenviou tudo, sem duplicar.' },
  { value: '3/3', label: 'ataques ao OTA recusados', text: 'Firmware adulterado, assinatura errada e versão antiga: a placa recusa.' },
  { value: '49', label: 'comandos de ponta a ponta', text: 'Robô de teste ligando e desligando a válvula, com 0 erros nas funções da nuvem.' },
  { value: '0', label: 'vulnerabilidades conhecidas', text: 'Dependências Python auditadas; segredos conferidos antes de cada commit.' },
  { value: '1,2–1,5 s', label: 'do clique à confirmação', text: 'Medido do navegador até a tela, passando pela estação e pela nuvem.' },
];

const MILESTONES: ReadonlyArray<{ title: string; text: string }> = [
  { title: 'TCC em Análise e Desenvolvimento de Sistemas', text: 'Primeira versão: ESP32 com sensores, válvula e controle pelo aplicativo.' },
  { title: 'V5: arquitetura em nuvem', text: 'AWS IoT Core, funções Lambda, DynamoDB e Firebase; site em React e TypeScript.' },
  { title: 'Revisão de segurança em camadas', text: 'Posse da estação conferida no servidor, regras do banco testadas, App Check, segredos protegidos e acesso de convidado isolado.' },
  { title: 'Firmware assinado', text: 'Atualização pela internet (OTA) com assinatura digital conferida em 5 pontos e volta automática se falhar.' },
  { title: 'Estação resiliente', text: 'Fila no cartão SD, confirmações duráveis, proteção contra rajadas e testes de queda de rede e de energia.' },
  { title: 'Site profissional', text: 'Auditoria com filtros e exclusão segura, agendamentos inteligentes, histórico com CSV, explicações e diagramas.' },
  { title: 'Controles na estação', text: 'Botões físicos de irrigação e display, com eventos rastreáveis confirmados pela nuvem, e página pública de apresentação.' },
  { title: 'Tema escuro e notificações', text: 'Tema claro, escuro ou automático e central de avisos: estação offline, sensores, chuva prevista, regas puladas, firmware novo e falhas.' },
  { title: 'Site rápido, acessível e no celular', text: 'Design system com tema claro e escuro, páginas sob demanda com orçamento de peso, janelas acessíveis, atalhos de teclado e versão para celular.' },
  { title: 'Código público com publicação segura', text: 'Repositório no GitHub gerado por um exportador que barra segredos e dados pessoais antes de qualquer arquivo sair do repositório privado.' },
];

const ROADMAP: ReadonlyArray<{ title: string; icon: ReactNode; tone: string; items: string[] }> = [
  {
    title: 'Agora',
    icon: <Hourglass className="w-4 h-4 text-brand" />,
    tone: 'border-[#A5D6A7] bg-brand-tint/50',
    items: ['Instalação da estação no jardim', 'Testes automáticos a cada envio ao GitHub (CI)', 'Diagramas e decisões de arquitetura no repositório público'],
  },
  {
    title: 'Próximo',
    icon: <Rocket className="w-4 h-4 text-info" />,
    tone: 'border-info-soft bg-info-tint/50',
    items: ['Firmware com recuperação automática de falhas', 'Proteção anti-robô obrigatória (App Check)', 'Gráficos de meses e anos com resumos por hora e por dia'],
  },
  {
    title: 'Futuro',
    icon: <Telescope className="w-4 h-4 text-[#7B1FA2]" />,
    tone: 'border-[#E1BEE7] bg-[#F3E5F5]/50',
    items: ['Versão 6: nova arquitetura com mais autonomia local', 'Engenharia de dados em camadas (bronze, prata e ouro) e painéis de BI', 'Indicadores de água economizada e regas evitadas'],
  },
];

export function AboutProjectPage() {
  return (
    <div className="space-y-5">
      {/* Capa */}
      <div id="visao" className="scroll-mt-28 rounded-2xl overflow-hidden shadow-sm border border-[#1B5E20]/20">
        <div className="bg-gradient-to-br from-brand-strong via-brand to-[#388E3C] text-white p-6 lg:p-8 space-y-4">
          <div className="flex items-center gap-3">
            <span className="p-3 rounded-2xl bg-white/15 border border-white/20">
              <Sprout className="w-7 h-7" />
            </span>
            <div>
              <h1 className="text-xl lg:text-2xl font-extrabold">AgroSmart Precision IoT</h1>
              <p className="text-sm text-white/85">Irrigação inteligente de ponta a ponta: do sensor no jardim à tela do celular.</p>
            </div>
          </div>
          <p className="text-sm text-white/90 max-w-3xl leading-relaxed">
            Uma estação com ESP32 mede o solo, o ar, a luz, o UV e a chuva, e controla uma válvula de irrigação. A nuvem guarda as
            leituras, executa os agendamentos levando o clima em conta e envia comandos com confirmação. Este site permite
            acompanhar tudo em tempo real, irrigar com um clique e auditar cada ação.
          </p>
          <div className="flex flex-wrap gap-2">
            {['Começou como TCC em Análise e Desenvolvimento de Sistemas', 'Versão 5 com revisão completa de segurança', 'Acesso de demonstração para convidados'].map((t) => (
              <span key={t} className="px-3 py-1 rounded-full bg-white/15 border border-white/20 text-xs font-bold">
                {t}
              </span>
            ))}
          </div>
          <a
            href="https://github.com/JamesEhlert/agrosmart-iot"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="repo-link"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white text-brand-strong text-sm font-extrabold shadow-sm hover:bg-white/90 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand"
          >
            <Github className="w-4 h-4" aria-hidden="true" />
            Ver o código no GitHub
          </a>
        </div>
        <nav className="bg-surface px-4 py-3 flex gap-2 overflow-x-auto" aria-label="Seções da página">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="shrink-0 px-3 py-1.5 rounded-xl bg-sunken text-xs font-bold text-ink-muted hover:text-brand-strong hover:bg-brand-soft/50 transition"
            >
              {s.label}
            </a>
          ))}
        </nav>
      </div>

      <Section id="como" title="Como funciona em 1 minuto" icon={<Zap className="w-4 h-4" />}>
        <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            ['Mede', 'A estação faz as 6 medições periodicamente e envia à nuvem por um canal criptografado.'],
            ['Decide', 'Na hora de uma agenda, a nuvem confere chuva, previsão e umidade do solo antes de regar.'],
            ['Age', 'A válvula abre por um tempo definido, com limite de segurança na própria placa.'],
            ['Confirma', 'A estação confirma cada ação; o site mostra o resultado e guarda tudo na auditoria.'],
          ].map(([t, d], i) => (
            <li key={t} className="rounded-xl bg-subtle border border-line p-4">
              <span className="inline-flex w-7 h-7 rounded-full bg-brand text-white text-xs font-extrabold items-center justify-center">{i + 1}</span>
              <p className="mt-2 text-sm font-extrabold text-ink">{t}</p>
              <p className="text-xs text-ink-muted mt-1 leading-relaxed">{d}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="arquitetura" title="Arquitetura em 4 camadas" icon={<Layers className="w-4 h-4" />}>
        <div className="flex flex-col lg:flex-row items-stretch gap-2">
          {LAYERS.map((l, i) => (
            <div key={l.title} className="flex flex-col lg:flex-row items-center gap-2 flex-1">
              <div className="w-full flex-1 rounded-2xl border border-line overflow-hidden bg-surface">
                <div className={`bg-gradient-to-br ${l.tone} text-white px-4 py-3 flex items-center gap-2.5`}>
                  {l.icon}
                  <div>
                    <p className="text-sm font-extrabold leading-tight">{l.title}</p>
                    <p className="text-xs text-white/85">{l.subtitle}</p>
                  </div>
                </div>
                <ul className="p-3 space-y-1.5">
                  {l.items.map((it) => (
                    <li key={it} className="text-xs text-ink-soft flex items-start gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-brand mt-1.5 shrink-0" />
                      {it}
                    </li>
                  ))}
                </ul>
              </div>
              {i < LAYERS.length - 1 && (
                <span className="text-[#78909C] shrink-0" aria-hidden="true">
                  <ArrowRight className="w-5 h-5 hidden lg:block" />
                  <ArrowDown className="w-5 h-5 lg:hidden" />
                </span>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-muted leading-relaxed">
          A estação só conversa com a AWS (MQTT com certificado próprio). O site usa o Firebase para login e dados em tempo real, e chama a
          API da AWS para comandos e telemetria. Cada função na nuvem tem permissões mínimas, só para o que precisa fazer.
        </p>
      </Section>

      <Section id="diagrama" title="Fluxos de dados (animado)" icon={<Activity className="w-4 h-4" />}>
        <p className="text-xs text-ink-muted leading-relaxed">
          Cada linha é um caminho que os dados percorrem. Os pontos coloridos mostram o sentido: leituras subindo da estação, comandos descendo
          do site e confirmações voltando.
        </p>
        <FlowLanesDiagram />
      </Section>

      <Section id="comando" title="Um comando, passo a passo" icon={<Timer className="w-4 h-4" />}>
        <CommandTimeline />
      </Section>

      <Section id="fluxos" title="Fluxos em detalhe" icon={<RefreshCw className="w-4 h-4" />}>
        <div className="space-y-4">
          {FLOWS.map((f) => (
            <div key={f.title} className="rounded-xl border border-line p-4 space-y-3">
              <p className="flex items-center gap-2 text-sm font-extrabold text-ink">
                <span className="p-1.5 rounded-lg bg-brand-soft/60 text-brand-strong">{f.icon}</span>
                {f.title}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {f.steps.map((s, i) => (
                  <span key={s} className="inline-flex items-center gap-1.5">
                    <span className="px-2.5 py-1 rounded-lg bg-[#F1F8E9] border border-[#C5E1A5] text-xs font-bold text-[#33691E]">{s}</span>
                    {i < f.steps.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-[#78909C]" aria-hidden="true" />}
                  </span>
                ))}
              </div>
              <p className="text-xs text-ink-muted leading-relaxed">{f.note}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="seguranca" title="Segurança por design" icon={<ShieldCheck className="w-4 h-4" />}>
        <p className="text-xs text-ink-muted leading-relaxed">
          Defesa em camadas: o caminho de um comando, do navegador até a válvula, e o que cada camada confere no caminho.
        </p>
        <DefenseLayersDiagram />
        <p className="text-sm font-extrabold text-ink pt-2">Em resumo</p>
        <ul className="grid md:grid-cols-2 gap-x-6 gap-y-2">
          <Bullet>Toda chamada à API exige login, e o servidor confere se o usuário é dono da estação (nada depende só da tela).</Bullet>
          <Bullet>Regras do banco de dados cobertas por testes automáticos no emulador (titular, convidado, intruso e anônimo).</Bullet>
          <Bullet>A estação tem um certificado só dela e não consegue publicar comandos: comando forjado vira alerta de segurança.</Bullet>
          <Bullet>Convidados com passe temporário, expiração, revogação, limites de uso e sessão isolada.</Bullet>
          <Bullet>Segredos guardados criptografados na nuvem; nada sensível no código, nos registros ou no navegador.</Bullet>
          <Bullet>Firmware assinado: uma versão adulterada é recusada pela placa antes de ser gravada.</Bullet>
          <Bullet>Origem do site restrita (CORS), cabeçalhos de segurança e política de conteúdo (CSP) no Hosting.</Bullet>
          <Bullet>Verificação de segredos antes de cada commit e dependências sem vulnerabilidades conhecidas.</Bullet>
          <Bullet>Alertas de segurança protegidos contra exclusão por 30 dias; ninguém edita a auditoria.</Bullet>
          <Bullet>Exportação CSV protegida contra “CSV injection” (fórmulas maliciosas no Excel).</Bullet>
        </ul>
      </Section>

      <Section id="robustez" title="Robustez da estação" icon={<HardDrive className="w-4 h-4" />}>
        <ul className="grid md:grid-cols-2 gap-x-6 gap-y-2">
          <Bullet>Válvula com tempo máximo de abertura na própria placa: mesmo sem internet, ela fecha sozinha.</Bullet>
          <Bullet>Ao religar após queda de energia, a válvula começa fechada (estado seguro).</Bullet>
          <Bullet>Confirmações (ACK) gravadas na memória da placa até a nuvem receber: nada se perde num reinício.</Bullet>
          <Bullet>Proteção contra comandos repetidos ou em rajada, com prioridade para o “desligar”.</Bullet>
          <Bullet>Comando antigo que chega depois da queda de rede é descartado, sem abrir a válvula.</Bullet>
          <Bullet>Watchdog, observação de 90 s após atualização e volta automática para a versão anterior.</Bullet>
        </ul>
      </Section>

      <Section id="hardware" title="Hardware" icon={<Cpu className="w-4 h-4" />}>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {SENSORS.map((s) => (
            <div key={s.name} className="flex items-start gap-2.5 rounded-xl bg-subtle border border-line p-3">
              <span className="mt-0.5">{s.icon}</span>
              <div>
                <p className="text-sm font-bold text-ink">{s.name}</p>
                <p className="text-xs text-ink-muted">{s.text}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-muted leading-relaxed">
          Também: display OLED, cartão microSD para a fila offline e LED de estado. O projeto elétrico de campo separa a alimentação do relé
          da placa e inclui proteção para a válvula de 220 V (dispositivo DR e supressão de surtos). Hoje a estação está em bancada; a
          instalação no jardim é um dos próximos passos.
        </p>
      </Section>

      <Section id="dados" title="Onde os dados ficam" icon={<Database className="w-4 h-4" />}>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-[#FFE0B2] bg-[#FFF8E1]/40 p-4">
            <p className="text-sm font-extrabold text-ink">Cloud Firestore · tempo real</p>
            <p className="text-xs text-ink-muted mb-3">O que o site mostra ao vivo e a auditoria.</p>
            <div className="font-mono text-[12px] leading-6 text-ink-soft">
              <div><strong>estações</strong> / {'{estação}'}</div>
              <div className="pl-5 border-l-2 border-[#FFCC80] ml-2">
                <div>configurações · estado da válvula · presença · firmware</div>
                <div><strong>comandos</strong> — cada pedido e o seu ACK</div>
                <div><strong>histórico</strong> — auditoria e alertas</div>
                <div><strong>agendas</strong> — rotinas semanais</div>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-[#C5CAE9] bg-[#E8EAF6]/40 p-4">
            <p className="text-sm font-extrabold text-ink">DynamoDB · série temporal</p>
            <p className="text-xs text-ink-muted mb-3">Uma linha por leitura enviada pela estação.</p>
            <div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-[12px]">
              <span className="px-2 py-0.5 rounded-md bg-[#3949AB] text-white font-bold text-[11px] h-fit">CHAVE</span>
              <span className="text-ink-soft"><strong>estação</strong> + <strong>data/hora</strong> (consulta por período é rápida)</span>
              <span className="px-2 py-0.5 rounded-md bg-[#7986CB] text-white font-bold text-[11px] h-fit">DADOS</span>
              <span className="text-ink-soft">solo, ar, luz, UV, chuva, válvula, sinal Wi-Fi, memória, firmware</span>
              <span className="px-2 py-0.5 rounded-md bg-[#9FA8DA] text-white font-bold text-[11px] h-fit">PRÓXIMO</span>
              <span className="text-ink-soft">resumos por hora e por dia para gráficos de meses e anos</span>
            </div>
          </div>
        </div>
      </Section>

      <Section id="decisoes" title="Decisões de engenharia" icon={<Lightbulb className="w-4 h-4" />}>
        <p className="text-xs text-ink-muted leading-relaxed">Problemas reais do projeto, a decisão tomada e o porquê.</p>
        <div className="grid md:grid-cols-2 gap-3">
          {DECISIONS.map((d) => (
            <div key={d.problem} className="rounded-xl border border-line bg-subtle p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-muted">Problema</p>
              <p className="text-sm font-bold text-ink leading-snug">{d.problem}</p>
              <p className="mt-2 text-xs font-bold uppercase tracking-wide text-brand">Decisão</p>
              <p className="text-sm text-brand-strong font-semibold leading-snug">{d.decision}</p>
              <p className="mt-2 text-xs text-ink-muted leading-relaxed">{d.why}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="testes" title="Como foi testado" icon={<FlaskConical className="w-4 h-4" />}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {TEST_STATS.map((s) => (
            <div key={s.label} className="rounded-xl bg-subtle border border-line p-3.5">
              <p className="text-xl font-extrabold text-brand-strong">{s.value}</p>
              <p className="text-xs font-bold text-ink mt-0.5">{s.label}</p>
              <p className="text-xs text-ink-muted mt-1 leading-snug">{s.text}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="historia" title="Linha do tempo do projeto" icon={<History className="w-4 h-4" />}>
        <ol className="relative border-l-2 border-brand-soft ml-2 space-y-4">
          {MILESTONES.map((m) => (
            <li key={m.title} className="pl-5 relative">
              <span className="absolute -left-[9px] top-1 w-4 h-4 rounded-full bg-brand border-2 border-white shadow" />
              <p className="text-sm font-extrabold text-ink">{m.title}</p>
              <p className="text-xs text-ink-muted leading-relaxed">{m.text}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="stack" title="Tecnologias" icon={<Layers className="w-4 h-4" />}>
        <div className="space-y-3">
          {STACK.map((g) => (
            <div key={g.group} className="flex flex-col sm:flex-row sm:items-center gap-2">
              <span className="w-24 shrink-0 text-xs font-extrabold text-ink-muted uppercase tracking-wide">{g.group}</span>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map((i) => (
                  <Pill key={i}>{i}</Pill>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section id="roadmap" title="Próximos passos" icon={<MapIcon className="w-4 h-4" />}>
        <div className="grid md:grid-cols-3 gap-3">
          {ROADMAP.map((col) => (
            <div key={col.title} className={`rounded-xl border p-4 ${col.tone}`}>
              <p className="flex items-center gap-2 text-sm font-extrabold text-ink">
                {col.icon}
                {col.title}
              </p>
              <ul className="mt-2 space-y-1.5">
                {col.items.map((i) => (
                  <li key={i} className="text-xs text-ink-soft leading-relaxed flex gap-1.5">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-brand shrink-0" />
                    {i}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-2 text-xs text-ink-muted">
          <Lock className="w-3.5 h-3.5" />
          <span>
            Projeto e engenharia: <strong className="text-ink">James Rafael Ehlert Reinard</strong>.
          </span>
        </div>
      </Section>

      <Section id="contato" title="Autor e contato" icon={<Contact className="w-4 h-4" />}>
        <AuthorContact />
      </Section>
    </div>
  );
}
