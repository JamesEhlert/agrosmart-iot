#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/tasks/rtos_sync.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Declaração centralizada de Mutexes, Filas FreeRTOS, Spinlocks e helpers
 *            de aquisição/liberação com timeout determinístico.
 * ===================================================================================
 */
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>
#include <stdint.h>

extern SemaphoreHandle_t logMutex;
extern SemaphoreHandle_t i2cMutex;
extern SemaphoreHandle_t dataMutex;
extern SemaphoreHandle_t valveMutex;
extern SemaphoreHandle_t sdMutex;
extern SemaphoreHandle_t cfgMutex;
extern SemaphoreHandle_t tsMutex;
extern SemaphoreHandle_t otaMutex;
extern SemaphoreHandle_t ackMutex;
extern SemaphoreHandle_t durableAckMutex;

extern QueueHandle_t sensorQueue;
extern QueueHandle_t ackQueue;

extern portMUX_TYPE g_valveSpinlock;

/**
 * Cria e valida via configASSERT todos os Mutexes e Filas do FreeRTOS no boot.
 */
void initRtosSyncPrimitives();

inline bool lockSem(SemaphoreHandle_t sem, uint32_t waitMs) {
  if (!sem) return false;
  return xSemaphoreTake(sem, pdMS_TO_TICKS(waitMs)) == pdTRUE;
}

inline void unlockSem(SemaphoreHandle_t sem) {
  if (sem) xSemaphoreGive(sem);
}