"""
=====================================================================================
ARQUIVO: backend/LambdasFuncs/AgroSmart_Scheduler_Logic/AgroSmart_Scheduler_Logic.py
PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5)
RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1B — Limites das Agendas Demo)
DATA DE CRIACAO: 2026-02-18 07:00
ULTIMA ATUALIZACAO: 2026-11-22T04:15:00Z (UTC)
VERSAO: v5.27.0 — Comando manual sem confirmação vira "Sem confirmação" (Fase 4.0-E E4)
=====================================================================================
CHANGELOG v5.27.0 (2026-11-24, Fase 4.0-E E4 / backlog FS-01):
- Varredura a cada `UNACKED_SWEEP_EVERY_MIN` (5) minutos: comando MANUAL on/off que
  continua `pending` depois de `UNACKED_COMMAND_GRACE_SEC` (150 s = validade de 120 s
  + folga; depois disso a placa recusaria o comando de qualquer jeito) ganha
  `confirmation="timeout"` e um registro no histórico `cmd-<id>` com
  `status="unconfirmed"` e `reason="no_ack_timeout"`.
- NÃO altera `status`/`last_status` do comando nem o `state` da estação: se o ACK
  chegar atrasado, a AckToFirestore atualiza o comando e o histórico normalmente.
- Agendas continuam no fluxo próprio (`schedule_confirmation_due_epoch`). OTA/config
  ficam de fora. Consulta por estação (índice automático), sem índice novo; custo
  ~10 leituras a cada 5 min. Falhas viram WARN (não sujam a métrica de erro).
CHANGELOG v5.26.0 (2026-11-22):
- Fase 1B (Limites Unificados da Sessão Demo em Agendamentos):
  * Adiciona helper resiliente `_env_int` (não quebra cold start com env inválido) e
    as constantes alinhadas ao SendCommand: `DEMO_MAX_ON_DURATION_SEC=300`,
    `DEMO_ON_COOLDOWN_SEC=60` e `DEMO_MAX_ON_SECONDS_PER_SESSION=1800`.
  * Adiciona função pura `_evaluate_demo_schedule_limits(demo_auth, duration_s, now_epoch)`
    com a mesma semântica de espera (`demo_cooldown`) e cota (`demo_quota_exhausted`)
    do acionamento manual em `SendCommand`.
  * Aplica teto de duração (`min(effective_duration_s, DEMO_MAX_ON_DURATION_SEC)`)
    para agendas com `created_by_demo is True` dentro de `_tx_schedule`, cortando
    também agendas Demo antigas de até 15 min sem rejeitá-las.
  * Cobra `demo_on_seconds_used` e atualiza `demo_last_on_epoch` em `private/demo_auth`
    na mesma transação ACID quando a agenda Demo é aceita (`not is_retry`), e registra
    skip final em `history` retornando `("demo_limit", <motivo>, ...)` sem alterar
    `state` nem a agenda quando recusada. Retries de `publish_failed` não cobram de novo.
  * Evita ler ou alterar `private/demo_auth` para agendas do Operador Titular.
  * Trata `tx_status == "demo_limit"` no `lambda_handler` como `skipped += 1` com log
    estruturado `demo_schedule_limit_rejected` (usando apenas `sha256(demo_sid)[:8]`).

PROPÓSITO ARQUITETURAL:
Motor de agendamento inteligente acionado a cada minuto pelo Amazon EventBridge
(`rate(1 minute)`). Avalia todos os agendamentos ativos para o dia da semana e
minuto atuais, cruzando dados dos sensores de borda no DynamoDB com a previsão
meteorológica hiperlocal (Open-Meteo API).
=====================================================================================
"""

import base64
import contextvars
import datetime
import hashlib
import hmac
import json
import math
import os
import random
import time
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

import boto3

# --- INICIO HELPER SSM PARAMETER STORE GRATUITO (FINOPS ZERO-COST) ---
_agro_ssm_client = None


def _agro_fetch_secret_or_ssm(secret_id: str, region_name: str = "us-east-2", boto_cfg=None) -> dict:
    global _agro_ssm_client
    clean_id = (secret_id or "").strip()
    if clean_id.startswith("/"):
        if _agro_ssm_client is None:
            _agro_ssm_client = boto3.client("ssm", region_name=region_name, config=boto_cfg)
        param = _agro_ssm_client.get_parameter(Name=clean_id, WithDecryption=True)
        return {"SecretString": param["Parameter"]["Value"]}
    sm_cli = boto3.client("secretsmanager", region_name=region_name, config=boto_cfg)
    return sm_cli.get_secret_value(SecretId=clean_id)
# --- FIM HELPER SSM PARAMETER STORE ---


import pytz
from boto3.dynamodb.conditions import Key
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError
from google.cloud import firestore
from google.oauth2 import service_account


def _env_int(
    name: str,
    default: int,
    min_val: Optional[int] = None,
    max_val: Optional[int] = None,
) -> int:
    """Lê variável de ambiente inteira com fallback seguro para não quebrar o cold start."""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        parsed = int(raw.strip())
    except (TypeError, ValueError):
        return default
    if min_val is not None and parsed < min_val:
        return default
    if max_val is not None and parsed > max_val:
        return default
    return parsed


# =====================================================================================
# CONFIGURAÇÕES GERAIS E CONSTANTES DE SEGURANÇA
# =====================================================================================
AWS_REGION = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "us-east-2"
TZ_NAME = os.getenv("TZ_NAME", "America/Sao_Paulo")
IOT_TOPIC_PREFIX = os.getenv("IOT_TOPIC_PREFIX", "agrosmart/v5").strip().strip("/")
IOT_DATA_ENDPOINT_URL = (
    os.getenv("IOT_DATA_ENDPOINT_URL", "").strip()
    or os.getenv("IOT_DATA_ENDPOINT", "").strip()
    or None
)

DYNAMO_TABLE = (
    os.getenv("DYNAMO_TABLE")
    or os.getenv("DYNAMODB_TABLE")
    or os.getenv("DYNAMODB_TABLE_NAME")
    or "AgroTelemetryData_V5"
)
DYNAMO_REGION = (
    os.getenv("DYNAMO_REGION")
    or os.getenv("DYNAMODB_REGION")
    or os.getenv("AWS_REGION")
    or AWS_REGION
)

DYNAMODB_PARTITION_KEY = os.getenv("DYNAMODB_PARTITION_KEY", "device_id")
DYNAMODB_SORT_KEY = os.getenv("DYNAMODB_SORT_KEY", "timestamp")

TELEMETRY_MAX_AGE_SEC = int(os.getenv("TELEMETRY_MAX_AGE_SEC", "180"))
MAX_FUTURE_CLOCK_SKEW_SEC = int(os.getenv("MAX_FUTURE_CLOCK_SKEW_SEC", "60"))
MAX_VALVE_DURATION_S = int(os.getenv("MAX_VALVE_DURATION_S", "900"))
MAX_SCHEDULES_PER_TICK = int(os.getenv("MAX_SCHEDULES_PER_TICK", "50"))
WEATHER_FORECAST_WINDOW_HOURS = int(os.getenv("WEATHER_FORECAST_WINDOW_HOURS", "3"))
RAIN_PROB_THRESHOLD_PCT = int(os.getenv("RAIN_PROB_THRESHOLD_PCT", "70"))
COMMAND_TTL_SECONDS = int(os.getenv("COMMAND_TTL_SECONDS", "120"))
STALE_LOCK_GRACE_SEC = int(os.getenv("STALE_LOCK_GRACE_SEC", "15"))
OTA_LOCK_TTL_SECONDS = int(os.getenv("OTA_LOCK_TTL_SECONDS", "300"))
SAFE_REMAINING_TIME_MS = int(os.getenv("SAFE_REMAINING_TIME_MS", "2500"))

# v5.27.0 (E4): comandos manuais sem confirmação
UNACKED_COMMAND_GRACE_SEC = _env_int("UNACKED_COMMAND_GRACE_SEC", 150, min_val=60, max_val=3600)
UNACKED_SWEEP_EVERY_MIN = _env_int("UNACKED_SWEEP_EVERY_MIN", 5, min_val=1, max_val=60)
UNACKED_MAX_DEVICES = _env_int("UNACKED_MAX_DEVICES", 25, min_val=1, max_val=200)
UNACKED_MAX_PER_DEVICE = _env_int("UNACKED_MAX_PER_DEVICE", 20, min_val=1, max_val=200)

# Limites unificados da sessão Demo (alinhados ao SendCommand)
DEMO_MAX_ON_DURATION_SEC = _env_int(
    "DEMO_MAX_ON_DURATION_SEC", 300, min_val=1, max_val=MAX_VALVE_DURATION_S
)
DEMO_ON_COOLDOWN_SEC = _env_int("DEMO_ON_COOLDOWN_SEC", 60, min_val=0)
DEMO_MAX_ON_SECONDS_PER_SESSION = _env_int(
    "DEMO_MAX_ON_SECONDS_PER_SESSION", 1800, min_val=1
)

GCP_SECRET_ARN = (
    os.getenv("GCP_SECRET_ARN", "").strip()
    or os.getenv("FIREBASE_SA_SECRET_ARN", "").strip()
)

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").strip().upper()
_LOG_RANK = {"DEBUG": 10, "INFO": 20, "WARN": 30, "WARNING": 30, "ERROR": 40}

