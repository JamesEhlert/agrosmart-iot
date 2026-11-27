/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/tasks/rtos_sync.cpp
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Instanciação e inicialização verificada (configASSERT) dos objetos de
 *            sincronização e filas do FreeRTOS.
 * ===================================================================================
 */
#include "tasks/rtos_sync.h"
#include "config/app_config.h"
#include "config/system_types.h"

SemaphoreHandle_t logMutex        = nullptr;
SemaphoreHandle_t i2cMutex        = nullptr;
SemaphoreHandle_t dataMutex       = nullptr;
SemaphoreHandle_t valveMutex      = nullptr;
SemaphoreHandle_t sdMutex         = nullptr;
SemaphoreHandle_t cfgMutex        = nullptr;
SemaphoreHandle_t tsMutex         = nullptr;
SemaphoreHandle_t otaMutex        = nullptr;
SemaphoreHandle_t ackMutex        = nullptr;
SemaphoreHandle_t durableAckMutex = nullptr;

QueueHandle_t sensorQueue = nullptr;
QueueHandle_t ackQueue    = nullptr;

portMUX_TYPE g_valveSpinlock = portMUX_INITIALIZER_UNLOCKED;

void initRtosSyncPrimitives() {
  logMutex        = xSemaphoreCreateMutex();
  i2cMutex        = xSemaphoreCreateMutex();
  dataMutex       = xSemaphoreCreateMutex();
  valveMutex      = xSemaphoreCreateMutex();
  sdMutex         = xSemaphoreCreateMutex();
  cfgMutex        = xSemaphoreCreateMutex();
  tsMutex         = xSemaphoreCreateMutex();
  otaMutex        = xSemaphoreCreateMutex();
  ackMutex        = xSemaphoreCreateMutex();
  durableAckMutex = xSemaphoreCreateMutex();

  sensorQueue = xQueueCreate(SENSOR_QUEUE_LEN, sizeof(TelemetryData));
  ackQueue    = xQueueCreate(ACK_QUEUE_LEN, sizeof(AckMessage));

  configASSERT(logMutex != nullptr);
  configASSERT(i2cMutex != nullptr);
  configASSERT(dataMutex != nullptr);
  configASSERT(valveMutex != nullptr);
  configASSERT(sdMutex != nullptr);
  configASSERT(cfgMutex != nullptr);
  configASSERT(tsMutex != nullptr);
  configASSERT(otaMutex != nullptr);
  configASSERT(ackMutex != nullptr);
  configASSERT(durableAckMutex != nullptr);
  configASSERT(sensorQueue != nullptr);
  configASSERT(ackQueue != nullptr);
}