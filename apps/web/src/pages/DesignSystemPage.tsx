/**
 * =====================================================================================
 * ARQUIVO: src/pages/DesignSystemPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-26T00:00:00Z (UTC)
 * VERSÃO: v5.44.0
 * PROPÓSITO: Vitrine do design system — paleta por papel, tipografia, botões, selos,
 *            filtros, avisos, estados vazios/carregando e a janela acessível, nos temas
 *            claro e escuro (use o botão sol/lua). Página estática: não lê dados.
 * =====================================================================================
 */
import { useState } from 'react';
import { Bell, CalendarClock, Droplets, Inbox, Palette, Plus, Save, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, CardHeader, Chip, Dialog, EmptyState, IconButton, Segmented, Skeleton } from '../shared/ui';

const SWATCHES: { group: string; items: { name: string; cls: string; ink?: string }[] }[] = [
  { group: 'Fundos', items: [
    { name: 'canvas', cls: 'bg-canvas' }, { name: 'surface', cls: 'bg-surface' }, { name: 'subtle', cls: 'bg-subtle' },
    { name: 'sunken', cls: 'bg-sunken' }, { name: 'brand-tint', cls: 'bg-brand-tint' }, { name: 'brand-soft', cls: 'bg-brand-soft' },
    { name: 'brand', cls: 'bg-brand', ink: 'text-white' }, { name: 'brand-strong', cls: 'bg-brand-strong', ink: 'text-white' },
    { name: 'info', cls: 'bg-info', ink: 'text-white' }, { name: 'danger', cls: 'bg-danger', ink: 'text-white' },
  ] },
  { group: 'Textos', items: [
    { name: 'ink', cls: 'text-ink' }, { name: 'ink-soft', cls: 'text-ink-soft' }, { name: 'ink-muted', cls: 'text-ink-muted' },
    { name: 'brand', cls: 'text-brand' }, { name: 'brand-strong', cls: 'text-brand-strong' }, { name: 'info', cls: 'text-info' },
    { name: 'warning', cls: 'text-warning' }, { name: 'danger', cls: 'text-danger' },
  ] },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <h2 className="text-sm font-extrabold text-ink mb-4">{title}</h2>
      {children}
    </Card>
  );
}