# =====================================================================================
# CONTEXTVARS E LOG ESTRUTURADO JSON COM CRONÓMETRO DE EXECUÇÃO (ELAPSED_MS)
# =====================================================================================
_current_request_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "request_id", default=None
)
_request_start_ns: contextvars.ContextVar[Optional[int]] = contextvars.ContextVar(
    "request_start_ns", default=None
)
_current_device_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "device_id", default=None
)
_current_schedule_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "schedule_id", default=None
)


def _log(level: str, event_name: str, **fields: Any) -> None:
    """
    Emite log estruturado JSON no CloudWatch com `request_id`, `device_id`,
    `schedule_id` e `elapsed_ms` injetados automaticamente via `contextvars`.
    """
    lvl_upper = level.upper()
    if _LOG_RANK.get(lvl_upper, 20) < _LOG_RANK.get(LOG_LEVEL, 20):
        return

    rid = _current_request_id.get()
    if rid and "request_id" not in fields:
        fields["request_id"] = rid

    did = _current_device_id.get()
    if did and "device_id" not in fields:
        fields["device_id"] = did

    sid = _current_schedule_id.get()
    if sid and "schedule_id" not in fields:
        fields["schedule_id"] = sid

    start_ns = _request_start_ns.get()
    elapsed_ms: Optional[float] = None
    if start_ns is not None:
        elapsed_ms = round((time.perf_counter_ns() - start_ns) / 1_000_000.0, 2)

    payload = {
        "level": lvl_upper,
        "component": "SchedulerLogic",
        "fw_backend": "v5.26.0",
        "event_name": event_name,
        "elapsed_ms": elapsed_ms,
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **{k: v for k, v in fields.items() if v is not None},
    }
    print(json.dumps(payload, ensure_ascii=False, default=str))


# =====================================================================================
# CLIENTES AWS COM TIMEOUT / RETRY PADRÃO E SINGLETON FIRESTORE
# =====================================================================================
_DEFAULT_BOTO_CONFIG = BotoConfig(
    connect_timeout=5,
    read_timeout=5,
    retries={"max_attempts": 3, "mode": "standard"},
)

dynamodb = boto3.resource(
    "dynamodb", region_name=DYNAMO_REGION, config=_DEFAULT_BOTO_CONFIG
)
table = dynamodb.Table(DYNAMO_TABLE)

if IOT_DATA_ENDPOINT_URL:
    _normalized_iot_ep = (
        IOT_DATA_ENDPOINT_URL
        if IOT_DATA_ENDPOINT_URL.startswith("https://")
        else f"https://{IOT_DATA_ENDPOINT_URL}"
    )
    iot_client = boto3.client(
        "iot-data",
        region_name=AWS_REGION,
        endpoint_url=_normalized_iot_ep,
        config=_DEFAULT_BOTO_CONFIG,
    )
else:
    iot_client = boto3.client(
        "iot-data", region_name=AWS_REGION, config=_DEFAULT_BOTO_CONFIG
    )

_firestore_client: Optional[firestore.Client] = None

# Caches temporários por ciclo de invocação (limpos no início de cada lambda_handler)
_cycle_weather_cache: Dict[Tuple[float, float, str], Tuple[bool, str]] = {}
_cycle_telemetry_cache: Dict[Tuple[str, int], Tuple[Optional[Dict[str, Any]], int]] = {}


def get_firestore_client() -> firestore.Client:
    """Inicializa e reutiliza o cliente Google Cloud Firestore via AWS SSM Parameter Store."""
    global _firestore_client
    if _firestore_client is not None:
        return _firestore_client

    if not GCP_SECRET_ARN:
        sa_raw = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
        if sa_raw:
            sa_info = json.loads(sa_raw)
            project_id = sa_info.get("project_id")
            creds = service_account.Credentials.from_service_account_info(sa_info)
            _firestore_client = firestore.Client(project=project_id, credentials=creds)
            _log("INFO", "firestore_connect_ok_from_env", project_id=project_id)
            return _firestore_client

        raise RuntimeError(
            "GCP_SECRET_ARN/FIREBASE_SA_SECRET_ARN não configurado no ambiente da Lambda."
        )

    t0 = time.perf_counter()
    resp = _agro_fetch_secret_or_ssm(GCP_SECRET_ARN, AWS_REGION, _DEFAULT_BOTO_CONFIG)

    if "SecretString" in resp and resp["SecretString"]:
        sa_info = json.loads(resp["SecretString"])
    else:
        sa_info = json.loads(
            base64.b64decode(resp["SecretBinary"]).decode("utf-8", errors="replace")
        )

    project_id = sa_info.get("project_id")
    creds = service_account.Credentials.from_service_account_info(sa_info)
    _firestore_client = firestore.Client(project=project_id, credentials=creds)

    _log(
        "INFO",
        "firestore_connect_ok",
        project_id=project_id,
        init_latency_ms=round((time.perf_counter() - t0) * 1000.0, 2),
    )
    return _firestore_client


def _has_enough_lambda_time(context: Any) -> bool:
    """Verifica se restam pelo menos `SAFE_REMAINING_TIME_MS` antes do timeout da Lambda."""
    if context is None or not hasattr(context, "get_remaining_time_in_millis"):
        return True
    try:
        return int(context.get_remaining_time_in_millis()) > SAFE_REMAINING_TIME_MS
    except Exception:
        return True


def build_device_command_topic(device_id: str) -> str:
    """Retorna o tópico MQTT de comando exclusivo do dispositivo."""
    return f"{IOT_TOPIC_PREFIX}/{device_id}/command"


def build_command_id(
    schedule_id: str,
    now_local: datetime.datetime,
    scheduled_time_hhmm: Optional[str] = None,
) -> str:
    """
    Gera um `command_id` determinístico por agendamento e horário planeado (`sched-<sha1_16>`),
    garantindo idempotência tanto em disparos duplos no mesmo minuto quanto na janela de
    tolerância de 1 minuto.
    """
    date_part = now_local.strftime("%Y%m%d")
    if scheduled_time_hhmm and ":" in scheduled_time_hhmm:
        hhmm_clean = scheduled_time_hhmm.replace(":", "").strip()[:4]
    else:
        hhmm_clean = now_local.strftime("%H%M")
    minute_key = f"{date_part}{hhmm_clean}"
    raw = f"{schedule_id}:{minute_key}".encode("utf-8")
    h = hashlib.sha1(raw).hexdigest()[:16]
    return f"sched-{h}"


def _safe_nonneg_int(raw_val: Any, default: int = 0) -> int:
    """Converte um valor em inteiro >= 0; valores ausentes, negativos ou de tipo inválido valem `default`."""
    if raw_val is None or isinstance(raw_val, bool):
        return default
    try:
        val = int(raw_val)
        return val if val >= 0 else default
    except (TypeError, ValueError):
        return default


def _hash_demo_sid_for_log(demo_sid: Optional[str]) -> Optional[str]:
    """Retorna hash SHA-256 truncado (8 chars) do `demo_sid` para correlação segura em logs."""
    if not isinstance(demo_sid, str):
        return None
    clean = demo_sid.strip()
    if not clean:
        return None
    return hashlib.sha256(clean.encode("utf-8")).hexdigest()[:8]


def _evaluate_demo_schedule_limits(
    demo_auth: Dict[str, Any],
    duration_s: int,
    now_epoch: int,
) -> Tuple[bool, Optional[str], Optional[int]]:
    """
    Avalia espera (`demo_cooldown`) e cota acumulada (`demo_quota_exhausted`) de uma
    agenda Demo contra os mesmos contadores do acionamento manual em `private/demo_auth`.
    Valores ausentes, negativos ou de tipo inválido são tratados como 0.
    """
    safe_auth = demo_auth if isinstance(demo_auth, dict) else {}
    safe_duration = _safe_nonneg_int(duration_s, 0)

    last_on_epoch = _safe_nonneg_int(safe_auth.get("demo_last_on_epoch"), 0)
    if last_on_epoch > 0 and DEMO_ON_COOLDOWN_SEC > 0:
        unlock_epoch = last_on_epoch + DEMO_ON_COOLDOWN_SEC
        if now_epoch < unlock_epoch:
            retry_after = max(1, unlock_epoch - now_epoch)
            return (False, "demo_cooldown", retry_after)

    used_seconds = _safe_nonneg_int(safe_auth.get("demo_on_seconds_used"), 0)
    if (used_seconds + safe_duration) > DEMO_MAX_ON_SECONDS_PER_SESSION:
        return (False, "demo_quota_exhausted", None)

    return (True, None, None)


def _parse_schedule_duration_s(schedule_dict: Dict[str, Any]) -> int:
    """Converte `duration_minutes` da agenda em segundos inteiros limitados a `[1, MAX_VALVE_DURATION_S]`."""
    raw_dur_min = schedule_dict.get("duration_minutes", 5)
    try:
        val_min = float(raw_dur_min if raw_dur_min is not None else 5)
        if not math.isfinite(val_min):
            val_min = 5.0
    except Exception:
        val_min = 5.0
    raw_duration_s = int(val_min) * 60
    return max(1, min(raw_duration_s, MAX_VALVE_DURATION_S))


