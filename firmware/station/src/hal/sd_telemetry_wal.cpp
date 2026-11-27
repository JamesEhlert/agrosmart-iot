/**
 * ===================================================================================
 * PROJETO: AgroSmart Precision IoT V5
 * ARQUIVO: firmware/src/hal/sd_telemetry_wal.cpp
 * RESPONSÁVEL PELA ALTERAÇÃO: Revisão de Confiabilidade Offline (v5.23.2)
 * REVISÃO: 2026-11-21 UTC
 * PROPÓSITO: Implementação da fila persistente WAL no MicroSD (/queue) protegida por
 *            sdMutex, envio Store-and-Forward e esvaziamento seguro antes de reboot.
 * CHANGELOG 2026-11-21 (v5.23.2):
 * - Corrige reconciliação em `sdReconcilePendingState()` que revertia `g_pendingSegWrite`
 *   para `maxSeg` após rotação de segmento cheio (causava repetição de `Rotacionado para seg=N`).
 * - Zera ponteiros (`segR=0, segW=0, off=0`) ao remover o último segmento drenado.
 * ===================================================================================
 */
#include "hal/sd_telemetry_wal.h"
#include "config/board_pins.h"
#include "core/time_math.h"
#include "hal/nvs_store.h"
#include "hal/rtc_time_service.h"
#include "services/diagnostics_service.h"
#include "services/logger.h"
#include "tasks/rtos_sync.h"
#include <SPI.h>
#include <SD.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <esp_task_wdt.h>

extern PubSubClient  client;
extern volatile bool g_mqttConnected;

void flushAckQueueTick();
bool mqttPublish(const char* topic, const uint8_t* payload, uint32_t len, bool retained = false);

volatile bool g_sdOk = false;
char          g_netSharedJsonBuf[1536];

std::atomic<uint32_t> g_cachedQueueBytes{0};
std::atomic<bool>     g_queueBytesDirty{true};
uint32_t              g_appendCounter  = 0;
uint32_t              g_sdLastReinitMs = 0;

String getDailyCsvFilename() {
  DateTime now = getSystemTime();
  char buf[64];
  if (now.year() >= 2020 && now.year() < 2038) {
    snprintf(buf, sizeof(buf), "/telemetry_%04d-%02d-%02d.csv", now.year(), now.month(), now.day());
  } else {
    snprintf(buf, sizeof(buf), "/telemetry_default.csv");
  }
  return String(buf);
}

void queueMakeSegPath(uint32_t segId, char* out, size_t outSz) {
  snprintf(out, outSz, "%s/q_%08lu.ndjson", QUEUE_DIR, static_cast<unsigned long>(segId));
}

bool sdQueueEnsureDirLocked() {
  if (SD.exists(QUEUE_DIR)) return true;
  bool ok = SD.mkdir(QUEUE_DIR);
  if (!ok) LOGE("[SD][QUEUE] Falha ao criar dir %s", QUEUE_DIR);
  return ok;
}

bool sdQueueFindMinMaxLocked(uint32_t& minSeg, uint32_t& maxSeg, uint32_t& count) {
  minSeg = 0xFFFFFFFFUL;
  maxSeg = 0;
  count = 0;

  File dir = SD.open(QUEUE_DIR);
  if (!dir) return false;

  for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
    const char* name = f.name();
    const char* base = strrchr(name, '/');
    base = base ? (base + 1) : name;

    unsigned long id = 0;
    if (sscanf(base, "q_%lu.ndjson", &id) == 1) {
      if (static_cast<uint32_t>(id) < minSeg) minSeg = static_cast<uint32_t>(id);
      if (static_cast<uint32_t>(id) > maxSeg) maxSeg = static_cast<uint32_t>(id);
      count++;
    }
    f.close();
  }

  dir.close();
  return count > 0;
}

uint32_t sdQueueSegSizeLocked(uint32_t segId) {
  char path[64];
  queueMakeSegPath(segId, path, sizeof(path));
  if (!SD.exists(path)) return 0;
  File f = SD.open(path, FILE_READ);
  if (!f) return 0;
  uint32_t s = static_cast<uint32_t>(f.size());
  f.close();
  return s;
}

