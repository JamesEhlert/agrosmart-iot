#pragma once
/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/include/config/app_config.h
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Segurança (Fase 3 / Parte B — v5.24.0)
 * REVISÃO: 2026-11-22 UTC
 * PROPÓSITO: Flags de compilação, constantes simbólicas operacionais, tempos de
 *            segurança, limites de sanidade ADC, parâmetros WAL/OTA e chaves NVS.
 * CHANGELOG 2026-11-24 (v5.27.0):
 * - Fallback FW_VERSION "5.27.0".
 * - BTN_* / DISPLAY_* / VALVE_CMD_SECTION_WAIT_MS: botões físicos e energia do display.
 * CHANGELOG 2026-11-24 (v5.26.0 (Fase 4.0-E)):
 * - Fallback FW_VERSION "5.26.0".
 * - FLOOD_* / VALVE_MIN_OFF_TO_ON_MS: balde anti-rajada de LIGAR (substitui CMD_RATE_*).
 * - ACK_*: outbox v2 (reenvio, adiamento do LIGAR interrompido, abandono, melhor esforço).
 * CHANGELOG 2026-11-23 (v5.25.2 (Fase 3C)):
 * - Fallback FW_VERSION "5.25.2"; device_id obrigatorio; sys.cmd_rejected; presenca sem IP.
 * CHANGELOG 2026-11-23 (v5.25.1 (Fase 3B, ajustes)):
 * - Fallback FW_VERSION "5.25.1".
 * CHANGELOG 2026-11-23 (v5.25.0 (Fase 3B)):
 * - VALVE_ACTIVE_LOW / ENABLE_VALVE_STATUS_LED (válvula no GPIO26, LED no GPIO2).
 * - VALVE_GUARD_* (guarda independente por esp_timer + heartbeat da task).
 * - POWER_SAFE_MODE_* e chave NVS K_BO_STREAK ("bo_streak").
 * - OTA_OBSERVATION_* substitui OTA_LOCAL_HEALTH_APPROVE_MS (aprovação em 15s).
 * CHANGELOG 2026-11-22 (v5.24.0):
 * - Atualiza fallback FW_VERSION para "5.24.0".
 * - Adiciona OTA_SELF_TEST_ABSOLUTE_DEADLINE_MS = 600000UL (10 min com ou sem Wi-Fi).
 * - Adiciona chaves NVS K_OTA_RBWHY ("ota_rbwhy") e K_OTA_BADVER ("ota_badver").
 * CHANGELOG 2026-11-21 (v5.23.2):
 * - Separa o supervisor de conectividade em 3 camadas:
 *   * VALVE_OFFLINE_FAILSAFE_MS    = 180s (fecha válvula aberta sem reiniciar placa)
 *   * NET_WIFI_SOFT_RESET_EVERY_MS = 300s (reciclagem suave do rádio Wi-Fi/TLS)
 *   * NET_SUPERVISOR_MAX_OFFLINE_MS = 6h  (reboot de último recurso, eliminando
 *                                          ciclos de 480 reboots/dia offline)
 * - Atualiza fallback FW_VERSION para "5.23.2".
 * ===================================================================================
 */
#include <stdint.h>
#include <stddef.h>

// ===================================================================================
// BUILD FLAGS / DEFAULTS
// ===================================================================================
#ifndef FW_VERSION
  #define FW_VERSION "5.27.0"
#endif

// Polaridade do driver da válvula (v5.25.0 (Fase 3B)).
// 1 = módulo relé "low level trigger" (IN em LOW energiza a bobina) — padrão.
// 0 = driver ativo em HIGH (ex.: MOSFET/transistor NPN direto).
#ifndef VALVE_ACTIVE_LOW
  #define VALVE_ACTIVE_LOW 1
#endif

// LED de status no GPIO2 (LED azul da DevKit): aceso = válvula ABERTA.
#ifndef ENABLE_VALVE_STATUS_LED
  #define ENABLE_VALVE_STATUS_LED 1
#endif

#ifndef DEFAULT_TELEMETRY_INTERVAL_MS
  #define DEFAULT_TELEMETRY_INTERVAL_MS 30000UL
#endif

#ifndef ENABLE_OLED
  #define ENABLE_OLED 1