def _is_demo_schedule_expired_or_revoked(
    schedule_dict: Dict[str, Any],
    demo_auth_dict: Optional[Dict[str, Any]],
    now_epoch: int,
) -> Tuple[bool, str]:
    """
    Valida estritamente agendas criadas em sessão de Usuário Teste (`created_by_demo == True`):
      1. Exige `demo_session_id` gravado na agenda (agendas demo legadas sem vínculo são
         colocadas em quarentena e pausadas);
      2. Consulta `devices/{device_id}/private/demo_auth` (exclusivo do backend);
      3. Exige passe reivindicado (`pass_claimed == True`), expiração estritamente no futuro
         (`now_epoch < expires_epoch`, alinhado com `firestore.rules`) e correspondência exata
         entre `schedule.demo_session_id` e `demo_auth.session_id` (impede vazamento entre
         sessão A e sessão B).
    Agendamentos do Operador Titular (`created_by_demo != True`) nunca expiram por passe demo.
    """
    if not isinstance(schedule_dict, dict) or schedule_dict.get("created_by_demo") is not True:
        return (False, "")

    sched_sid = str(schedule_dict.get("demo_session_id") or "").strip()
    if not sched_sid:
        return (True, "agendamento demo legado sem vínculo de sessão (quarentena automática)")

    if not isinstance(demo_auth_dict, dict) or not demo_auth_dict:
        return (True, "nenhuma sessão ativa de Usuário Teste registrada na estação")

    is_claimed = bool(demo_auth_dict.get("pass_claimed") is True)
    active_sid = str(demo_auth_dict.get("session_id") or "").strip()
    try:
        demo_exp = int(demo_auth_dict.get("expires_epoch") or 0)
    except Exception:
        demo_exp = 0

    if not is_claimed or not active_sid or demo_exp <= 0:
        return (True, "passe temporário de Usuário Teste encerrado ou revogado pelo administrador")

    # Corte inclusivo alinhado com `demo_auth.expires_epoch > now` do firestore.rules
    if now_epoch >= demo_exp:
        return (True, "tempo do passe temporário de Usuário Teste expirado")

    if not hmac.compare_digest(active_sid, sched_sid):
        return (True, "agendamento pertence a uma sessão de Usuário Teste anterior já substituída")

    return (False, "")


def compute_effective_telemetry_max_age_sec(
    settings: Dict[str, Any],
    sys_block: Optional[Dict[str, Any]] = None,
) -> int:
    """
    Calcula dinamicamente a idade máxima permitida (em segundos) para considerar a última
    telemetria válida, adaptando-se automaticamente ao intervalo configurado na placa
    (ex.: 30s na bancada vs 10 min ou 30 min no campo):
      `effective_max_age = max(TELEMETRY_MAX_AGE_SEC, (intervalo_s * 2) + 120)`
    """
    interval_ms = 0
    if isinstance(sys_block, dict) and sys_block.get("tele_int_ms") is not None:
        try:
            interval_ms = int(float(sys_block["tele_int_ms"]))
        except Exception:
            interval_ms = 0

    if interval_ms <= 0 and isinstance(settings, dict):
        raw_cfg = settings.get("telemetry_interval_ms")
        if raw_cfg is not None:
            try:
                interval_ms = int(float(raw_cfg))
            except Exception:
                interval_ms = 0

    if interval_ms < 10000 or interval_ms > 3600000:
        return TELEMETRY_MAX_AGE_SEC

    interval_sec = interval_ms // 1000
    dynamic_limit = (interval_sec * 2) + 120
    return max(TELEMETRY_MAX_AGE_SEC, dynamic_limit)


def _parse_strict_sensor_bool(raw_value: Any) -> Optional[bool]:
    """
    Converte indicadores físicos obrigatórios (`rain_detected`, `soil_fault`) de forma
    estrita (fail-closed): retorna `None` se ausente ou de tipo inválido, nunca presumindo `False`.
    """
    if isinstance(raw_value, bool):
        return raw_value
    if isinstance(raw_value, int) and raw_value in (0, 1):
        return bool(raw_value)
    return None


# =====================================================================================
# LEITURA ANTI-STALE DE TELEMETRIA E PREVISÃO CLIMÁTICA (COM CACHE DE CICLO)
# =====================================================================================
def get_latest_telemetry_snapshot(
    device_id: str,
    settings: Optional[Dict[str, Any]] = None,
) -> Tuple[Optional[Dict[str, Any]], int]:
    """
    Consulta a leitura mais recente (`Limit=1`) do dispositivo no DynamoDB e valida:
      - Pacote recente (`-60 <= age <= effective_max_age_sec`);
      - `soil_moisture` finito entre 0 e 100%;
      - `rain_detected` e `soil_fault` presentes e válidos (fail-closed — F3.5).
    """
    cfg_interval_ms = int((settings or {}).get("telemetry_interval_ms") or 30000)
    cache_key = (device_id, cfg_interval_ms)
    if cache_key in _cycle_telemetry_cache:
        return _cycle_telemetry_cache[cache_key]

    fallback_max_age = compute_effective_telemetry_max_age_sec(settings or {}, None)

    try:
        t0 = time.perf_counter()
        resp = table.query(
            KeyConditionExpression=Key(DYNAMODB_PARTITION_KEY).eq(device_id),
            ScanIndexForward=False,
            Limit=1,
        )
        dynamo_ms = round((time.perf_counter() - t0) * 1000.0, 2)

        items = resp.get("Items", []) or []
        if not items:
            _log("WARN", "telemetry_empty", table=DYNAMO_TABLE, dynamo_ms=dynamo_ms)
            _cycle_telemetry_cache[cache_key] = (None, fallback_max_age)
            return None, fallback_max_age

        item = items[0]
        ts_raw = item.get(DYNAMODB_SORT_KEY)
        ts_int: Optional[int] = int(ts_raw) if ts_raw is not None and not isinstance(ts_raw, bool) else None

        sensors = item.get("sensors") or {}
        sys_block = item.get("sys") or {}
        effective_max_age = compute_effective_telemetry_max_age_sec(
            settings or {}, sys_block
        )

        moisture_raw = sensors.get("soil_moisture")
        if moisture_raw is None or isinstance(moisture_raw, bool):
            _log("WARN", "soil_moisture_missing_field", sensors_keys=list(sensors.keys()))
            _cycle_telemetry_cache[cache_key] = (None, effective_max_age)
            return None, effective_max_age

        try:
            val = float(moisture_raw)
        except Exception:
            _log("WARN", "soil_moisture_invalid_type", raw_value=str(moisture_raw)[:40])
            _cycle_telemetry_cache[cache_key] = (None, effective_max_age)
            return None, effective_max_age

        if not math.isfinite(val) or val < 0.0 or val > 100.0:
            _log("WARN", "soil_moisture_out_of_range_or_nan", soil_moisture=str(moisture_raw)[:40])
            _cycle_telemetry_cache[cache_key] = (None, effective_max_age)
            return None, effective_max_age

        # Validação fail-closed de chuva e saúde elétrica do sensor de solo (F3.5)
        rain_detected = _parse_strict_sensor_bool(sensors.get("rain_detected"))
        if rain_detected is None:
            _log("WARN", "rain_detected_missing_or_invalid", sensors_keys=list(sensors.keys()))
            _cycle_telemetry_cache[cache_key] = (None, effective_max_age)
            return None, effective_max_age

        soil_fault_sensors = _parse_strict_sensor_bool(sensors.get("soil_fault"))
        soil_fault_sys = _parse_strict_sensor_bool(sys_block.get("soil_fault"))
        if soil_fault_sensors is None and soil_fault_sys is None:
            _log("WARN", "soil_fault_missing_or_invalid", sensors_keys=list(sensors.keys()))
            _cycle_telemetry_cache[cache_key] = (None, effective_max_age)
            return None, effective_max_age

        soil_fault = bool(soil_fault_sensors is True or soil_fault_sys is True)

        now = int(time.time())
        age = (now - ts_int) if ts_int is not None else None

        _log(
            "DEBUG",
            "telemetry_item_inspected",
            dynamo_latency_ms=dynamo_ms,
            telemetry_ts=ts_int,
            server_now_ts=now,
            telemetry_age_sec=age,
            effective_max_age_sec=effective_max_age,
            tele_int_ms=sys_block.get("tele_int_ms") or cfg_interval_ms,
            soil_moisture=val,
            soil_raw=sensors.get("soil_raw"),
            soil_fault=soil_fault,
            rain_detected=rain_detected,
            device_fw=sys_block.get("fw"),
            device_part=sys_block.get("part"),
        )

        # Proteção contra relógio no futuro (age < -60s) ou telemetria expirada
        if (
            age is None
            or age < -MAX_FUTURE_CLOCK_SKEW_SEC
            or age > effective_max_age
        ):
            _log(
                "WARN",
                "telemetry_stale_or_future_skew",
                soil_moisture=val,
                telemetry_ts=ts_int,
                telemetry_age_sec=age,
                effective_max_age_sec=effective_max_age,
            )
            _cycle_telemetry_cache[cache_key] = (None, effective_max_age)
            return None, effective_max_age

        result_snap = {
            "soil_moisture": val,
            "rain_detected": rain_detected,
            "soil_fault": soil_fault,
            "age_sec": age,
            "effective_max_age_sec": effective_max_age,
        }
        _cycle_telemetry_cache[cache_key] = (result_snap, effective_max_age)
        return result_snap, effective_max_age

    except Exception as e:
        _log("WARN", "telemetry_read_failed", error=f"{type(e).__name__}: {e}")
        return None, fallback_max_age