uint32_t sdQueueComputeTotalBytesLocked() {
  if (!SD.exists(QUEUE_DIR)) {
    g_cachedQueueBytes.store(0);
    g_queueBytesDirty.store(false);
    return 0;
  }

  uint32_t minSeg = 0, maxSeg = 0, count = 0;
  if (!sdQueueFindMinMaxLocked(minSeg, maxSeg, count)) {
    g_cachedQueueBytes.store(0);
    g_queueBytesDirty.store(false);
    return 0;
  }

  uint32_t rSeg = g_pendingSegRead;
  uint32_t wSeg = g_pendingSegWrite;
  if (rSeg < minSeg) rSeg = minSeg;
  if (wSeg > maxSeg) wSeg = maxSeg;
  if (rSeg > wSeg) { rSeg = minSeg; wSeg = maxSeg; }

  uint64_t total = 0;
  uint32_t scannedSegs = 0;
  for (uint32_t s = rSeg; s <= wSeg; s++) {
    total += sdQueueSegSizeLocked(s);
    if (s == wSeg || ++scannedSegs >= 256) break;
  }

  uint32_t rSize = sdQueueSegSizeLocked(rSeg);
  if (rSize > 0 && g_pendingOffset < rSize) {
    total -= static_cast<uint64_t>(g_pendingOffset);
  }
  if (total > 0xFFFFFFFFULL) total = 0xFFFFFFFFULL;

  uint32_t finalBytes = static_cast<uint32_t>(total);
  g_cachedQueueBytes.store(finalBytes);
  g_queueBytesDirty.store(false);
  return finalBytes;
}

uint32_t sdQueueTotalBytes(bool forceRecalc) {
  if (!g_sdOk) return 0;
  if (!forceRecalc && !g_queueBytesDirty.load()) {
    return g_cachedQueueBytes.load();
  }
  if (!lockSem(sdMutex, 500)) {
    return g_cachedQueueBytes.load();
  }
  uint32_t val = sdQueueComputeTotalBytesLocked();
  unlockSem(sdMutex);
  return val;
}

void sdReconcilePendingState(const char* reason) {
  if (!g_sdOk) return;
  if (!lockSem(sdMutex, 3000)) return;

  LOGD("[SD][RECONCILE] Iniciando reconciliação WAL (motivo=%s)...", reason ? reason : "-");

  bool hasBak = SD.exists(PENDING_BAK_FILENAME);
  bool hasTmp = SD.exists(PENDING_TMP_FILENAME);
  bool hasLegacy = SD.exists(PENDING_FILENAME);

  if (hasBak) {
    if (!hasLegacy) {
      if (SD.rename(PENDING_BAK_FILENAME, PENDING_FILENAME)) {
        hasLegacy = true;
        g_pendingOffset = 0;
      }
    } else {
      SD.remove(PENDING_BAK_FILENAME);
    }
  }
  if (hasTmp) {
    SD.remove(PENDING_TMP_FILENAME);
  }

  sdQueueEnsureDirLocked();

  uint32_t minSeg = 0, maxSeg = 0, segCount = 0;
  bool hasSegs = sdQueueFindMinMaxLocked(minSeg, maxSeg, segCount);

  if (hasLegacy && !hasSegs) {
    char seg0[64];
    queueMakeSegPath(0, seg0, sizeof(seg0));
    SD.remove(seg0);
    if (SD.rename(PENDING_FILENAME, seg0)) {
      g_pendingSegRead = 0;
      g_pendingSegWrite = 0;
      uint32_t s0 = sdQueueSegSizeLocked(0);
      if (g_pendingOffset > s0) g_pendingOffset = 0;
      g_offDirty++;
      persistOffsetIfNeeded(true);
    }
  }

  hasSegs = sdQueueFindMinMaxLocked(minSeg, maxSeg, segCount);

  if (!hasSegs) {
    if (g_pendingSegRead != 0 || g_pendingSegWrite != 0 || g_pendingOffset != 0) {
      g_pendingSegRead = 0;
      g_pendingSegWrite = 0;
      g_pendingOffset = 0;
      g_offDirty++;
      persistOffsetIfNeeded(true);
    }
    g_cachedQueueBytes.store(0);
    g_queueBytesDirty.store(false);
    unlockSem(sdMutex);
    return;
  }

  if (g_pendingSegRead < minSeg) {
    g_pendingSegRead = minSeg;
    g_pendingOffset = 0;
    g_offDirty++;
  }

  // Preserva g_pendingSegWrite == maxSeg + 1 quando o segmento anterior acabou de rotacionar
  // ao atingir 256 KiB e o novo arquivo ainda não recebeu sua primeira gravação.
  bool isFreshRotatedWriteSeg =
    (g_pendingSegWrite == (maxSeg + 1)) &&
    (sdQueueSegSizeLocked(maxSeg) >= QUEUE_SEGMENT_MAX_BYTES);

  if (g_pendingSegWrite < minSeg || (g_pendingSegWrite > maxSeg && !isFreshRotatedWriteSeg)) {
    g_pendingSegWrite = maxSeg;
    g_offDirty++;
  }
  if (g_pendingSegRead > g_pendingSegWrite) {
    g_pendingSegRead = minSeg;
    g_pendingSegWrite = isFreshRotatedWriteSeg ? (maxSeg + 1) : maxSeg;
    g_pendingOffset = 0;
    g_offDirty++;
  }

  uint32_t rSize = sdQueueSegSizeLocked(g_pendingSegRead);
  if (rSize == 0) {
    if (g_pendingSegRead < maxSeg) {
      g_pendingSegRead++;
      g_pendingOffset = 0;
      g_offDirty++;
    } else {
      g_pendingSegRead = maxSeg;
      if (!isFreshRotatedWriteSeg) g_pendingSegWrite = maxSeg;
      g_pendingOffset = 0;
      g_offDirty++;
    }
  } else if (g_pendingOffset > rSize) {
    g_pendingOffset = 0;
    g_offDirty++;
  } else if (g_pendingOffset == rSize && rSize > 0) {
    char path[64];
    queueMakeSegPath(g_pendingSegRead, path, sizeof(path));
    SD.remove(path);
    if (g_pendingSegRead < maxSeg) {
      g_pendingSegRead++;
      g_pendingOffset = 0;
    } else {
      g_pendingSegRead = 0;
      g_pendingSegWrite = 0;
      g_pendingOffset = 0;
    }
    g_offDirty++;
  }

  if (g_offDirty > 0) persistOffsetIfNeeded(true);
  uint32_t totalB = sdQueueComputeTotalBytesLocked();
  LOGD("[SD][RECONCILE] Concluído: segR=%lu segW=%lu off=%lu totalBytes=%lu",
       static_cast<unsigned long>(g_pendingSegRead),
       static_cast<unsigned long>(g_pendingSegWrite),
       static_cast<unsigned long>(g_pendingOffset),
       static_cast<unsigned long>(totalB));
  unlockSem(sdMutex);
}

