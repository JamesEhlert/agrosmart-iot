/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/services/local_controls.cpp
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-24 UTC (v5.27.0)
 * PROPÓSITO: Botões físicos (display GPIO27, irrigação GPIO25), energia do display e
 *            eventos locais rastreáveis (`loc-...`) no outbox durável de ACK.
 *            A lógica de tempo (anti-repique, segurar, travado) e o modelo do display
 *            ficam em core/local_input.h, com testes nativos.
 * ===================================================================================
 */
#include "services/local_controls.h"
#include "config/app_config.h"
#include "config/board_pins.h"
#include "core/ack_outbox.h"
#include "core/local_input.h"
#include "core/time_math.h"
#include "core/valve_controller.h"
#include "hal/rtc_time_service.h"
#include "hal/sensor_drivers.h"
#include "services/diagnostics_service.h"
#include "services/logger.h"
#include "services/ota_manager.h"
#include "tasks/rtos_sync.h"
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <atomic>

static const char* LOCAL_NVS_NS = "agrolocal";
static const char* K_DISP_DEF   = "disp_def";
static const char* K_BTN_MIN    = "btn_min";

static SemaphoreHandle_t s_cmdSection = nullptr;
static portMUX_TYPE      s_dispMux = portMUX_INITIALIZER_UNLOCKED;
static agrodisp::Model   s_disp;
static std::atomic<bool>     s_dispWake{false};
static std::atomic<uint8_t>  s_btnMin{static_cast<uint8_t>(BTN_IRRIG_DEFAULT_MIN)};
static std::atomic<uint8_t>  s_btnFault{0};      // bit0 = display travado, bit1 = irrigação travado
static std::atomic<uint32_t> s_localSeq{0};
static std::atomic<uint32_t> s_dispEvtSkipped{0};

static agrobtn::Button s_btnDisplay(agrobtn::Config{BTN_DEBOUNCE_MS, 0, BTN_STUCK_MS, BTN_REARM_MS});
static agrobtn::Button s_btnIrrig(agrobtn::Config{BTN_DEBOUNCE_MS, BTN_IRRIG_HOLD_MS, BTN_STUCK_MS, BTN_REARM_MS});

// Só a task dos botões mexe nestes dois.
static bool s_irrigPressConsumed = false;        // este aperto já DESLIGOU: não liga ao segurar
static char s_irrigOnByThisPress[48] = {0};      // LIGAR feito pelo aperto que ainda está em curso

// ---------------------------------------------------------------------------------
// Seção crítica de comandos da válvula
// ---------------------------------------------------------------------------------
ValveCommandSection::ValveCommandSection() : held_(false) {
  if (s_cmdSection != nullptr) {
    held_ = (xSemaphoreTake(s_cmdSection, pdMS_TO_TICKS(VALVE_CMD_SECTION_WAIT_MS)) == pdTRUE);
    if (!held_) LOGW("[LOCAL][SECTION] Secao de comando ocupada por >%lu ms; seguindo sem ela",
                     static_cast<unsigned long>(VALVE_CMD_SECTION_WAIT_MS));
  }
}
ValveCommandSection::~ValveCommandSection() {
  if (held_ && s_cmdSection != nullptr) xSemaphoreGive(s_cmdSection);
}

// ---------------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------------
static void nextLocalId(char* out, size_t sz, const char* kind) {
  uint32_t seq = s_localSeq.fetch_add(1) + 1;
  if (!agrolocal::makeEventId(out, sz, g_bootId, seq, kind)) out[0] = '\0';
}

static bool activeCommandIs(const char* id) {
  if (!id || !id[0]) return false;
  bool same = false;
  if (lockSem(valveMutex, 50)) {
    same = (strcmp(g_activeCommandId, id) == 0);
    unlockSem(valveMutex);
  }
  return same;
}

static void storeRainSample(int raw, int pct, bool detected) {
  if (lockSem(dataMutex, 10)) {
    g_latestData.rain_raw = raw;
    g_latestData.rain_pct = pct;
    g_latestData.rain_detected = detected;
    unlockSem(dataMutex);
  }
}