def check_rain_forecast(
    lat: float, lon: float, now_local: datetime.datetime
) -> Tuple[bool, str]:
    """
    Consulta a API Open-Meteo (com 1 retry rápido em caso de falha transitória) e avalia
    a probabilidade de precipitação nas próximas `WEATHER_FORECAST_WINDOW_HOURS` (3h).
    """
    if not (
        math.isfinite(lat)
        and math.isfinite(lon)
        and -90.0 <= lat <= 90.0
        and -180.0 <= lon <= 180.0
    ):
        return (False, "Coordenadas GPS fora do intervalo válido (prosseguindo)")

    hour_key = now_local.strftime("%Y%m%d%H")
    cache_key = (round(float(lat), 4), round(float(lon), 4), hour_key)

    if cache_key in _cycle_weather_cache:
        return _cycle_weather_cache[cache_key]

    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat:.4f}&longitude={lon:.4f}"
        "&hourly=precipitation_probability"
        "&forecast_days=2"
        "&timezone=America%2FSao_Paulo"
    )

    data: Optional[Dict[str, Any]] = None
    for attempt in range(1, 3):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "AgroSmart-Precision-IoT/5.26.0"}
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                data = json.loads(response.read().decode("utf-8", errors="replace"))
            break
        except Exception as e:
            if attempt == 1:
                time.sleep(0.4)
            else:
                _log("WARN", "weather_api_failed", error=str(e))
                return (False, "Falha ao consultar clima (prosseguindo por segurança)")

    if not isinstance(data, dict):
        return (False, "Sem dados meteorológicos (prosseguindo)")

    hourly = data.get("hourly") or {}
    hourly_times = hourly.get("time") or []
    hourly_probs = hourly.get("precipitation_probability") or []

    if not hourly_probs:
        res = (False, "Sem dados de precipitação (prosseguindo)")
        _cycle_weather_cache[cache_key] = res
        return res

    now_naive = now_local.replace(tzinfo=None)
    window_start = now_naive.replace(minute=0, second=0, microsecond=0)
    window_end = now_naive + datetime.timedelta(hours=WEATHER_FORECAST_WINDOW_HOURS)

    probs_in_window: List[int] = []
    if hourly_times and len(hourly_times) == len(hourly_probs):
        for t_str, p in zip(hourly_times, hourly_probs):
            if p is None:
                continue
            try:
                t_dt = datetime.datetime.fromisoformat(str(t_str))
                if window_start <= t_dt <= window_end:
                    probs_in_window.append(int(p))
            except Exception:
                continue

    if not probs_in_window:
        start_idx = min(now_naive.hour, max(0, len(hourly_probs) - 1))
        probs_in_window = [
            int(x)
            for x in hourly_probs[start_idx : start_idx + WEATHER_FORECAST_WINDOW_HOURS]
            if x is not None
        ]

    max_prob = max(probs_in_window or [0])
    if max_prob >= RAIN_PROB_THRESHOLD_PCT:
        res = (
            True,
            f"Alta chance de chuva nas próximas {WEATHER_FORECAST_WINDOW_HOURS}h (máx={max_prob}%)",
        )
    else:
        res = (
            False,
            f"Chance de chuva aceitável nas próximas {WEATHER_FORECAST_WINDOW_HOURS}h (máx={max_prob}%)",
        )

    _cycle_weather_cache[cache_key] = res
    return res


# =====================================================================================
# TRANSAÇÃO ATÓMICA DE RESERVA E CRIAÇÃO DE COMANDO AGENDADO
# =====================================================================================
def _is_valve_lock_still_active(
    state: Dict[str, Any], now_utc: datetime.datetime
) -> bool:
    """
    A reserva pendente e a abertura confirmada bloqueiam novos comandos ON.
    Aplica fallback seguro caso `reservation_expires_epoch` esteja ausente em registro legado.
    """
    if not isinstance(state, dict):
        return False

    now_ts = now_utc.timestamp()

    if state.get("valve_pending") is True and state.get("current_command_id"):
        deadline = state.get("reservation_expires_epoch")
        if isinstance(deadline, (int, float)) and not isinstance(deadline, bool) and deadline > 0:
            return now_ts <= float(deadline)

        reserved_ep = state.get("reserved_epoch")
        if isinstance(reserved_ep, (int, float)) and not isinstance(reserved_ep, bool) and reserved_ep > 0:
            fallback_deadline = (
                float(reserved_ep)
                + COMMAND_TTL_SECONDS
                + MAX_VALVE_DURATION_S
                + STALE_LOCK_GRACE_SEC
            )
            return now_ts <= fallback_deadline

        return False

    if state.get("valve_open") is not True:
        return False

    ends_at = state.get("valve_ends_at")
    if not isinstance(ends_at, datetime.datetime):
        return False

    if ends_at.tzinfo is None:
        ends_at = ends_at.replace(tzinfo=datetime.timezone.utc)
    if now_utc > (ends_at + datetime.timedelta(seconds=STALE_LOCK_GRACE_SEC)):
        return False

    return True


def _is_ota_lock_still_active(ota_status: Dict[str, Any], now_epoch: int) -> bool:
    """Verifica se há uma atualização OTA em andamento (`in_progress` ou `awaiting_reboot`)."""
    if not isinstance(ota_status, dict) or not (
        ota_status.get("in_progress") is True or ota_status.get("awaiting_reboot") is True
    ):
        return False

    expires_epoch = int(ota_status.get("expires_epoch") or 0)
    started_epoch = int(ota_status.get("started_epoch") or 0)

    if expires_epoch <= 0 and started_epoch <= 0:
        return False

    effective_deadline = (
        expires_epoch
        if expires_epoch > 0
        else (started_epoch + OTA_LOCK_TTL_SECONDS)
    )
    return now_epoch <= effective_deadline


def _normalize_schedule_label(value: Any) -> Optional[str]:
    return (value.strip()[:80] or None) if isinstance(value, str) else None


def _occurrence_schedule_label(history: dict, fallback: Optional[str]) -> Optional[str]:
    return _normalize_schedule_label(history.get("schedule_label", fallback))


def _schedule_skip_record(
    device_id, log_type, source, message, command_id, schedule_id, schedule_label,
    history, extra=None, *, final_valve_conflict=False,
):
    record = {
        "type": log_type, "source": source, "device_id": device_id,
        "command_id": command_id, "schedule_id": schedule_id,
        "schedule_label": _occurrence_schedule_label(history, schedule_label),
        "message": message, "timestamp": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP, "extra": extra or {},
    }
    if final_valve_conflict:
        record["schedule_skip_final"] = True
    return record


