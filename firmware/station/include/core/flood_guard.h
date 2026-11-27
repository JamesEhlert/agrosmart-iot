#pragma once
// =====================================================================================
// v5.26.0 (Fase 4.0-E): proteção contra rajada de LIGAR (sem dependência do Arduino).
// - Balde de fichas: até `burst` LIGAR seguidos; depois 1 ficha a cada `refillMs`.
//   Só LIGAR que realmente abriu a válvula consome ficha (recusas não gastam).
// - Intervalo mínimo entre a válvula FECHAR e um novo LIGAR (relé, solenoide e golpe
//   de aríete).
// - DESLIGAR nunca passa por aqui: parar a água nunca é limitado.
// Todos os tempos em ms de uptime (uint32 com wrap tratado por subtração).
// =====================================================================================
#include <stdint.h>

namespace agroflood {
struct Config {
  uint32_t burst;         // fichas máximas
  uint32_t refillMs;      // ms por ficha
  uint32_t minOffToOnMs;  // ms mínimos entre fechar e religar
};
enum Verdict : uint8_t { Allowed = 0, RateLimited = 1, ValveCooldown = 2 };
struct Decision {
  Verdict verdict;
  uint32_t retryAfterMs;
};
class Guard {
 public:
  explicit Guard(Config c) : cfg_(c) {}
  // lastCloseMs == 0 significa "a válvula ainda não fechou neste boot".
  Decision check(uint32_t nowMs, uint32_t lastCloseMs) {
    refill(nowMs);
    if (lastCloseMs != 0 && cfg_.minOffToOnMs > 0) {
      uint32_t since = nowMs - lastCloseMs;
      if (since < cfg_.minOffToOnMs) return Decision{ValveCooldown, cfg_.minOffToOnMs - since};
    }
    if (cfg_.refillMs > 0 && credit_ < cfg_.refillMs) return Decision{RateLimited, cfg_.refillMs - credit_};
    return Decision{Allowed, 0};
  }
  void consume(uint32_t nowMs) {
    refill(nowMs);
    credit_ = credit_ >= cfg_.refillMs ? credit_ - cfg_.refillMs : 0u;
  }
  // Fichas disponíveis x1000 (diagnóstico).
  uint32_t tokensMilli() const {
    return cfg_.refillMs ? static_cast<uint32_t>((static_cast<uint64_t>(credit_) * 1000u) / cfg_.refillMs) : cfg_.burst * 1000u;
  }

 private:
  // Crédito em ms: cada ms de uptime vale 1; uma ficha custa refillMs. Conta exata, sem arredondar.
  void refill(uint32_t nowMs) {
    uint64_t cap = static_cast<uint64_t>(cfg_.burst) * cfg_.refillMs;
    if (!init_) { init_ = true; last_ = nowMs; credit_ = static_cast<uint32_t>(cap); return; }
    uint32_t elapsed = nowMs - last_;
    last_ = nowMs;
    uint64_t next = static_cast<uint64_t>(credit_) + elapsed;
    credit_ = static_cast<uint32_t>(next > cap ? cap : next);
  }
  Config cfg_;
  uint32_t credit_ = 0;
  uint32_t last_ = 0;
  bool init_ = false;
};
}  // namespace agroflood