// ---------------------------------------------------------------------------------
// Irrigação pelo botão
// ---------------------------------------------------------------------------------
// Desliga a válvula (qualquer origem). `why` vai no ACK do comando interrompido e no
// evento local de desligar.
static void localValveOff(const char* why) {
  ValveCommandSection section;
  char id[48];
  nextLocalId(id, sizeof(id), "off");
  char interruptedId[48] = {0};
  if (lockSem(valveMutex, 50)) {
    if (g_activeCommandId[0] != '\0') safeCopy(interruptedId, sizeof(interruptedId), g_activeCommandId);
    g_activeCommandId[0] = '\0';
    unlockSem(valveMutex);
  }
  valveApplyCommand(false, 0);  // nunca bloqueado: fecha mesmo sem o mutex (fail-safe)
  LOGI("[LOCAL][IRRIG] Botao: valvula DESLIGADA (evt=%s motivo=%s interrompido=%s)",
       id[0] ? id : "-", why, interruptedId[0] ? interruptedId : "-");
  if (interruptedId[0] != '\0') enqueueAck(interruptedId, "done", "off", 0, why, nullptr);
  if (id[0] != '\0') enqueueAck(id, "done", "off", 0, why, nullptr, interruptedId[0] ? interruptedId : nullptr);
  // Igual ao DESLIGAR remoto: o evento de desligar chega primeiro ao Firestore.
  if (interruptedId[0] != '\0') ackDeferFirstSend(interruptedId, ACK_SIBLING_DEFER_MS);
}

// LIGAR pelo botão: as MESMAS proteções do LIGAR remoto, na mesma ordem.
static void localValveOn() {
  ValveCommandSection section;
  char id[48];
  nextLocalId(id, sizeof(id), "on");
  if (id[0] == '\0') return;
  const int32_t duration = static_cast<int32_t>(s_btnMin.load()) * 60;

  bool open = false;
  uint32_t offAt = 0;
  valveReadStateAtomic(open, offAt);
  if (open) {
    LOGW("[LOCAL][IRRIG] Valvula ja aberta por outra origem; aperto ignorado.");
    return;
  }
  if (g_otaInProgress || g_otaJob.pending) {
    LOGW("[LOCAL][IRRIG] LIGAR recusado: atualizacao OTA em andamento.");
    enqueueAck(id, "failed", "on", duration, "ota_in_progress", "ota_busy");
    return;
  }
  if (powerSafeModeActive()) {
    LOGW("[LOCAL][IRRIG] LIGAR recusado: modo seguro de energia.");
    enqueueAck(id, "failed", "on", duration, "power_unstable", "brownout_safe_mode");
    return;
  }
  if (g_valveGuardTripReason.load() != 0) {
    LOGW("[LOCAL][IRRIG] LIGAR recusado: guarda independente com ACK pendente.");
    enqueueAck(id, "failed", "on", duration, "valve_guard_pending", "valve_busy");
    return;
  }
  int rainRaw = 4095, rainPct = 0;
  bool raining = sampleRainSensorNow(rainRaw, rainPct);
  storeRainSample(rainRaw, rainPct, raining);
  if (raining) {
    g_rainInterlocks++;
    LOGW("[LOCAL][IRRIG] LIGAR recusado: sensor de chuva ativo (%d%%).", rainPct);
    enqueueAck(id, "failed", "on", duration, "rain_interlock", "raining_now");
    return;
  }
  agroflood::Decision flood = ackFloodCheck(msNow());
  if (flood.verdict != agroflood::Allowed) {
    g_floodRejects++;
    const char* why = (flood.verdict == agroflood::ValveCooldown) ? "valve_cooldown" : "rate_limited";
    char wait[24];
    snprintf(wait, sizeof(wait), "retry_after_s=%lu", static_cast<unsigned long>((flood.retryAfterMs + 999UL) / 1000UL));
    LOGW("[LOCAL][IRRIG] LIGAR recusado (%s); liberado em %lu ms", why, static_cast<unsigned long>(flood.retryAfterMs));
    enqueueAck(id, "failed", "on", duration, why, wait);
    return;
  }
  // Relógio válido: validade curta para o livro de idempotência. Sem relógio (offline
  // desde o boot) o botão funciona igual: o número local nunca se repete.
  uint32_t nowEp = g_timeSynced ? epochNow() : 0;
  uint64_t expiresAt = isValidEpoch(nowEp) ? static_cast<uint64_t>(nowEp) + static_cast<uint64_t>(duration) + 60ULL : 0ULL;
  if (!ackReserveOn(id, clampValveDurationS(duration), expiresAt)) {
    const char* why = ackOutboxDegraded() ? "ack_storage_unavailable" : "ack_outbox_busy";
    LOGW("[LOCAL][IRRIG] LIGAR recusado: sem vaga duravel (%s).", why);
    enqueueAck(id, "failed", "on", duration, why, "durable_reservation_failed");
    return;
  }
  if (sampleRainSensorNow(rainRaw, rainPct)) {
    storeRainSample(rainRaw, rainPct, true);
    g_rainInterlocks++;
    enqueueAck(id, "failed", "on", duration, "rain_interlock", "raining_before_activation");
    return;
  }
  valveApplyCommand(true, duration, id);
  bool nowOn = false;
  valveReadStateAtomic(nowOn, offAt);
  if (nowOn) {
    ackFloodConsume(msNow());
    safeCopy(s_irrigOnByThisPress, sizeof(s_irrigOnByThisPress), id);
    enqueueAck(id, "started", "on", duration, nullptr, nullptr);
    LOGI("[LOCAL][IRRIG] Botao: valvula LIGADA por %ld s (evt=%s)", static_cast<long>(duration), id);
  } else {
    enqueueAck(id, "failed", "on", duration, "valve_not_on", "valve_failed_to_start");
  }
}

