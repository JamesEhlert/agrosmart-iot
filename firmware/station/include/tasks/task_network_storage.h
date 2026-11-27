#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/tasks/task_network_storage.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Task FreeRTOS de Prioridade 2 (Média) para gerência de Wi-Fi/MQTT mTLS,
 *            Supervisor Autônomo de Conectividade (180s), sincronismo NTP, despacho
 *            de ACKs, fila WAL no MicroSD e atualização remota OTA.
 * ===================================================================================
 */

void taskNetworkStorage(void* pvParameters);