def _atomic_reserve_and_create_scheduled_command(
    db: firestore.Client,
    device_ref: Any,
    command_id: str,
    duration_s: int,
    schedule_ref: Any,
    schedule_label: Optional[str],
    now_local: datetime.datetime,
    expected_sched_time: str,
    expected_day_flutter: int,
    command_expires_epoch: Optional[int] = None,
) -> Tuple[str, Optional[str], int, int, int]:
    """
    Executa numa única Transação Atómica (`@firestore.transactional`):
      1. Relê `schedules/{schedule_id}` (e `private/demo_auth` apenas para agendas Demo)
         para confirmar que a agenda continua `enabled == True`, no mesmo horário/dia
         (SCH-1) e que a sessão Demo segue ativa (F1.3);
      2. Aplica teto de 300s para agendas Demo (`created_by_demo is True`);
      3. Verifica se `commands/{command_id}` já existe (permitindo retry de
         `publish_failed` sem cobrar novamente, CMD-2);
      4. Verifica se `ota_status` ou `state` está bloqueado por outra operação;
      5. Avalia espera e cota da Demo via `_evaluate_demo_schedule_limits` e cobra
         `demo_on_seconds_used`/`demo_last_on_epoch` na mesma transação quando aceita;
      6. Cria reserva pendente em `devices/{id}` (espelhando `state` em `demo_view/current`),
         e persiste `commands/{command_id}` e `history/cmd-{command_id}`.
    """
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_epoch = int(time.time())
    default_expires_epoch = command_expires_epoch or (now_epoch + COMMAND_TTL_SECONDS)
    now_server = firestore.SERVER_TIMESTAMP
    device_id = device_ref.id
    topic = build_device_command_topic(device_id)
    cmd_ref = device_ref.collection("commands").document(command_id)
    history_ref = device_ref.collection("history").document(f"cmd-{command_id}")
    demo_auth_ref = device_ref.collection("private").document("demo_auth")
    demo_view_ref = device_ref.collection("demo_view").document("current")

    @firestore.transactional
    def _tx_schedule(
        transaction: firestore.Transaction,
    ) -> Tuple[str, Optional[str], int, int, int]:
        # Todas as leituras ocorrem estritamente ANTES de qualquer escrita na transação
        sched_snap = schedule_ref.get(transaction=transaction)
        cmd_snap = cmd_ref.get(transaction=transaction)
        dev_snap = device_ref.get(transaction=transaction)
        history_snap = history_ref.get(transaction=transaction)
        demo_view_snap = demo_view_ref.get(transaction=transaction)

        fresh_sched = (sched_snap.to_dict() or {}) if sched_snap.exists else {}
        is_demo_schedule = fresh_sched.get("created_by_demo") is True
        demo_auth_snap = (
            demo_auth_ref.get(transaction=transaction) if is_demo_schedule else None
        )

        if not dev_snap.exists:
            return ("device_missing", None, duration_s, now_epoch, default_expires_epoch)

        # 1. Revalidação Atômica da Agenda dentro da Transação (SCH-1)
        if not sched_snap.exists:
            return ("schedule_disabled_or_changed", "deleted", duration_s, now_epoch, default_expires_epoch)

        if fresh_sched.get("enabled") is not True:
            return ("schedule_disabled_or_changed", "disabled", duration_s, now_epoch, default_expires_epoch)

        fresh_time = str(fresh_sched.get("time") or "").strip()
        fresh_days = fresh_sched.get("days")
        if (
            fresh_time != expected_sched_time
            or not isinstance(fresh_days, list)
            or expected_day_flutter not in fresh_days
        ):
            return ("schedule_disabled_or_changed", "reconfigured", duration_s, now_epoch, default_expires_epoch)

        effective_duration_s = _parse_schedule_duration_s(fresh_sched)
        if is_demo_schedule:
            effective_duration_s = min(effective_duration_s, DEMO_MAX_ON_DURATION_SEC)
        fresh_label = _normalize_schedule_label(fresh_sched.get("label")) or schedule_label

        dev_data = dev_snap.to_dict() or {}
        demo_auth_data = (
            (demo_auth_snap.to_dict() or {})
            if (demo_auth_snap is not None and demo_auth_snap.exists)
            else {}
        )
        history = (history_snap.to_dict() or {}) if history_snap.exists else {}

        # 1B. Guarda Zero-Trust por Sessão para Agendamentos Demo (F1.3)
        demo_expired, demo_exp_reason = _is_demo_schedule_expired_or_revoked(
            fresh_sched, demo_auth_data, now_epoch
        )
        if demo_expired:
            transaction.set(
                schedule_ref,
                {"enabled": False},
                merge=True,
            )
            transaction.set(
                history_ref,
                _schedule_skip_record(
                    device_id,
                    "skipped",
                    "schedule",
                    f"Ignorado e pausado: Agendamento de Usuário Teste encerrado ({demo_exp_reason}).",
                    command_id,
                    schedule_ref.id,
                    fresh_label,
                    history,
                    {"reason": "demo_pass_expired", "schedule_id": schedule_ref.id},
                ),
            )
            return ("demo_schedule_expired", demo_exp_reason, effective_duration_s, now_epoch, default_expires_epoch)

        # 2. Verificação de Comando Existente e Retentativa de publish_failed (CMD-2)
        existing_cmd = (cmd_snap.to_dict() or {}) if cmd_snap.exists else {}
        is_retry = False
        new_retry_count = 0
        effective_issued_at = now_epoch
        effective_expires_at = default_expires_epoch

        if cmd_snap.exists:
            existing_status = str(
                existing_cmd.get("last_status") or existing_cmd.get("status") or ""
            ).strip().lower()
            if existing_cmd.get("reservation_released_by_off_id") or existing_status != "publish_failed":
                return ("duplicate", existing_status, effective_duration_s, effective_issued_at, effective_expires_at)

            is_retry = True
            new_retry_count = int(existing_cmd.get("retry_count") or 0) + 1
            prior_created = int(existing_cmd.get("created_epoch") or 0)
            prior_on_exp = int(existing_cmd.get("on_expires_epoch") or 0)
            if prior_created > 0 and prior_on_exp > now_epoch:
                effective_issued_at = prior_created
                effective_expires_at = prior_on_exp
            if existing_cmd.get("requested_duration"):
                effective_duration_s = int(existing_cmd["requested_duration"])
                if is_demo_schedule:
                    effective_duration_s = min(effective_duration_s, DEMO_MAX_ON_DURATION_SEC)

        if history.get("schedule_skip_final") is True:
            return ("already_blocked", None, effective_duration_s, effective_issued_at, effective_expires_at)

        state = dev_data.get("state") or {}
        ota_status = dev_data.get("ota_status") or {}

        if _is_ota_lock_still_active(ota_status, now_epoch):
            return ("locked", "ota_in_progress", effective_duration_s, effective_issued_at, effective_expires_at)

        same_valve_holder = str(state.get("current_command_id") or "") == command_id
        if same_valve_holder and state.get("valve_open") is True:
            return ("duplicate", "started", effective_duration_s, effective_issued_at, effective_expires_at)

        if _is_valve_lock_still_active(state, now_utc) and not (same_valve_holder and is_retry):
            locked_origin = str(state.get("valve_origin") or "manual")
            if cmd_snap.exists:
                return ("locked", locked_origin, effective_duration_s, effective_issued_at, effective_expires_at)
            transaction.set(history_ref, _schedule_skip_record(
                device_id, "skipped", "schedule",
                f"Ignorado (transação): Recurso ocupado por ({locked_origin}).",
                command_id, schedule_ref.id, fresh_label, history,
                {"locked_origin": locked_origin, "schedule_id": schedule_ref.id},
                final_valve_conflict=True,
            ))
            return ("blocked_valve", locked_origin, effective_duration_s, effective_issued_at, effective_expires_at)

        # 3. Cobrança de Cota e Espera Unificadas para Agendas Demo (Fase 1B)
        if is_demo_schedule and not is_retry:
            demo_ok, demo_limit_reason, demo_retry_after = _evaluate_demo_schedule_limits(
                demo_auth_data, effective_duration_s, now_epoch
            )
            if not demo_ok:
                if demo_limit_reason == "demo_cooldown":
                    wait_sec = demo_retry_after or DEMO_ON_COOLDOWN_SEC
                    skip_msg = f"Ignorado: limite do Usuário Teste (aguarde {wait_sec}s)."
                else:
                    skip_msg = "Ignorado: cota de irrigação da sessão do Usuário Teste esgotada."

                skip_extra: Dict[str, Any] = {
                    "reason": demo_limit_reason,
                    "schedule_id": schedule_ref.id,
                }
                if demo_retry_after is not None:
                    skip_extra["retry_after_sec"] = demo_retry_after

                transaction.set(
                    history_ref,
                    _schedule_skip_record(
                        device_id,
                        "skipped",
                        "schedule",
                        skip_msg,
                        command_id,
                        schedule_ref.id,
                        fresh_label,
                        history,
                        skip_extra,
                        final_valve_conflict=True,
                    ),
                )
                return ("demo_limit", demo_limit_reason, effective_duration_s, now_epoch, default_expires_epoch)

        existing_schedule = existing_cmd.get("schedule")
        fallback_label = (
            _normalize_schedule_label(existing_schedule["label"])
            if isinstance(existing_schedule, dict) and "label" in existing_schedule
            else fresh_label
        )
        occurrence_label = _occurrence_schedule_label(history, fallback_label)
        confirmation_due = effective_expires_at + effective_duration_s + STALE_LOCK_GRACE_SEC

        cmd_doc: Dict[str, Any] = {
            "device_id": device_id,
            "command_id": command_id,
            "origin": "schedule",
            "schedule_confirmation_due_epoch": confirmation_due,
            "on_expires_epoch": effective_expires_at,
            "schedule_confirmation": "dispatching",
            "status": "pending",
            "last_status": "pending",
            "requested_action": "on",
            "requested_duration": effective_duration_s,
            "action": "on",
            "duration": effective_duration_s,
            "created_at": existing_cmd.get("created_at") if is_retry and existing_cmd.get("created_at") else now_server,
            "created_epoch": effective_issued_at,
            "updated_at": now_server,
            "schedule": {
                "id": schedule_ref.id,
                "path": schedule_ref.path,
                "local_time": now_local.isoformat(),
                "label": occurrence_label,
            },
            "mqtt": {"topic": topic, "qos": 1},
            "schema_version": 2,
            "valve_reservation_schema": 1,
        }
        if is_retry:
            cmd_doc["retry_count"] = new_retry_count

        new_state_map = {
            "valve_open": False,
            "valve_pending": True,
            "reservation_expires_epoch": confirmation_due,
            "valve_origin": "schedule",
            "current_command_id": command_id,
            "reserved_epoch": effective_issued_at,
            "reserved_at": (
                state.get("reserved_at")
                if (same_valve_holder and is_retry and state.get("reserved_at") is not None)
                else now_server
            ),
            "valve_started_at": None,
            "valve_ends_at": None,
            "confirmation_source": None,
            "execution_evidence": "awaiting_started_ack",
            "reconciled_command_id": None,
        }

        transaction.set(device_ref, {"state": new_state_map}, merge=True)
        if demo_view_snap.exists:
            transaction.set(
                demo_view_ref,
                {"state": new_state_map, "updated_at": now_server},
                merge=True,
            )
        if is_demo_schedule and not is_retry:
            prev_used = _safe_nonneg_int(demo_auth_data.get("demo_on_seconds_used"), 0)
            transaction.set(
                demo_auth_ref,
                {
                    "demo_on_seconds_used": prev_used + effective_duration_s,
                    "demo_last_on_epoch": now_epoch,
                },
                merge=True,
            )
        transaction.set(cmd_ref, cmd_doc, merge=True)
        transaction.set(history_ref, {
            "type": "command_execution", "source": "schedule", "status": "pending",
            "device_id": device_id, "command_id": command_id, "schedule_id": schedule_ref.id,
            "schedule_label": occurrence_label,
            "message": "Agendamento em processamento; execução ainda não confirmada.",
            "timestamp": now_server, "updated_at": now_server,
        }, merge=True)
        return ("created", None, effective_duration_s, effective_issued_at, effective_expires_at)

    tx = db.transaction()
    return _tx_schedule(tx)


