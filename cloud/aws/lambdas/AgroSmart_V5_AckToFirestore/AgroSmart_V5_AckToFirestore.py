"""
=====================================================================================
ARQUIVO: backend/LambdasFuncs/AgroSmart_V5_AckToFirestore/AgroSmart_V5_AckToFirestore.py
PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5)
RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 3C — Itens 1 e 4)
DATA DE CRIACAO: 2026-02-18 06:15
ULTIMA ATUALIZACAO: 2026-11-24T23:00:00Z (UTC)
VERSAO: v5.33.0 — Eventos dos botões físicos da estação (firmware 5.27.0)
=====================================================================================
CHANGELOG v5.33.0 (2026-11-24, firmware 5.27.0):
- Eventos locais `loc-<boot_id>-<seq>-<on|off|disp>` (botões físicos) deixam de ser
  tratados como "comando não registrado": formato exato validado por regex, ação
  coerente com o tipo (on: on/off; off: off; disp: display) e qualquer outro `loc-`
  recusado sem gravar nada. Origem `local_button` no comando, no estado da válvula e
  no histórico (`type="local_action"`, `event_code="LOCAL_BUTTON"`).
- Histórico do botão: "Irrigação ligada pelo botão da estação (5 min)" no `started` e
  desfecho no terminal (mesmo documento). Desligar pelo botão que interrompe outra rega
  não duplica: o comando interrompido registra "encerrada pelo botão da estação".
- Limite por estação em `security.local_events` (`LOCAL_EVENT_MAX_PER_WINDOW=120`/h):
  acima dele não grava, mas o recibo é enviado (a placa libera a vaga).
- Mensagens novas: `local_button_stop`, `button_stuck`, `display_updated`,
  `buttons_updated`, `local_config_updated`, `invalid_config`.
- Nada muda para comandos do app, agendas, OTA ou recibos já existentes.
CHANGELOG v5.32.0 (2026-11-24, backlog ACK-01):
- Dois ACKs simultâneos do mesmo comando (ex.: DESLIGAR + LIGAR interrompido) podiam
  esgotar as tentativas da transação e gerar `409 Aborted (contention)`: a invocação
  falhava (métrica Errors/alarme) e só a reentrega da placa resolvia.
- Agora `_process_ack_with_contention_retry` repete a transação inteira até
  `ACK_TX_CONTENTION_RETRIES` (3) vezes com espera curta e aleatória (120/240/480 ms
  ±50%), registrando `WARN ack_tx_contention_retry`. Só repete erro de disputa
  (Aborted/Conflict/409): a transação abortada não gravou nada, e o `event_id`
  continua garantindo idempotência. Outros erros sobem como antes.
- E4: comando já marcado `confirmation="timeout"` pela Scheduler_Logic v5.27.0 sempre
  regrava o histórico no ACK final (inclusive DESLIGAR `manual_off`), trocando
  "Sem confirmação" pelo resultado real.
- (Versões 5.31.0: aquecimento em leque e leitura em lote — ver fim do arquivo.)
CHANGELOG v5.30.0 (2026-11-23):
- Fase 3C / Item 1 (Comando não registrado — alerta de segurança e anti-spam):
  * Identifica ACKs sem documento prévio em `devices/{device_id}/commands/{command_id}`
    (exceto `overflow-cmd`, classificado com origem `"device"`), definindo
    `origin="unregistered"`, `unregistered=True` e `registered_by_server=False`.
  * Grava alerta de segurança no histórico (`type="security_alert"`,
    `source="unregistered"`, `event_code="CMD_UNREGISTERED"`, `details.unregistered=True`,
    `ui_hint={"kind": "security", "severity": "warning"}`) inclusive em `received` e
    `started`, sem supressão por `skip_duplicate_stop_history`.
  * Mantém a atualização do estado físico da válvula (com `valve_origin="unregistered"`).
  * Aplica janela fixa de rate limit por estação em `security.unregistered_ack`
    (`UNREGISTERED_ACK_WINDOW_S=3600`, `UNREGISTERED_ACK_MAX_PER_WINDOW=20`), sem
    espelhar `security.*` no `demo_view`, omitindo escrita de comando/histórico acima
    do limite e mantendo o envio de `_receipt` (`committed`).
  * Emite logs estruturados `ack_unregistered_command` (WARN) e
    `ack_unregistered_rate_limited` (ERROR, uma vez por janela).
- Fase 3C / Item 4 (Novos motivos PT-BR e detalhe de rollback OTA):
  * Acrescenta ao `reason_map`: `power_unstable`, `failsafe_guard_timer`,
    `valve_task_stall`, `valve_guard_pending`, `clock_or_ttl_invalid`,
    `unknown_action` e `execution_unknown_after_reset`.
  * Inclui `power_unstable` e `valve_guard_pending` na lista `is_warning`.
  * Adiciona `ota_rollback_detail_map` para detalhar o campo `error` em `ota_rollback`.

CHANGELOG v5.29.0 (2026-11-22):
- Fase 3 / Parte A: Adiciona traduções PT-BR no `reason_map` para falhas de
  assinatura, anti-downgrade, versão bloqueada e timeout de self-test OTA
  (`ota_signature_invalid`, `ota_signature_missing`, `ota_downgrade_blocked`,
  `ota_version_blocked`, `ota_selftest_timeout`). Deduplicação e `ota_rollback`
  inalterados.

CHANGELOG v5.28.0 (2026-11-21):
- F4.2 (Isolamento de Canal MQTT): `_receipt()` publica exclusivamente no tópico
  dedicado `{IOT_TOPIC_PREFIX}/{device_id}/ack_receipt`, permitindo retirar da role
  `AgroSmart_V5_Ack_Role` qualquer permissão de publicação no tópico `.../command`.

CHANGELOG v5.27.0 (2026-11-21):
- F1.2: Espelha atualizações transacionais de `state` e `ota_status` sanitizado para
  `devices/{device_id}/demo_view/current`.
- F3.1: Exige envelope canônico da IoT Rule `AgroSmart_V5_AckToLambda` e tópico exato
  `{IOT_TOPIC_PREFIX}/{device_id}/ack`, sem dumps brutos nos logs.
- F3.3: `LOG_LEVEL` default alinhado para `"INFO"` e remoção de cliente ocioso de
  `secretsmanager`.

PROPÓSITO ARQUITETURAL:
Função AWS Lambda acionada pela IoT Rule `AgroSmart_V5_AckToLambda` sempre que o ESP32
publica uma confirmação de execução (ACK) no tópico `agrosmart/v5/+/ack`.
=====================================================================================
"""

import base64
import contextvars
import datetime
import hashlib
import json
import os
import random
import re
import time
from typing import Any, Dict, Optional, Tuple

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


from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

_current_request_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "request_id", default=None
)
_request_start_ns: contextvars.ContextVar[Optional[int]] = contextvars.ContextVar(
    "request_start_ns", default=None
)
_current_device_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "device_id", default=None
)
_current_command_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "command_id", default=None
)


