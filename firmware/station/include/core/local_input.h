#pragma once
// =====================================================================================
// v5.27.0: lógica pura dos botões físicos e do display (sem dependência do Arduino).
// Exercitada por testes nativos em firmware/test_host/local_input_host_test.cpp.
//
// agrobtn::Button   — anti-repique, toque, "segurar N ms" e botão travado.
// agrodisp::Model   — quem manda no display: padrão (NVS) + sobreposição temporária (RAM).
// agrolocal::*      — formato do número dos eventos locais e validação da configuração.
//
// Todos os tempos em ms de uptime (uint32 com wrap tratado por subtração).
// =====================================================================================
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace agrobtn {
struct Config {
  uint32_t debounceMs;  // leitura precisa ficar estável este tempo
  uint32_t holdMs;      // "segurar" (0 = não usa)
  uint32_t stuckMs;     // apertado por mais que isso = botão com defeito
  uint32_t rearmMs;     // depois de travado, precisa ficar solto este tempo
};
enum Event : uint8_t {
  None = 0,
  PressEdge = 1,     // começou um aperto válido
  HoldReached = 2,   // aperto válido chegou a holdMs (uma vez por aperto)
  StuckDetected = 3, // aperto passou de stuckMs: botão ignorado até soltar
  Released = 4,      // aperto válido terminou
  StuckCleared = 5,  // botão travado voltou ao normal (solto por rearmMs)
};

class Button {
 public:
  explicit Button(Config c) : cfg_(c) {}

  // Botão já apertado ao ligar a placa NUNCA vale como aperto: precisa soltar antes.
  void begin(bool rawPressed, uint32_t nowMs) {
    stable_ = rawPressed;
    lastRaw_ = rawPressed;
    rawSinceMs_ = nowMs;
    pressStartMs_ = nowMs;
    armed_ = !rawPressed;
    holdFired_ = false;
    stuck_ = false;
    releasedSinceMs_ = nowMs;
    started_ = true;
  }

  Event update(bool rawPressed, uint32_t nowMs) {
    if (!started_) begin(rawPressed, nowMs);
    if (rawPressed != lastRaw_) {
      lastRaw_ = rawPressed;
      rawSinceMs_ = nowMs;
    }
    if (rawPressed != stable_ && (nowMs - rawSinceMs_) >= cfg_.debounceMs) {
      stable_ = rawPressed;
      if (stable_) {
        pressStartMs_ = nowMs;
        holdFired_ = false;
        if (armed_) return PressEdge;
        return None;  // aperto não armado (boot apertado / travado): ignorado
      }
      releasedSinceMs_ = nowMs;
      if (armed_) return Released;
      if (!stuck_) armed_ = true;  // solto depois do boot: passa a valer
      return None;
    }
    if (stable_) {
      uint32_t held = nowMs - pressStartMs_;
      if (!stuck_ && cfg_.stuckMs > 0 && held >= cfg_.stuckMs) {
        stuck_ = true;
        armed_ = false;
        return StuckDetected;
      }
      if (armed_ && !holdFired_ && cfg_.holdMs > 0 && held >= cfg_.holdMs) {
        holdFired_ = true;
        return HoldReached;
      }
    } else if (stuck_ && (nowMs - releasedSinceMs_) >= cfg_.rearmMs) {
      stuck_ = false;
      armed_ = true;
      return StuckCleared;
    }
    return None;
  }

  bool stuck() const { return stuck_; }
  bool pressed() const { return stable_; }
  bool armed() const { return armed_; }

 private:
  Config cfg_;
  bool started_ = false;
  bool stable_ = false;
  bool lastRaw_ = false;
  bool armed_ = false;
  bool holdFired_ = false;
  bool stuck_ = false;
  uint32_t rawSinceMs_ = 0;
  uint32_t pressStartMs_ = 0;
  uint32_t releasedSinceMs_ = 0;
};
}  // namespace agrobtn

namespace agrodisp {
enum Override : uint8_t { NoOverride = 0, OnUntil = 1, OffUntilAction = 2 };
enum TapResult : uint8_t { TurnedOn = 1, TurnedOff = 2 };

// Padrão (NVS) + sobreposição temporária (RAM). A sobreposição some no reinício.
class Model {
 public:
  void begin(bool defaultOn, uint32_t nowMs, uint32_t bootShowMs) {
    defaultOn_ = defaultOn;
    override_ = NoOverride;
    untilMs_ = 0;
    if (!defaultOn_ && bootShowMs > 0) setOnFor(nowMs, bootShowMs);  // mostra o boot
  }
  bool defaultOn() const { return defaultOn_; }

