/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/services/mqtt_link.cpp
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-24 UTC (v5.26.0, Fase 4.0-E)
 * PROPÓSITO: Implementação do transporte MQTT mTLS, presença com session_seq e
 *            reenvio periódico de ACKs duráveis até confirmação (ack_receipt).
 * v5.26.0: ordem de envio (DESLIGAR primeiro), contabilidade para abandono de ACK
 *          sem recibo e fila de melhor esforço; formato do ACK inalterado.
 * ===================================================================================
 */
#include "services/mqtt_link.h"
#include "core/ack_outbox.h"
#include "core/durable_ack.h"
#include "core/time_math.h"
#include "hal/nvs_store.h"
#include "hal/rtc_time_service.h"
#include "services/diagnostics_service.h"
#include "services/logger.h"
#include "tasks/rtos_sync.h"
#include <ArduinoJson.h>
#include <WiFi.h>
#include <esp_system.h>
#include <type_traits>
#include <utility>

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "secrets.h não encontrado. Garanta que está em firmware/include/secrets.h"
#endif

WiFiClientSecure net;
PubSubClient     client(net);

volatile bool g_wifiConnected = false;
volatile bool g_mqttConnected = false;

const char* mqttStateName(int st) {
  switch (st) {
    case MQTT_CONNECTION_TIMEOUT:      return "TIMEOUT";
    case MQTT_CONNECTION_LOST:         return "CONNECTION_LOST";
    case MQTT_CONNECT_FAILED:          return "CONNECT_FAILED";
    case MQTT_DISCONNECTED:            return "DISCONNECTED";
    case MQTT_CONNECTED:               return "CONNECTED";
    case MQTT_CONNECT_BAD_PROTOCOL:    return "BAD_PROTOCOL";
    case MQTT_CONNECT_BAD_CLIENT_ID:   return "BAD_CLIENT_ID";
    case MQTT_CONNECT_UNAVAILABLE:     return "UNAVAILABLE";
    case MQTT_CONNECT_BAD_CREDENTIALS: return "BAD_CREDENTIALS";
    case MQTT_CONNECT_UNAUTHORIZED:    return "UNAUTHORIZED";
    default:                           return "UNKNOWN";
  }
}

template <typename T>
struct has_lastError {
  template <typename U>
  static auto test(int) -> decltype(std::declval<U&>().lastError(static_cast<char*>(nullptr), size_t(0)), std::true_type{});
  template <typename>
  static std::false_type test(...);
  static constexpr bool value = decltype(test<T>(0))::value;
};

template <typename ClientT>
static void logTlsLastError_impl(ClientT& c, std::true_type) {
  char buf[256] = {0};
  int err = c.lastError(buf, sizeof(buf));
  if (err != 0 || buf[0] != '\0') {
    LOGW("[TLS] lastError=%d msg=%s", err, buf);
  }
}

template <typename ClientT>
static void logTlsLastError_impl(ClientT& c, std::false_type) {
  int we = c.getWriteError();
  LOGW("[TLS] writeError=%d", we);
}

void logTlsLastError() {
  logTlsLastError_impl(net, std::integral_constant<bool, has_lastError<WiFiClientSecure>::value>{});
}

bool mqttPublish(const char* topic, const uint8_t* payload, uint32_t len, bool retained) {
  if (!g_mqttConnected || !client.connected()) {
    return false;
  }

  uint16_t bufSz = client.getBufferSize();
  if (len + 10 > bufSz) {
    LOGE("[AWS] payload len=%lu > buffer=%u", static_cast<unsigned long>(len), static_cast<unsigned>(bufSz));
    return false;
  }

  uint32_t t0 = msNow();
  bool ok = client.publish(topic, payload, len, retained);
  uint32_t dt = msNow() - t0;

  if (!ok) {
    int st = client.state();
    LOGE("[AWS] publish FAIL (%lums): state=%d(%s) topic=%s len=%lu",
         static_cast<unsigned long>(dt), st, mqttStateName(st), topic, static_cast<unsigned long>(len));
    logTlsLastError();
  } else {
    LOGD("[AWS] publish OK (%lums): topic=%s len=%lu retained=%d",
         static_cast<unsigned long>(dt), topic, static_cast<unsigned long>(len), static_cast<int>(retained));
  }
  return ok;
}