bool sdBeginWithFreq(uint32_t freqHz) {
  SPI.begin(18, 19, 23, SD_CS_PIN);
  bool ok = SD.begin(SD_CS_PIN, SPI, freqHz);
  if (ok && SD.cardType() != CARD_NONE) {
    LOGI("[SD] OK (SPI=%lu Hz) type=%d", static_cast<unsigned long>(freqHz), static_cast<int>(SD.cardType()));
    return true;
  }
  LOGW("[SD] FAIL (SPI=%lu Hz)", static_cast<unsigned long>(freqHz));
  return false;
}

bool sdInit() {
  if (lockSem(sdMutex, 2000)) {
    SD.end();
    bool ok = sdBeginWithFreq(SD_SPI_FREQ_PRIMARY);
    if (!ok) ok = sdBeginWithFreq(SD_SPI_FREQ_FALLBACK);
    g_sdOk = ok;
    g_queueBytesDirty.store(true);
    unlockSem(sdMutex);

    if (ok) {
      String dailyCsv = getDailyCsvFilename();
      if (lockSem(sdMutex, 2000)) {
        if (!SD.exists(dailyCsv.c_str())) {
          File f = SD.open(dailyCsv.c_str(), FILE_WRITE);
          if (f) {
            f.println("Timestamp,Temp,Umid,Solo,Luz,ChuvaRaw,ChuvaPct,ChuvaDet,UV,Status_Envio,telemetry_id,seq");
            f.close();
          }
        }
        unlockSem(sdMutex);
      }
    }
  } else {
    LOGW("[SD] Mutex ocupado na init.");
    g_sdOk = false;
  }
  return g_sdOk;
}

void sdMarkErrorAndTriggerReinit(const char* context) {
  g_sdWriteErrors++;
  LOGE("[SD][ERR] Falha em '%s' (total_err=%lu). Marcando SD para auto-reinit.",
       context, static_cast<unsigned long>(g_sdWriteErrors.load()));
  g_sdOk = false;
}