  // Expira a sobreposição vencida. Chamar sempre antes de ler o estado.
  void tick(uint32_t nowMs) {
    if (override_ == OnUntil && static_cast<int32_t>(nowMs - untilMs_) >= 0) {
      override_ = NoOverride;
      untilMs_ = 0;
    }
  }
  bool isOn(uint32_t nowMs) {
    tick(nowMs);
    if (override_ == OnUntil) return true;
    if (override_ == OffUntilAction) return false;
    return defaultOn_;
  }
  // Segundos restantes de um "ligar por X min" (0 se não houver).
  uint32_t leftS(uint32_t nowMs) {
    tick(nowMs);
    if (override_ != OnUntil) return 0;
    return ((untilMs_ - nowMs) + 999u) / 1000u;
  }

  // Botão: aceso -> apaga; apagado -> acende por onMs.
  TapResult tap(uint32_t nowMs, uint32_t onMs) {
    if (isOn(nowMs)) {
      turnOff();
      return TurnedOff;
    }
    if (defaultOn_) {  // estava apagado só pela sobreposição: volta ao padrão (aceso)
      override_ = NoOverride;
      untilMs_ = 0;
    } else {
      setOnFor(nowMs, onMs);
    }
    return TurnedOn;
  }
  void setOnFor(uint32_t nowMs, uint32_t onMs) {
    override_ = OnUntil;
    untilMs_ = nowMs + (onMs ? onMs : 1u);
  }
  void turnOff() {
    // Padrão desligado: basta tirar a sobreposição. Padrão ligado: apaga até nova ação.
    override_ = defaultOn_ ? OffUntilAction : NoOverride;
    untilMs_ = 0;
  }
  void setDefault(bool on) {
    defaultOn_ = on;
    override_ = NoOverride;
    untilMs_ = 0;
  }

 private:
  bool defaultOn_ = true;
  Override override_ = NoOverride;
  uint32_t untilMs_ = 0;
};
}  // namespace agrodisp

namespace agrolocal {
static const unsigned DISPLAY_MIN_MINUTES = 1;
static const unsigned DISPLAY_MAX_MINUTES = 120;
static const unsigned BTN_IRRIG_MIN_MINUTES = 1;
static const unsigned BTN_IRRIG_MAX_MINUTES = 15;

// Número do evento local: loc-<boot_id 16 hex>-<seq>-<kind>. kind: on | off | disp.
// O servidor reconhece só este formato exato (comandos de fora com "loc-" são recusados).
inline bool makeEventId(char* out, size_t outSz, const char* bootId, uint32_t seq, const char* kind) {
  if (!out || outSz == 0 || !bootId || !kind) return false;
  int n = snprintf(out, outSz, "loc-%s-%lu-%s", bootId, static_cast<unsigned long>(seq), kind);
  return n > 0 && static_cast<size_t>(n) < outSz;
}
inline bool isLocalPrefix(const char* id) {
  if (!id) return false;
  return (id[0] == 'l' || id[0] == 'L') && (id[1] == 'o' || id[1] == 'O') &&
         (id[2] == 'c' || id[2] == 'C') && id[3] == '-';
}

enum DisplayMode : uint8_t { ModeInvalid = 0, ModeOn = 1, ModeOff = 2, ModeDefaultOn = 3, ModeDefaultOff = 4 };
inline DisplayMode parseDisplayMode(const char* s) {
  if (!s) return ModeInvalid;
  if (strcmp(s, "on") == 0) return ModeOn;
  if (strcmp(s, "off") == 0) return ModeOff;
  if (strcmp(s, "default_on") == 0) return ModeDefaultOn;
  if (strcmp(s, "default_off") == 0) return ModeDefaultOff;
  return ModeInvalid;
}
inline bool validDisplayMinutes(long m) { return m >= long(DISPLAY_MIN_MINUTES) && m <= long(DISPLAY_MAX_MINUTES); }
inline bool validBtnMinutes(long m) { return m >= long(BTN_IRRIG_MIN_MINUTES) && m <= long(BTN_IRRIG_MAX_MINUTES); }
}  // namespace agrolocal