// ---------------------------------------------------------------------------------
// Display pelo botão
// ---------------------------------------------------------------------------------
static void recordDisplayEvent(bool on, int32_t durationS) {
  // O display é conveniência: o evento só entra no outbox se sobrar folga, para nunca
  // tomar a vaga de que um LIGAR (remoto ou pelo botão) precisaria.
  unsigned freeSlots = 0;
  if (lockSem(durableAckMutex, 50)) {
    freeSlots = g_durableAcks.freeSlots();
    unlockSem(durableAckMutex);
  }
  if (freeSlots < LOCAL_DISPLAY_EVENT_MIN_FREE) {
    s_dispEvtSkipped++;
    LOGW("[LOCAL][DISPLAY] Evento nao registrado na nuvem (vagas livres=%u).", freeSlots);
    return;
  }
  char id[48];
  nextLocalId(id, sizeof(id), "disp");
  if (id[0] == '\0') return;
  enqueueAck(id, "done", "display", durationS, on ? "display_on" : "display_off", nullptr);
}

static void handleDisplayTap() {
  uint32_t now = msNow();
  portENTER_CRITICAL(&s_dispMux);
  agrodisp::TapResult r = s_disp.tap(now, DISPLAY_TAP_ON_MS);
  bool defOn = s_disp.defaultOn();
  portEXIT_CRITICAL(&s_dispMux);
  s_dispWake.store(true);
  bool on = (r == agrodisp::TurnedOn);
  int32_t durationS = (on && !defOn) ? static_cast<int32_t>(DISPLAY_TAP_ON_MS / 1000UL) : 0;
  LOGI("[LOCAL][DISPLAY] Botao: display %s", on ? (defOn ? "ligado (padrao)" : "ligado por 5 min") : "desligado");
  recordDisplayEvent(on, durationS);
}

// ---------------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------------
void localControlsInit() {
  if (s_cmdSection == nullptr) s_cmdSection = xSemaphoreCreateMutex();
  pinMode(PIN_BTN_DISPLAY, INPUT_PULLUP);
  pinMode(PIN_BTN_IRRIGATION, INPUT_PULLUP);

  bool defOn = true;  // sem chave na NVS: comportamento das versões anteriores (sempre aceso)
  uint8_t btnMin = static_cast<uint8_t>(BTN_IRRIG_DEFAULT_MIN);
  Preferences p;
  if (p.begin(LOCAL_NVS_NS, false)) {
    if (p.isKey(K_DISP_DEF)) defOn = (p.getUChar(K_DISP_DEF, 1) != 0);
    if (p.isKey(K_BTN_MIN)) {
      uint8_t v = p.getUChar(K_BTN_MIN, btnMin);
      if (agrolocal::validBtnMinutes(v)) btnMin = v;
    }
    p.end();
  } else {
    LOGW("[LOCAL] NVS 'agrolocal' indisponivel; usando padroes.");
  }
  s_btnMin.store(btnMin);

  delay(5);  // pull-up interno estabiliza antes da primeira leitura
  uint32_t now = msNow();
  portENTER_CRITICAL(&s_dispMux);
  s_disp.begin(defOn, now, DISPLAY_BOOT_SHOW_MS);
  portEXIT_CRITICAL(&s_dispMux);
  bool dispAtBoot = (digitalRead(PIN_BTN_DISPLAY) == LOW);
  bool irrigAtBoot = (digitalRead(PIN_BTN_IRRIGATION) == LOW);
  s_btnDisplay.begin(dispAtBoot, now);
  s_btnIrrig.begin(irrigAtBoot, now);
  LOGI("[LOCAL] Botoes prontos (display=GPIO%d, irrigacao=GPIO%d). Display padrao=%s, irrigacao pelo botao=%u min.",
       static_cast<int>(PIN_BTN_DISPLAY), static_cast<int>(PIN_BTN_IRRIGATION),
       defOn ? "ligado" : "desligado", static_cast<unsigned>(btnMin));
  if (dispAtBoot || irrigAtBoot) {
    LOGW("[LOCAL] Botao apertado no boot (display=%d, irrigacao=%d): ignorado ate soltar.",
         int(dispAtBoot), int(irrigAtBoot));
  }
}