void sdTryReinit() {
  uint32_t now = msNow();
  if (g_sdOk) return;
  if (!timeReached(now, g_sdLastReinitMs + SD_REINIT_COOLDOWN_MS)) return;

  LOGW("[SD] Tentando auto-recuperação (reinit)...");
  g_sdLastReinitMs = now;
  if (sdInit()) {
    sdReconcilePendingState("reinit");
  }
}

bool isValidJsonEnvelope(const char* line, uint32_t len) {
  if (!line || len < 10) return false;
  while (len > 0 && (line[len - 1] == ' ' || line[len - 1] == '\r' || line[len - 1] == '\n')) {
    len--;
  }
  if (len < 10) return false;
  return (line[0] == '{' && line[len - 1] == '}');
}

bool sdAppendPendingLine(const char* line, uint32_t len) {
  if (!g_sdOk) return false;
  if (len == 0 || len > PENDING_LINE_MAX) return false;

  if ((g_appendCounter++ % RECONCILE_EVERY_APPENDS) == 0 || g_queueBytesDirty.load()) {
    sdReconcilePendingState("append_periodic");
  }

  if (!lockSem(sdMutex, 2500)) {
    LOGW("[SD][QUEUE] mutex ocupado (append).");
    return false;
  }

  if (!sdQueueEnsureDirLocked()) {
    unlockSem(sdMutex);
    sdMarkErrorAndTriggerReinit("mkdir_queue");
    return false;
  }

  if (g_pendingSegWrite < g_pendingSegRead) g_pendingSegWrite = g_pendingSegRead;

  uint32_t currentQueueBytes = g_queueBytesDirty.load()
    ? sdQueueComputeTotalBytesLocked()
    : g_cachedQueueBytes.load();

  if (currentQueueBytes + len + 1 > QUEUE_MAX_BYTES) {
    g_telemetryDropped++;
    LOGE("[SD][QUEUE] Fila excedeu limite (%lu bytes, dropped=%lu).",
         static_cast<unsigned long>(QUEUE_MAX_BYTES),
         static_cast<unsigned long>(g_telemetryDropped.load()));
    unlockSem(sdMutex);
    return false;
  }

  char path[64];
  queueMakeSegPath(g_pendingSegWrite, path, sizeof(path));

  uint32_t sizeBefore = 0;
  if (SD.exists(path)) {
    File s = SD.open(path, FILE_READ);
    if (s) { sizeBefore = static_cast<uint32_t>(s.size()); s.close(); }
  }

  File f = SD.open(path, FILE_APPEND);
  if (!f) {
    unlockSem(sdMutex);
    sdMarkErrorAndTriggerReinit("open_append_seg");
    return false;
  }

  size_t w = f.write(reinterpret_cast<const uint8_t*>(line), len);
  size_t w2 = f.write('\n');
  f.flush();
  f.close();

  bool okWrite = (w == len) && (w2 == 1);

  if (okWrite) {
    uint32_t addedBytes = static_cast<uint32_t>(len + 1);
    uint32_t newTotal = g_cachedQueueBytes.fetch_add(addedBytes) + addedBytes;

    uint32_t sizeAfter = sizeBefore + addedBytes;
    LOGD("[SD][WAL] Append OK em %s (+%lu B | segSize=%lu B | filaTotal=%lu B)",
         path, static_cast<unsigned long>(addedBytes),
         static_cast<unsigned long>(sizeAfter),
         static_cast<unsigned long>(newTotal));

    if (sizeAfter >= QUEUE_SEGMENT_MAX_BYTES) {
      g_pendingSegWrite++;
      g_offDirty++;
      persistOffsetIfNeeded(true);
      LOGI("[SD][QUEUE] Rotacionado para seg=%lu", static_cast<unsigned long>(g_pendingSegWrite));
    }
  }

  unlockSem(sdMutex);

  if (!okWrite) {
    sdMarkErrorAndTriggerReinit("partial_write_seg");
    return false;
  }

  return true;
}