#endif

#ifndef LOG_LEVEL
  #define LOG_LEVEL 2
#endif

#ifndef NVS_FORCE_CONFIG_DEFAULTS
  #define NVS_FORCE_CONFIG_DEFAULTS 0
#endif

#ifndef TELEMETRY_SCHEMA_VERSION
  #define TELEMETRY_SCHEMA_VERSION 2
#endif

#ifndef AGROSMART_TOPIC_PREFIX
  #define AGROSMART_TOPIC_PREFIX "agrosmart/v5"
#endif

// Allowlist estrita dos endpoints HTTPS oficiais do bucket privado S3 OTA
#ifndef OTA_ALLOWED_URL_PREFIX_REGIONAL
  #define OTA_ALLOWED_URL_PREFIX_REGIONAL "https://agrosmart-v5-ota-firmware-851725302756.s3.us-east-2.amazonaws.com/firmware/"
#endif

#ifndef OTA_ALLOWED_URL_PREFIX_GLOBAL
  #define OTA_ALLOWED_URL_PREFIX_GLOBAL "https://agrosmart-v5-ota-firmware-851725302756.s3.amazonaws.com/firmware/"
#endif

// ===================================================================================
// CONSTANTES DE TEMPO, FUSO E SANIDADE DE RELÓGIO
// ===================================================================================
static constexpr long     BRT_OFFSET_SEC          = -10800L;      // UTC-3 (Brasília)
static constexpr uint32_t EPOCH_2020_01_01        = 1577836800UL; // 2020-01-01 00:00:00 UTC
static constexpr uint32_t EPOCH_MAX_SANE          = 2145916800UL; // 2038-01-01 00:00:00 UTC
static constexpr uint32_t FALLBACK_EPOCH_BASE     = 1700000000UL;

// ===================================================================================
// FAIL-SAFE, AMOSTRAGEM RÁPIDA DE CHUVA E SEGURANÇA FÍSICA DA VÁLVULA
// ===================================================================================
static constexpr uint32_t MAX_VALVE_DURATION_S          = 900UL;  // 15 min máximo absoluto por comando e contínuo
static constexpr uint32_t VALVE_DEBUG_EVERY_MS          = 5000UL;
static constexpr uint32_t VALVE_RAIN_SAMPLE_EVERY_MS    = 200UL;  // Amostra chuva a cada 200ms quando a válvula está aberta
static constexpr uint8_t  VALVE_RAIN_DEBOUNCE_SAMPLES   = 3;      // 3 leituras consecutivas (600ms) confirmam chuva real
static constexpr uint32_t POST_VALVE_TELEMETRY_DELAY_MS = 2000UL; // Aguarda 2s após acionar válvula para ler sensores/SD sem atrasar o ACK

// Guarda independente da válvula (esp_timer) — não depende da taskValveControl nem do WDT de 120s
static constexpr uint32_t VALVE_GUARD_PERIOD_MS          = 500UL;  // Verificação a cada 500ms
static constexpr uint32_t VALVE_GUARD_GRACE_MS           = 5000UL; // Tolerância além do prazo antes de a guarda agir
static constexpr uint32_t VALVE_GUARD_HEARTBEAT_STALE_MS = 3000UL; // Task da válvula sem heartbeat por 3s = travada
static constexpr uint8_t  VALVE_GUARD_TRIP_DEADLINE      = 1;
static constexpr uint8_t  VALVE_GUARD_TRIP_STALL         = 2;

// Modo seguro de energia (brownout em série costuma indicar fonte fraca ou queda ao energizar o relé)
static constexpr uint8_t  POWER_SAFE_MODE_BROWNOUT_THRESHOLD = 3;                 // 3 brownouts seguidos ativam o modo seguro
static constexpr uint32_t POWER_SAFE_MODE_DURATION_MS        = 30UL * 60UL * 1000UL; // ON bloqueado por 30 min
static constexpr uint32_t POWER_BROWNOUT_STREAK_CLEAR_MS     = 60UL * 60UL * 1000UL; // 60 min estável zera a série