def _env_int(name: str, default: int, min_value: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        parsed = int(raw.strip())
        return parsed if parsed >= min_value else default
    except (TypeError, ValueError):
        return default


AWS_REGION = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "us-east-2"
IOT_TOPIC_PREFIX = os.getenv("IOT_TOPIC_PREFIX", "agrosmart/v5").strip().strip("/")
_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
_ACK_TOPIC_RE = re.compile(
    rf"^{re.escape(IOT_TOPIC_PREFIX)}/([A-Za-z0-9_.:-]{{1,120}})/ack$"
)

UNREGISTERED_ACK_WINDOW_S = _env_int("UNREGISTERED_ACK_WINDOW_S", 3600, min_value=1)
# v5.33.0: eventos dos botões físicos (firmware 5.27.0). Formato exato; nada mais com "loc-".
_LOCAL_EVENT_RE = re.compile(r"^loc-[0-9A-F]{16}-[0-9]{1,10}-(on|off|disp)$")
_LOCAL_KIND_REQUESTED_ACTION = {"on": "on", "off": "off", "disp": "display"}
_LOCAL_KIND_ALLOWED_ACTIONS = {"on": {"on", "off"}, "off": {"off"}, "disp": {"display"}}
LOCAL_EVENT_WINDOW_S = _env_int("LOCAL_EVENT_WINDOW_S", 3600, min_value=1)
LOCAL_EVENT_MAX_PER_WINDOW = _env_int("LOCAL_EVENT_MAX_PER_WINDOW", 120, min_value=1)
UNREGISTERED_ACK_MAX_PER_WINDOW = _env_int("UNREGISTERED_ACK_MAX_PER_WINDOW", 20, min_value=1)
ACK_TX_CONTENTION_RETRIES = _env_int("ACK_TX_CONTENTION_RETRIES", 3, min_value=0)
_UNREGISTERED_ALERT_PREFIX = (
    "⚠ Comando não registrado no servidor (possível injeção ou teste): "
)

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").strip().upper()
_LOG_RANK = {"DEBUG": 10, "INFO": 20, "WARN": 30, "WARNING": 30, "ERROR": 40}


def _log(level: str, event_name: str, **fields: Any) -> None:
    lvl_upper = level.upper()
    if _LOG_RANK.get(lvl_upper, 20) < _LOG_RANK.get(LOG_LEVEL, 20):
        return

    rid = _current_request_id.get()
    if rid and "request_id" not in fields:
        fields["request_id"] = rid

    did = _current_device_id.get()
    if did and "device_id" not in fields:
        fields["device_id"] = did

    cid = _current_command_id.get()
    if cid and "command_id" not in fields:
        fields["command_id"] = cid

    start_ns = _request_start_ns.get()
    elapsed_ms: Optional[float] = None
    if start_ns is not None:
        elapsed_ms = round((time.perf_counter_ns() - start_ns) / 1_000_000.0, 2)

    payload = {
        "level": lvl_upper,
        "component": "AckToFirestore",
        "fw_backend": "v5.33.0",
        "event_name": event_name,
        "elapsed_ms": elapsed_ms,
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **{k: v for k, v in fields.items() if v is not None},
    }
    print(json.dumps(payload, ensure_ascii=False, default=str))


try:
    import firebase_admin
    from firebase_admin import credentials, firestore
    from google.cloud import firestore as gcf_firestore

    FIREBASE_AVAILABLE = True
except ImportError:
    firebase_admin = None
    credentials = None
    firestore = None
    gcf_firestore = None
    FIREBASE_AVAILABLE = False

_firestore_client: Optional[Any] = None
_iot_data_client: Optional[Any] = None

_DEFAULT_BOTO_CONFIG = BotoConfig(
    connect_timeout=5,
    read_timeout=5,
    retries={"max_attempts": 3, "mode": "standard"},
)

_ALLOWED_STATUSES = {"received", "started", "done", "failed"}

_STATUS_RANK: Dict[str, int] = {
    "pending": 0,
    "received": 1,
    "started": 2,
    "done": 3,
    "failed": 3,
}

_TERMINAL_STATES = {"done", "failed"}

_SYS_INT_FIELDS = {
    "rssi",
    "uptime_s",
    "heap",
    "boot_count",
    "session_seq",
    "schema",
    "tele_int_ms",
    "soil_dry",
    "soil_wet",
    "sd_err",
    "corrupt_lines",
    "rain_interlocks",
    "wifi_disc",
    "mqtt_reconn",
    "aht_err",
    "ack_drops",
    "telemetry_dropped",
    "valve_state",
    "valve_remaining_s",
    "pending_bytes",
    "pending_off",
    "pending_seg_r",
    "pending_seg_w",
}

_SYS_BOOL_FIELDS = {
    "sd_ok",
    "rtc_ok",
    "aht_ok",
    "soil_fault",
    "battery_present",
}


def _get_iot_data_client() -> Any:
    """Inicializa e reutiliza o cliente Boto3 `iot-data` com fallback seguro de endpoint."""
    global _iot_data_client
    if _iot_data_client is not None:
        return _iot_data_client

    raw_endpoint = (
        os.getenv("IOT_DATA_ENDPOINT", "").strip()
        or os.getenv("IOT_DATA_ENDPOINT_URL", "").strip()
    )
    if raw_endpoint:
        endpoint_url = (
            raw_endpoint
            if raw_endpoint.startswith("https://")
            else f"https://{raw_endpoint}"
        )
        _iot_data_client = boto3.client(
            "iot-data",
            region_name=AWS_REGION,
            endpoint_url=endpoint_url,
            config=_DEFAULT_BOTO_CONFIG,
        )
    else:
        _iot_data_client = boto3.client(
            "iot-data",
            region_name=AWS_REGION,
            config=_DEFAULT_BOTO_CONFIG,
        )
    return _iot_data_client


def _get_firestore() -> Optional[Any]:
    global _firestore_client
    if not FIREBASE_AVAILABLE:
        return None
    if _firestore_client is not None:
        return _firestore_client
    if getattr(firebase_admin, "_apps", None) and firebase_admin._apps:
        _firestore_client = firestore.client()
        return _firestore_client

    sa_json = ""
    secret_arn = (
        os.getenv("FIREBASE_SA_SECRET_ARN", "").strip()
        or os.getenv("GCP_SECRET_ARN", "").strip()
    )
    if secret_arn:
        try:
            resp = _agro_fetch_secret_or_ssm(secret_arn, AWS_REGION, _DEFAULT_BOTO_CONFIG)
            if "SecretString" in resp and resp["SecretString"]:
                sa_json = resp["SecretString"].strip()
            elif "SecretBinary" in resp and resp["SecretBinary"]:
                sa_json = base64.b64decode(resp["SecretBinary"]).decode("utf-8", errors="replace").strip()
        except Exception as e:
            _log("ERROR", "secret_fetch_failed", error=str(e))
            return None

    if not sa_json:
        sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()

    if sa_json:
        try:
            sa_obj = json.loads(sa_json)
            cred_obj = credentials.Certificate(sa_obj)
            firebase_admin.initialize_app(cred_obj)
        except Exception as e:
            _log("ERROR", "firebase_init_failed", error=str(e))
            return None
    else:
        try:
            firebase_admin.initialize_app()
        except Exception:
            return None

    _firestore_client = firestore.client()
    return _firestore_client


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _safe_get(d: Dict[str, Any], key: str, default: Any = None) -> Any:
    v = d.get(key, default)
    return v if v is not None else default


def _extract_trusted_ack_origin(event: Any) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Valida estritamente a origem do evento da IoT Rule `AgroSmart_V5_AckToLambda` (F3.1):
      - Exige `event` como dicionário canônico da regra (não aceita envelopes alternativos);
      - Exige `mqtt_topic` na raiz correspondendo exatamente a `{IOT_TOPIC_PREFIX}/{device_id}/ack`;
      - Exige coincidência entre `device_id` extraído do tópico, `topic_device_id` (da rule)
        e `device_id` do payload (quando informado).
    Retorna `(device_id, mqtt_topic, error_code)`.
    """
    if not isinstance(event, dict):
        return None, None, "invalid_event_envelope"

    mqtt_topic = event.get("mqtt_topic")
    if not isinstance(mqtt_topic, str) or not mqtt_topic.strip():
        return None, None, "missing_trusted_mqtt_topic"
    mqtt_topic = mqtt_topic.strip().strip("/")

    match = _ACK_TOPIC_RE.fullmatch(mqtt_topic)
    if not match:
        return None, mqtt_topic, "invalid_ack_topic_pattern"

    topic_seg_device_id = match.group(1)

    rule_topic_device_id = event.get("topic_device_id")
    if rule_topic_device_id is not None:
        if not isinstance(rule_topic_device_id, str) or rule_topic_device_id.strip() != topic_seg_device_id:
            return None, mqtt_topic, "topic_device_id_mismatch"

    payload_device_id = event.get("device_id")
    if payload_device_id is not None:
        if not isinstance(payload_device_id, str) or payload_device_id.strip() != topic_seg_device_id:
            return None, mqtt_topic, "device_id_topic_mismatch"

    if not _DEVICE_ID_RE.fullmatch(topic_seg_device_id):
        return None, mqtt_topic, "invalid_identity"

    return topic_seg_device_id, mqtt_topic, None


def _normalize_status(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    if not s:
        return ""
    if s == "error":
        return "failed"
    if s in _ALLOWED_STATUSES:
        return s
    return "unknown"


def _status_to_result(status: str, ok_value: Optional[bool], error_value: Optional[str]) -> str:
    s = (status or "").lower().strip()
    if error_value:
        return "failed"
    if ok_value is False:
        return "failed"
    if s == "done":
        return "success"
    return "failed"


def _normalize_action(value: Any) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip().lower()
    return s if s else None


def _normalize_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(float(value))
    except Exception:
        return None


def _sanitize_sys(sys_raw: Any) -> Dict[str, Any]:
    if not isinstance(sys_raw, dict):
        return {}

    sanitized: Dict[str, Any] = {}
    for k, v in sys_raw.items():
        if not isinstance(k, str) or v is None:
            continue
        key_clean = k.strip()[:32]
        if not key_clean:
            continue

        if key_clean in _SYS_INT_FIELDS:
            parsed_int = _normalize_int(v)
            if parsed_int is not None:
                sanitized[key_clean] = parsed_int
        elif key_clean in _SYS_BOOL_FIELDS:
            if isinstance(v, bool):
                sanitized[key_clean] = v
            elif isinstance(v, (int, float)):
                sanitized[key_clean] = bool(v != 0)
            elif isinstance(v, str):
                sanitized[key_clean] = v.strip().lower() in ("true", "1")
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            sanitized[key_clean] = v
        elif isinstance(v, bool):
            sanitized[key_clean] = v
        else:
            sanitized[key_clean] = str(v).strip()[:64]

    return sanitized


def _normalize_reason_logic(
    reason: Optional[str],
    status: str,
    result: str,
    requested_action: Optional[str],
    requested_duration: Optional[int],
) -> Tuple[Optional[str], Optional[str]]:
    if not reason:
        return None, None

    r_clean = reason.strip()
    r_lower = r_clean.lower()

    if (
        r_lower == "timeout"
        and status == "done"
        and result == "success"
        and (requested_action or "").lower() == "on"
        and (requested_duration or 0) > 0
    ):
        return "duration_elapsed", r_clean

    if r_lower != r_clean:
        return r_lower, r_clean

    return r_lower, None


def _fmt_duration_pt(v: Optional[int]) -> Optional[str]:
    if v is None or v <= 0:
        return None
    if v >= 60 and v % 60 == 0:
        return f"{v // 60} min"
    return "1 s" if v == 1 else f"{v} s"


def _describe_local_config(config_meta: Any) -> str:
    """v5.33.0: texto do histórico para a config do display/botão (vinda do comando)."""
    cfg = config_meta if isinstance(config_meta, dict) else {}
    parts = []
    mode = cfg.get("display_mode")
    if mode == "on":
        minutes = _normalize_int(cfg.get("display_minutes"))
        parts.append(f"Display da estação ligado pelo aplicativo por {minutes} min" if minutes else "Display da estação ligado pelo aplicativo")
    elif mode == "off":
        parts.append("Display da estação desligado pelo aplicativo")
    elif mode == "default_on":
        parts.append("Display da estação configurado para ficar sempre ligado")
    elif mode == "default_off":
        parts.append("Display da estação configurado para ficar apagado (acende pelo botão)")
    btn = _normalize_int(cfg.get("btn_irrig_min"))
    if btn:
        parts.append(f"botão de irrigação da estação ajustado para {btn} min")
    if not parts:
        return "Configuração do display e dos botões da estação atualizada"
    text = "; ".join(parts)
    return text[0].upper() + text[1:]


def _local_event_kind(command_id: str) -> Optional[str]:
    """v5.33.0: 'on' | 'off' | 'disp' para eventos dos botões; None para o resto."""
    m = _LOCAL_EVENT_RE.fullmatch(command_id or "")
    return m.group(1) if m else None


def _build_local_history_message(
    kind: str,
    status: str,
    result: str,
    reason: Optional[str],
    requested_duration: Optional[int],
    final_duration: Optional[int],
) -> Tuple[str, str]:
    """v5.33.0: (mensagem, severidade) do histórico de um evento dos botões."""
    r_key = str(reason or "").strip().lower()
    if kind == "disp":
        dur = _fmt_duration_pt(final_duration)
        if r_key == "display_off":
            return "Display desligado pelo botão da estação", "info"
        return (f"Display ligado pelo botão da estação ({dur})" if dur else "Display ligado pelo botão da estação"), "info"
    if kind == "off":
        if r_key == "button_stuck":
            return "Válvula desligada: botão da estação travado", "warning"
        return "Válvula desligada pelo botão da estação", "info"
    dur = _fmt_duration_pt(requested_duration)
    suffix = f" ({dur})" if dur else ""
    if status == "started":
        return f"Irrigação ligada pelo botão da estação{suffix}", "info"
    if status == "failed" and r_key not in ("rain_interlock", "button_stuck"):
        why = _build_history_message_simple(
            result="failed", requested_action="on", requested_duration=requested_duration,
            reason=reason, error_value=None,
        )
        return f"Botão da estação: irrigação recusada — {why[0].lower() + why[1:]}", "warning"
    if r_key == "duration_elapsed":
        return f"Irrigação pelo botão da estação concluída{suffix}", "info"
    if r_key == "local_button_stop":
        return f"Irrigação pelo botão da estação encerrada no botão{suffix}", "info"
    if r_key in ("manual_off", "manual_stop"):
        return f"Irrigação pelo botão da estação encerrada pelo aplicativo{suffix}", "info"
    if r_key == "rain_interlock":
        if status == "failed":
            return "Botão da estação: irrigação recusada — chuva detectada no local", "warning"
        return f"Irrigação pelo botão da estação interrompida: chuva detectada{suffix}", "warning"
    if r_key == "button_stuck":
        return "Irrigação pelo botão da estação encerrada: botão travado", "warning"
    base = _build_history_message_simple(
        result=result, requested_action="on", requested_duration=requested_duration,
        reason=reason, error_value=None,
    )
    return f"Irrigação pelo botão da estação: {base[0].lower() + base[1:]}", ("info" if result == "success" else "warning")


def _build_history_message_simple(
    result: str,
    requested_action: Optional[str],
    requested_duration: Optional[int],
    reason: Optional[str],
    error_value: Optional[str],
    fw_version: Optional[str] = None,
    config_meta: Any = None,
) -> str:
    def fmt_seconds(v: Optional[int]) -> Optional[str]:
        if v is None or v <= 0:
            return None
        if v >= 60 and v % 60 == 0:
            mins = v // 60
            return f"{mins} min"
        return "1 s" if v == 1 else f"{v} s"

    r_key = str(reason or "").strip().lower()

    reason_map = {
        "timeout": "timeout de segurança",
        "duration_elapsed": "ciclo concluído",
        "safety_timeout": "timeout de segurança",
        "watchdog": "proteção do sistema",
        "rain_interlock": "sensor detetou chuva no local",
        "power_loss_reset": "queda de energia / reinício da estação",
        "failsafe_no_deadline": "proteção fail-safe ativada",
        "manual_off": "encerrado manualmente",
        "manual_stop": "encerrado manualmente",
        "already_off": "válvula já estava desligada",
        "cancelled_by_off": "cancelado manualmente antes da execução",
        "superseded_by_off": "bloqueado porque um comando OFF mais recente já foi aplicado",
        "valve_already_open": "válvula já se encontrava aberta em outra rega",
        "config_updated": "calibração atualizada",
        "invalid_calibration": "calibração inválida (margem mínima < 100)",
        "duplicate_ignored": "comando duplicado ignorado",
        "command_expired": "comando expirado na rede (TTL excedido)",
        "rate_limited": "bloqueado por limite de comandos (rate limit)",
        "payload_too_large": "payload JSON excedeu limite de segurança",
        "ota_updated": "firmware atualizado com sucesso",
        "ota_rebooting": "firmware gravado e verificado (a reiniciar)",
        "ota_same_version": "a estação já está nesta versão de firmware",
        "ota_valve_busy": "bloqueado porque a válvula estava a irrigar",
        "ota_low_heap": "memória RAM livre insuficiente para download OTA",
        "ota_http_failed": "falha no download HTTPS do firmware",
        "ota_hash_mismatch": "hash SHA-256 inválido (ficheiro corrompido descartado)",
        "ota_flash_error": "falha ao gravar partição OTA na memória Flash",
        "ota_power_loss": "queda de energia durante download OTA (partição original mantida)",
        "ota_rollback": "auto-rollback ativado: falha no boot da nova versão",
        "ota_signature_invalid": "assinatura digital do firmware inválida",
        "ota_signature_missing": "firmware sem assinatura",
        "ota_downgrade_blocked": "versão mais antiga bloqueada",
        "ota_version_blocked": "versão bloqueada após falha anterior",
        "ota_selftest_timeout": "nova versão não conectou à AWS no prazo; voltou à anterior",
        "power_unstable": "bloqueado: energia instável (modo seguro após quedas de tensão)",
        "failsafe_guard_timer": "válvula fechada pela proteção independente (prazo excedido)",
        "valve_task_stall": "válvula fechada pela proteção independente (controle da válvula travou)",
        "valve_guard_pending": "bloqueado: proteção independente finalizando o fechamento anterior",
        "clock_or_ttl_invalid": "bloqueado: relógio ou validade do comando não confirmados",
        "unknown_action": "ação desconhecida recusada pela estação",
        "execution_unknown_after_reset": "estação reiniciou durante a rega; válvula fechada por segurança",
        "local_button_stop": "encerrado pelo botão da estação",
        "local_button_off": "desligado pelo botão da estação",
        "button_stuck": "botão da estação travado (válvula fechada por segurança)",
        "invalid_config": "configuração recusada pela estação (valor fora da faixa)",
        "valve_cooldown": "aguardando o intervalo mínimo após fechar a válvula",
        "ack_outbox_busy": "fila de confirmações da estação ocupada",
    }

    ota_rollback_detail_map = {
        "bootloader_rollback": "a nova versão não foi aprovada a tempo",
        "crash_after_ota": "a nova versão travou após iniciar",
        "selftest_timeout": "a nova versão não conectou à AWS no prazo",
        "power_loss_rollback": "queda de energia/reinício durante a verificação (versão NÃO bloqueada)",
    }

    reason_txt = reason_map.get(r_key, str(reason).strip()) if reason else None

    if result == "success":
        if r_key == "rain_interlock":
            return "Irrigação interrompida: sensor detetou chuva no local"
        if r_key in ("manual_off", "manual_stop"):
            return "Irrigação encerrada manualmente"
        if r_key == "local_button_stop":
            return "Irrigação encerrada pelo botão da estação"
        if r_key == "button_stuck":
            return "Irrigação encerrada: botão da estação travado"
        if r_key in ("display_updated", "buttons_updated", "local_config_updated"):
            return _describe_local_config(config_meta)
        if r_key == "config_updated":
            return "Configuração de sensores calibrada com sucesso"
        if r_key == "ota_same_version":
            return "Atualização OTA ignorada: versão já instalada na placa"
        if r_key in ("ota_updated", "ota_rebooting") or requested_action == "ota":
            ver_suffix = f" (v{fw_version})" if fw_version else ""
            return f"Atualização remota de firmware (OTA) gravada com sucesso{ver_suffix} — a reiniciar estação"
        if requested_action == "on":
            dur = fmt_seconds(requested_duration)
            if dur:
                return f"Controlador confirmou fim do temporizador (programado: {dur}); fluxo de água não medido"
            return "Controlador confirmou encerramento; fluxo de água não medido"
        if requested_action == "off":
            return "Irrigação desligada"
        return "Comando executado com sucesso"

    if r_key == "rain_interlock":
        return "Irrigação bloqueada: a chover no local"
    if r_key == "power_loss_reset":
        return "Controlador reiniciou; causa elétrica e duração real não confirmadas"
    if r_key == "execution_unknown_after_reset":
        return "Resultado da irrigação desconhecido após reinício; sem evidência persistente de encerramento"
    if r_key == "network_supervisor_stop":
        return "Saída da válvula desligada pelo supervisor após perda prolongada de conexão"
    if r_key == "ack_storage_unavailable":
        return "Irrigação bloqueada: armazenamento das confirmações indisponível"
    if r_key == "clock_or_ttl_invalid":
        return "Irrigação bloqueada: relógio ou validade do comando não confirmados"
    if r_key == "command_expired":
        return "Comando rejeitado: tempo limite de entrega (TTL) expirado"
    if r_key in ("cancelled_by_off", "superseded_by_off"):
        return "Comando ON cancelado por desligamento manual posterior"
    if r_key == "rate_limited":
        return "Comando rejeitado: excesso de acionamentos seguidos"
    if r_key == "valve_already_open":
        return "Comando rejeitado: a válvula já estava aberta noutra operação"
    if r_key == "ota_valve_busy":
        return "Atualização OTA recusada: válvula em operação de rega"
    if r_key == "ota_hash_mismatch":
        return "Atualização OTA abortada: hash SHA-256 inválido"
    if r_key == "ota_http_failed":
        return "Atualização OTA falhou: erro ao transferir binário do S3"
    if r_key == "ota_flash_error":
        return "Atualização OTA falhou: erro de gravação na partição Flash"
    if r_key == "ota_power_loss":
        return "Atualização OTA interrompida por queda de energia (partição anterior preservada)"
    if r_key == "ota_rollback":
        base_rb_msg = "Alerta OTA: nova versão falhou no self-test (Auto-Rollback executado)"
        err_key = str(error_value or "").strip().lower()
        rb_detail = ota_rollback_detail_map.get(err_key)
        if rb_detail:
            return f"{base_rb_msg} — {rb_detail}"
        return base_rb_msg
    if reason_txt:
        return f"Comando interrompido ({reason_txt})"
    if error_value:
        return f"Falha ao executar comando ({error_value})"
    return "Falha ao executar comando"


def _compute_expected_ends_at(duration_seconds: Optional[int]) -> Optional[datetime.datetime]:
    if not duration_seconds or duration_seconds <= 0:
        return None
    return datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        seconds=duration_seconds
    )


def _receipt(device_id: str, command_id: str, event_id: str, disposition: str) -> None:
    """
    Publica o recibo `ack_receipt` no tópico DEDICADO `{IOT_TOPIC_PREFIX}/{device_id}/ack_receipt`
    somente APÓS o commit da transação Firestore, com QoS 1, retain=False e retry (F4.2).
    """
    client = _get_iot_data_client()
    topic = f"{IOT_TOPIC_PREFIX}/{device_id}/ack_receipt"
    payload_bytes = json.dumps(
        {
            "action": "ack_receipt",
            "ack_protocol": 1,
            "device_id": device_id,
            "command_id": command_id,
            "event_id": event_id,
            "disposition": disposition,
        },
        separators=(",", ":"),
    ).encode("utf-8")

    try:
        client.publish(topic=topic, qos=1, retain=False, payload=payload_bytes)
    except ClientError as e:
        err_code = e.response.get("Error", {}).get("Code", "")
        if err_code in (
            "ThrottlingException",
            "InternalFailureException",
            "ServiceUnavailableException",
        ):
            time.sleep(round(0.3 + random.random() * 0.4, 3))
            client.publish(topic=topic, qos=1, retain=False, payload=payload_bytes)
        else:
            raise

    _log("INFO", "ack_receipt_published", event_id=event_id, disposition=disposition, topic=topic)


def _event_fingerprint(ack: Dict[str, Any]) -> str:
    # Metadados do broker são excluídos; campos imutáveis do produtor são incluídos.
    keys = (
        "ack_protocol",
        "event_id",
        "device_id",
        "command_id",
        "status",
        "action",
        "duration",
        "ts",
        "reason",
        "error",
        "interrupted_cmd_id",
        "sys",
        "evidence",
    )
    body = {key: ack[key] for key in keys if key in ack}
    return hashlib.sha256(
        json.dumps(
            body,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    ).hexdigest()


# A margem protege a reconciliação contra pequenas diferenças entre os relógios.
# ACKs antigos ou com timestamp ausente/incoerente conservam a trava original.
_PENDING_OFF_CLOCK_MARGIN_SEC = 15
_PENDING_OFF_MAX_ACK_AGE_SEC = 120


def _pending_off_target(
    state: Dict[str, Any],
    off_command: Dict[str, Any],
    sys_obj: Dict[str, Any],
    connection: Dict[str, Any],
    ts_unix: Any,
    now_epoch: int,
) -> Optional[str]:
    """Confere geração da reserva e validade da prova de OFF antes de ler o ON."""
    target = off_command.get("off_pending_target")
    owner = state.get("current_command_id")
    reserved_at = state.get("reserved_at")
    if (
        not isinstance(target, dict)
        or not isinstance(owner, str)
        or not re.fullmatch(r"[A-Za-z0-9:_-]{1,47}", owner)
        or target.get("command_id") != owner
        or not isinstance(reserved_at, datetime.datetime)
        or target.get("reserved_at") != reserved_at
        or state.get("valve_pending") is not True
        or state.get("valve_open") is not False
    ):
        return None

    boot = sys_obj.get("boot_id")
    session = sys_obj.get("session_seq")
    if (
        not boot
        or boot != connection.get("boot_id")
        or type(session) is not int
        or session <= 0
        or session != connection.get("session_seq")
        or connection.get("state") != "online"
        or type(ts_unix) is not int
        or not -_PENDING_OFF_CLOCK_MARGIN_SEC <= now_epoch - ts_unix <= _PENDING_OFF_MAX_ACK_AGE_SEC
    ):
        return None
    return owner


def _off_proves_expired_on(
    on_command: Dict[str, Any],
    off_command: Dict[str, Any],
    ts_unix: int,
) -> bool:
    """Usa o TTL real da publicação, sem inferi-lo de reservas legadas."""
    expires = on_command.get("on_expires_epoch")
    off_created = off_command.get("created_epoch")
    return (
        on_command.get("requested_action") == "on"
        and str(on_command.get("last_status") or on_command.get("status"))
        in ("pending", "publish_failed", "received")
        and not on_command.get("reservation_released_by_off_id")
        and type(expires) is int
        and expires > 0
        and type(off_created) is int
        and off_created >= expires + _PENDING_OFF_CLOCK_MARGIN_SEC
        and ts_unix > expires
        and ts_unix >= off_created - _PENDING_OFF_CLOCK_MARGIN_SEC
    )


def _is_eligible_pending_on_for_explicit_cancel(on_command: Dict[str, Any]) -> bool:
    """Verifica se o comando ON alvo ainda está pendente e elegível para cancelamento explícito."""
    return (
        on_command.get("requested_action") == "on"
        and str(on_command.get("last_status") or on_command.get("status"))
        in ("pending", "publish_failed", "received")
        and not on_command.get("reservation_released_by_off_id")
    )


def _diagnose_pending_off_reconcile(
    state: Dict[str, Any],
    off_command: Dict[str, Any],
    sys_obj: Dict[str, Any],
    connection: Dict[str, Any],
    ts_unix: Any,
    now_epoch: int,
    on_command: Optional[Dict[str, Any]] = None,
) -> str:
    """Retorna o código de motivo específico quando a reconciliação por OFF não libera a reserva."""
    target = off_command.get("off_pending_target")
    owner = state.get("current_command_id")
    reserved_at = state.get("reserved_at")
    if not isinstance(target, dict):
        return "missing_off_pending_target"
    if (
        not isinstance(owner, str)
        or target.get("command_id") != owner
        or not isinstance(reserved_at, datetime.datetime)
        or target.get("reserved_at") != reserved_at
    ):
        return "pending_owner_changed"
    if (
        not sys_obj.get("boot_id")
        or sys_obj.get("boot_id") != connection.get("boot_id")
        or type(sys_obj.get("session_seq")) is not int
        or sys_obj.get("session_seq") != connection.get("session_seq")
        or connection.get("state") != "online"
    ):
        return "presence_session_mismatch"
    if (
        type(ts_unix) is not int
        or not -_PENDING_OFF_CLOCK_MARGIN_SEC <= now_epoch - ts_unix <= _PENDING_OFF_MAX_ACK_AGE_SEC
    ):
        return "ack_timestamp_invalid"
    if on_command is not None:
        expires = on_command.get("on_expires_epoch")
        off_created = off_command.get("created_epoch")
        if type(expires) is int and type(off_created) is int:
            if off_created < expires + _PENDING_OFF_CLOCK_MARGIN_SEC or ts_unix <= expires:
                return "off_before_on_expiry"
    return "reconcile_condition_not_met"


def _sanitize_ota_for_demo_view(ota_state: Dict[str, Any], now_server: Any) -> Dict[str, Any]:
    """Filtra apenas os campos não sensíveis de `ota_status` para a projeção `demo_view/current`."""
    out: Dict[str, Any] = {
        "in_progress": bool(ota_state.get("in_progress", False)),
        "awaiting_reboot": bool(ota_state.get("awaiting_reboot", False)),
        "status": ota_state.get("status"),
        "updated_at": now_server,
    }
    if ota_state.get("target_version"):
        out["target_version"] = ota_state["target_version"]
    if ota_state.get("reason"):
        out["reason"] = ota_state["reason"]
    return out


def _process_ack_unified_transaction(
    db: Any,
    device_id: str,
    command_id: str,
    status: str,
    action: Optional[str],
    duration: Optional[int],
    ts_unix: Any,
    ok_value: Optional[bool],
    reason_in: Optional[str],
    error_value: Optional[str],
    interrupted_cmd_id: Optional[str],
    sys_obj: Dict[str, Any],
    mqtt_topic: Optional[str],
    event_id: Optional[str] = None,
    event_fingerprint: Optional[str] = None,
    evidence: Optional[str] = None,
    local_kind: Optional[str] = None,
) -> Tuple[bool, bool, str, Optional[str]]:
    now_server = firestore.SERVER_TIMESTAMP
    device_ref = db.collection("devices").document(device_id)
    cmd_ref = device_ref.collection("commands").document(command_id)
    history_ref = device_ref.collection("history").document(f"cmd-{command_id}")
    demo_view_ref = device_ref.collection("demo_view").document("current")

    event_ref = device_ref.collection("ack_events").document(event_id) if event_id else None
    reconcile_audit: Dict[str, Any] = {}
    unregistered_audit: Dict[str, Any] = {}

    @gcf_firestore.transactional
    def _tx_unified(transaction: Any) -> Tuple[bool, bool, str, Optional[str]]:
        reconcile_audit.clear()
        unregistered_audit.clear()
        # AGROSMART_LEITURA_EM_LOTE (v5.31.0): 1 ida ao Firestore em vez de 4 (trava mais curta).
        _agro_refs = [cmd_ref, device_ref, demo_view_ref]
        if event_ref:
            _agro_refs.append(event_ref)
        _agro_snaps = {_s.reference.path: _s for _s in transaction.get_all(_agro_refs) if _s is not None}
        cmd_snap = _agro_snaps.get(cmd_ref.path)
        dev_snap = _agro_snaps.get(device_ref.path)
        demo_view_snap = _agro_snaps.get(demo_view_ref.path)
        event_snap = _agro_snaps.get(event_ref.path) if event_ref else None
        if cmd_snap is None:
            cmd_snap = cmd_ref.get(transaction=transaction)
        if dev_snap is None:
            dev_snap = device_ref.get(transaction=transaction)
        if demo_view_snap is None:
            demo_view_snap = demo_view_ref.get(transaction=transaction)
        if event_ref and event_snap is None:
            event_snap = event_ref.get(transaction=transaction)
        if event_snap is not None and event_snap.exists:
            prior_event = event_snap.to_dict() or {}
            if prior_event.get("fingerprint") != event_fingerprint:
                raise ValueError("ACK event_id collision: immutable payload changed")
            return (
                True,
                bool(prior_event.get("terminal_conflict")),
                str(prior_event.get("result") or "pending"),
                prior_event.get("reason"),
            )

        existing_cmd = cmd_snap.to_dict() if cmd_snap.exists else {}
        current_dev = dev_snap.to_dict() if dev_snap.exists else {}

        is_unregistered = (
            ((not cmd_snap.exists) and command_id != "overflow-cmd" and not local_kind)
            or bool(existing_cmd.get("unregistered") is True)
        )
        is_device_diagnostic = (not cmd_snap.exists) and command_id == "overflow-cmd"

        existing_status = (
            str(existing_cmd.get("last_status") or existing_cmd.get("status") or "")
            .strip()
            .lower()
        )
        incoming_reason_lower = str(reason_in or "").strip().lower()

        existing_rank = _STATUS_RANK.get(existing_status, 0)
        new_rank = _STATUS_RANK.get(status, 0)

        is_legitimate_ota_rollback = (
            existing_status == "done"
            and status == "failed"
            and _normalize_action(existing_cmd.get("requested_action") or action) == "ota"
            and incoming_reason_lower == "ota_rollback"
        )

        is_terminal_conflict = (
            existing_status in _TERMINAL_STATES
            and status in _TERMINAL_STATES
            and existing_status != status
            and not is_legitimate_ota_rollback
        )

        is_out_of_order_regression = (new_rank < existing_rank) or is_terminal_conflict

        terminal_repeat = existing_status in _TERMINAL_STATES and not is_legitimate_ota_rollback
        regressive = (
            is_out_of_order_regression
            or terminal_repeat
            or (status == existing_status and status not in _TERMINAL_STATES)
        )

        released_on_ref = None
        released_on_id = None
        now_tx_epoch = int(time.time())
        cur_state_check = current_dev.get("state") or {}
        cur_conn_check = current_dev.get("connection") or {}

        unreg_win_start = 0
        unreg_count = 0
        unreg_limited = False
        if is_unregistered and not regressive:
            cur_security = current_dev.get("security") or {}
            cur_unreg = (
                cur_security.get("unregistered_ack")
                if isinstance(cur_security, dict)
                else None
            )
            if not isinstance(cur_unreg, dict):
                cur_unreg = {}
            prev_win_start = _normalize_int(cur_unreg.get("window_start_epoch")) or 0
            prev_count = _normalize_int(cur_unreg.get("count")) or 0
            if (
                prev_win_start > 0
                and 0 <= (now_tx_epoch - prev_win_start) < UNREGISTERED_ACK_WINDOW_S
            ):
                unreg_win_start = prev_win_start
                unreg_count = prev_count + 1
            else:
                unreg_win_start = now_tx_epoch
                unreg_count = 1
            unreg_limited = unreg_count > UNREGISTERED_ACK_MAX_PER_WINDOW
            unregistered_audit.update(
                {
                    "command_id": command_id,
                    "status": status,
                    "action": action,
                    "count": unreg_count,
                    "limited": unreg_limited,
                    "window_start_epoch": unreg_win_start,
                    "rate_limit_just_exceeded": (
                        unreg_count == UNREGISTERED_ACK_MAX_PER_WINDOW + 1
                    ),
                }
            )

        # v5.33.0: limite de eventos dos botões por estação (conta 1 por evento novo).
        local_win_start = 0
        local_count = 0
        local_limited = False
        if local_kind and not regressive and not cmd_snap.exists:
            cur_security_l = current_dev.get("security") or {}
            cur_local = (
                cur_security_l.get("local_events")
                if isinstance(cur_security_l, dict)
                else None
            )
            if not isinstance(cur_local, dict):
                cur_local = {}
            prev_l_start = _normalize_int(cur_local.get("window_start_epoch")) or 0
            prev_l_count = _normalize_int(cur_local.get("count")) or 0
            if prev_l_start > 0 and 0 <= (now_tx_epoch - prev_l_start) < LOCAL_EVENT_WINDOW_S:
                local_win_start = prev_l_start
                local_count = prev_l_count + 1
            else:
                local_win_start = now_tx_epoch
                local_count = 1
            local_limited = local_count > LOCAL_EVENT_MAX_PER_WINDOW
            if local_count == LOCAL_EVENT_MAX_PER_WINDOW + 1:
                unregistered_audit.update({"local_rate_limited": True, "command_id": command_id,
                                           "status": status, "action": action, "count": local_count,
                                           "limited": True, "window_start_epoch": local_win_start})
        writes_limited = unreg_limited or local_limited

        ack_boot = str(sys_obj.get("boot_id") or "").strip()
        dev_boot = str(cur_conn_check.get("boot_id") or "").strip()
        ack_sess = int(sys_obj.get("session_seq") or 0)
        dev_sess = int(cur_conn_check.get("session_seq") or 0)
        same_session = bool(ack_boot and ack_boot == dev_boot and ack_sess > 0 and ack_sess == dev_sess)

        if (
            not regressive
            and event_ref is not None
            and existing_cmd.get("requested_action") == "off"
            and status == "done"
            and action == "off"
            and incoming_reason_lower in ("already_off", "manual_off", "manual_stop")
            and evidence == "controller_report"
        ):
            pending_owner_now = cur_state_check.get("current_command_id")
            explicit_cancel_match = (
                bool(interrupted_cmd_id)
                and isinstance(pending_owner_now, str)
                and interrupted_cmd_id == pending_owner_now
                and cur_state_check.get("valve_pending") is True
                and cur_state_check.get("valve_open") is False
            )

            if explicit_cancel_match and pending_owner_now != command_id:
                if not same_session or cur_conn_check.get("state") != "online":
                    reconcile_audit.update({
                        "decision": "presence_session_mismatch",
                        "on_command_id": pending_owner_now,
                        "off_command_id": command_id,
                    })
                else:
                    target_ref = device_ref.collection("commands").document(pending_owner_now)
                    target_snap = target_ref.get(transaction=transaction)
                    target_dict = (target_snap.to_dict() or {}) if target_snap.exists else {}
                    if target_snap.exists and _is_eligible_pending_on_for_explicit_cancel(target_dict):
                        released_on_ref = target_ref
                        released_on_id = pending_owner_now
                        reconcile_audit.update({
                            "decision": "explicit_cancel_released",
                            "on_command_id": pending_owner_now,
                            "off_command_id": command_id,
                        })
                    else:
                        reconcile_audit.update({
                            "decision": "explicit_cancel_target_ineligible",
                            "on_command_id": pending_owner_now,
                            "off_command_id": command_id,
                        })
            elif not interrupted_cmd_id and incoming_reason_lower == "already_off":
                target_id = _pending_off_target(
                    cur_state_check,
                    existing_cmd,
                    sys_obj,
                    cur_conn_check,
                    ts_unix,
                    now_tx_epoch,
                )
                if target_id and target_id != command_id:
                    target_ref = device_ref.collection("commands").document(target_id)
                    target_snap = target_ref.get(transaction=transaction)
                    target_dict = (target_snap.to_dict() or {}) if target_snap.exists else {}
                    if target_snap.exists and _off_proves_expired_on(
                        target_dict,
                        existing_cmd,
                        ts_unix,
                    ):
                        released_on_ref = target_ref
                        released_on_id = target_id
                        reconcile_audit.update({
                            "decision": "pending_reservation_released",
                            "on_command_id": target_id,
                            "off_command_id": command_id,
                        })
                    else:
                        reconcile_audit.update({
                            "decision": _diagnose_pending_off_reconcile(
                                cur_state_check,
                                existing_cmd,
                                sys_obj,
                                cur_conn_check,
                                ts_unix,
                                now_tx_epoch,
                                target_dict,
                            ),
                            "on_command_id": target_id,
                            "off_command_id": command_id,
                        })
                elif cur_state_check.get("valve_pending") is True:
                    reconcile_audit.update({
                        "decision": _diagnose_pending_off_reconcile(
                            cur_state_check,
                            existing_cmd,
                            sys_obj,
                            cur_conn_check,
                            ts_unix,
                            now_tx_epoch,
                            None,
                        ),
                        "on_command_id": pending_owner_now,
                        "off_command_id": command_id,
                    })

        if event_ref is not None and not writes_limited:
            transaction.set(
                event_ref,
                {
                    "event_id": event_id,
                    "command_id": command_id,
                    "device_id": device_id,
                    "fingerprint": event_fingerprint,
                    "received_at": now_server,
                    "status": status,
                    "reason": reason_in,
                    "error": error_value,
                    "device_ts": ts_unix,
                    "sys": sys_obj,
                    "evidence": evidence,
                    "action": action,
                    "duration": duration,
                    "interrupted_cmd_id": interrupted_cmd_id,
                    "result": (
                        existing_cmd.get("result", "pending")
                        if regressive
                        else _status_to_result(status, ok_value=ok_value, error_value=error_value)
                    ),
                    "applied": not regressive,
                    "terminal_conflict": is_terminal_conflict
                    or bool(
                        terminal_repeat
                        and (
                            status != existing_status
                            or str(reason_in or "") != str(existing_cmd.get("reason") or "")
                        )
                    ),
                    "canonical_status": existing_status if regressive else status,
                },
            )
        if regressive:
            _log(
                "WARN" if is_terminal_conflict else "INFO",
                "ack_canonical_preserved",
                incoming_status=status,
                canonical_status=existing_status,
                event_id=event_id,
            )
            return (
                True,
                is_terminal_conflict,
                str(existing_cmd.get("result") or "pending"),
                existing_cmd.get("reason"),
            )

        status_ts_field = (
            f"status_ts.{status}"
            if status in _ALLOWED_STATUSES
            else "status_ts.unknown"
        )

        cmd_update: Dict[str, Any] = {
            "device_id": device_id,
            "command_id": command_id,
            "updated_at": now_server,
        }
        if is_unregistered:
            cmd_update["unregistered"] = True
            cmd_update["registered_by_server"] = False
            cmd_update["origin"] = "unregistered"
        if local_kind:
            cmd_update["origin"] = "local_button"
            cmd_update["registered_by_server"] = False
            cmd_update["local_event"] = True
            cmd_update["local_kind"] = local_kind
            if not existing_cmd.get("requested_action"):
                cmd_update["requested_action"] = _LOCAL_KIND_REQUESTED_ACTION[local_kind]
            if not cmd_snap.exists:
                cmd_update["created_at"] = now_server
                cmd_update["created_epoch"] = now_tx_epoch

        schedule_confirmation = existing_cmd.get("schedule_confirmation")
        if schedule_confirmation and status in _TERMINAL_STATES:
            cmd_update["schedule_confirmation"] = "terminal"
            cmd_update["schedule_confirmation_due_epoch"] = gcf_firestore.DELETE_FIELD
            cmd_update["schedule_confirmation_late"] = schedule_confirmation == "timeout"

        status_ts_map = existing_cmd.get("status_ts")
        has_status_ts = (
            status_ts_field in existing_cmd
            or (isinstance(status_ts_map, dict) and status in status_ts_map)
        )
        if not has_status_ts:
            cmd_update[status_ts_field] = now_server

        if event_id:
            cmd_update["terminal_event_id"] = event_id
            cmd_update["ack_protocol"] = 1
            cmd_update["evidence"] = evidence or "controller_report"

        if not is_out_of_order_regression:
            cmd_update["status"] = status
            cmd_update["last_status"] = status
            cmd_update["last_status_at"] = now_server

        result_calculated = "pending"
        if status in ("done", "failed"):
            result_calculated = _status_to_result(
                status, ok_value=ok_value, error_value=error_value
            )
            if not is_out_of_order_regression:
                cmd_update["finished_at"] = now_server
                cmd_update["result"] = result_calculated
        elif status == "received" and not existing_cmd.get("received_at"):
            cmd_update["received_at"] = now_server
        elif status == "started" and not existing_cmd.get("started_at"):
            cmd_update["started_at"] = now_server

        req_action = _normalize_action(
            existing_cmd.get("requested_action")
            or (_LOCAL_KIND_REQUESTED_ACTION[local_kind] if local_kind else None)
            or action
        )
        req_duration = _normalize_int(
            existing_cmd.get("requested_duration")
            if existing_cmd.get("requested_duration") is not None
            else duration
        )

        final_reason, original_reason_raw = _normalize_reason_logic(
            reason=reason_in,
            status=status,
            result=result_calculated,
            requested_action=req_action,
            requested_duration=req_duration,
        )

        if final_reason is not None and not is_out_of_order_regression:
            cmd_update["reason"] = final_reason
        if original_reason_raw is not None and not is_out_of_order_regression:
            cmd_update["reason_raw"] = original_reason_raw
        if interrupted_cmd_id:
            cmd_update["interrupted_cmd_id"] = interrupted_cmd_id

        if sys_obj:
            cmd_update["sys"] = sys_obj
        if error_value is not None and not is_out_of_order_regression:
            cmd_update["error"] = error_value
        if action is not None and not is_out_of_order_regression:
            cmd_update["action"] = action
        if duration is not None and not is_out_of_order_regression:
            cmd_update["duration"] = duration
        if ts_unix is not None:
            cmd_update["device_ts"] = ts_unix
        if mqtt_topic is not None:
            cmd_update["mqtt_topic"] = mqtt_topic

        if status in ("received", "started"):
            if action and not existing_cmd.get("requested_action"):
                cmd_update["requested_action"] = action
            if duration is not None and existing_cmd.get("requested_duration") is None:
                cmd_update["requested_duration"] = duration

        state_data = cur_state_check
        current_active_cmd_id = state_data.get("current_command_id")
        lock_reserved_epoch = int(state_data.get("reserved_epoch") or 0)
        cmd_created_epoch = int(existing_cmd.get("created_epoch") or 0)

        if local_kind:
            cmd_origin = "local_button"
        elif is_unregistered:
            cmd_origin = "unregistered"
        elif is_device_diagnostic:
            cmd_origin = "device"
        else:
            cmd_origin = str(
                existing_cmd.get("origin")
                or ("schedule" if command_id.startswith("sched-") else "manual")
            )
        ota_target_ver = (existing_cmd.get("ota") or {}).get("target_version") or sys_obj.get("fw")

        dev_updates: Dict[str, Any] = {"updated_at": now_server}
        demo_view_updates: Dict[str, Any] = {}

        if is_unregistered:
            dev_updates["security"] = {
                "unregistered_ack": {
                    "window_start_epoch": unreg_win_start,
                    "count": unreg_count,
                    "last_at": now_server,
                    "last_command_id": command_id,
                }
            }
        if local_kind and local_count > 0:
            dev_updates["security"] = {
                "local_events": {
                    "window_start_epoch": local_win_start,
                    "count": local_count,
                    "last_at": now_server,
                    "last_command_id": command_id,
                }
            }

        config_created = existing_cmd.get("created_epoch")
        try:
            fresh_config = bool(config_created and 0 <= time.time() - int(config_created) <= 120)
        except (TypeError, ValueError):
            fresh_config = False
        allow_settings_sync = (
            same_session
            and fresh_config
            and req_action == "config"
            and status == "done"
            and final_reason == "config_updated"
        )

        settings_sync: Dict[str, Any] = {}
        if "tele_int_ms" in sys_obj and 10000 <= int(sys_obj["tele_int_ms"]) <= 3600000:
            settings_sync["telemetry_interval_ms"] = int(sys_obj["tele_int_ms"])
        if "soil_dry" in sys_obj and 100 <= int(sys_obj["soil_dry"]) <= 4080:
            settings_sync["soil_raw_dry"] = int(sys_obj["soil_dry"])
        if "soil_wet" in sys_obj and 100 <= int(sys_obj["soil_wet"]) <= 4080:
            settings_sync["soil_raw_wet"] = int(sys_obj["soil_wet"])
        previous_report = (current_dev or {}).get("reported_config") or {}
        try:
            previous_epoch = int(previous_report.get("command_created_epoch") or 0)
            current_epoch = int(config_created or 0)
        except (TypeError, ValueError):
            previous_epoch, current_epoch = 0, 0
        if (
            settings_sync
            and allow_settings_sync
            and (current_epoch >= previous_epoch or previous_report.get("command_id") == command_id)
        ):
            dev_updates["reported_config"] = {
                **settings_sync,
                "command_id": command_id,
                "command_created_epoch": current_epoch,
                "confirmed_at": now_server,
                "boot_id": ack_boot,
                "session_seq": ack_sess,
            }

        if (req_action == "ota" or action == "ota") and same_session and not is_out_of_order_regression:
            cur_ota_status = (current_dev or {}).get("ota_status") or {}
            active_ota_cmd_id = str(cur_ota_status.get("last_command_id") or "").strip()
            other_ota_active = bool(
                active_ota_cmd_id
                and active_ota_cmd_id != command_id
                and (cur_ota_status.get("in_progress") is True or cur_ota_status.get("awaiting_reboot") is True)
            )
            if other_ota_active:
                _log(
                    "WARN",
                    "ota_status_update_skipped_other_active",
                    incoming_ota_cmd_id=command_id,
                    active_ota_cmd_id=active_ota_cmd_id,
                )
            else:
                in_prog = status in ("received", "started")
                awaiting_boot = status == "done" and final_reason != "ota_same_version"
                ota_state: Dict[str, Any] = {
                    "last_command_id": command_id,
                    "in_progress": in_prog,
                    "awaiting_reboot": awaiting_boot,
                    "status": (
                        "rolled_back"
                        if final_reason == "ota_rollback"
                        else ("rebooting" if awaiting_boot else status)
                    ),
                    "updated_at": now_server,
                }
                if ack_boot and status in ("received", "started", "done"):
                    ota_state["origin_boot_id"] = ack_boot
                if final_reason:
                    ota_state["reason"] = final_reason
                if error_value:
                    ota_state["error"] = error_value
                if ota_target_ver:
                    ota_state["target_version"] = str(ota_target_ver)
                if status == "done":
                    ota_state["flashed_at"] = now_server
                dev_updates["ota_status"] = ota_state
                demo_view_updates["ota_status"] = _sanitize_ota_for_demo_view(ota_state, now_server)

        elif (
            status == "started"
            and action == "on"
            and req_action == "on"
            and same_session
            and not is_out_of_order_regression
        ):
            if current_active_cmd_id == command_id or (
                current_active_cmd_id is None
                and not existing_cmd.get("valve_reservation_schema")
                and state_data.get("valve_pending") is not True
            ):
                expected_ends_at = _compute_expected_ends_at(duration or req_duration)
                started_state = {
                    "valve_open": True,
                    "valve_pending": False,
                    "reservation_expires_epoch": 0,
                    "confirmation_source": "controller_started_ack",
                    "execution_evidence": "controller_report",
                    "reconciled_command_id": None,
                    "valve_origin": cmd_origin,
                    "current_command_id": command_id,
                    "valve_started_at": now_server,
                    "valve_ends_at": expected_ends_at,
                }
                dev_updates["state"] = started_state
                demo_view_updates["state"] = started_state

        elif status in ("done", "failed") and not is_out_of_order_regression:
            is_explicit_stop_command = (req_action == "off")
            is_owner_of_current_lock = (current_active_cmd_id == command_id)

            can_stop_clear_lock = released_on_ref is not None
            if is_explicit_stop_command and status == "done" and not can_stop_clear_lock:
                if current_active_cmd_id is None:
                    can_stop_clear_lock = same_session
                elif (
                    interrupted_cmd_id
                    and interrupted_cmd_id == current_active_cmd_id
                    and state_data.get("valve_pending") is not True
                    and same_session
                ):
                    can_stop_clear_lock = True
                elif (
                    not interrupted_cmd_id
                    and state_data.get("valve_pending") is not True
                    and lock_reserved_epoch > 0
                    and cmd_created_epoch > lock_reserved_epoch
                    and same_session
                ):
                    can_stop_clear_lock = True

            if can_stop_clear_lock or (
                req_action == "on"
                and is_owner_of_current_lock
                and final_reason != "valve_already_open"
            ):
                closed_state = {
                    "valve_open": False,
                    "valve_pending": False,
                    "reservation_expires_epoch": 0,
                    "valve_origin": None,
                    "current_command_id": None,
                    "reserved_epoch": 0,
                    "valve_ends_at": now_server,
                    "confirmation_source": "controller_terminal_ack",
                    **({"reconciled_command_id": released_on_id} if released_on_id else {}),
                    "execution_evidence": evidence or "controller_report",
                }
                dev_updates["state"] = closed_state
                demo_view_updates["state"] = closed_state
            elif (
                req_action == "on"
                and action == "off"
                and state_data.get("confirmation_source") == "new_boot_safe_off"
                and state_data.get("execution_evidence") == "awaiting_terminal_ack"
                and state_data.get("reconciled_command_id") == command_id
                and state_data.get("valve_open") is False
                and current_active_cmd_id is None
                and lock_reserved_epoch == 0
            ):
                evidence_update = {
                    "execution_evidence": evidence or "controller_report",
                }
                dev_updates["state"] = evidence_update
                demo_view_updates["state"] = evidence_update

        if released_on_ref is not None:
            transaction.set(
                released_on_ref,
                {
                    "reservation_released_by_off_id": command_id,
                    "reservation_released_at": now_server,
                },
                merge=True,
            )
            cmd_update["released_pending_command_id"] = released_on_id

        if not writes_limited:
            transaction.set(cmd_ref, cmd_update, merge=True)
        transaction.set(device_ref, dev_updates, merge=True)

        if demo_view_snap.exists and demo_view_updates:
            demo_view_updates["updated_at"] = now_server
            transaction.set(demo_view_ref, demo_view_updates, merge=True)

        # v5.32.0 (E4): se a varredura já marcou "Sem confirmação", o ACK atrasado
        # SEMPRE regrava o histórico (senão um DESLIGAR atrasado ficaria "sem confirmação").
        skip_duplicate_stop_history = bool(
            not is_unregistered
            and existing_cmd.get("confirmation") != "timeout"
            and req_action == "off"
            and status == "done"
            and (interrupted_cmd_id or final_reason in ("manual_off", "manual_stop", "already_off"))
        )

        if schedule_confirmation and status == "started":
            timed_out = schedule_confirmation == "timeout"
            transaction.set(
                history_ref,
                {
                    "status": "unconfirmed" if timed_out else "started",
                    "message": (
                        "Início confirmado após o prazo; término ainda não confirmado."
                        if timed_out
                        else "Início da irrigação confirmado pelo controlador."
                    ),
                    "updated_at": now_server,
                },
                merge=True,
            )

        should_write_history = (
            not is_out_of_order_regression
            and not writes_limited
            and (
                (is_unregistered and status in ("received", "started", "done", "failed"))
                or (
                    not is_unregistered
                    and status in ("done", "failed")
                    and not skip_duplicate_stop_history
                )
                or (local_kind == "on" and status == "started")
            )
        )

        if should_write_history:
            if is_unregistered and status in ("received", "started"):
                message = f"{_UNREGISTERED_ALERT_PREFIX}execução iniciada pela estação"
            else:
                base_message = _build_history_message_simple(
                    result=result_calculated,
                    requested_action=req_action,
                    requested_duration=req_duration,
                    reason=final_reason,
                    error_value=error_value,
                    fw_version=str(ota_target_ver) if ota_target_ver else None,
                    config_meta=existing_cmd.get("config"),
                )
                message = (
                    f"{_UNREGISTERED_ALERT_PREFIX}{base_message}"
                    if is_unregistered
                    else base_message
                )

            local_severity: Optional[str] = None
            if local_kind:
                message, local_severity = _build_local_history_message(
                    kind=local_kind,
                    status=status,
                    result=result_calculated,
                    reason=final_reason,
                    requested_duration=req_duration,
                    final_duration=duration,
                )

            details: Dict[str, Any] = {
                "result": result_calculated,
                "final_status": status,
                "requested": {
                    "action": req_action,
                    "duration": req_duration,
                },
                "final": {
                    "action": action,
                    "duration": duration,
                },
                "reason": final_reason,
                "error": error_value,
                "interrupted_cmd_id": interrupted_cmd_id,
                "sys": sys_obj if sys_obj else None,
                "device_ts": ts_unix,
                "mqtt_topic": mqtt_topic,
                "evidence": evidence or "controller_report",
                "event_id": event_id,
            }
            if cmd_update.get("reason_raw"):
                details["reason_raw"] = cmd_update["reason_raw"]
            if is_unregistered:
                details["unregistered"] = True

            is_warning = str(final_reason or "").lower() in (
                "rain_interlock",
                "power_loss_reset",
                "power_unstable",
                "valve_guard_pending",
                "command_expired",
                "cancelled_by_off",
                "superseded_by_off",
                "rate_limited",
                "valve_already_open",
                "ota_valve_busy",
                "ota_same_version",
                "ota_power_loss",
                "ota_rollback",
                "button_stuck",
            )
            severity = (
                "warning"
                if is_warning
                else ("info" if result_calculated == "success" else "error")
            )

            history_doc: Dict[str, Any] = {
                "type": "command_execution",
                "source": cmd_origin,
                "device_id": device_id,
                "command_id": command_id,
                "message": message,
                "timestamp": now_server,
                "updated_at": now_server,
                "schema_version": 2,
                "event_name": "command.execution.finished",
                "event_code": "CMD_EXEC_FINISHED",
                "status": status,
                "result": result_calculated,
                "reason": final_reason,
                "mqtt_topic": mqtt_topic,
                "details": details,
                "evidence": evidence or "controller_report",
                "terminal_event_id": event_id,
                "ui_hint": {
                    "kind": "command",
                    "severity": severity,
                },
            }
            if is_unregistered:
                history_doc["type"] = "security_alert"
                history_doc["source"] = "unregistered"
                history_doc["event_code"] = "CMD_UNREGISTERED"
                history_doc["ui_hint"] = {
                    "kind": "security",
                    "severity": "warning",
                }
            if local_kind:
                details["local_kind"] = local_kind
                history_doc["type"] = "local_action"
                history_doc["source"] = "local_button"
                history_doc["event_name"] = "local.button.action"
                history_doc["event_code"] = "LOCAL_BUTTON"
                history_doc["local_kind"] = local_kind
                history_doc["ui_hint"] = {
                    "kind": "local",
                    "severity": local_severity or "info",
                }
            sched_meta = existing_cmd.get("schedule")
            if isinstance(sched_meta, dict):
                if sched_meta.get("id"):
                    history_doc["schedule_id"] = sched_meta["id"]
                if "label" in sched_meta:
                    history_doc["schedule_label"] = sched_meta["label"]
            if schedule_confirmation:
                history_doc["schedule_confirmation"] = "terminal"
                history_doc["schedule_confirmation_late"] = schedule_confirmation == "timeout"
            if error_value:
                history_doc["error"] = error_value

            transaction.set(history_ref, history_doc, merge=True)

        return (
            is_out_of_order_regression,
            is_terminal_conflict,
            result_calculated,
            final_reason,
        )

    tx = db.transaction()
    tx_res = _tx_unified(tx)
    if reconcile_audit:
        _log("INFO", "pending_off_reconcile_audit", **reconcile_audit)
    if unregistered_audit.get("local_rate_limited"):
        _log(
            "ERROR",
            "ack_local_events_rate_limited",
            command_id=unregistered_audit["command_id"],
            count=unregistered_audit["count"],
            limit=LOCAL_EVENT_MAX_PER_WINDOW,
            window_s=LOCAL_EVENT_WINDOW_S,
        )
    elif unregistered_audit:
        _log(
            "WARN",
            "ack_unregistered_command",
            command_id=unregistered_audit["command_id"],
            status=unregistered_audit["status"],
            action=unregistered_audit["action"],
            count=unregistered_audit["count"],
            limited=unregistered_audit["limited"],
        )
        if unregistered_audit.get("rate_limit_just_exceeded"):
            _log(
                "ERROR",
                "ack_unregistered_rate_limited",
                command_id=unregistered_audit["command_id"],
                status=unregistered_audit["status"],
                action=unregistered_audit["action"],
                count=unregistered_audit["count"],
                limit=UNREGISTERED_ACK_MAX_PER_WINDOW,
                window_s=UNREGISTERED_ACK_WINDOW_S,
                window_start_epoch=unregistered_audit["window_start_epoch"],
            )
    return tx_res


def _is_contention_error(exc: BaseException) -> bool:
    """ACK-01: erro de disputa de transação do Firestore (Aborted/Conflict, HTTP 409)."""
    if type(exc).__name__ in ("Aborted", "Conflict"):
        return True
    code = getattr(exc, "code", None)
    if getattr(code, "value", code) == 409:
        return True
    return "contention" in str(exc).lower()


def _process_ack_with_contention_retry(**kwargs: Any):
    """ACK-01: repete a transação inteira só em disputa (409), com espera curta e aleatória."""
    attempt = 0
    while True:
        try:
            return _process_ack_unified_transaction(**kwargs)
        except Exception as exc:
            if not _is_contention_error(exc) or attempt >= ACK_TX_CONTENTION_RETRIES:
                raise
            delay = min(1.0, 0.12 * (2 ** attempt)) * (0.5 + random.random())
            attempt += 1
            _log("WARN", "ack_tx_contention_retry", attempt=attempt, delay_ms=int(delay * 1000),
                 error_type=type(exc).__name__)
            time.sleep(delay)


def lambda_handler(event: Any, context: Any) -> Dict[str, Any]:
    request_id = getattr(context, "aws_request_id", "n/a")
    _current_request_id.set(request_id)
    _request_start_ns.set(time.perf_counter_ns())
    _current_device_id.set(None)
    _current_command_id.set(None)

    device_id, mqtt_topic, origin_err = _extract_trusted_ack_origin(event)
    if origin_err or not device_id or not mqtt_topic:
        _log(
            "ERROR",
            "ack_untrusted_origin_blocked",
            reason=origin_err or "invalid_origin",
            mqtt_topic=mqtt_topic,
            event_keys=sorted(event.keys())[:20] if isinstance(event, dict) else [],
        )
        return {"ok": False, "error": origin_err or "invalid_origin"}

    ack = event
    command_id = str(_safe_get(ack, "command_id", "")).strip()
    status = _normalize_status(_safe_get(ack, "status", ""))

    if not command_id or not status or len(command_id) > 120 or "/" in command_id:
        _log(
            "ERROR",
            "missing_or_invalid_fields",
            mqtt_topic=mqtt_topic,
            has_command_id=bool(command_id),
            has_status=bool(status),
            event_keys=sorted(ack.keys())[:20],
        )
        return {"ok": False, "error": "missing_or_invalid_fields"}

    # v5.33.0: eventos dos botões físicos. Qualquer outro "loc-" é recusado sem gravar.
    local_kind = _local_event_kind(command_id)
    if command_id[:4].lower() == "loc-" and local_kind is None:
        _log("WARN", "local_event_id_rejected", mqtt_topic=mqtt_topic, command_id_prefix=command_id[:24])
        return {"ok": False, "error": "invalid_local_event_id"}

    event_id = str(ack.get("event_id") or "") or None
    protocol = ack.get("ack_protocol")
    if protocol is not None or event_id is not None:
        if (
            protocol != 1
            or not event_id
            or not re.fullmatch(r"[0-9a-fA-F]{32}", event_id)
            or status not in _TERMINAL_STATES
        ):
            _log(
                "WARN",
                "invalid_durable_ack_rejected",
                mqtt_topic=mqtt_topic,
                status=status,
                has_event_id=bool(event_id),
            )
            return {"ok": False, "error": "invalid_durable_ack"}
    fingerprint = _event_fingerprint(ack) if event_id else None
    evidence = str(ack.get("evidence") or "controller_report")

    _current_device_id.set(device_id)
    _current_command_id.set(command_id)

    action = _normalize_action(_safe_get(ack, "action"))
    duration = _normalize_int(_safe_get(ack, "duration"))
    if local_kind is not None and action not in _LOCAL_KIND_ALLOWED_ACTIONS[local_kind]:
        _log("WARN", "local_event_action_rejected", local_kind=local_kind, action=action)
        return {"ok": False, "error": "invalid_local_event_action"}
    ts_unix = _safe_get(ack, "ts")
    ok_value = _safe_get(ack, "ok")
    reason_in = _safe_get(ack, "reason")
    error_value = _safe_get(ack, "error")
    interrupted_cmd_id = str(_safe_get(ack, "interrupted_cmd_id", "") or "").strip() or None

    raw_sys_obj = _safe_get(ack, "sys", {}) or {}
    sys_obj = _sanitize_sys(raw_sys_obj)

    db = _get_firestore()
    if db is None:
        _log("ERROR", "firestore_unavailable_ack_failed")
        raise RuntimeError("Firestore indisponível para persistir ACK.")

    t0_tx = time.perf_counter()
    (
        is_out_of_order_regression,
        is_terminal_conflict,
        result_calculated,
        final_reason,
    ) = _process_ack_with_contention_retry(
        db=db,
        device_id=device_id,
        command_id=command_id,
        status=status,
        action=action,
        duration=duration,
        ts_unix=ts_unix,
        ok_value=ok_value,
        reason_in=reason_in,
        error_value=error_value,
        interrupted_cmd_id=interrupted_cmd_id,
        sys_obj=sys_obj,
        mqtt_topic=mqtt_topic,
        event_id=event_id,
        event_fingerprint=fingerprint,
        evidence=evidence,
        local_kind=local_kind,
    )
    if event_id:
        _receipt(
            device_id,
            command_id,
            event_id,
            "conflict_recorded"
            if is_terminal_conflict
            else ("duplicate" if is_out_of_order_regression else "committed"),
        )
    tx_ms = round((time.perf_counter() - t0_tx) * 1000.0, 2)

    _log(
        "INFO",
        "ack_processed_unified_tx",
        status=status,
        action=action,
        result=result_calculated,
        reason=final_reason,
        interrupted_cmd_id=interrupted_cmd_id,
        device_fw=sys_obj.get("fw"),
        device_part=sys_obj.get("part"),
        tele_int_ms=sys_obj.get("tele_int_ms"),
        out_of_order_ignored=is_out_of_order_regression,
        terminal_conflict_ignored=is_terminal_conflict,
        tx_latency_ms=tx_ms,
    )

    return {
        "ok": True,
        "device_id": device_id,
        "command_id": command_id,
        "status": status,
        "out_of_order_ignored": is_out_of_order_regression,
        "terminal_conflict_ignored": is_terminal_conflict,
        "mqtt_topic": mqtt_topic,
        "request_id": request_id,
        "at": _utc_now_iso(),
    }


# =====================================================================================
# Aquecimento (EventBridge Scheduler a cada 5 min) — 2026-11-23
# So reage a {"agrosmart_warmup": true} no NIVEL MAIS ALTO do evento. Eventos do API
# Gateway trazem o corpo como texto em "body": a internet nao chega aqui, e este caminho
# nao executa comando nenhum (so devolve {"warmup": "ok"}).
# Tambem deixa pronto o cliente do Firestore, a parte mais lenta do inicio a frio.
# =====================================================================================
import time as _agrosmart_time

def _agrosmart_fanout(context):
    """v5.31.0: aquece uma SEGUNDA instancia. O DESLIGAR gera 2 ACKs simultaneos; com so
    uma instancia quente, o 2o caia numa fria (~2 s a mais). Enquanto ESTA instancia esta
    ocupada, chamamos a propria funcao (sem "fanout": nao ha recursao), entao a AWS usa
    outra instancia e a deixa pronta. Nunca falha o aquecimento."""
    _t0 = _agrosmart_time.perf_counter()
    try:
        import json as _js
        import boto3 as _b3
        from botocore.config import Config as _Cfg
        _cli = _b3.client("lambda", config=_Cfg(connect_timeout=3, read_timeout=20,
                                                 retries={"max_attempts": 0}))
        _r = _cli.invoke(FunctionName=context.invoked_function_arn, InvocationType="RequestResponse",
                         Payload=_js.dumps({"agrosmart_warmup": True}).encode())
        _ok = _r.get("StatusCode") == 200 and not _r.get("FunctionError")
        return {"ok": 1 if _ok else 0, "ms": int((_agrosmart_time.perf_counter() - _t0) * 1000)}
    except Exception as _e:  # nunca falha o aquecimento
        return {"ok": 0, "erro": type(_e).__name__,
                "ms": int((_agrosmart_time.perf_counter() - _t0) * 1000)}


_agrosmart_handler_original = lambda_handler


def lambda_handler(event, context):  # noqa: F811
    if isinstance(event, dict) and event.get("agrosmart_warmup") is True:
        _t0 = _agrosmart_time.perf_counter()
        _estado = "ausente"
        for _nome in ("_get_firestore", "_get_firestore_client", "get_firestore_client", "_get_db"):
            _fn = globals().get(_nome)
            if callable(_fn):
                try:
                    _estado = "ok" if _fn() is not None else "sem_cliente"
                except Exception as _e:  # nunca falha o aquecimento
                    _estado = "erro:" + type(_e).__name__
                break
        _resp = {"warmup": "ok", "firestore": _estado,
                 "ms": int((_agrosmart_time.perf_counter() - _t0) * 1000)}
        if event.get("fanout") == 2 and context is not None:
            _resp["fanout"] = _agrosmart_fanout(context)
        return _resp
    return _agrosmart_handler_original(event, context)
