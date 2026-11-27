/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/services/diagnostics_service.cpp
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Bloco 2 — F4.2 Tópico ack_receipt)
 * REVISÃO: 2026-11-21 UTC
 * PROPÓSITO: Implementação das métricas de diagnóstico, identificação de boot,
 *            tópicos MQTT isolados (`command` vs `ack_receipt`) e serialização JSON
 *            de Telemetria (Schema V2) e Presença.
 * ===================================================================================
 */
#include "services/diagnostics_service.h"
#include "services/local_controls.h"
#include "core/ack_outbox.h"
#include "core/time_math.h"
#include "hal/nvs_store.h"
#include "hal/rtc_time_service.h"
#include "hal/sensor_drivers.h"
#include "hal/sd_telemetry_wal.h"
#include "services/logger.h"
#include "tasks/rtos_sync.h"
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_heap_caps.h>

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "secrets.h não encontrado. Garanta que está em firmware/include/secrets.h"
#endif

extern volatile bool g_wifiConnected;

char g_topicTelemetry[128];
char g_topicCommand[128];
char g_topicAck[128];
char g_topicAckReceipt[128];
char g_topicPresence[128];

char     g_runningPartition[16] = "unknown";
bool     g_partitionNeedsVerify = false;
bool     g_appSelfTestPending   = false;
uint32_t g_wifiConnectedSinceMs = 0;

std::atomic<uint32_t> g_sdWriteErrors{0};
std::atomic<uint32_t> g_sdCorruptLines{0};
std::atomic<uint32_t> g_wifiDisconnects{0};
std::atomic<uint32_t> g_mqttReconnects{0};
std::atomic<uint32_t> g_mqttSessionSeq{0};
std::atomic<uint32_t> g_sensorErrAHT{0};
std::atomic<uint32_t> g_rainInterlocks{0};
std::atomic<uint32_t> g_ackDrops{0};
std::atomic<uint32_t> g_cmdRejected{0};  // v5.25.2 (Fase 3C)
std::atomic<uint32_t> g_telemetryDropped{0};

uint32_t    g_bootCount   = 0;

// v5.25.0 (Fase 3B): modo seguro de energia
uint8_t           g_brownoutStreak = 0;
std::atomic<bool> g_brownoutStreakClearRequested{false};
static volatile bool     s_powerSafeModeActive  = false;
static volatile uint32_t s_powerSafeModeUntilMs = 0;

static void initBrownoutSafeMode(esp_reset_reason_t rr) {
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  uint8_t streak = p.isKey(K_BO_STREAK) ? p.getUChar(K_BO_STREAK, 0) : 0;
  if (rr == ESP_RST_BROWNOUT) {
    if (streak < 255) streak++;
    p.putUChar(K_BO_STREAK, streak);
  }
  p.end();
  g_brownoutStreak = streak;
  if (streak >= POWER_SAFE_MODE_BROWNOUT_THRESHOLD) {
    s_powerSafeModeUntilMs = msNow() + POWER_SAFE_MODE_DURATION_MS;
    s_powerSafeModeActive = true;
    LOGE("[POWER][SAFE-MODE] %u brownouts seguidos: comandos ON bloqueados por %lu min. Verifique a fonte!",
         static_cast<unsigned>(streak), static_cast<unsigned long>(POWER_SAFE_MODE_DURATION_MS / 60000UL));
  } else if (streak > 0) {
    LOGW("[POWER] Serie de brownouts=%u (limite=%u).", static_cast<unsigned>(streak),
         static_cast<unsigned>(POWER_SAFE_MODE_BROWNOUT_THRESHOLD));
  }
}

bool powerSafeModeActive() {
  if (!s_powerSafeModeActive) return false;
  if (timeReached(msNow(), s_powerSafeModeUntilMs)) {
    s_powerSafeModeActive = false;
    return false;
  }
  return true;
}