// ===================================================================================
// RATE LIMITING E CACHE DE IDEMPOTÊNCIA DE COMANDOS MQTT
// ===================================================================================
static constexpr size_t   RECENT_CMD_CACHE_SIZE   = 12;      // Cache circular de idempotência em RAM

// v5.26.0 (Fase 4.0-E): anti-rajada de LIGAR. DESLIGAR nunca é limitado.
static constexpr uint32_t FLOOD_ON_BURST          = 6;        // até 6 LIGAR seguidos...
static constexpr uint32_t FLOOD_ON_REFILL_MS      = 30000UL;  // ...depois 1 a cada 30 s
static constexpr uint32_t VALVE_MIN_OFF_TO_ON_MS  = 2000UL;   // 2 s entre fechar e religar (relé/golpe de aríete)

// v5.26.0 (Fase 4.0-E): outbox de ACK durável v2.
static constexpr uint32_t ACK_RETRY_BASE_MS       = 10000UL;  // reenvio de terminal sem recibo: 10 s...
static constexpr uint32_t ACK_RETRY_JITTER_MS     = 3000UL;   // ...+ até 3 s aleatórios
static constexpr uint32_t ACK_SIBLING_DEFER_MS    = 800UL;    // LIGAR interrompido sai 0,8 s depois do DESLIGAR
static constexpr uint16_t ACK_ABANDON_AFTER_SENDS = 720;      // ~2 h publicando sem recibo -> libera a vaga
static constexpr unsigned ACK_BESTEFFORT_SLOTS    = 4;        // ACK sem vaga durável (RAM)
static constexpr uint8_t  ACK_BESTEFFORT_ATTEMPTS = 3;
static constexpr uint32_t ACK_HEALTH_TICK_MS      = 60000UL;  // autocura do outbox + estatística da NVS

// ===================================================================================
// SUPERVISOR AUTÔNOMO DE CONECTIVIDADE (3 CAMADAS PARA AUTONOMIA DE CAMPO)
// ===================================================================================
static constexpr uint32_t WIFI_ASSOC_GRACE_MS           = 10000UL;               // Aguarda 10s para WPA2 + DHCP antes de reiniciar WiFi.begin()
static constexpr uint32_t VALVE_OFFLINE_FAILSAFE_MS     = 180000UL;              // 3 min sem MQTT fecha válvula aberta (sem reiniciar MCU)
static constexpr uint32_t NET_WIFI_SOFT_RESET_EVERY_MS  = 300000UL;              // 5 min sem MQTT recicla apenas o rádio Wi-Fi/TLS (sem reboot)
static constexpr uint32_t NET_SUPERVISOR_MAX_OFFLINE_MS = 6UL * 3600UL * 1000UL; // 6h sem MQTT força reboot limpo como último recurso
static constexpr uint32_t NET_SUPERVISOR_LOG_EVERY_MS   = 30000UL;               // Loga diagnóstico do supervisor a cada 30s quando desconectado
static constexpr uint32_t PRESENCE_HEARTBEAT_EVERY_MS   = 300000UL;              // Reenvia presença online a cada 5 min (cura perda de Birth)
static constexpr uint8_t  PRESENCE_QOS                  = 1;
static constexpr bool     PRESENCE_RETAIN               = true;

// ===================================================================================
// LIMITES DE SANIDADE DOS SENSORES ANALÓGICOS (ADC 12-bit: 0..4095) E CONFIGURAÇÃO
// ===================================================================================
static constexpr uint32_t MIN_TELEMETRY_INTERVAL_MS = 10000UL;
static constexpr uint32_t MAX_TELEMETRY_INTERVAL_MS = 3600000UL;
static constexpr int      SOIL_RAW_MIN_VALID        = 100;
static constexpr int      SOIL_RAW_MAX_VALID        = 4080;
static constexpr int      SOIL_CALIB_MIN_DELTA      = 100;     // Margem mínima entre seco e molhado
static constexpr int      ADC_MAX_12BIT             = 4095;
static constexpr int      RAIN_RAW_WET_LIMIT        = 1500;
static constexpr int      RAIN_THRESHOLD_PCT        = 50;
static constexpr float    ADC_VREF_VOLTS            = 3.3f;
static constexpr float    UV_SENSOR_GAIN            = 0.1f;
static constexpr float    UV_MIN_NOISE_FLOOR        = 0.2f;