bool publishPresenceOnline(const char* kindLabel) {
  static char payload[320];
  uint32_t len = 0;
  uint32_t curSess = g_mqttSessionSeq.load();
  if (!buildPresenceJson("online", kindLabel, curSess, payload, sizeof(payload), len)) return false;
  bool ok = mqttPublish(g_topicPresence, reinterpret_cast<const uint8_t*>(payload), len, PRESENCE_RETAIN);
  LOGI("[PRESENCE] Published ONLINE (kind=%s | session_seq=%lu | v%s | part=%s) ok=%d",
       kindLabel, static_cast<unsigned long>(curSess), FW_VERSION, g_runningPartition, static_cast<int>(ok));
  return ok;
}

void publishPresenceOtaRebooting() {
  static char payload[320];
  uint32_t len = 0;
  uint32_t curSess = g_mqttSessionSeq.load();
  if (!buildPresenceJson("offline", "ota_reboot", curSess, payload, sizeof(payload), len)) return;
  mqttPublish(g_topicPresence, reinterpret_cast<const uint8_t*>(payload), len, PRESENCE_RETAIN);
}

bool publishCommandAckDirect(const char* commandId, const char* status, const char* action,
                             int32_t durationS, const char* reason, const char* error,
                             const char* interruptedCmdId, const AckMessage* origin) {
  if (!commandId || commandId[0] == '\0') return false;
  if (!status || status[0] == '\0') status = "unknown";

  recordOrUpdateCommandOutcome(commandId, action, durationS, status, reason);

  RuntimeConfig cfgSnap = cfgGet();
  static StaticJsonDocument<640> doc;
  doc.clear();

  doc["device_id"] = THINGNAME;
  doc["command_id"] = commandId;
  doc["status"] = status;
  if (origin) { if (origin->originTs) doc["ts"] = origin->originTs; else doc["ts"] = nullptr; }
  else doc["ts"] = epochNow();

  JsonObject sys = doc.createNestedObject("sys");
  sys["fw"] = FW_VERSION;
  sys["part"] = g_runningPartition;
  sys["uptime_s"] = origin ? origin->originUptime : static_cast<uint32_t>(msNow() / 1000UL);
  sys["heap"] = static_cast<uint32_t>(esp_get_free_heap_size());
  if (g_wifiConnected) sys["rssi"] = WiFi.RSSI();
  sys["boot_id"] = origin ? origin->originBoot : g_bootId;
  sys["boot_count"] = g_bootCount;
  sys["session_seq"] = origin ? origin->originSession : g_mqttSessionSeq.load();
  sys["reset_reason"] = g_resetReason;
  sys["tele_int_ms"] = origin ? origin->originInterval : cfgSnap.telemetry_interval_ms;
  sys["soil_dry"] = origin ? origin->originSoilDry : cfgSnap.soil_raw_dry;
  sys["soil_wet"] = origin ? origin->originSoilWet : cfgSnap.soil_raw_wet;

  if (action && action[0] != '\0') doc["action"] = action;
  if (durationS >= 0) doc["duration"] = durationS;
  if (reason && reason[0] != '\0') doc["reason"] = reason;
  if (error && error[0] != '\0') doc["error"] = error;
  if (interruptedCmdId && interruptedCmdId[0] != '\0') {
    doc["interrupted_cmd_id"] = interruptedCmdId;
  }

  static char out[768];
  size_t outLen = serializeJson(doc, out, sizeof(out));
  if (outLen == 0) return false;

  bool ok = mqttPublish(g_topicAck, reinterpret_cast<const uint8_t*>(out), static_cast<uint32_t>(outLen), false);
  LOGI("[ACK] status=%s cmd=%s action=%s reason=%s intCmd=%s ok=%d",
       status, commandId,
       action ? action : "-",
       reason ? reason : "-",
       interruptedCmdId && interruptedCmdId[0] ? interruptedCmdId : "-",
       static_cast<int>(ok));
  return ok;
}

void publishOrQueueAck(const char* commandId, const char* status, const char* action,
                       int32_t durationS, const char* reason, const char* error,
                       const char* interruptedCmdId) {
  if (status && (strcmp(status, "done") == 0 || strcmp(status, "failed") == 0)) {
    enqueueAck(commandId, status, action, durationS, reason, error, interruptedCmdId); return;
  }
  if (g_mqttConnected && client.connected()) {
    if (publishCommandAckDirect(commandId, status, action, durationS, reason, error, interruptedCmdId)) {
      return;
    }
  }
  enqueueAck(commandId, status, action, durationS, reason, error, interruptedCmdId);
}

