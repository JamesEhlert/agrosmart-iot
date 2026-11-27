#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/services/mqtt_link.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Cliente MQTT sobre mTLS X.509 (AWS IoT Core), publicação de Presença
 *            (Birth, Heartbeat, Reboot OTA) e despacho da fila de ACKs (RAM e NVS).
 * ===================================================================================
 */
#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <stdint.h>
#include "config/app_config.h"
#include "config/system_types.h"

extern WiFiClientSecure net;
extern PubSubClient     client;

extern volatile bool g_wifiConnected;
extern volatile bool g_mqttConnected;

const char* mqttStateName(int st);
void        logTlsLastError();
bool        mqttPublish(const char* topic, const uint8_t* payload, uint32_t len, bool retained = false);
bool        publishPresenceOnline(const char* kindLabel = "birth");
void        publishPresenceOtaRebooting();

bool        publishCommandAckDirect(const char* commandId, const char* status, const char* action = nullptr,
                                    int32_t durationS = -1, const char* reason = nullptr, const char* error = nullptr,
                                    const char* interruptedCmdId = nullptr, const AckMessage* origin = nullptr);

void        publishOrQueueAck(const char* commandId, const char* status, const char* action = nullptr,
                              int32_t durationS = -1, const char* reason = nullptr, const char* error = nullptr,
                              const char* interruptedCmdId = nullptr);

void        flushDurableAckTick();
void        flushAckQueueTick();