export function DesignSystemPage() {
  const [chips, setChips] = useState<Record<string, boolean>>({ irrigacoes: true, botoes: false, falhas: false });
  const [period, setPeriod] = useState<'1h' | '24h' | '7d'>('24h');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  return (
    <div className="space-y-5" data-testid="design-system">
      <Card>
        <CardHeader
          as="h1"
          icon={<Palette className="w-5 h-5" />}
          title="Design system do AgroSmart"
          subtitle="Paleta por papel, componentes e regras visuais usados em todas as telas. Troque o tema no botão sol/lua do topo para ver as duas versões."
          actions={<Badge tone="brand" dot>v5.44.0</Badge>}
        />
        <ul className="mt-4 grid sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs text-ink-muted">
          <li className="px-3 py-2 rounded-xl bg-subtle border border-line"><b className="text-ink">Cores por papel:</b> texto, fundo e borda têm nomes próprios; nada de cor solta.</li>
          <li className="px-3 py-2 rounded-xl bg-subtle border border-line"><b className="text-ink">Contraste AA:</b> todo texto com pelo menos 4,5:1, testado automaticamente.</li>
          <li className="px-3 py-2 rounded-xl bg-subtle border border-line"><b className="text-ink">Teclado:</b> foco visível em tudo; janelas prendem o foco e fecham com Esc.</li>
          <li className="px-3 py-2 rounded-xl bg-subtle border border-line"><b className="text-ink">Legível:</b> texto de 11 px no mínimo; ações em frases, sem CAIXA ALTA.</li>
        </ul>
      </Card>

      <Section title="Paleta (design tokens)">
        {SWATCHES.map((g) => (
          <div key={g.group} className="mb-4 last:mb-0">
            <p className="text-xs font-bold text-ink-muted mb-2">{g.group}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2">
              {g.items.map((s) => g.group === 'Fundos' ? (
                <div key={s.name} className={`h-16 rounded-xl border border-line p-2 flex items-end ${s.cls} ${s.ink ?? 'text-ink'}`}>
                  <code className="text-[11px] font-mono font-bold">bg-{s.name}</code>
                </div>
              ) : (
                <div key={s.name} className="h-16 rounded-xl border border-line bg-surface p-2 flex flex-col justify-between">
                  <span className={`text-sm font-extrabold ${s.cls}`}>Aa Irrigação</span>
                  <code className="text-[11px] font-mono text-ink-muted">text-{s.name}</code>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section title="Tipografia (Inter e JetBrains Mono, no próprio site)">
        <div className="space-y-2">
          <p className="text-2xl font-extrabold text-ink">Título de página · 24 px</p>
          <p className="text-lg font-extrabold text-ink">Título de seção · 18 px</p>
          <p className="text-base font-bold text-ink">Título de cartão · 16 px</p>
          <p className="text-sm text-ink">Texto comum · 14 px — a estação confirma cada comando.</p>
          <p className="text-xs text-ink-muted">Texto de apoio · 12 px — horário da estação, origem, detalhes.</p>
          <p className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">Rótulo · 11 px (mínimo do site)</p>
          <p className="text-xs font-mono text-ink-soft">app-1795655749626-639861 · código e identificadores</p>
        </div>
      </Section>

      <Section title="Botões">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<Plus className="w-4 h-4" />}>Novo agendamento</Button>
          <Button variant="secondary" icon={<Save className="w-4 h-4" />}>Salvar</Button>
          <Button variant="ghost">Cancelar</Button>
          <Button variant="danger" icon={<Trash2 className="w-4 h-4" />}>Excluir</Button>
          <Button variant="water" icon={<Droplets className="w-4 h-4" />}>Iniciar irrigação</Button>
          <Button variant="primary" loading={loading} onClick={() => { setLoading(true); window.setTimeout(() => setLoading(false), 1500); }}>
            {loading ? 'Enviando…' : 'Clique (carregando)'}
          </Button>
          <Button variant="primary" disabled>Desabilitado</Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary">Pequeno</Button>
          <Button size="md" variant="secondary">Médio</Button>
          <Button size="lg" variant="secondary">Grande</Button>
          <IconButton label="Notificações" variant="secondary"><Bell className="w-4 h-4" /></IconButton>
          <IconButton label="Agenda" variant="ghost" size="lg"><CalendarClock className="w-5 h-5" /></IconButton>
        </div>
      </Section>

      <div className="grid lg:grid-cols-2 gap-5">
        <Section title="Selos de status">
          <div className="flex flex-wrap gap-2">
            <Badge tone="success" dot pulse>Online</Badge>
            <Badge tone="brand">Ativa</Badge>
            <Badge tone="neutral">Pausada</Badge>
            <Badge tone="warning" dot>Sem confirmação</Badge>
            <Badge tone="danger" dot>Falha</Badge>
            <Badge tone="info" dot>Irrigando</Badge>
          </div>
        </Section>
        <Section title="Filtros e escolha única">
          <div className="flex flex-wrap gap-2 mb-3">
            {([['irrigacoes', 'Irrigações', 12], ['botoes', 'Botões da estação', 4], ['falhas', 'Falhas', 0]] as const).map(([k, l, n]) => (
              <Chip key={k} selected={chips[k]} count={n} onClick={() => setChips((c) => ({ ...c, [k]: !c[k] }))}>{l}</Chip>
            ))}
          </div>
          <Segmented label="Período" value={period} onChange={setPeriod}
            options={[{ value: '1h', label: '1 h' }, { value: '24h', label: '24 h' }, { value: '7d', label: '7 dias' }]} />
          <p className="mt-2 text-xs text-ink-muted">Use as setas do teclado para trocar o período.</p>
        </Section>
      </div>

      <Section title="Avisos">
        <div className="grid sm:grid-cols-2 gap-2">
          <Alert tone="success" title="Comando confirmado">A estação confirmou em 1,2 s.</Alert>
          <Alert tone="info">Chuva prevista para amanhã: as agendas serão puladas.</Alert>
          <Alert tone="warning" title="Sinal Wi-Fi fraco">-77 dBm. Aproxime a estação do roteador.</Alert>
          <Alert tone="danger" title="Falha no cartão SD">As leituras continuam sendo enviadas direto.</Alert>
        </div>
      </Section>

      <div className="grid lg:grid-cols-2 gap-5">
        <Section title="Estado vazio">
          <EmptyState icon={<Inbox className="w-6 h-6" />} title="Nenhum registro neste período"
            action={<Button size="sm" variant="secondary">Ver 7 dias</Button>}>
            Tente um período maior ou outra categoria.
          </EmptyState>
        </Section>
        <Section title="Carregando (esqueleto)">
          <div className="space-y-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72 max-w-full" />
            <div className="grid grid-cols-3 gap-2"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
          </div>
        </Section>
      </div>

      <Section title="Janela (diálogo acessível)">
        <p className="text-xs text-ink-muted mb-3">No computador abre no centro; no celular abre como folha presa embaixo. O foco fica dentro dela e volta ao botão ao fechar.</p>
        <Button variant="secondary" onClick={() => setOpen(true)}>Abrir exemplo</Button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Excluir agendamento?" description="Esta ação não pode ser desfeita."
          footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button><Button variant="danger" onClick={() => setOpen(false)}>Excluir</Button></>}>
          <p className="text-sm text-ink">A rotina <b>Rega da manhã</b> deixará de ser executada. O histórico dela continua em Logs &amp; Auditoria.</p>
        </Dialog>
      </Section>
    </div>
  );
}