// Serializa um registro do protocolo durável v1 e publica no tópico ack (formato inalterado).
static bool publishDurableRecord(const agroack::Record& r) {
  static StaticJsonDocument<1280> doc;
  static char payload[1280];
  doc.clear();
  doc["ack_protocol"] = 1; doc["event_id"] = r.eventId;
  doc["device_id"] = THINGNAME; doc["command_id"] = r.commandId;
  doc["status"] = r.status; doc["action"] = r.action; doc["duration"] = r.duration;
  if (r.timestamp) doc["ts"] = r.timestamp; else doc["ts"] = nullptr;
  if (r.reason[0]) doc["reason"] = r.reason;
  if (r.error[0]) doc["error"] = r.error;
  if (r.interruptedId[0]) doc["interrupted_cmd_id"] = r.interruptedId;
  doc["evidence"] = strcmp(r.reason, "execution_unknown_after_reset") == 0 ? "unknown_after_reset" : "controller_report";
  JsonObject sys = doc.createNestedObject("sys");
  sys["fw"] = r.fw; sys["part"] = r.part; sys["boot_id"] = r.bootId;
  sys["reset_reason"] = r.resetReason; sys["boot_count"] = r.bootCount;
  sys["session_seq"] = r.session; sys["uptime_s"] = r.uptimeS; sys["heap"] = r.heap;
  sys["rssi"] = r.rssi; sys["tele_int_ms"] = r.intervalMs; sys["soil_dry"] = r.soilDry; sys["soil_wet"] = r.soilWet;
  if (doc.overflowed() || measureJson(doc) >= sizeof(payload)) { LOGE("[ACK][SERIALIZE_ERROR] cmd=%s", r.commandId); return false; }
  size_t len = serializeJson(doc, payload, sizeof(payload));
  return mqttPublish(g_topicAck, reinterpret_cast<const uint8_t*>(payload), len, false);
}

// v5.26.0 (Fase 4.0-E): 1 terminal por volta do loop. Nunca enviados primeiro (o mais
// novo antes: DESLIGAR comandado antes do LIGAR interrompido); depois os reenvios.
// Em seguida, 1 item da fila de melhor esforço (ACK sem vaga durável).
void flushDurableAckTick() {
  agroack::Record r{};
  uint32_t now = msNow();
  if (ackNextDurableToSend(now, r)) {
    bool ok = publishDurableRecord(r);
    ackNoteSent(r.eventId, r.commandId, ok);
    LOGI("[ACK][RETRY] cmd=%s event=%s mqtt_ok=%d; waiting_firestore_receipt=1", r.commandId, r.eventId, int(ok));
  }
  if (ackBestEffortNext(now, r)) {
    bool ok = publishDurableRecord(r);
    LOGW("[ACK][BEST_EFFORT] cmd=%s event=%s mqtt_ok=%d (enviado da RAM, sem vaga duravel)", r.commandId, r.eventId, int(ok));
  }
}

void flushAckQueueTick() {
  if (!g_mqttConnected || !client.connected() || !ackQueue) return;
  flushDurableAckTick();

  for (uint8_t count = 0; count < 8; count++) {
    AckMessage msg{};
    bool hasItem = false;
    if (lockSem(ackMutex, 15)) {
      if (xQueueReceive(ackQueue, &msg, 0) == pdPASS) {
        hasItem = true;
      }
      unlockSem(ackMutex);
    }
    if (!hasItem) break;

    bool ok = publishCommandAckDirect(
      msg.commandId,
      msg.status,
      msg.action[0] ? msg.action : nullptr,
      msg.durationS,
      msg.reason[0] ? msg.reason : nullptr,
      msg.error[0] ? msg.error : nullptr,
      msg.interruptedCmdId[0] ? msg.interruptedCmdId : nullptr,
      &msg
    );

    if (!ok) {
      if (lockSem(ackMutex, 15)) {
        xQueueSendToFront(ackQueue, &msg, 0);
        unlockSem(ackMutex);
      }
      break;
    }
  }
}