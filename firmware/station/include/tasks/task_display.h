#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/tasks/task_display.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Task FreeRTOS de Prioridade 1 (Baixa) para atualização periódica do
 *            display OLED SSD1306 I2C (telas de sensores e barra de progresso OTA).
 * ===================================================================================
 */
#include "config/app_config.h"

#if ENABLE_OLED
void taskDisplay(void* pvParameters);
#endif