bool localDisplayShouldBeOn() {
  uint32_t now = msNow();
  portENTER_CRITICAL(&s_dispMux);
  bool on = s_disp.isOn(now);
  portEXIT_CRITICAL(&s_dispMux);
  return on;
}

bool localDisplayTakeWake() {
  return s_dispWake.exchange(false);
}

void taskLocalControls(void* pvParameters) {
  (void)pvParameters;
#ifdef ESP32
  esp_task_wdt_add(NULL);
#endif
  bool lastDispOn = localDisplayShouldBeOn();
  uint32_t lastDispCheckMs = msNow();
  for (;;) {
#ifdef ESP32
    esp_task_wdt_reset();
#endif
    uint32_t now = msNow();

    switch (s_btnDisplay.update(digitalRead(PIN_BTN_DISPLAY) == LOW, now)) {
      case agrobtn::PressEdge:
        handleDisplayTap();
        break;
      case agrobtn::StuckDetected:
        s_btnFault.fetch_or(0x01);
        LOGE("[LOCAL][DISPLAY] Botao do display apertado por >%lus: considerado travado e ignorado ate soltar.",
             static_cast<unsigned long>(BTN_STUCK_MS / 1000UL));
        requestImmediateTelemetry("button_fault");
        break;
      case agrobtn::StuckCleared:
        s_btnFault.fetch_and(static_cast<uint8_t>(~0x01));
        LOGI("[LOCAL][DISPLAY] Botao do display voltou ao normal.");
        requestImmediateTelemetry("button_fault_cleared");
        break;
      default:
        break;
    }

    switch (s_btnIrrig.update(digitalRead(PIN_BTN_IRRIGATION) == LOW, now)) {
      case agrobtn::PressEdge: {
        bool open = false;
        uint32_t offAt = 0;
        valveReadStateAtomic(open, offAt);
        s_irrigPressConsumed = open;
        s_irrigOnByThisPress[0] = '\0';
        if (open) localValveOff("local_button_stop");  // qualquer toque desliga
        break;
      }
      case agrobtn::HoldReached:
        if (!s_irrigPressConsumed) localValveOn();
        break;
      case agrobtn::StuckDetected:
        s_btnFault.fetch_or(0x02);
        LOGE("[LOCAL][IRRIG] Botao de irrigacao apertado por >%lus: considerado travado e ignorado ate soltar.",
             static_cast<unsigned long>(BTN_STUCK_MS / 1000UL));
        // Se foi ESTE aperto (travado) que ligou a válvula, ela é desligada.
        if (activeCommandIs(s_irrigOnByThisPress)) localValveOff("button_stuck");
        s_irrigOnByThisPress[0] = '\0';
        requestImmediateTelemetry("button_fault");
        break;
      case agrobtn::StuckCleared:
        s_btnFault.fetch_and(static_cast<uint8_t>(~0x02));
        LOGI("[LOCAL][IRRIG] Botao de irrigacao voltou ao normal.");
        requestImmediateTelemetry("button_fault_cleared");
        break;
      case agrobtn::Released:
        s_irrigOnByThisPress[0] = '\0';
        break;
      default:
        break;
    }

    // Fim de um "ligar por X min": acorda a taskDisplay para apagar na hora.
    if (static_cast<uint32_t>(now - lastDispCheckMs) >= 500UL) {
      lastDispCheckMs = now;
      bool on = localDisplayShouldBeOn();
      if (on != lastDispOn) {
        lastDispOn = on;
        s_dispWake.store(true);
      }
    }
    vTaskDelay(pdMS_TO_TICKS(BTN_POLL_MS));
  }
}

bool localConfigPresent(JsonDocument& doc) {
  return (doc.containsKey("display_mode") && !doc["display_mode"].isNull()) ||
         (doc.containsKey("btn_irrig_min") && !doc["btn_irrig_min"].isNull());
}

