#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/tasks/task_sensors.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Task FreeRTOS de Prioridade 3 (Alta) para aquisição filtrada de sensores,
 *            detecção de falha física e enfileiramento na sensorQueue.
 * ===================================================================================
 */

void taskSensors(void* pvParameters);