// ===================================================================================
// BARRAMENTO I2C, DISPLAY OLED E SINCRONISMO NTP
// ===================================================================================
static constexpr uint32_t OLED_SWITCH_MS      = 2000UL;
static constexpr uint32_t I2C_MUTEX_WAIT_MS   = 200UL;

// v5.27.0: botões físicos (GPIO27 display, GPIO25 irrigação; ligam ao GND, pull-up interno)
static constexpr uint32_t BTN_POLL_MS                  = 20UL;      // ciclo da task dos botões
static constexpr uint32_t BTN_DEBOUNCE_MS              = 30UL;      // anti-repique
static constexpr uint32_t BTN_IRRIG_HOLD_MS            = 1000UL;    // segurar 1 s para LIGAR
static constexpr uint32_t BTN_STUCK_MS                 = 10000UL;   // >10 s apertado = travado
static constexpr uint32_t BTN_REARM_MS                 = 1000UL;    // travado volta após 1 s solto
static constexpr uint32_t BTN_IRRIG_DEFAULT_MIN        = 5UL;       // duração padrão (1..15 min)
static constexpr uint32_t DISPLAY_TAP_ON_MS            = 5UL * 60UL * 1000UL;  // toque acende 5 min
static constexpr uint32_t DISPLAY_BOOT_SHOW_MS         = 60UL * 1000UL;        // boot aceso 60 s
static constexpr uint32_t VALVE_CMD_SECTION_WAIT_MS    = 500UL;     // seção crítica LIGAR/DESLIGAR
static constexpr unsigned LOCAL_DISPLAY_EVENT_MIN_FREE = 4;         // evento do display só com folga no outbox
static constexpr const char* NTP_SERVER       = "pool.ntp.org";
static constexpr uint32_t NTP_RESYNC_EVERY_MS = 6UL * 3600UL * 1000UL; // Ressincroniza RTC via NTP a cada 6 horas

// ===================================================================================
// FILA WRITE-AHEAD LOG (WAL) SEGMENTADA NO MICROSD E WEAR-LEVELING NVS
// ===================================================================================
static constexpr const char* PENDING_FILENAME          = "/pending_telemetry.ndjson";
static constexpr const char* PENDING_TMP_FILENAME      = "/pending_telemetry.tmp";
static constexpr const char* PENDING_BAK_FILENAME      = "/pending_telemetry.bak";
static constexpr const char* QUEUE_DIR                 = "/queue";
static constexpr uint32_t QUEUE_SEGMENT_MAX_BYTES      = 256UL * 1024UL;         // 256 KB por segmento
static constexpr uint32_t QUEUE_MAX_BYTES              = 16UL * 1024UL * 1024UL; // 16 MB cap (protege wear leveling do SD)
static constexpr size_t   PENDING_LINE_MAX             = 1500;
static constexpr uint32_t SD_REINIT_COOLDOWN_MS        = 30000UL;
static constexpr uint32_t SD_SPI_FREQ_PRIMARY          = 4000000UL;
static constexpr uint32_t SD_SPI_FREQ_FALLBACK         = 1000000UL;
static constexpr uint32_t RECONCILE_EVERY_APPENDS      = 50UL;
static constexpr uint32_t PENDING_FLUSH_EVERY_MS_DEFAULT  = 15000UL;
static constexpr uint32_t PENDING_FLUSH_MAX_ITEMS_DEFAULT = 30UL;
static constexpr uint32_t PENDING_FLUSH_MAX_MS_DEFAULT    = 8000UL;

static constexpr uint32_t SEQ_PERSIST_EVERY = 10;
static constexpr uint32_t OFF_PERSIST_EVERY = 20;
static constexpr uint32_t TS_PERSIST_EVERY  = 20;

// ===================================================================================
// MQTT E LIMITES DE PAYLOAD POR TIPO DE COMANDO
// ===================================================================================
static constexpr uint16_t MQTT_PORT               = 8883;
static constexpr uint16_t MQTT_BUFFER_SIZE        = 4096; // 4 KB para suportar Pre-Signed URLs S3 STS no comando OTA
static constexpr size_t   MAX_STD_CMD_PAYLOAD_LEN = 512;  // Limite estrito de 512B para comandos on/off/config e ack_receipt
static constexpr size_t   MAX_OTA_CMD_PAYLOAD_LEN = 2500; // Limite para comandos OTA com URL pré-assinada do S3