bool localControlsApplyConfig(JsonDocument& doc, const char** reasonOut, const char** errorOut) {
  *reasonOut = "invalid_config";
  *errorOut = nullptr;
  bool hasMode = doc.containsKey("display_mode") && !doc["display_mode"].isNull();
  bool hasBtn = doc.containsKey("btn_irrig_min") && !doc["btn_irrig_min"].isNull();
  bool hasMinutes = doc.containsKey("display_minutes") && !doc["display_minutes"].isNull();

  // 1) Valida TUDO antes de mudar qualquer coisa.
  agrolocal::DisplayMode mode = agrolocal::ModeInvalid;
  long minutes = 0;
  if (hasMode) {
    if (!doc["display_mode"].is<const char*>()) { *errorOut = "invalid_display_mode"; return false; }
    mode = agrolocal::parseDisplayMode(doc["display_mode"].as<const char*>());
    if (mode == agrolocal::ModeInvalid) { *errorOut = "invalid_display_mode"; return false; }
    if (mode == agrolocal::ModeOn) {
      if (!hasMinutes || !doc["display_minutes"].is<int>()) { *errorOut = "display_minutes_required"; return false; }
      minutes = doc["display_minutes"].as<int>();
      if (!agrolocal::validDisplayMinutes(minutes)) { *errorOut = "display_minutes_out_of_range"; return false; }
    } else if (hasMinutes) {
      *errorOut = "display_minutes_only_with_on";
      return false;
    }
  } else if (hasMinutes) {
    *errorOut = "display_minutes_without_mode";
    return false;
  }
  long btn = 0;
  if (hasBtn) {
    if (!doc["btn_irrig_min"].is<int>()) { *errorOut = "btn_irrig_min_invalid"; return false; }
    btn = doc["btn_irrig_min"].as<int>();
    if (!agrolocal::validBtnMinutes(btn)) { *errorOut = "btn_irrig_min_out_of_range"; return false; }
  }
  if (!hasMode && !hasBtn) { *errorOut = "empty_local_config"; return false; }

  // 2) Persiste o que é permanente (gravação conferida por leitura).
  bool persistDefault = (mode == agrolocal::ModeDefaultOn || mode == agrolocal::ModeDefaultOff);
  if (hasBtn || persistDefault) {
    bool ok = false;
    Preferences p;
    if (p.begin(LOCAL_NVS_NS, false)) {
      ok = true;
      if (hasBtn) {
        uint8_t v = static_cast<uint8_t>(btn);
        ok = (p.putUChar(K_BTN_MIN, v) == 1) && (p.getUChar(K_BTN_MIN, 0) == v);
      }
      if (ok && persistDefault) {
        uint8_t v = (mode == agrolocal::ModeDefaultOn) ? 1 : 0;
        ok = (p.putUChar(K_DISP_DEF, v) == 1) && (p.getUChar(K_DISP_DEF, 9) == v);
      }
      p.end();
    }
    if (!ok) {
      *reasonOut = "nvs_write_error";
      *errorOut = "failed_to_persist_config";
      return false;
    }
  }

  // 3) Aplica na RAM.
  if (hasBtn) s_btnMin.store(static_cast<uint8_t>(btn));
  if (hasMode) {
    uint32_t now = msNow();
    portENTER_CRITICAL(&s_dispMux);
    switch (mode) {
      case agrolocal::ModeOn: s_disp.setOnFor(now, static_cast<uint32_t>(minutes) * 60000UL); break;
      case agrolocal::ModeOff: s_disp.turnOff(); break;
      case agrolocal::ModeDefaultOn: s_disp.setDefault(true); break;
      case agrolocal::ModeDefaultOff: s_disp.setDefault(false); break;
      default: break;
    }
    portEXIT_CRITICAL(&s_dispMux);
    s_dispWake.store(true);
  }
  *reasonOut = (hasMode && hasBtn) ? "local_config_updated" : (hasMode ? "display_updated" : "buttons_updated");
  LOGI("[LOCAL][CONFIG] %s (display_mode=%s minutos=%ld btn_irrig_min=%ld)", *reasonOut,
       hasMode ? doc["display_mode"].as<const char*>() : "-", minutes, hasBtn ? btn : -1L);
  return true;
}

void localControlsFillSys(JsonObject sys) {
  uint32_t now = msNow();
  portENTER_CRITICAL(&s_dispMux);
  bool on = s_disp.isOn(now);
  bool def = s_disp.defaultOn();
  uint32_t left = s_disp.leftS(now);
  portEXIT_CRITICAL(&s_dispMux);
  sys["disp"] = on ? 1 : 0;
  sys["disp_def"] = def ? 1 : 0;
  sys["disp_left_s"] = left;
  sys["btn_min"] = static_cast<unsigned>(s_btnMin.load());
  sys["btn_fault"] = static_cast<unsigned>(s_btnFault.load());
  uint32_t skipped = s_dispEvtSkipped.load();
  if (skipped) sys["disp_evt_skip"] = skipped;
}
