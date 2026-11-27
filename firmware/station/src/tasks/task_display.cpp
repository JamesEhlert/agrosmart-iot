/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/tasks/task_display.cpp
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-24 UTC (v5.27.0)
 * PROPÓSITO: Implementação da taskDisplay protegida por i2cMutex.
 * CHANGELOG 2026-11-24 (v5.27.0):
 * - Energia do painel (DISPLAYON/OFF) segue o padrão da NVS, o botão e o app
 *   (services/local_controls). Desligado: nada é desenhado (menos tráfego I2C).
 * - Espera em fatias de 100 ms: um toque no botão acende/apaga na hora.
 * - Durante o OTA o painel sempre acende para mostrar o progresso.
 * ===================================================================================
 */
#include "tasks/task_display.h"

#if ENABLE_OLED
#include "config/app_config.h"
#include "config/system_types.h"
#include "core/valve_controller.h"
#include "hal/oled_display.h"
#include "hal/rtc_time_service.h"
#include "hal/sd_telemetry_wal.h"
#include "hal/sensor_drivers.h"
#include "services/diagnostics_service.h"
#include "services/local_controls.h"
#include "tasks/rtos_sync.h"
#include <esp_task_wdt.h>

extern volatile bool    g_wifiConnected;
extern volatile bool    g_mqttConnected;
extern volatile bool    g_otaInProgress;
extern volatile uint8_t g_otaProgressPct;
extern volatile uint8_t g_otaCurrentAttempt;

// v5.27.0: espera até `totalMs`, mas volta antes se o botão/app pedir redesenho.
static void waitDisplayOrWake(uint32_t totalMs) {
  for (uint32_t waited = 0; waited < totalMs; waited += 100UL) {
    if (localDisplayTakeWake()) return;
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

void taskDisplay(void* pvParameters) {
  (void)pvParameters;
#ifdef ESP32
  esp_task_wdt_add(NULL);
#endif
  int screen = 0;
  bool panelOn = true;  // display.begin() deixa o painel ligado

  for (;;) {
#ifdef ESP32
    esp_task_wdt_reset();
#endif
    // v5.27.0: energia do painel. OTA sempre mostra o progresso.
    bool wantOn = g_otaInProgress || localDisplayShouldBeOn();
    if (wantOn != panelOn && lockSem(i2cMutex, I2C_MUTEX_WAIT_MS)) {
      if (!wantOn) {  // limpa antes de apagar: ao reacender não aparece tela velha
        display.clearDisplay();
        display.display();
      }
      display.ssd1306_command(wantOn ? SSD1306_DISPLAYON : SSD1306_DISPLAYOFF);
      unlockSem(i2cMutex);
      panelOn = wantOn;
      if (panelOn) screen = 0;
    }
    if (!panelOn) {
      waitDisplayOrWake(500UL);
      continue;
    }
    TelemetryData local{};
    if (lockSem(dataMutex, 50)) { local = g_latestData; unlockSem(dataMutex); }

    bool valveOn = false;
    uint32_t dummyOff = 0;
    valveReadStateAtomic(valveOn, dummyOff);

    uint32_t pendingBytesCached = sdQueueTotalBytes(false);
    DateTime nowUTC = getSystemTime();

    if (lockSem(i2cMutex, I2C_MUTEX_WAIT_MS)) {
      display.clearDisplay();
      display.setTextColor(WHITE);

      if (g_otaInProgress) {
        uint8_t pct = g_otaProgressPct;
        uint8_t att = g_otaCurrentAttempt;
        display.setTextSize(1);
        display.setCursor(0, 0);
        display.printf("OTA S3 (T%u/%u)", static_cast<unsigned>(att), static_cast<unsigned>(OTA_MAX_ATTEMPTS));
        display.drawLine(0, 10, 128, 10, WHITE);

        display.setTextSize(2);
        display.setCursor(38, 18);
        display.printf("%u%%", static_cast<unsigned>(pct));

        display.drawRect(4, 42, 120, 12, WHITE);
        int barWidth = (static_cast<int>(pct) * 116) / 100;
        if (barWidth > 0) {
          display.fillRect(6, 44, barWidth, 8, WHITE);
        }
        display.setTextSize(1);
        display.setCursor(10, 56);
        display.print("Verificando SHA256");
      } else {
        DateTime nowBRT = DateTime(nowUTC.unixtime() + BRT_OFFSET_SEC);

        display.setTextSize(1);
        display.setCursor(0, 0);
        display.printf("%02d:%02d", nowBRT.hour(), nowBRT.minute());
        display.setCursor(40, 0);
        display.print(valveOn ? "REGANDO!" : (g_wifiConnected ? "W:OK" : "W:X"));
        display.drawLine(0, 9, 128, 9, WHITE);

        display.setCursor(0, 15);
        switch (screen) {
          case 0:
            display.printf("FW:%s (%s)\n", FW_VERSION, g_runningPartition);
            display.printf("MQTT: %s\n", g_mqttConnected ? "ON" : "OFF");
            display.printf("SD:   %s\n", g_sdOk ? "OK" : "ERRO");
            display.printf("PEND: %lu B\n", static_cast<unsigned long>(pendingBytesCached));
            display.printf("VALV: %s\n", valveOn ? "ON" : "OFF");
            break;
          case 1:
            display.setTextSize(2);
            display.printf("%.1fC\n", local.air_temp);
            display.setTextSize(1);
            display.printf("Um:%.0f%% UV:%.1f", local.air_hum, local.uv_index);
            break;
          case 2:
            display.setTextSize(1);
            display.println("SOLO/LUZ/CHUVA:");
            display.setTextSize(2);
            if (local.soil_fault) {
              display.println("ERR SOLO");
            } else {
              display.printf("%d%%\n", local.soil_moisture);
            }
            display.setTextSize(1);
            display.printf("Lz:%d%% Chv:%d%%", local.light_level, local.rain_pct);
            break;
        }
      }

      display.display();
      unlockSem(i2cMutex);
    }
    waitDisplayOrWake(g_otaInProgress ? 400UL : OLED_SWITCH_MS);
    if (!g_otaInProgress) {
      screen = (screen + 1) % 3;
    }
  }
}
#endif // ENABLE_OLED