bool sdQueueReadLine(uint32_t segId, uint32_t offset, char* outLine, size_t maxLen,
                     uint32_t& nextOffset, uint32_t& segSize, uint32_t& outLen, bool& truncated) {
  outLine[0] = '\0';
  nextOffset = offset;
  segSize = 0;
  outLen = 0;
  truncated = false;

  if (!g_sdOk) return false;
  if (!lockSem(sdMutex, 2000)) return false;

  char path[64];
  queueMakeSegPath(segId, path, sizeof(path));

  File f = SD.open(path, FILE_READ);
  if (!f) {
    unlockSem(sdMutex);
    return false;
  }

  segSize = static_cast<uint32_t>(f.size());
  if (offset >= segSize) {
    f.close();
    unlockSem(sdMutex);
    return false;
  }

  if (!f.seek(offset)) {
    f.close();
    unlockSem(sdMutex);
    return false;
  }

  size_t idx = 0;
  bool foundNewline = false;

  while (f.available()) {
    char c = static_cast<char>(f.read());
    if (c == '\n') { foundNewline = true; break; }
    if (c == '\r') continue;

    if (idx < maxLen - 1) {
      outLine[idx++] = c;
    } else {
      truncated = true;
    }
  }

  outLine[idx] = '\0';
  outLen = static_cast<uint32_t>(idx);

  if (truncated && !foundNewline) {
    while (f.available()) {
      if (static_cast<char>(f.read()) == '\n') break;
    }
  }

  nextOffset = static_cast<uint32_t>(f.position());
  f.close();
  unlockSem(sdMutex);

  return (nextOffset > offset);
}

bool pendingFlushTick(bool force) {
  RuntimeConfig c = cfgGet();
  static uint32_t lastFlushMs = 0;
  uint32_t now = msNow();

  if (!g_sdOk) return false;
  if (!g_mqttConnected || !client.connected()) return false;

  if (!force && !timeReached(now, lastFlushMs + c.pending_flush_every_ms)) return false;
  lastFlushMs = now;

  uint32_t totalBytes = sdQueueTotalBytes(false);
  if (totalBytes == 0 && !force) return true;

  if (force || g_queueBytesDirty.load()) {
    sdReconcilePendingState(force ? "force_flush" : "pre_flush");
    totalBytes = sdQueueTotalBytes(false);
    if (totalBytes == 0) return true;
  }

  uint32_t start = msNow();
  uint32_t sent = 0;
  uint32_t failures = 0;
  uint32_t skipped = 0;

  uint32_t workSeg = 0;
  uint32_t workOff = 0;
  uint32_t maxWriteSeg = 0;

  if (lockSem(sdMutex, 500)) {
    workSeg = g_pendingSegRead;
    workOff = g_pendingOffset;
    maxWriteSeg = g_pendingSegWrite;
    unlockSem(sdMutex);
  } else {
    return false;
  }

  uint32_t segsToDelete[32];
  uint32_t delCount = 0;

  while (sent < c.pending_flush_max_items && (msNow() - start) < c.pending_flush_max_ms) {
#ifdef ESP32
    esp_task_wdt_reset();
#endif

    if (client.connected()) {
      client.loop();
      flushAckQueueTick();
    }

    if (workSeg > maxWriteSeg) break;

    uint32_t nextOff = workOff;
    uint32_t segSize = 0;
    uint32_t outLen = 0;
    bool truncated = false;

    bool okRead = sdQueueReadLine(workSeg, workOff, g_netSharedJsonBuf, sizeof(g_netSharedJsonBuf),
                                  nextOff, segSize, outLen, truncated);

    if (!okRead) {
      if (workSeg < maxWriteSeg) {
        workSeg++;
        workOff = 0;
        continue;
      }
      break;
    }

    if (truncated || outLen == 0 || !isValidJsonEnvelope(g_netSharedJsonBuf, outLen)) {
      if (outLen > 0) {
        g_sdCorruptLines++;
        LOGW("[SD][FLUSH] Linha corrompida descartada (seg=%lu off=%lu len=%lu)",
             static_cast<unsigned long>(workSeg), static_cast<unsigned long>(workOff), static_cast<unsigned long>(outLen));
      }
      skipped++;
      workOff = nextOff;

      if (segSize > 0 && workOff >= segSize) {
        if (delCount < 32) segsToDelete[delCount++] = workSeg;
        workSeg++;
        workOff = 0;
      }
      continue;
    }

    bool okPub = mqttPublish(g_topicTelemetry, reinterpret_cast<const uint8_t*>(g_netSharedJsonBuf), outLen, false);
    if (!okPub) {
      failures++;
      LOGW("[SD][FLUSH] publish falhou. Abortando rodada sem commitar offsets.");
      break;
    }

    sent++;
    workOff = nextOff;

    if (segSize > 0 && workOff >= segSize) {
      if (delCount < 32) segsToDelete[delCount++] = workSeg;
      workSeg++;
      workOff = 0;
    }

    vTaskDelay(1);
  }

  bool progressed = (sent > 0) || (skipped > 0);
  bool stable = client.connected() && g_mqttConnected && (WiFi.status() == WL_CONNECTED);

  if (progressed && failures == 0 && stable) {
    if (lockSem(sdMutex, 3000)) {
      for (uint32_t i = 0; i < delCount; i++) {
        char pth[64];
        queueMakeSegPath(segsToDelete[i], pth, sizeof(pth));
        SD.remove(pth);
      }

      g_pendingSegRead = workSeg;
      g_pendingOffset = workOff;
      if (g_pendingSegWrite < g_pendingSegRead) {
        g_pendingSegWrite = g_pendingSegRead;
      }

      g_offDirty++;
      persistOffsetIfNeeded(delCount > 0);
      sdQueueComputeTotalBytesLocked();
      unlockSem(sdMutex);
    }
    sdReconcilePendingState("post_flush");
  }

  uint32_t totalAfter = sdQueueTotalBytes(false);
  LOGI("[SD][FLUSH] fim: sent=%lu skipped=%lu fail=%lu pendingBytes=%lu took=%lums",
       static_cast<unsigned long>(sent), static_cast<unsigned long>(skipped), static_cast<unsigned long>(failures),
       static_cast<unsigned long>(totalAfter), static_cast<unsigned long>(msNow() - start));

  return (sent > 0 && failures == 0 && totalAfter == 0);
}

