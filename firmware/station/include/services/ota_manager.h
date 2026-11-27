#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/services/ota_manager.h
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Fase 3 / Parte B — v5.24.0)
 * REVISÃO: 2026-11-22 UTC
 * CHANGELOG 2026-11-22 (v5.24.0):
 * - Atualiza `scheduleOtaJob` para transportar assinatura (`sigB64`, `sigAlg`).
 * PROPÓSITO: Motor de atualização remota de firmware Over-The-Air (OTA HTTPS via
 *            Amazon S3 Pre-Signed URL), streaming SHA-256, Self-Test e Auto-Rollback.
 * ===================================================================================
 */
#include <Arduino.h>
#include <stdint.h>
#include "config/app_config.h"
#include "config/system_types.h"

extern volatile bool    g_otaInProgress;
extern volatile uint8_t g_otaProgressPct;
extern volatile uint8_t g_otaCurrentAttempt;
extern OtaJobRequest    g_otaJob;

/**
 * Executa o Rollback determinístico para a partição anterior (`app0` <-> `app1`)
 * caso o novo firmware falhe no Self-Test.
 */
void triggerEmergencyOtaRollbackAndReboot(const char* failReasonLog);

/**
 * Inspeciona as partições da memória Flash (`app0` / `app1`) no boot.
 */
void inspectFlashPartitionsOnBoot();

/**
 * Confirma a partição atual no Bootloader do ESP-IDF após estabilidade local comprovada.
 */
void approveHardwarePartitionIfStable();

/**
 * Conclui o Self-Test pós-OTA assim que a sessão mTLS com o AWS IoT Core é estabelecida.
 */
void confirmOtaSelfTestAfterMqttConnected();

/**
 * v5.25.0 (Fase 3B): chamado a cada conexão MQTT. Se houver partição/self-test pendente,
 * inicia a observação de OTA_OBSERVATION_STABLE_MS; caso contrário finaliza na hora
 * (detecção de rollback e ACK).
 */
void otaOnMqttConnected();

/**
 * Chamado no loop de rede: aprova a partição só após 90s CONTÍNUOS de MQTT com heap OK.
 */
void otaObservationTick(bool mqttConnectedNow);

/**
 * true depois que o MQTT conectou ao menos uma vez neste boot com self-test pendente.
 */
bool otaSelfTestMqttSeen();

/**
 * Agenda uma atualização OTA validada pelo callback MQTT para execução na taskNetworkStorage.
 */
bool scheduleOtaJob(const char* cmdId, const char* version, const char* sha256,
                    const char* url, uint32_t fileSize,
                    const char* sigB64, const char* sigAlg);

/**
 * Aguarda reconexão Wi-Fi entre tentativas de download OTA.
 */
bool waitWifiForOtaRetry(uint32_t maxWaitMs);

/**
 * Executa o download OTA HTTPS S3 em streaming com verificação SHA-256 e intertravamento de válvula.
 */
void executePendingOtaJobIfAny();
