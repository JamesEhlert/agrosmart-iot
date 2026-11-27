/**
 * =====================================================================================
 * ARQUIVO: src/features/about/AuthorContact.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-27T00:00:00Z (UTC)
 * VERSÃO: v5.48.0
 * PROPÓSITO: Autor e contato na página Sobre (pública). Só redes sociais com link direto
 *            (abrem em nova aba com `noopener noreferrer`). E-mail e telefone saíram do site
 *            na 5.48.0: o contato é feito pelo LinkedIn (menos spam e golpes).
 * =====================================================================================
 */

import { ReactNode } from 'react';
import { Facebook, Github, Instagram, Linkedin, MessageSquare, UserCheck } from 'lucide-react';

const SOCIAL: ReadonlyArray<{ name: string; handle: string; url: string; icon: ReactNode; tone: string }> = [
  { name: 'LinkedIn', handle: 'james-ehlert-reinard', url: 'https://www.linkedin.com/in/james-ehlert-reinard/', icon: <Linkedin className="w-4 h-4" />, tone: 'text-[#0A66C2]' },
  { name: 'GitHub', handle: 'JamesEhlert', url: 'https://github.com/JamesEhlert', icon: <Github className="w-4 h-4" />, tone: 'text-ink' },
  { name: 'Instagram', handle: 'james.ehlert', url: 'https://www.instagram.com/james.ehlert/', icon: <Instagram className="w-4 h-4" />, tone: 'text-[#C13584]' },
  { name: 'Facebook', handle: 'jamesehlertreinard', url: 'https://www.facebook.com/jamesehlertreinard', icon: <Facebook className="w-4 h-4" />, tone: 'text-[#1877F2]' },
];

const linkCard =
  'group flex items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 hover:border-brand hover:shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2E7D32]';

export function AuthorContact() {
  return (
    <div className="space-y-3" data-testid="author-contact">
    <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-5">
      <div className="rounded-2xl bg-gradient-to-br from-[#F1F8E9] to-[#E3F2FD] border border-line p-5 flex gap-4 items-start">
        <span
          aria-hidden="true"
          className="shrink-0 w-16 h-16 rounded-2xl bg-gradient-to-br from-brand to-brand-strong text-white text-xl font-extrabold flex items-center justify-center shadow"
        >
          JR
        </span>
        <div className="min-w-0">
          <p className="text-base font-extrabold text-ink">James Rafael Ehlert Reinard</p>
          <p className="text-xs font-semibold text-brand">Autor do projeto: firmware, nuvem, segurança e site</p>
          <p className="text-xs text-ink-soft mt-2 leading-relaxed">
            O AgroSmart nasceu no meu TCC de Análise e Desenvolvimento de Sistemas e virou um laboratório prático de IoT, computação
            em nuvem e segurança. Fico feliz em conversar sobre o projeto e sobre oportunidades na área de tecnologia.
          </p>
          <p className="text-xs text-ink-muted mt-2 flex items-start gap-1.5">
            <MessageSquare className="w-3.5 h-3.5 shrink-0 mt-0.5 text-brand" />
            <span>
              Para conversar, mande uma mensagem pelo <strong>LinkedIn</strong>.
            </span>
          </p>
          <p className="text-xs text-ink-muted mt-2 flex items-start gap-1.5">
            <UserCheck className="w-3.5 h-3.5 shrink-0 mt-0.5 text-brand" />
            <span>
              Quer operar a estação de verdade? Peça um <strong>passe de convidado</strong>: acesso temporário e limitado, sem
              precisar de conta Google.
            </span>
          </p>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-2.5">
        {SOCIAL.map((s) => (
          <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer" className={linkCard}>
            <span className={`p-2 rounded-lg bg-subtle ${s.tone}`}>{s.icon}</span>
            <span className="min-w-0">
              <span className="block text-xs font-extrabold text-ink">{s.name}</span>
              <span className="block text-xs text-ink-muted truncate">{s.handle}</span>
            </span>
          </a>
        ))}

      </div>
    </div>
    <p className="text-xs text-ink-muted" data-testid="project-disclaimer">
      Projeto acadêmico e de portfólio, sem relação com a empresa Agrosmart.
    </p>
    </div>
  );
}
