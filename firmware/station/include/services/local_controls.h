#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/services/local_controls.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-24 UTC (v5.27.0)
 * PROPÓSITO: Botões físicos da estação (display no GPIO27, irrigação no GPIO25) e
 *            controle de energia do display OLED, com rastreabilidade na nuvem.
 *
 * - Botão do display: um toque acende por 5 min; outro toque apaga.
 * - Botão de irrigação: segurar 1 s liga (duração `btn_irrig_min`, 1..15 min);
 *   qualquer toque com a válvula aberta desliga (desligar nunca é bloqueado).
 * - Botão apertado no boot ou travado por mais de 10 s é ignorado até soltar; se o
 *   aperto travado tinha ligado a válvula, ela é desligada (`button_stuck`).
 * - Cada ação vira um evento `loc-<boot_id>-<seq>-<on|off|disp>` no MESMO outbox
 *   durável dos ACKs: fica guardado até o servidor devolver o recibo.
 * - Ligar pelo botão passa pelas MESMAS proteções do LIGAR remoto (OTA, energia,
 *   guarda, chuva, anti-rajada, vaga durável) e pela mesma seção crítica.
 * ===================================================================================
 */
#include <Arduino.h>
#include <ArduinoJson.h>

/** Lê padrões da NVS, configura os pinos e prepara o modelo do display. Chamar no setup(). */
void localControlsInit();

/** Task dos botões (ciclo de 20 ms). Criada no setup() depois de localControlsInit(). */
void taskLocalControls(void* pvParameters);

/** Display: estado efetivo (para a taskDisplay) e pedido de redesenho imediato. */
bool localDisplayShouldBeOn();
bool localDisplayTakeWake();

/** Config remota (action=config): true se o comando traz campos do display/botões. */
bool localConfigPresent(JsonDocument& doc);

/**
 * Aplica `display_mode` (on|off|default_on|default_off), `display_minutes` (1..120,
 * obrigatório com on) e `btn_irrig_min` (1..15). Valida tudo antes de mudar algo.
 * Devolve true/false e preenche reason/error para o ACK.
 */
bool localControlsApplyConfig(JsonDocument& doc, const char** reasonOut, const char** errorOut);

/** Campos `disp`, `disp_def`, `disp_left_s`, `btn_min` e `btn_fault` da telemetria. */
void localControlsFillSys(JsonObject sys);

/**
 * Seção crítica de comandos da válvula (LIGAR/DESLIGAR remoto x botão). Evita que um
 * LIGAR remoto e um aperto no botão passem juntos pelas verificações e disputem a
 * válvula. RAII: libera sozinho em qualquer `return`.
 */
class ValveCommandSection {
 public:
  ValveCommandSection();
  ~ValveCommandSection();
  ValveCommandSection(const ValveCommandSection&) = delete;
  ValveCommandSection& operator=(const ValveCommandSection&) = delete;

 private:
  bool held_;
};