def _rollback_scheduled_lock_on_publish_error(
    db: firestore.Client, device_ref: Any, command_id: str, error_msg: str
) -> None:
    """Registra erro MQTT, preservando a reserva nova quando a entrega é incerta."""
    now_server = firestore.SERVER_TIMESTAMP
    cmd_ref = device_ref.collection("commands").document(command_id)
    demo_view_ref = device_ref.collection("demo_view").document("current")

    @firestore.transactional
    def _tx_rollback(transaction: firestore.Transaction) -> None:
        cmd_snap = cmd_ref.get(transaction=transaction)
        snap = device_ref.get(transaction=transaction)
        demo_view_snap = demo_view_ref.get(transaction=transaction)
        command = (cmd_snap.to_dict() or {}) if cmd_snap.exists else {}
        if command.get("last_status", command.get("status")) != "pending":
            return
        transaction.set(
            cmd_ref,
            {
                "status": "publish_failed",
                "last_status": "publish_failed",
                "updated_at": now_server,
                "error": error_msg[:500],
            },
            merge=True,
        )
        if snap.exists:
            state = (snap.to_dict() or {}).get("state") or {}
            if state.get("current_command_id") == command_id and state.get("valve_pending") is not True:
                cleared_state = {
                    "valve_open": False,
                    "valve_origin": None,
                    "current_command_id": None,
                    "valve_ends_at": now_server,
                }
                transaction.set(device_ref, {"state": cleared_state}, merge=True)
                if demo_view_snap.exists:
                    transaction.set(
                        demo_view_ref,
                        {"state": cleared_state, "updated_at": now_server},
                        merge=True,
                    )

    try:
        tx = db.transaction()
        _tx_rollback(tx)
    except Exception as e:
        _log("WARN", "rollback_scheduled_lock_failed", error=str(e))


def save_history_log(
    db, device_id, log_type, source, message, command_id, schedule_id, *,
    schedule_label, extra=None, final_valve_conflict=False,
) -> bool:
    """
    Registra o bloqueio na mesma entrada que receberá a confirmação do comando.
    Quando `final_valve_conflict=True`, relê o documento da estação dentro da transação
    para confirmar que a válvula ainda está ocupada antes de gravar `schedule_skip_final=True`.
    """
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    device_ref = db.collection("devices").document(device_id)
    cmd_ref = device_ref.collection("commands").document(command_id)
    history_ref = device_ref.collection("history").document(f"cmd-{command_id}")

    @firestore.transactional
    def write_skip(transaction) -> bool:
        if cmd_ref.get(transaction=transaction).exists:
            return True
        history_snap = history_ref.get(transaction=transaction)
        history = (history_snap.to_dict() or {}) if history_snap.exists else {}
        if history.get("schedule_skip_final") is True:
            return True

        actual_extra = dict(extra or {})
        actual_message = message

        if final_valve_conflict:
            dev_snap = device_ref.get(transaction=transaction)
            if not dev_snap.exists:
                return False
            dev_state = (dev_snap.to_dict() or {}).get("state") or {}
            if (
                not _is_valve_lock_still_active(dev_state, now_utc)
                or str(dev_state.get("current_command_id") or "") == command_id
            ):
                return False
            locked_origin = str(dev_state.get("valve_origin") or "manual")
            actual_extra["locked_origin"] = locked_origin
            actual_message = f"Ignorado: Válvula já se encontra aberta noutra operação ({locked_origin})."

        transaction.set(history_ref, _schedule_skip_record(
            device_id, log_type, source, actual_message, command_id, schedule_id,
            schedule_label, history, actual_extra, final_valve_conflict=final_valve_conflict,
        ))
        return True

    return bool(write_skip(db.transaction()))


def _update_schedule_confirmation(db, cmd_ref, outcome, now_epoch=None):
    history_ref = cmd_ref.parent.parent.collection("history").document(f"cmd-{cmd_ref.id}")

    @firestore.transactional
    def update(transaction):
        snapshot = cmd_ref.get(transaction=transaction)
        command = snapshot.to_dict() or {}
        if command.get("origin") != "schedule":
            return
        due = command.get("schedule_confirmation_due_epoch")
        if due is None:
            return
        status = command.get("last_status", command.get("status"))
        if status in ("done", "failed"):
            if outcome == "timeout":
                transaction.update(cmd_ref, {"schedule_confirmation_due_epoch": firestore.DELETE_FIELD})
            return
        if outcome == "timeout":
            if due > now_epoch:
                return
            message = "Agendamento: prazo expirado; execução não confirmada."
            if status == "started":
                message = "Agendamento: início confirmado; término não confirmado no prazo."
        else:
            if status not in ("pending", "publish_failed") or command.get("schedule_confirmation") != "dispatching":
                return
            message = ("Comando publicado; aguardando confirmação do controlador."
                       if outcome == "published" else "Falha na publicação MQTT; entrega não confirmada.")
        updates = {"schedule_confirmation": outcome, "updated_at": firestore.SERVER_TIMESTAMP}
        if outcome == "timeout":
            updates["schedule_confirmation_due_epoch"] = firestore.DELETE_FIELD
        transaction.update(cmd_ref, updates)
        transaction.set(history_ref, {
            "message": message, "updated_at": firestore.SERVER_TIMESTAMP,
            "status": "unconfirmed" if outcome == "timeout" else status,
            "schedule_confirmation": outcome,
        }, merge=True)

    update(db.transaction())


def _expire_scheduled_confirmations(db: firestore.Client, now_epoch: int) -> int:
    """
    Varre até 50 comandos agendados com `schedule_confirmation_due_epoch <= now_epoch`
    com isolamento de erro individual por documento. Retorna a contagem de falhas.
    """
    sweep_errors = 0
    due = db.collection_group("commands").where(
        "schedule_confirmation_due_epoch", "<=", now_epoch
    ).limit(50)
    for snapshot in due.stream():
        try:
            _update_schedule_confirmation(db, snapshot.reference, "timeout", now_epoch)
        except Exception as item_exc:
            sweep_errors += 1
            _log(
                "WARN",
                "schedule_confirmation_item_timeout_failed",
                cmd_path=snapshot.reference.path,
                error=str(item_exc),
            )
    return sweep_errors


def _is_unacked_manual_candidate(cmd: Dict[str, Any], cutoff_epoch: int) -> bool:
    """E4 (v5.27.0): comando manual on/off ainda `pending`, criado antes do corte e não marcado."""
    if not isinstance(cmd, dict):
        return False
    if str(cmd.get("last_status") or cmd.get("status") or "").strip().lower() != "pending":
        return False
    if cmd.get("origin") == "schedule" or cmd.get("schedule_confirmation_due_epoch") is not None:
        return False
    action = str(cmd.get("requested_action") or cmd.get("action") or "").strip().lower()
    if action not in ("on", "off"):
        return False
    if cmd.get("confirmation_timeout_epoch"):
        return False
    created = _safe_nonneg_int(cmd.get("created_epoch"), 0)
    return 0 < created <= cutoff_epoch


def _mark_command_unconfirmed(db, cmd_ref, cutoff_epoch: int, now_epoch: int) -> bool:
    """E4: marca o comando e grava o histórico na mesma transação (relê antes de escrever)."""
    history_ref = cmd_ref.parent.parent.collection("history").document(f"cmd-{cmd_ref.id}")

    @firestore.transactional
    def mark(transaction) -> bool:
        snap = cmd_ref.get(transaction=transaction)
        if not snap.exists:
            return False
        cmd = snap.to_dict() or {}
        if not _is_unacked_manual_candidate(cmd, cutoff_epoch):
            return False
        hist_snap = history_ref.get(transaction=transaction)
        action = str(cmd.get("requested_action") or cmd.get("action") or "").strip().lower()
        duration = _safe_nonneg_int(cmd.get("requested_duration", cmd.get("duration")), 0)
        transaction.update(cmd_ref, {
            "confirmation": "timeout",
            "confirmation_timeout_epoch": now_epoch,
            "updated_at": firestore.SERVER_TIMESTAMP,
        })
        record = {
            "device_id": cmd.get("device_id") or cmd_ref.parent.parent.id,
            "command_id": cmd_ref.id,
            "type": "command_execution",
            "source": str(cmd.get("origin") or "manual"),
            "status": "unconfirmed",
            "reason": "no_ack_timeout",
            "message": (
                "Sem confirmação da estação: o comando expirou sem resposta. "
                "Se a estação ainda confirmar, este registro será atualizado."
            ),
            "details": {"requested": {"action": action, "duration": duration}, "confirmation": "timeout"},
            "schema_version": 2,
            "event_code": "CMD_NO_ACK_TIMEOUT",
            "ui_hint": {"kind": "command", "severity": "warning"},
            "updated_at": firestore.SERVER_TIMESTAMP,
        }
        if not hist_snap.exists:
            record["timestamp"] = cmd.get("created_at") or firestore.SERVER_TIMESTAMP
        transaction.set(history_ref, record, merge=True)
        return True

    return bool(mark(db.transaction()))