// ===================================================================================
// ATUALIZAÇÃO REMOTA DE FIRMWARE (OTA OVER-THE-AIR RESILIENTE)
// ===================================================================================
static constexpr uint32_t OTA_MIN_FREE_HEAP_BYTES     = 55000UL;  // Mínimo de RAM livre exigida antes de iniciar TLS OTA
static constexpr size_t   OTA_CHUNK_SIZE              = 1024;     // Tamanho do bloco de leitura/escrita em streaming (1 KB)
static constexpr uint32_t OTA_HTTP_TIMEOUT_MS         = 20000UL;  // Timeout de leitura de socket HTTP (20s)
static constexpr uint32_t OTA_MAX_ATTEMPTS            = 3;        // Máximo de tentativas de download em caso de queda de rede
static constexpr uint32_t OTA_WIFI_WAIT_MS            = 20000UL;  // Tempo máximo esperando Wi-Fi voltar entre tentativas OTA
static constexpr uint32_t OTA_MAX_ATTEMPT_TIME_MS     = 180000UL; // Tempo máximo permitido por tentativa de download (3 min)
static constexpr uint32_t OTA_SELF_TEST_DEADLINE_MS          = 90000UL;  // Prazo máximo (90s com Wi-Fi ativo) para conectar ao MQTT
static constexpr uint32_t OTA_SELF_TEST_ABSOLUTE_DEADLINE_MS = 600000UL; // Prazo absoluto (10 min desde o boot, com ou sem Wi-Fi)
static constexpr uint32_t OTA_OBSERVATION_STABLE_MS      = 90000UL; // 90s CONTÍNUOS de MQTT antes de aprovar a partição (reinicia se cair)
static constexpr uint32_t OTA_OBSERVATION_MIN_HEAP_BYTES = 25000UL; // Heap livre mínimo exigido ao final da observação

// ===================================================================================
// WATCHDOG, POLLING DE SENSORES E DIMENSIONAMENTO DE FILAS FREERTOS
// ===================================================================================
static constexpr uint32_t WDT_TIMEOUT_SEC     = 120UL;
static constexpr uint32_t SENSOR_WAKE_POLL_MS = 250UL;  // Verifica gatilho imediato a cada 250ms durante o sleep
static constexpr uint32_t SENSOR_WDT_FEED_MS  = 5000UL; // Alimenta o Watchdog a cada 5s durante períodos longos (10m/30m)
static constexpr size_t   SENSOR_QUEUE_LEN    = 20;
static constexpr size_t   ACK_QUEUE_LEN       = 32;

// ===================================================================================
// CHAVES NVS (NON-VOLATILE STORAGE)
// ===================================================================================
static constexpr const char* NVS_NS         = "agrosmart";
static constexpr const char* K_TELE_INT     = "tele_int";
static constexpr const char* K_SOIL_DRY     = "soil_dry";
static constexpr const char* K_SOIL_WET     = "soil_wet";
static constexpr const char* K_SEQ          = "tele_seq";
static constexpr const char* K_PEND_OFF     = "pend_off";
static constexpr const char* K_PEND_SEG_R   = "pend_seg_r";
static constexpr const char* K_PEND_SEG_W   = "pend_seg_w";
static constexpr const char* K_BOOT_CNT     = "boot_cnt";
static constexpr const char* K_LAST_TS      = "last_ts";
static constexpr const char* K_ACTIVE_CMD   = "active_cmd";
static constexpr const char* K_OTA_CMD      = "ota_cmd";
static constexpr const char* K_OTA_TARGET   = "ota_target";
static constexpr const char* K_OTA_INPROG   = "ota_inprog";
static constexpr const char* K_OTA_SELFTEST = "ota_selftest";
static constexpr const char* K_OTA_RBWHY    = "ota_rbwhy";
static constexpr const char* K_OTA_BADVER   = "ota_badver";
static constexpr const char* K_BO_STREAK    = "bo_streak";
