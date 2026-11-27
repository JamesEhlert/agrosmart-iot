#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/config/board_pins.h
 * RESPONSÁVEL: James Rafael Ehlert Reinard
 * REVISÃO: 2026-11-24 UTC (v5.27.0: botões no GPIO27 e GPIO25)
 * PROPÓSITO: Mapeamento físico de pinos GPIO (ESP32 DOIT DevKit V1) e dimensões de
 *            periféricos locais (SPI, I2C, ADC1 e Display OLED SSD1306).
 * ===================================================================================
 */

// Pinos de Sensores Analógicos (ADC1 - Compatível com Wi-Fi ativo) e Atuadores
#define SD_CS_PIN  5
#define PIN_SOLO   34
#define PIN_CHUVA  35
#define PIN_UV     32
#define PIN_LUZ    33
// v5.25.0 (Fase 3B): válvula saiu do GPIO2 (strapping pin com pull-down interno no reset:
// com relé active-low, cada reset/OTA dava um pulso de abertura). O GPIO26 fica em
// alta impedância no reset, o que mantém o relé desligado até o setup().
#define PIN_VALVE  26
#define PIN_VALVE_STATUS_LED 2   // LED azul da DevKit: aceso = válvula ABERTA

// v5.27.0: botões físicos (push button entre o pino e o GND; pull-up interno)
#define PIN_BTN_DISPLAY     27   // toque: acende o display 5 min / apaga
#define PIN_BTN_IRRIGATION  25   // segurar 1 s: liga a irrigação; toque: desliga

// Barramento SPI (Cartão MicroSD)
#define PIN_SPI_SCK  18
#define PIN_SPI_MISO 19
#define PIN_SPI_MOSI 23

// Barramento I2C (RTC DS3231, Sensor AHTX0 e Display OLED SSD1306)
#define PIN_I2C_SDA  21
#define PIN_I2C_SCL  22

// Dimensões do Display OLED I2C (0x3C)
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
