/**
 * =====================================================================================
 * ARQUIVO: src/shared/glossary.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T22:30:00Z (UTC)
 * VERSÃO: v5.41.0 (termos do display e dos botões da estação)
 * PROPÓSITO: Dicionário único das explicações curtas do ícone ⓘ (WEB-15). Linguagem para
 *            leigos, 1–2 frases, sem identificadores internos. Usado por `InfoTip`.
 * =====================================================================================
 */

export const GLOSSARY = {
  ack: { term: 'ACK (confirmação)', text: 'Resposta que a estação envia depois de executar um comando. Só com ela o site mostra o resultado como “confirmado”.' },
  operacao: { term: 'Operação', text: 'Número único de cada pedido (command_id). Se o mesmo número chegar duas vezes, a estação não repete a ação.' },
  idempotencia: { term: 'Idempotência', text: 'Repetir o mesmo pedido não muda o resultado: um comando reenviado não abre a válvula duas vezes.' },
  eventoTerminal: { term: 'Evento terminal', text: 'Número do registro final da estação para esta operação (concluída, recusada ou interrompida).' },
  registroAuditoria: { term: 'Registro de auditoria', text: 'Identificador deste item no histórico. Ninguém consegue editá-lo; só o titular pode excluir.' },
  linhaDoTempo: { term: 'Linha do tempo', text: 'Horários em que o pedido foi registrado, executado e confirmado (ACK), medidos no servidor.' },
  origem: { term: 'Origem', text: 'Quem pediu a ação: o titular no site, um convidado (Demo), uma agenda ou a própria estação.' },
  status: { term: 'Status', text: 'Como a ação terminou na estação: concluída, recusada por proteção, falhou ou ficou sem confirmação.' },
  motivo: { term: 'Motivo técnico', text: 'Explicação dada pela estação ou pelo servidor, por exemplo “chuva detectada” ou “tempo encerrado”.' },
  semConfirmacao: { term: 'Sem confirmação', text: 'A estação não respondeu dentro do prazo (por exemplo, sem internet). Se a resposta chegar depois, o registro é atualizado.' },
  antiRajada: { term: 'Proteção anti-rajada', text: 'Limite de comandos LIGAR seguidos, para proteger a válvula e a rede. O DESLIGAR nunca é bloqueado.' },
  telemetria: { term: 'Telemetria', text: 'Medições que a estação envia sozinha de tempos em tempos (solo, ar, luz, UV e chuva).' },
  ultimaLeitura: { term: 'Última leitura', text: 'Quanto tempo faz desde a medição mais recente que chegou à nuvem.' },
  firmware: { term: 'Firmware e partição', text: 'Versão do programa da placa. Ela guarda duas cópias (app0 e app1): a nova é gravada na outra e, se falhar, a placa volta para a anterior.' },
  ota: { term: 'OTA', text: 'Atualização do programa da placa pela internet, sem cabo. Só versões assinadas digitalmente são aceitas.' },
  rollback: { term: 'Rollback', text: 'Volta automática para a versão anterior quando a nova não passa na verificação.' },
  rssi: { term: 'Sinal Wi-Fi (dBm)', text: 'Força do sinal: perto de -50 dBm é excelente; abaixo de -80 dBm a conexão pode falhar.' },
  uptime: { term: 'Tempo ativo', text: 'Há quanto tempo a placa está ligada sem reiniciar.' },
  wal: { term: 'Fila no cartão SD', text: 'Leituras guardadas no cartão quando a internet cai. São reenviadas sozinhas, sem perder nem duplicar.' },
  boot: { term: 'Reinícios', text: 'Quantas vezes a placa já ligou e o motivo do último reinício (energia, atualização, proteção).' },
  heap: { term: 'Memória livre', text: 'Memória RAM disponível na placa. Valores estáveis indicam que o programa não está “vazando” memória.' },
  protecoes: { term: 'Proteções da estação', text: 'Travas da própria placa: tempo máximo de rega, limite de comandos seguidos e modo seguro após falhas.' },
  iaClimatica: { term: 'IA climática', text: 'Antes de cada rega agendada, a nuvem consulta a previsão e pula a rega se houver chuva provável.' },
  proximaRega: { term: 'Próxima rega', text: 'A próxima agenda ativa, no horário da estação. Chuva ou solo úmido ainda podem fazer a rega ser pulada.' },
  sobreposicao: { term: 'Sobreposição', text: 'Duas regas cujo horário e duração se cruzam no mesmo dia: a segunda começaria com a válvula já aberta.' },
  limiteAgendas: { term: 'Limite de agendas', text: 'Até 20 rotinas por estação para o titular e 5 por sessão de convidado, para manter o sistema simples e seguro.' },
  alertaSeguranca: { term: 'Alerta de segurança', text: 'Ação que chegou à estação sem ter sido registrada pelo servidor (possível tentativa de invasão). Fica protegido por 30 dias.' },
  displayEstacao: { term: 'Display da estação', text: 'Pequena tela OLED na placa. Pode ficar sempre ligada (bancada) ou apagada, acendendo por 5 minutos quando alguém toca no botão.' },
  botaoFisico: { term: 'Botões da estação', text: 'Dois botões na caixa: um acende ou apaga o display; o outro liga a irrigação (segurar 1 segundo) ou desliga (um toque).' },
  eventoLocal: { term: 'Evento da estação', text: 'Registro criado quando alguém aperta um botão na placa. Fica guardado na memória dela até a nuvem confirmar o recebimento, mesmo sem internet.' },
  botaoTravado: { term: 'Botão travado', text: 'Botão apertado por mais de 10 segundos (água ou curto). A estação passa a ignorá-lo, a válvula nunca liga por ele e o site avisa.' },
  demo: { term: 'Modo demonstração', text: 'Acesso temporário para convidados: pode testar a válvula por pouco tempo e criar até 5 agendas, sem ver dados pessoais.' },
  validacao: { term: 'Aguardando confirmação', text: 'O pedido saiu do site e espera o ACK da estação (normalmente cerca de 1 segundo).' },
} as const satisfies Record<string, { term: string; text: string }>;

export type GlossaryKey = keyof typeof GLOSSARY;