void powerStabilityTick(uint32_t nowMs) {
  if (s_powerSafeModeActive && timeReached(nowMs, s_powerSafeModeUntilMs)) {
    s_powerSafeModeActive = false;
    LOGW("[POWER][SAFE-MODE] Modo seguro expirou; comandos ON liberados.");
  }
  if (g_brownoutStreak == 0) {
    g_brownoutStreakClearRequested.store(false);
    return;
  }
  bool byCycle = g_brownoutStreakClearRequested.exchange(false);
  bool byUptime = timeReached(nowMs, POWER_BROWNOUT_STREAK_CLEAR_MS);
  if (!byCycle && !byUptime) return;
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  if (p.isKey(K_BO_STREAK)) p.remove(K_BO_STREAK);
  p.end();
  LOGI("[POWER] Serie de brownouts zerada (%s).", byCycle ? "rega_completa" : "uptime_estavel");
  g_brownoutStreak = 0;
}
char        g_bootId[17]  = {0};
const char* g_resetReason = "unknown";

void buildMqttTopics() {
  snprintf(g_topicTelemetry,  sizeof(g_topicTelemetry),  "%s/%s/telemetry",   AGROSMART_TOPIC_PREFIX, THINGNAME);
  snprintf(g_topicCommand,    sizeof(g_topicCommand),    "%s/%s/command",     AGROSMART_TOPIC_PREFIX, THINGNAME);
  snprintf(g_topicAck,        sizeof(g_topicAck),        "%s/%s/ack",         AGROSMART_TOPIC_PREFIX, THINGNAME);
  snprintf(g_topicAckReceipt, sizeof(g_topicAckReceipt), "%s/%s/ack_receipt", AGROSMART_TOPIC_PREFIX, THINGNAME);
  snprintf(g_topicPresence,   sizeof(g_topicPresence),   "%s/%s/presence",    AGROSMART_TOPIC_PREFIX, THINGNAME);
}

const char* resetReasonName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:   return "poweron";
    case ESP_RST_EXT:       return "ext_reset";
    case ESP_RST_SW:        return "sw_reset";
    case ESP_RST_PANIC:     return "panic";
    case ESP_RST_INT_WDT:   return "int_wdt";
    case ESP_RST_TASK_WDT:  return "task_wdt";
    case ESP_RST_WDT:       return "other_wdt";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_BROWNOUT:  return "brownout";
    case ESP_RST_SDIO:      return "sdio";
    default:                return "unknown";
  }
}

void persistBootCount() {
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  p.putUInt(K_BOOT_CNT, g_bootCount);
  p.end();
}

void initBootDiagnostics() {
  g_resetReason = resetReasonName(esp_reset_reason());
  Preferences p;
  if (p.begin(NVS_NS, true)) {
    g_bootCount = p.getUInt(K_BOOT_CNT, 0);
    p.end();
  }
  g_bootCount++;
  persistBootCount();
  initBrownoutSafeMode(esp_reset_reason());
  uint32_t r1 = static_cast<uint32_t>(esp_random());
  uint32_t r2 = static_cast<uint32_t>(esp_random());
  snprintf(g_bootId, sizeof(g_bootId), "%08lX%08lX",
           static_cast<unsigned long>(r1), static_cast<unsigned long>(r2));
  LOGI("[BOOT][DIAG] boot_id=%s | boot_count=%lu | reset_reason=%s",
       g_bootId, static_cast<unsigned long>(g_bootCount), g_resetReason);
}

void printConfig() {
  RuntimeConfig c = cfgGet();
  uint32_t freeHeap = esp_get_free_heap_size();
  uint32_t maxBlock = heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);
  LOGI("FW=%s | PART=%s | THING=%s | schema=%d | freeHeap=%lu B | maxContigBlock=%lu B",
       FW_VERSION, g_runningPartition, THINGNAME, TELEMETRY_SCHEMA_VERSION,
       static_cast<unsigned long>(freeHeap),
       static_cast<unsigned long>(maxBlock));
  LOGI("[MQTT] telemetry=%s | command=%s | ack=%s | ack_receipt=%s | presence=%s",
       g_topicTelemetry, g_topicCommand, g_topicAck, g_topicAckReceipt, g_topicPresence);
  LOGI("[NVS] tele_int=%lu ms, soil(dry=%d wet=%d), seq=%lu, pend_off=%lu, boot_cnt=%lu",
       static_cast<unsigned long>(c.telemetry_interval_ms), c.soil_raw_dry, c.soil_raw_wet,
       static_cast<unsigned long>(g_telemetrySeq.load()), static_cast<unsigned long>(g_pendingOffset),
       static_cast<unsigned long>(g_bootCount));
}