void gracefulDrainBeforeOtaReboot(const char* contextLabel) {
  uint32_t t0 = msNow();
  uint32_t drainedCount = 0;
  TelemetryData item{};

  if (sensorQueue != nullptr) {
    while (xQueueReceive(sensorQueue, &item, 0) == pdPASS) {
#ifdef ESP32
      esp_task_wdt_reset();
#endif
      uint32_t payloadLen = 0;
      bool jsonOk = buildTelemetryJson(item, g_netSharedJsonBuf, sizeof(g_netSharedJsonBuf), payloadLen);
      bool queuedOk = false;

      if (g_sdOk && jsonOk) {
        queuedOk = sdAppendPendingLine(g_netSharedJsonBuf, payloadLen);
      }

      if (!queuedOk) {
        g_telemetryDropped++;
        LOGW("[DRAIN] Falha ao gravar seq=%lu no SD antes do reboot (dropped=%lu).",
             static_cast<unsigned long>(item.seq),
             static_cast<unsigned long>(g_telemetryDropped.load()));
      } else {
        drainedCount++;
        LOGI("[DRAIN] Amostra seq=%lu (ts=%lu) drenada da RAM para a fila WAL do SD.",
             static_cast<unsigned long>(item.seq),
             static_cast<unsigned long>(item.timestamp));
      }

      if (g_sdOk && lockSem(sdMutex, 1000)) {
        String dailyCsv = getDailyCsvFilename();
        File f = SD.open(dailyCsv.c_str(), FILE_APPEND);
        if (f) {
          char tid[80];
          makeTelemetryId(tid, sizeof(tid), item.timestamp, item.seq);
          f.printf("%lu,%.2f,%.2f,%d,%d,%d,%d,%d,%.2f,%s,%s,%lu\n",
                   static_cast<unsigned long>(item.timestamp),
                   item.air_temp, item.air_hum,
                   item.soil_moisture, item.light_level,
                   item.rain_raw, item.rain_pct, item.rain_detected ? 1 : 0,
                   item.uv_index,
                   queuedOk ? "QUEUED" : "DROP",
                   tid,
                   static_cast<unsigned long>(item.seq));
          f.close();
        }
        unlockSem(sdMutex);
      }
    }
  }

  persistSeqIfNeeded(true);
  persistOffsetIfNeeded(true);

  uint32_t tsSnap = 0;
  if (lockSem(tsMutex, 50)) {
    tsSnap = g_lastTelemetryTs;
    g_tsDirty = 0;
    unlockSem(tsMutex);
  }
  if (tsSnap > 0) {
    persistLastTsIfNeeded(true, tsSnap);
  }

  LOGI("[DRAIN] Concluído (%s) em %lu ms: %lu amostra(s) salva(s) no SD | NVS sincronizado (seq=%lu, last_ts=%lu).",
       contextLabel ? contextLabel : "reboot",
       static_cast<unsigned long>(msNow() - t0),
       static_cast<unsigned long>(drainedCount),
       static_cast<unsigned long>(g_telemetrySeq.load()),
       static_cast<unsigned long>(tsSnap));
}