#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/core/command_parser.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Callback receptor de comandos MQTT (agrosmart/v5/<THINGNAME>/command),
 *            validação de segurança de payload, idempotência, TTL, rate-limiting e
 *            despacho para ações on, off, config, ota e ack_receipt.
 * ===================================================================================
 */
#include <Arduino.h>

void mqttCallback(char* topic, byte* payload, unsigned int length);