_LAST_DRYRUN_IDS: List[str] = []


def _expire_unacked_manual_commands(db, now_epoch: int, dry_run: bool = False) -> Tuple[int, int]:
    """E4: varre os comandos `pending` de cada estação. Retorna (marcados, falhas).
    Com dry_run=True só conta os candidatos (nada é gravado)."""
    cutoff = now_epoch - UNACKED_COMMAND_GRACE_SEC
    marked = 0
    failures = 0
    ids: List[str] = []
    for dev_snap in db.collection("devices").select(["owner_uid"]).limit(UNACKED_MAX_DEVICES).stream():
        query = (
            dev_snap.reference.collection("commands")
            .where("last_status", "==", "pending")
            .limit(UNACKED_MAX_PER_DEVICE)
        )
        for snap in query.stream():
            if not _is_unacked_manual_candidate(snap.to_dict() or {}, cutoff):
                continue
            if dry_run:
                marked += 1
                ids.append(snap.id)
                continue
            try:
                if _mark_command_unconfirmed(db, snap.reference, cutoff, now_epoch):
                    marked += 1
                    ids.append(snap.id)
            except Exception as item_exc:
                failures += 1
                _log("WARN", "unacked_command_mark_failed", cmd_path=snap.reference.path,
                     error=str(item_exc)[:200])
    if (marked or failures) and not dry_run:
        _log("INFO", "unacked_command_sweep", marked=marked, failures=failures,
             command_ids=ids[:20])
    if dry_run:
        _LAST_DRYRUN_IDS[:] = ids[:20]
    return marked, failures


def publish_iot_command(device_id: str, payload: dict) -> str:
    """Publica o comando agendado no tópico MQTT com QoS 1 e retentativa anti-throttling."""
    topic = build_device_command_topic(device_id)
    mqtt_json_str = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    t0 = time.perf_counter()

    try:
        iot_client.publish(topic=topic, qos=1, payload=mqtt_json_str)
    except ClientError as e:
        err_code = e.response.get("Error", {}).get("Code", "")
        if err_code in (
            "ThrottlingException",
            "InternalFailureException",
            "ServiceUnavailableException",
        ):
            backoff_sec = round(0.4 + random.random() * 0.4, 3)
            time.sleep(backoff_sec)
            iot_client.publish(topic=topic, qos=1, payload=mqtt_json_str)
        else:
            raise

    _log(
        "DEBUG",
        "iot_command_published",
        topic=topic,
        publish_latency_ms=round((time.perf_counter() - t0) * 1000.0, 2),
    )
    return topic


