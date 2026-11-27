#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/tasks/task_valve_control.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Task FreeRTOS de Prioridade 4 (Máxima) dedicada ao controle físico
 *            determinístico (100ms) da válvula solenoide e Edge Interlock de chuva.
 * ===================================================================================
 */

/**
 * Task de tempo real (Prioridade 4) de supervisão física da válvula solenoide.
 */
void taskValveControl(void* pvParameters);