void makeTelemetryId(char* out, size_t outSz, uint32_t ts, uint32_t seq) {
  snprintf(out, outSz, "%s:%lu:%lu", THINGNAME, static_cast<unsigned long>(ts), static_cast<unsigned long>(seq));
}

bool buildPresenceJson(const char* state, const char* kind, uint32_t sessionSeq,
                       char* out, size_t outSz, uint32_t& outLen) {
  if (!state || !out || outSz < 8) return false;

  static StaticJsonDocument<448> doc;
  doc.clear();

  doc["device_id"] = THINGNAME;
  doc["state"] = state;
  doc["kind"]  = kind ? kind : "evt";
  doc["fw"]    = FW_VERSION;
  doc["part"]  = g_runningPartition;
  doc["uptime_ms"] = msNow();
  doc["boot_id"] = g_bootId;
  doc["boot_count"] = g_bootCount;
  doc["session_seq"] = sessionSeq;
  doc["reset_reason"] = g_resetReason;
  // v5.25.1 (Fase 3B): true enquanto a particao nova esta em observacao (ainda reversivel)
  doc["ota_pending_verify"] = (g_partitionNeedsVerify || g_appSelfTestPending);

  uint32_t curEpoch = epochNow();
  if (isValidEpoch(curEpoch)) {
    doc["epoch"] = curEpoch;
  }

  // v5.25.2 (Fase 3C): IP local nao e mais enviado a nuvem (minimizacao de dados).

  outLen = static_cast<uint32_t>(serializeJson(doc, out, outSz));
  if (outLen == 0 || outLen >= outSz) return false;
  out[outLen] = '\0';
  return true;
}