# =====================================================================================
# HANDLER PRINCIPAL DA LAMBDA
# =====================================================================================
def lambda_handler(event: Any, context: Any) -> Dict[str, Any]:
    """Ponto de entrada acionado a cada minuto pelo Amazon EventBridge."""
    request_id = getattr(context, "aws_request_id", "n/a")
    _current_request_id.set(request_id)
    _request_start_ns.set(time.perf_counter_ns())
    _current_device_id.set(None)
    _current_schedule_id.set(None)

    _cycle_weather_cache.clear()
    _cycle_telemetry_cache.clear()

    tz = pytz.timezone(TZ_NAME)
    now_local = datetime.datetime.now(tz)
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_epoch = int(time.time())

    # v5.27.0 (E4): contagem sem gravar, só por invocação manual com IAM (o EventBridge
    # nunca envia esta chave; não há rota de API para esta Lambda).
    if isinstance(event, dict) and event.get("agrosmart_unacked_dryrun") is True:
        found, _ = _expire_unacked_manual_commands(get_firestore_client(), now_epoch, dry_run=True)
        _log("INFO", "unacked_command_dryrun", candidates=found)
        return {"dry_run": True, "unacked_candidates": found, "command_ids": list(_LAST_DRYRUN_IDS),
                "grace_sec": UNACKED_COMMAND_GRACE_SEC}

    current_day_flutter = now_local.weekday() + 1  # 1=Seg ... 7=Dom
    current_time_str = now_local.strftime("%H:%M")

    # Janela de tolerância de 1 minuto (no mesmo dia) contra atrasos de segundo do EventBridge
    prev_dt = now_local - datetime.timedelta(minutes=1)
    candidate_times = [current_time_str]
    if prev_dt.date() == now_local.date():
        prev_time_str = prev_dt.strftime("%H:%M")
        if prev_time_str != current_time_str:
            candidate_times.append(prev_time_str)

    _log(
        "INFO",
        "scheduler_tick",
        now_local=now_local.isoformat(),
        day_flutter=current_day_flutter,
        candidate_times=candidate_times,
        dynamo_table=DYNAMO_TABLE,
    )

    try:
        db = get_firestore_client()

        t0_q = time.perf_counter()
        docs_list = list(
            db.collection_group("schedules")
            .where("enabled", "==", True)
            .where("days", "array_contains", current_day_flutter)
            .where("time", "in", candidate_times)
            .limit(MAX_SCHEDULES_PER_TICK)
            .stream()
        )
        query_ms = round((time.perf_counter() - t0_q) * 1000.0, 2)

        if len(docs_list) >= MAX_SCHEDULES_PER_TICK:
            _log(
                "WARN",
                "scheduler_tick_limit_reached",
                matched_count=len(docs_list),
                max_schedules_per_tick=MAX_SCHEDULES_PER_TICK,
            )

        _log(
            "DEBUG",
            "schedules_collection_group_queried",
            matched_count=len(docs_list),
            query_latency_ms=query_ms,
        )

        executed = 0
        skipped = 0
        duplicates = 0
        errors = 0
        demo_auth_cache: Dict[str, Dict[str, Any]] = {}

        try:
            errors += _expire_scheduled_confirmations(db, now_epoch)
        except Exception as exc:
            errors += 1
            _log("ERROR", "schedule_confirmation_sweep_failed", error=str(exc))

        # v5.27.0 (E4): comandos manuais sem confirmação (a cada N minutos; falha = WARN)
        if now_local.minute % UNACKED_SWEEP_EVERY_MIN == 0:
            try:
                _expire_unacked_manual_commands(db, now_epoch)
            except Exception as exc:
                _log("WARN", "unacked_command_sweep_failed", error=str(exc)[:200])

        for doc in docs_list:
            if not _has_enough_lambda_time(context):
                _log(
                    "WARN",
                    "scheduler_tick_time_budget_exhausted",
                    executed=executed,
                    skipped=skipped,
                )
                break

            try:
                schedule = doc.to_dict() or {}
                device_ref = doc.reference.parent.parent
                if device_ref is None:
                    continue

                device_id = device_ref.id
                schedule_ref = doc.reference
                schedule_id = schedule_ref.id

                _current_device_id.set(device_id)
                _current_schedule_id.set(schedule_id)

                sched_time_str = str(schedule.get("time") or current_time_str).strip()
                is_catchup_from_prev_min = (sched_time_str != current_time_str)
                command_id = build_command_id(schedule_id, now_local, sched_time_str)

                if is_catchup_from_prev_min:
                    existing_cmd_snap = (
                        device_ref.collection("commands").document(command_id).get()
                    )
                    if existing_cmd_snap.exists:
                        existing_cmd_data = existing_cmd_snap.to_dict() or {}
                        existing_st = str(
                            existing_cmd_data.get("last_status")
                            or existing_cmd_data.get("status")
                            or ""
                        ).strip().lower()
                        if (
                            existing_cmd_data.get("reservation_released_by_off_id")
                            or existing_st != "publish_failed"
                        ):
                            continue
                    else:
                        existing_hist_snap = (
                            device_ref.collection("history").document(f"cmd-{command_id}").get()
                        )
                        if existing_hist_snap.exists:
                            continue

                label = _normalize_schedule_label(schedule.get("label"))
                duration_s = _parse_schedule_duration_s(schedule)

                device_doc = device_ref.get()
                if not device_doc.exists:
                    _log("WARN", "device_not_found")
                    errors += 1
                    continue

                device_data = device_doc.to_dict() or {}
                owner_uid = str(device_data.get("owner_uid") or device_data.get("ownerUid") or "").strip()
                if not owner_uid:
                    _log("WARN", "schedule_skipped_unowned_device")
                    skipped += 1
                    continue

                settings = device_data.get("settings") or {}
                state = device_data.get("state") or {}
                ota_status = device_data.get("ota_status") or {}

                # 0) GUARDA ZERO-TRUST POR SESSÃO PARA AGENDAMENTOS DEMO (F1.1 + F1.3)
                if schedule.get("created_by_demo") is True:
                    if device_id not in demo_auth_cache:
                        auth_snap = device_ref.collection("private").document("demo_auth").get()
                        demo_auth_cache[device_id] = (
                            (auth_snap.to_dict() or {}) if auth_snap.exists else {}
                        )
                    demo_expired, demo_exp_reason = _is_demo_schedule_expired_or_revoked(
                        schedule, demo_auth_cache[device_id], now_epoch
                    )
                    if demo_expired:
                        try:
                            schedule_ref.set({"enabled": False}, merge=True)
                        except Exception as pause_err:
                            _log("WARN", "demo_schedule_autopause_failed", error=str(pause_err))
                        msg = f"Ignorado e pausado: Agendamento de Usuário Teste encerrado ({demo_exp_reason})."
                        save_history_log(
                            db,
                            device_id,
                            "skipped",
                            "schedule",
                            msg,
                            schedule_id=schedule_id,
                            schedule_label=label,
                            command_id=command_id,
                            extra={"schedule_id": schedule_id, "reason": "demo_pass_expired"},
                        )
                        skipped += 1
                        _log("INFO", "demo_schedule_autopause_triggered", reason=demo_exp_reason)
                        continue

                # 1A) CHECAGEM DE OTA EM ANDAMENTO
                if _is_ota_lock_still_active(ota_status, now_epoch):
                    msg = "Ignorado: Estação em processo de atualização de firmware (OTA)."
                    save_history_log(
                        db,
                        device_id,
                        "skipped",
                        "schedule",
                        msg,
                        schedule_id=schedule_id,
                        schedule_label=label,
                        command_id=command_id,
                        extra={"schedule_id": schedule_id, "reason": "ota_in_progress"},
                    )
                    skipped += 1
                    continue

                # 1B) CHECAGEM DE CONCORRÊNCIA DE VÁLVULA (EXCETUANDO PRÓPRIO RETRY DE PUBLISH_FAILED)
                same_holder_now = str(state.get("current_command_id") or "") == command_id
                if _is_valve_lock_still_active(state, now_utc) and not same_holder_now:
                    locked_origin = state.get("valve_origin") or "manual"
                    msg = f"Ignorado: Válvula já se encontra aberta noutra operação ({locked_origin})."
                    was_locked_in_tx = save_history_log(
                        db,
                        device_id,
                        "skipped",
                        "schedule",
                        msg,
                        schedule_id=schedule_id,
                        schedule_label=label,
                        command_id=command_id,
                        extra={"locked_origin": locked_origin, "schedule_id": schedule_id},
                        final_valve_conflict=True,
                    )
                    if was_locked_in_tx:
                        skipped += 1
                        continue

                try:
                    target_moisture = float(settings.get("target_soil_moisture", 100))
                    if not math.isfinite(target_moisture):
                        target_moisture = 100.0
                    target_moisture = max(0.0, min(100.0, target_moisture))
                except Exception:
                    target_moisture = 100.0

                enable_weather = bool(settings.get("enable_weather_control", False))
                try:
                    lat = float(settings.get("latitude", 0.0) or 0.0)
                    lon = float(settings.get("longitude", 0.0) or 0.0)
                except Exception:
                    lat, lon = 0.0, 0.0

                # 2) TELEMETRIA & SENSORES DE BORDA (FAIL-CLOSED ESTRITO — F3.5)
                snapshot, effective_max_age = get_latest_telemetry_snapshot(
                    device_id, settings=settings
                )
                if snapshot is None:
                    msg = "Ignorado: Telemetria indisponível, incompleta ou desatualizada (proteção fail-closed)."
                    save_history_log(
                        db,
                        device_id,
                        "skipped",
                        "schedule",
                        msg,
                        schedule_id=schedule_id,
                        schedule_label=label,
                        command_id=command_id,
                        extra={"telemetry_max_age_sec": effective_max_age},
                    )
                    skipped += 1
                    continue

                if snapshot.get("soil_fault") is True:
                    msg = "Ignorado: Sensor de solo reportou falha elétrica (cabo desligado ou curto)."
                    save_history_log(
                        db,
                        device_id,
                        "skipped",
                        "schedule",
                        msg,
                        schedule_id=schedule_id,
                        schedule_label=label,
                        command_id=command_id,
                    )
                    skipped += 1
                    continue

                if snapshot.get("rain_detected") is True:
                    msg = "Ignorado: Sensor físico da estação detetou chuva no momento."
                    save_history_log(
                        db,
                        device_id,
                        "skipped",
                        "weather_ai",
                        msg,
                        schedule_id=schedule_id,
                        schedule_label=label,
                        command_id=command_id,
                    )
                    skipped += 1
                    continue

                current_moisture = snapshot["soil_moisture"]
                if current_moisture >= target_moisture:
                    msg = f"Ignorado: Solo já húmido em {int(current_moisture)}% (Meta: {int(target_moisture)}%)"
                    save_history_log(
                        db,
                        device_id,
                        "skipped",
                        "schedule",
                        msg,
                        schedule_id=schedule_id,
                        schedule_label=label,
                        command_id=command_id,
                        extra={
                            "soil_moisture": current_moisture,
                            "target_moisture": target_moisture,
                        },
                    )
                    skipped += 1
                    continue

                # 3) PREVISÃO DE CLIMA EXTERNA NAS PRÓXIMAS 3 HORAS (Open-Meteo)
                if enable_weather and (lat != 0.0 or lon != 0.0):
                    should_skip, reason = check_rain_forecast(lat, lon, now_local)
                    if should_skip:
                        save_history_log(
                            db,
                            device_id,
                            "skipped",
                            "weather_ai",
                            f"Cancelado: {reason}",
                            schedule_id=schedule_id,
                            schedule_label=label,
                            command_id=command_id,
                        )
                        skipped += 1
                        continue

                # 4) TRANSAÇÃO ATÓMICA DE RESERVA E DISPARO DO COMANDO
                now_ts = int(time.time())
                initial_expires_at = now_ts + COMMAND_TTL_SECONDS

                (
                    tx_status,
                    tx_detail,
                    effective_duration_s,
                    effective_issued_at,
                    effective_expires_at,
                ) = _atomic_reserve_and_create_scheduled_command(
                    db=db,
                    device_ref=device_ref,
                    command_id=command_id,
                    duration_s=duration_s,
                    schedule_ref=schedule_ref,
                    schedule_label=label,
                    now_local=now_local,
                    expected_sched_time=sched_time_str,
                    expected_day_flutter=current_day_flutter,
                    command_expires_epoch=initial_expires_at,
                )

                if tx_status in ("schedule_disabled_or_changed", "demo_schedule_expired"):
                    skipped += 1
                    _log(
                        "INFO",
                        "schedule_aborted_at_transaction",
                        command_id=command_id,
                        decision=tx_status,
                        reason=tx_detail,
                    )
                    continue

                if tx_status == "demo_limit":
                    skipped += 1
                    sched_sid = str(schedule.get("demo_session_id") or "").strip()
                    _log(
                        "WARN",
                        "demo_schedule_limit_rejected",
                        command_id=command_id,
                        reason=tx_detail,
                        demo_sid_hash=_hash_demo_sid_for_log(sched_sid),
                    )
                    continue

                if tx_status == "duplicate":
                    if not is_catchup_from_prev_min:
                        duplicates += 1
                        _log("INFO", "duplicate_scheduled_command", command_id=command_id)
                    continue

                if tx_status in ("already_blocked", "blocked_valve"):
                    skipped += 1
                    _log(
                        "INFO",
                        "scheduled_occurrence_blocked",
                        command_id=command_id,
                        decision=tx_status,
                        locked_origin=tx_detail,
                    )
                    continue

                if tx_status == "locked":
                    skipped += 1
                    msg = f"Ignorado (transação): Recurso ocupado por ({tx_detail})."
                    save_history_log(
                        db,
                        device_id,
                        "skipped",
                        "schedule",
                        msg,
                        schedule_id=schedule_id,
                        schedule_label=label,
                        command_id=command_id,
                        extra={"locked_origin": tx_detail, "schedule_id": schedule_id},
                    )
                    continue

                if tx_status != "created":
                    errors += 1
                    continue

                payload = {
                    "device_id": device_id,
                    "command_id": command_id,
                    "action": "on",
                    "duration": effective_duration_s,
                    "origin": "schedule",
                    "schedule_id": schedule_id,
                    "issued_at": effective_issued_at,
                    "expires_at": effective_expires_at,
                }

                try:
                    publish_iot_command(device_id, payload)
                except Exception as pub_err:
                    errors += 1
                    _rollback_scheduled_lock_on_publish_error(
                        db, device_ref, command_id, str(pub_err)
                    )
                    _log("WARN", "schedule_publish_error", command_id=command_id, error=str(pub_err))
                    _update_schedule_confirmation(
                        db, device_ref.collection("commands").document(command_id), "publish_error"
                    )
                    continue

                _update_schedule_confirmation(
                    db, device_ref.collection("commands").document(command_id), "published"
                )
                executed += 1

            except Exception as item_err:
                errors += 1
                _log(
                    "ERROR",
                    "schedule_item_processing_failed",
                    error_type=type(item_err).__name__,
                    error=str(item_err),
                )

        _current_device_id.set(None)
        _current_schedule_id.set(None)

        body = {
            "message": "Scheduler cycle completed",
            "executed": executed,
            "skipped": skipped,
            "duplicates": duplicates,
            "errors": errors,
            "timestamp": now_local.isoformat(),
            "request_id": request_id,
        }

        if errors > 0:
            _log("WARN", "scheduler_cycle_had_errors", **body)
        else:
            _log("INFO", "scheduler_cycle_completed", **body)

        return {
            "statusCode": 200,
            "body": json.dumps(body, ensure_ascii=False),
        }

    except Exception as e:
        _log(
            "ERROR",
            "scheduler_critical_error",
            error_type=type(e).__name__,
            error=str(e),
        )
        raise
