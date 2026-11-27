#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/hal/oled_display.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-14 UTC
 * PROPÓSITO: Instância compartilhada do controlador OLED SSD1306 I2C (0x3C).
 * ===================================================================================
 */
#include <Arduino.h>
#include <Wire.h>
#include "config/app_config.h"
#include "config/board_pins.h"

#if ENABLE_OLED
  #include <Adafruit_GFX.h>
  #include <Adafruit_SSD1306.h>
  extern Adafruit_SSD1306 display;
#endif