bool buildTelemetryJson(const TelemetryData& d, char* out, size_t outSz, uint32_t& outLen) {
  static StaticJsonDocument<2048> doc;  // v5.26.0: +campos do outbox v2
  doc.clear();

  RuntimeConfig cfgSnap = cfgGet();

  doc["device_id"] = THINGNAME;
  doc["timestamp"] = d.timestamp;
  doc["telemetry_seq"] = d.seq;

  char tid[80];
  makeTelemetryId(tid, sizeof(tid), d.timestamp, d.seq);
  doc["telemetry_id"] = tid;

  JsonObject s = doc.createNestedObject("sensors");
  s["air_temp"] = d.air_temp;
  s["air_humidity"] = d.air_hum;
  s["soil_moisture"] = d.soil_moisture;
  s["soil_raw"] = d.soil_raw;
  s["soil_fault"] = d.soil_fault;
  s["light_level"] = d.light_level;
  s["rain_raw"] = d.rain_raw;
  s["rain_pct"] = d.rain_pct;
  s["rain_detected"] = d.rain_detected;
  s["uv_index"] = d.uv_index;

  const char* tsSourceSnapshot = "rtc";
  if (lockSem(tsMutex, 10)) {
    tsSourceSnapshot = g_lastTsSource;
    unlockSem(tsMutex);
  }

  bool anyHardwareAlert = (!g_sdOk || !g_rtcOk || !g_ahtOk || d.soil_fault);

  JsonObject sys = doc.createNestedObject("sys");
  sys["fw"] = FW_VERSION;
  sys["part"] = g_runningPartition;
  sys["schema"] = TELEMETRY_SCHEMA_VERSION;
  sys["health"] = anyHardwareAlert ? "alert" : "ok";
  sys["uptime_s"] = static_cast<uint32_t>(msNow() / 1000UL);
  sys["heap"] = d.sampled_heap > 0 ? d.sampled_heap : static_cast<uint32_t>(esp_get_free_heap_size());
  if (d.sampled_wifi_conn) {
    sys["rssi"] = d.sampled_rssi;
  } else if (g_wifiConnected) {
    sys["rssi"] = WiFi.RSSI();
  }

  sys["boot_id"] = g_bootId;
  sys["boot_count"] = g_bootCount;
  sys["session_seq"] = g_mqttSessionSeq.load();
  sys["reset_reason"] = g_resetReason;
  sys["ts_source"] = tsSourceSnapshot;
  sys["tele_int_ms"] = cfgSnap.telemetry_interval_ms;
  sys["soil_dry"] = cfgSnap.soil_raw_dry;
  sys["soil_wet"] = cfgSnap.soil_raw_wet;
  sys["wifi_disc"] = g_wifiDisconnects.load();
  sys["mqtt_reconn"] = g_mqttReconnects.load();
  sys["aht_err"] = g_sensorErrAHT.load();
  sys["rain_interlocks"] = g_rainInterlocks.load();
  sys["ack_drops"] = g_ackDrops.load();
  sys["cmd_rejected"] = g_cmdRejected.load();  // v5.25.2 (Fase 3C)
  if (lockSem(durableAckMutex, 10)) {
    unsigned pendingAcks = 0, usedAcks = 0;
    for (unsigned i = 0; i < agroack::CAPACITY; ++i) {
      if (g_durableAcks.records[i].kind != agroack::Empty) ++usedAcks;
      if (g_durableAcks.records[i].kind == agroack::Terminal) ++pendingAcks;
    }
    sys["ack_outbox_pending"] = pendingAcks;
    sys["ack_outbox_used"] = usedAcks;
    sys["ack_outbox_fault"] = g_durableAcks.fault;
    // v5.26.0 (Fase 4.0-E): saúde do outbox v2
    sys["ack_evicted"] = g_durableAcks.evicted;
    sys["ack_repaired"] = g_durableAcks.repaired;
    sys["ack_write_fail"] = g_durableAcks.writeFailures;
    if (g_durableAcks.fault) sys["health"] = "alert";
    unlockSem(durableAckMutex);
  } else {
    sys["ack_outbox_pending"] = nullptr;
    sys["ack_outbox_fault"] = nullptr;
  }
  sys["ack_besteffort"] = g_ackBestEffort.load();
  sys["ack_abandoned"] = g_ackAbandoned.load();
  sys["flood_rejects"] = g_floodRejects.load();
  {
    int32_t nvsFree = g_nvsFreeEntries.load();
    if (nvsFree >= 0) sys["nvs_free"] = nvsFree; else sys["nvs_free"] = nullptr;
  }
  sys["telemetry_dropped"] = g_telemetryDropped.load();

  sys["sd_ok"] = g_sdOk;
  sys["rtc_ok"] = g_rtcOk;
  sys["aht_ok"] = g_ahtOk;
  sys["soil_fault"] = d.soil_fault;
  sys["sd_err"] = g_sdWriteErrors.load();
  sys["corrupt_lines"] = g_sdCorruptLines.load();

  sys["valve_state"] = d.sampled_valve_state;
  if (d.sampled_valve_state == 1) {
    sys["valve_remaining_s"] = d.sampled_valve_rem_s;
  }
  sys["battery_present"] = false;
  localControlsFillSys(sys);  // v5.27.0: display e botões (disp, disp_def, disp_left_s, btn_min, btn_fault)

  uint32_t pendSz = sdQueueTotalBytes(false);
  if (lockSem(sdMutex, 20)) {
    sys["pending_bytes"] = pendSz;
    sys["pending_off"] = g_pendingOffset;
    sys["pending_seg_r"] = g_pendingSegRead;
    sys["pending_seg_w"] = g_pendingSegWrite;
    unlockSem(sdMutex);
  } else {
    sys["pending_bytes"] = pendSz;
  }

  if (doc.overflowed()) {
    LOGE("[JSON] StaticJsonDocument estourou capacidade em buildTelemetryJson!");
    return false;
  }

  size_t needed = measureJson(doc) + 1;
  if (needed > outSz) {
    LOGE("[JSON] buffer pequeno: needed=%u outSz=%u", static_cast<unsigned>(needed), static_cast<unsigned>(outSz));
    return false;
  }

  outLen = static_cast<uint32_t>(serializeJson(doc, out, outSz));
  return outLen > 0;
}
