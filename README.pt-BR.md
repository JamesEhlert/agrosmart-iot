# AgroSmart V5 — Irrigação de Precisão com IoT

**Sistema de irrigação inteligente de ponta a ponta**: estação ESP32 em campo, back-end serverless na AWS IoT, Firebase e painel web em React, construído com foco em segurança.

**Página do projeto:** https://agrosmart-v5.web.app/sobre · 🇺🇸 [Read in English](README.md)

> Projeto acadêmico e de portfólio (nasceu no meu TCC de Análise e Desenvolvimento de Sistemas). Sem relação com a empresa Agrosmart.

## O que faz
- Mede temperatura e umidade do ar, umidade do solo, luz, UV e chuva em tempo real.
- Liga e desliga a válvula pelo site, por agendas semanais ou pelos botões físicos da estação.
- Pula a rega quando há chuva prevista (Open-Meteo, janela de 3 horas).
- Registra tudo: cada comando é confirmado pela própria estação (ACK) e auditado.
- Recrutadores podem operar a estação real com um passe de convidado temporário e revogável.

## Destaques de engenharia
- **Comandos idempotentes:** cada comando tem um `command_id` único; repetir o mesmo número nunca abre a válvula duas vezes.
- **Resiliência:** leituras ficam numa fila no cartão microSD durante quedas de rede; teste com 7 minutos sem internet e nenhuma leitura perdida.
- **Segurança física:** tempo máximo de válvula aberta e estado desligado seguro em reinício, queda de energia ou de conexão.
- **OTA assinado** (ECDSA P-256), conferido antes de baixar e antes de gravar, com volta automática.
- **Controle de acesso no servidor** em todas as rotas, 51 testes das regras do Firestore, passe de convidado com validade e revogação.
- **Site:** React + TypeScript, páginas sob demanda com orçamento de peso, tema escuro, acessibilidade, atalhos, versão para celular e 270 testes automáticos.

A arquitetura, os resultados medidos e a estrutura do repositório estão no [README em inglês](README.md).

## Como usei IA
Assistentes de IA geraram boa parte do código. Eu defini requisitos e arquitetura, revisei cada mudança, testei no hardware e na nuvem reais, auditei a segurança e tomei as decisões. Este repositório é publicado por um exportador automático que barra segredos e dados pessoais antes de qualquer arquivo sair do meu repositório privado.

## Autor
**James Rafael Ehlert Reinard** — [LinkedIn](https://www.linkedin.com/in/james-ehlert-reinard/) · [GitHub](https://github.com/JamesEhlert)

Copyright © 2026 James Rafael Ehlert Reinard. Todos os direitos reservados. Veja [LICENSE](LICENSE).
