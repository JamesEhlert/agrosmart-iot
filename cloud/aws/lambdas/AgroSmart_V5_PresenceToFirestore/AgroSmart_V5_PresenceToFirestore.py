"""
=====================================================================================
ARQUIVO: backend/LambdasFuncs/AgroSmart_V5_PresenceToFirestore/AgroSmart_V5_PresenceToFirestore.py
PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5)
RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1 & 3 — F1.2, F3.1, F3.3)
DATA DE CRIACAO: 2026-02-18 06:30
ULTIMA ATT: 2026-11-23T05:00:00Z (UTC)
VERSAO: v5.28.0 (Fase 3C: verificacao OTA so apos aprovacao real da particao)
=====================================================================================
PROPÓSITO ARQUITETURAL:
Função AWS Lambda acionada pela IoT Rule `AgroSmart_V5_PresenceToFirestore` sempre que
uma estação ESP32 publica no tópico MQTT `agrosmart/v5/+/presence`.

CHANGELOG v5.28.0 (2026-11-23) - Fase 3C, item 2:
- Le o campo `ota_pending_verify` da presenca (firmware >= 5.25.1).
- `birth` com a versao alvo e `ota_pending_verify=true` -> `ota_status.status="verifying"`
  (antes: `verified_online` imediato, durante os 90 s em que a placa ainda pode fazer rollback).
- Presenca seguinte do MESMO boot com `ota_pending_verify=false` -> `verified_online`.
- `birth` de outro boot com versao diferente durante `verifying` -> `rolled_back` (fluxo existente).
- Firmware sem o campo (< 5.25.1) mantem o comportamento anterior (verifica no `birth`).

CHANGELOG v5.27.0 (2026-11-21):
- F1.2 (Privacidade Demo): Espelha atualizações transacionais de presença, cura de
  válvula (`new_boot_safe_off`) e verificação pós-OTA para `devices/{id}/demo_view/current`
  (quando existente), omitindo `ip`, `boot_id`, `session_seq`, `device_epoch` e
  `verified_boot_id`.
- F3.1 (Confiança Estrita na Origem):
  * Aceita exclusivamente o envelope canônico da IoT Rule
    `AgroSmart_V5_PresenceToFirestore` (sem envelopes alternativos `message`/`payload`/`data`).
  * Exige `topic_device_id` na raiz do evento (e valida `mqtt_topic` contra
    `{IOT_TOPIC_PREFIX}/{device_id}/presence` quando presente), bloqueando divergências
    com `device_id` do payload.
- F3.3 (Higiene de Produção):
  * Alinha `LOG_LEVEL` default para `"INFO"` e remove instanciação ociosa de
    `boto3.client("secretsmanager")` em `_load_firebase_service_account()`.
=====================================================================================
"""

import base64
import contextvars
import datetime
import json
import os
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
from google.cloud import firestore
from google.oauth2 import service_account

AWS_REGION = os.getenv("AWS_REGION", "us-east-2")
IOT_TOPIC_PREFIX = os.getenv("IOT_TOPIC_PREFIX", "agrosmart/v5").strip().strip("/")
FIREBASE_SA_SECRET_ARN = (
    os.getenv("FIREBASE_SA_SECRET_ARN", "").strip()
    or os.getenv("GCP_SECRET_ARN", "").strip()
)
OTA_LOCK_TTL_SECONDS = int(os.getenv("OTA_LOCK_TTL_SECONDS", "300"))
COMMAND_TTL_SECONDS = int(os.getenv("COMMAND_TTL_SECONDS", "120"))
MAX_CLOCK_SKEW_SEC = int(os.getenv("MAX_CLOCK_SKEW_SEC", "120"))

_ALLOWED_STATES = {"online", "offline"}
_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
_PRESENCE_TOPIC_RE = re.compile(
    rf"^{re.escape(IOT_TOPIC_PREFIX)}/([A-Za-z0-9_.:-]{{1,120}})/presence$"
)

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").strip().upper()
_LOG_RANK = {"DEBUG": 10, "INFO": 20, "WARN": 30, "WARNING": 30, "ERROR": 40}

_current_request_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "request_id", default=None
)
_request_start_ns: contextvars.ContextVar[Optional[int]] = contextvars.ContextVar(
    "request_start_ns", default=None
)
_current_device_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "device_id", default=None
)

_DEFAULT_BOTO_CONFIG = BotoConfig(
    connect_timeout=5,
    read_timeout=5,
    retries={"max_attempts": 3, "mode": "standard"},
)

_firestore_client: Optional[firestore.Client] = None


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

    start_ns = _request_start_ns.get()
    elapsed_ms: Optional[float] = None
    if start_ns is not None:
        elapsed_ms = round((time.perf_counter_ns() - start_ns) / 1_000_000.0, 2)

    payload = {
        "level": lvl_upper,
        "component": "PresenceToFirestore",
        "fw_backend": "v5.28.0",
        "event_name": event_name,
        "elapsed_ms": elapsed_ms,
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **{k: v for k, v in fields.items() if v is not None},
    }
    print(json.dumps(payload, ensure_ascii=False, default=str))


def _load_firebase_service_account() -> Dict[str, Any]:
    if FIREBASE_SA_SECRET_ARN:
        resp = _agro_fetch_secret_or_ssm(FIREBASE_SA_SECRET_ARN, AWS_REGION, _DEFAULT_BOTO_CONFIG)
        if "SecretString" in resp and resp["SecretString"]:
            return json.loads(resp["SecretString"])
        if "SecretBinary" in resp and resp["SecretBinary"]:
            raw = base64.b64decode(resp["SecretBinary"]).decode("utf-8", errors="replace")
            return json.loads(raw)
        raise RuntimeError("AWS SSM Parameter Store retornou um segredo vazio.")

    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if sa_json:
        return json.loads(sa_json)

    raise RuntimeError("FIREBASE_SA_SECRET_ARN não configurado nas variáveis de ambiente da Lambda.")


def _get_firestore_client() -> firestore.Client:
    global _firestore_client
    if _firestore_client is not None:
        return _firestore_client

    sa_info = _load_firebase_service_account()
    creds = service_account.Credentials.from_service_account_info(sa_info)
    project_id = sa_info.get("project_id")
    _firestore_client = firestore.Client(credentials=creds, project=project_id)
    _log("INFO", "firestore_connect_ok", project_id=project_id)
    return _firestore_client


def _safe_get(d: Dict[str, Any], key: str, default: Any = None) -> Any:
    v = d.get(key, default)
    return v if v is not None else default


def _extract_trusted_presence_origin(event: Any) -> Tuple[Optional[str], Optional[str]]:
    """
    Valida estritamente o envelope canônico enviado pela IoT Rule
    `AgroSmart_V5_PresenceToFirestore` (F3.1):
      - Exige `event` como dicionário na raiz (sem wrappers alternativos);
      - Exige `topic_device_id` injetado pela rule via `topic(3)`;
      - Se `mqtt_topic` estiver presente, exige correspondência exata com
        `{IOT_TOPIC_PREFIX}/{topic_device_id}/presence`;
      - Se `device_id` estiver presente no payload, exige igualdade exata.
    Retorna `(device_id, error_code)`.
    """
    if not isinstance(event, dict):
        return None, "invalid_event_envelope"

    topic_dev_id = event.get("topic_device_id")
    if not isinstance(topic_dev_id, str) or not topic_dev_id.strip():
        return None, "missing_trusted_topic_device_id"
    topic_dev_id = topic_dev_id.strip()

    if not _DEVICE_ID_RE.fullmatch(topic_dev_id):
        return None, "invalid_device_id_format"

    mqtt_topic = event.get("mqtt_topic")
    if mqtt_topic is not None:
        if not isinstance(mqtt_topic, str) or not mqtt_topic.strip():
            return None, "invalid_mqtt_topic"
        clean_topic = mqtt_topic.strip().strip("/")
        m = _PRESENCE_TOPIC_RE.fullmatch(clean_topic)
        if not m or m.group(1) != topic_dev_id:
            return None, "mqtt_topic_mismatch"

    payload_dev_id = event.get("device_id")
    if payload_dev_id is not None:
        if not isinstance(payload_dev_id, str) or payload_dev_id.strip() != topic_dev_id:
            return None, "device_id_topic_mismatch"

    return topic_dev_id, None


def _normalize_presence(
    payload: Dict[str, Any], trusted_device_id: str
) -> Tuple[str, Dict[str, Any]]:
    state = str(_safe_get(payload, "state", "")).lower().strip()
    if not state or state not in _ALLOWED_STATES:
        raise ValueError(f"Estado de presença inválido: '{state}' (esperado 'online' ou 'offline')")

    kind = str(_safe_get(payload, "kind", "evt")).lower().strip()[:24] or "evt"

    fw = _safe_get(payload, "fw", None)
    part = _safe_get(payload, "part", None)
    ip = _safe_get(payload, "ip", None)
    boot_id = _safe_get(payload, "boot_id", None)
    boot_count = _safe_get(payload, "boot_count", None)
    session_seq = _safe_get(payload, "session_seq", None)
    reset_reason = _safe_get(payload, "reset_reason", None)
    uptime_ms = _safe_get(payload, "uptime_ms", None)
    epoch = _safe_get(payload, "epoch", None)
    # v5.28.0: so aceita booleano verdadeiro (nunca string/numero) para o sinal de observacao OTA
    pending_raw = payload.get("ota_pending_verify") if isinstance(payload, dict) else None
    ota_pending_verify = pending_raw if isinstance(pending_raw, bool) else None

    conn: Dict[str, Any] = {
        "state": state,
        "kind": kind,
        "fw": str(fw).strip()[:32] if fw is not None else None,
        "part": str(part).strip()[:16] if part is not None else None,
        "ip": str(ip).strip()[:45] if ip is not None else None,
        "boot_id": str(boot_id).strip()[:32] if boot_id is not None else None,
        "boot_count": int(boot_count) if isinstance(boot_count, (int, float)) and not isinstance(boot_count, bool) else None,
        "session_seq": int(session_seq) if isinstance(session_seq, (int, float)) and not isinstance(session_seq, bool) else None,
        "reset_reason": str(reset_reason).strip()[:32] if reset_reason is not None else None,
        "uptime_ms": int(uptime_ms) if isinstance(uptime_ms, (int, float)) and not isinstance(uptime_ms, bool) else None,
        "device_epoch": int(epoch) if isinstance(epoch, (int, float)) and not isinstance(epoch, bool) else None,
        "ota_pending_verify": ota_pending_verify,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }

    if state == "online":
        conn["lastConnectAt"] = firestore.SERVER_TIMESTAMP
    elif state == "offline":
        conn["lastDisconnectAt"] = firestore.SERVER_TIMESTAMP

    conn_filtered = {k: v for k, v in conn.items() if v is not None and v != ""}
    return trusted_device_id, conn_filtered


def _sanitize_connection_for_demo_view(conn: Dict[str, Any], now_server: Any) -> Dict[str, Any]:
    """
    Filtra apenas campos não sensíveis de `connection` para `demo_view/current` (F1.2):
    omite `ip`, `boot_id`, `session_seq`, `uptime_ms` e `device_epoch`.
    """
    safe: Dict[str, Any] = {"updatedAt": now_server}
    for k in ("state", "kind", "fw", "part", "boot_count", "reset_reason"):
        if conn.get(k) is not None:
            safe[k] = conn[k]
    return safe


def _is_incoming_presence_stale(
    prev_online: bool,
    prev_conn: Dict[str, Any],
    incoming_conn: Dict[str, Any],
    now_epoch: Optional[int] = None,
) -> Tuple[bool, str]:
    """
    Ordena eventos de presença estritamente por geração de boot (`boot_count` / `boot_id`)
    e geração de sessão MQTT (`session_seq`):
      - Se o evento recebido pertence a um `boot_count` menor, é descartado, EXCETO quando
        há evidência comprovada de reset de NVS na bancada (`state == "online"`,
        `kind in ("birth", "heartbeat")`, `boot_id` novo e `device_epoch` sincronizado com
        o servidor UTC e estritamente mais recente que `prev_conn.device_epoch`).
      - Se pertence ao mesmo `boot_id`:
        * Se `inc_sess_seq < prev_sess_seq`, é de uma sessão anterior -> descartado;
        * Se `inc_sess_seq == prev_sess_seq`:
          - Um `offline` (`lwt` / `ota_reboot`) é o encerramento legítimo dessa sessão -> ACEITO;
          - Um `online` (`heartbeat` / `birth`) que chegue DEPOIS que essa mesma sessão já foi
            encerrada (`prev_online == False`) não pode ressuscitar a sessão encerrada -> descartado.
    """
    inc_state = incoming_conn.get("state")
    inc_kind = incoming_conn.get("kind")

    prev_boot_id = str(prev_conn.get("boot_id") or "").strip()
    inc_boot_id = str(incoming_conn.get("boot_id") or "").strip()

    prev_boot_cnt = int(prev_conn.get("boot_count") or 0)
    inc_boot_cnt = int(incoming_conn.get("boot_count") or 0)

    prev_sess_seq = int(prev_conn.get("session_seq") or 0)
    inc_sess_seq = int(incoming_conn.get("session_seq") or 0)

    if inc_boot_cnt > 0 and prev_boot_cnt > 0 and inc_boot_cnt < prev_boot_cnt:
        now_ep = now_epoch if now_epoch is not None else int(time.time())
        inc_epoch = int(incoming_conn.get("device_epoch") or 0)
        prev_epoch = int(prev_conn.get("device_epoch") or 0)
        is_fresh_nvs_reset = (
            inc_state == "online"
            and inc_kind in ("birth", "heartbeat")
            and bool(inc_boot_id)
            and inc_boot_id != prev_boot_id
            and inc_epoch > 0
            and abs(now_ep - inc_epoch) <= MAX_CLOCK_SKEW_SEC
            and inc_epoch > prev_epoch
        )
        if is_fresh_nvs_reset:
            _log(
                "INFO",
                "boot_count_reset_accepted",
                prev_boot_count=prev_boot_cnt,
                new_boot_count=inc_boot_cnt,
                prev_boot_id=prev_boot_id,
                new_boot_id=inc_boot_id,
                device_epoch=inc_epoch,
            )
        else:
            return True, f"boot_count_older({inc_boot_cnt}<{prev_boot_cnt})"

    if prev_boot_id and inc_boot_id and prev_boot_id == inc_boot_id:
        if inc_sess_seq > 0 and prev_sess_seq > 0:
            if inc_sess_seq < prev_sess_seq:
                return True, f"session_seq_older({inc_sess_seq}<{prev_sess_seq})"
            if (
                inc_sess_seq == prev_sess_seq
                and inc_state == "online"
                and not prev_online
                and prev_conn.get("state") == "offline"
            ):
                return True, f"online_replay_for_closed_session({inc_sess_seq})"
            return False, ""

        prev_uptime = int(prev_conn.get("uptime_ms") or 0)
        inc_uptime = int(incoming_conn.get("uptime_ms") or 0)
        if inc_state == "offline" and inc_kind == "lwt" and prev_online and prev_conn.get("kind") == "birth":
            if inc_uptime > 0 and prev_uptime > 0 and inc_uptime < prev_uptime:
                return True, f"legacy_lwt_uptime_older({inc_uptime}<{prev_uptime})"

    return False, ""


def _apply_presence_and_ota_audit_transactional(
    db: firestore.Client,
    device_id: str,
    connection: Dict[str, Any],
) -> Tuple[Optional[str], bool]:
    now_server = firestore.SERVER_TIMESTAMP
    now_epoch = int(time.time())
    doc_ref = db.collection("devices").document(device_id)
    demo_view_ref = doc_ref.collection("demo_view").document("current")
    state = connection.get("state")
    kind = connection.get("kind")
    online_bool: Optional[bool] = (
        True if state == "online" else False if state == "offline" else None
    )

    @firestore.transactional
    def _tx_presence(transaction: firestore.Transaction) -> Tuple[Optional[str], bool]:
        snap = doc_ref.get(transaction=transaction)
        demo_view_snap = demo_view_ref.get(transaction=transaction)
        dev_data = snap.to_dict() if snap.exists else {}
        prev_online = bool((dev_data or {}).get("online") is True)
        prev_conn = (dev_data or {}).get("connection") or {}
        cur_state = (dev_data or {}).get("state") or {}

        is_stale, stale_reason = _is_incoming_presence_stale(
            prev_online=prev_online,
            prev_conn=prev_conn,
            incoming_conn=connection,
            now_epoch=now_epoch,
        )
        if is_stale:
            _log(
                "WARN",
                "stale_presence_ignored",
                reason=stale_reason,
                incoming_state=state,
                incoming_kind=kind,
                incoming_session_seq=connection.get("session_seq"),
                prev_session_seq=prev_conn.get("session_seq"),
            )
            return None, True

        # Leitura antecipada do comando pendente (se necessário) antes de qualquer escrita na transação
        pending_cmd_ref = None
        pending_cmd_data: Dict[str, Any] = {}
        cur_cmd_id = cur_state.get("current_command_id")
        if (
            state == "online"
            and kind == "birth"
            and cur_state.get("valve_pending") is True
            and isinstance(cur_cmd_id, str)
            and cur_cmd_id
        ):
            pending_cmd_ref = doc_ref.collection("commands").document(cur_cmd_id)
            pending_cmd_snap = pending_cmd_ref.get(transaction=transaction)
            if pending_cmd_snap.exists:
                pending_cmd_data = pending_cmd_snap.to_dict() or {}

        # Preserva lastConnectAt em heartbeats da mesma sessão já online
        conn_to_write = dict(connection)
        prev_boot_id = str(prev_conn.get("boot_id") or "").strip()
        new_boot_id = str(connection.get("boot_id") or "").strip()
        prev_sess_seq = int(prev_conn.get("session_seq") or 0)
        new_sess_seq = int(connection.get("session_seq") or 0)

        is_same_online_session_heartbeat = (
            state == "online"
            and kind == "heartbeat"
            and prev_online
            and bool(new_boot_id)
            and new_boot_id == prev_boot_id
            and (new_sess_seq == 0 or prev_sess_seq == 0 or new_sess_seq == prev_sess_seq)
        )
        if is_same_online_session_heartbeat and prev_conn.get("lastConnectAt") is not None:
            conn_to_write["lastConnectAt"] = prev_conn["lastConnectAt"]

        update_doc: Dict[str, Any] = {
            "connection": conn_to_write,
            "connection_state": state,
            "updated_at": now_server,
        }
        demo_view_updates: Dict[str, Any] = {
            "connection": _sanitize_connection_for_demo_view(conn_to_write, now_server),
            "connection_state": state,
            "updated_at": now_server,
        }
        if online_bool is not None:
            update_doc["online"] = online_bool
            demo_view_updates["online"] = online_bool
        if state == "online":
            update_doc["last_seen_at"] = now_server
            demo_view_updates["last_seen_at"] = now_server

        if state == "online" and kind == "birth":
            if new_boot_id and prev_boot_id and new_boot_id != prev_boot_id:
                if cur_state.get("valve_open") is True:
                    healed_state = {
                        "valve_open": False,
                        "valve_pending": False,
                        "reservation_expires_epoch": 0,
                        "valve_origin": None,
                        "current_command_id": None,
                        "reserved_epoch": 0,
                        "valve_ends_at": now_server,
                        "confirmation_source": "new_boot_safe_off",
                        "execution_evidence": "awaiting_terminal_ack",
                        "reconciled_command_id": cur_cmd_id,
                    }
                    update_doc["state"] = healed_state
                    demo_view_updates["state"] = healed_state
                    _log(
                        "INFO",
                        "stale_valve_healed_on_new_boot",
                        prev_boot_id=prev_boot_id,
                        new_boot_id=new_boot_id,
                        reconciled_command_id=cur_cmd_id,
                    )
                elif cur_state.get("valve_pending") is True:
                    reserved_ep = int(cur_state.get("reserved_epoch") or 0)
                    res_exp_ep = int(cur_state.get("reservation_expires_epoch") or 0)
                    on_exp_ep = int(
                        pending_cmd_data.get("on_expires_epoch")
                        or (reserved_ep + COMMAND_TTL_SECONDS if reserved_ep > 0 else 0)
                    )
                    if (on_exp_ep > 0 and now_epoch > on_exp_ep) or (res_exp_ep > 0 and now_epoch > res_exp_ep):
                        healed_pending_state = {
                            "valve_open": False,
                            "valve_pending": False,
                            "reservation_expires_epoch": 0,
                            "valve_origin": None,
                            "current_command_id": None,
                            "reserved_epoch": 0,
                            "valve_ends_at": now_server,
                            "confirmation_source": "new_boot_safe_off",
                            "execution_evidence": "awaiting_terminal_ack",
                            "reconciled_command_id": cur_cmd_id,
                        }
                        update_doc["state"] = healed_pending_state
                        demo_view_updates["state"] = healed_pending_state
                        if pending_cmd_ref is not None and pending_cmd_data:
                            transaction.set(
                                pending_cmd_ref,
                                {
                                    "reservation_released_by_off_id": "new_boot_safe_off",
                                    "reservation_released_at": now_server,
                                },
                                merge=True,
                            )
                        _log(
                            "INFO",
                            "expired_pending_valve_healed_on_new_boot",
                            prev_boot_id=prev_boot_id,
                            new_boot_id=new_boot_id,
                            reconciled_command_id=cur_cmd_id,
                        )

        ota_result_status: Optional[str] = None
        reported_fw = str(connection.get("fw") or "").strip().lstrip("vV")

        # Avalia pós-OTA estritamente em eventos 'birth' (nunca em 'heartbeat' pré-reboot)
        if state == "online" and kind == "birth" and reported_fw and snap.exists:
            ota_status = (dev_data or {}).get("ota_status") or {}
            awaiting = bool(ota_status.get("awaiting_reboot") is True)
            in_prog = bool(ota_status.get("in_progress") is True)
            status_cur = str(ota_status.get("status") or "").lower()
            target_ver = str(ota_status.get("target_version") or "").strip().lstrip("vV")
            prev_ver = str(ota_status.get("previous_version") or "").strip().lstrip("vV")
            ota_origin_boot_id = str(ota_status.get("origin_boot_id") or "").strip()
            cmd_id = str(ota_status.get("last_command_id") or "ota-boot")
            expires_ep = int(ota_status.get("expires_epoch") or 0)
            started_ep = int(ota_status.get("started_epoch") or 0)
            deadline_ep = expires_ep if expires_ep > 0 else (started_ep + OTA_LOCK_TTL_SECONDS)

            should_evaluate_ota = bool(
                target_ver
                and (
                    awaiting
                    or status_cur == "rebooting"
                    or status_cur == "verifying"
                    or (status_cur == "started" and in_prog and now_epoch <= deadline_ep)
                )
            )

            if should_evaluate_ota:
                history_ref = doc_ref.collection("history").document(f"ota-boot-{cmd_id}")
                if reported_fw == target_ver and connection.get("ota_pending_verify") is True:
                    # v5.28.0: firmware novo subiu, mas a particao ainda esta em observacao (reversivel)
                    transaction.set(
                        history_ref,
                        {
                            "type": "ota_verification",
                            "source": "system",
                            "device_id": device_id,
                            "command_id": cmd_id,
                            "status": "started",
                            "result": "pending",
                            "reason": "ota_observing",
                            "message": f"Firmware v{reported_fw} iniciou; observacao de estabilidade em andamento",
                            "timestamp": now_server,
                            "updated_at": now_server,
                            "details": {
                                "fw": reported_fw,
                                "part": connection.get("part"),
                                "previous_fw": prev_ver,
                                "boot_id": connection.get("boot_id"),
                                "boot_count": connection.get("boot_count"),
                                "reset_reason": connection.get("reset_reason"),
                            },
                        },
                        merge=True,
                    )
                    update_doc["ota_status"] = {
                        "in_progress": False,
                        "awaiting_reboot": False,
                        "status": "verifying",
                        "reason": "ota_observing",
                        "verifying_fw": reported_fw,
                        "verifying_boot_id": connection.get("boot_id"),
                        "verifying_since": now_server,
                        "updated_at": now_server,
                    }
                    demo_view_updates["ota_status"] = {
                        "in_progress": False,
                        "awaiting_reboot": False,
                        "status": "verifying",
                        "reason": "ota_observing",
                        "verifying_fw": reported_fw,
                        "updated_at": now_server,
                    }
                    ota_result_status = "verifying"
                elif reported_fw == target_ver:
                    msg = f"Boot confirmado no novo firmware v{reported_fw} (Self-Test aprovado)"
                    transaction.set(
                        history_ref,
                        {
                            "type": "ota_verification",
                            "source": "system",
                            "device_id": device_id,
                            "command_id": cmd_id,
                            "status": "done",
                            "result": "success",
                            "reason": "ota_updated",
                            "message": msg,
                            "timestamp": now_server,
                            "updated_at": now_server,
                            "details": {
                                "fw": reported_fw,
                                "part": connection.get("part"),
                                "previous_fw": prev_ver,
                                "boot_id": connection.get("boot_id"),
                                "boot_count": connection.get("boot_count"),
                                "reset_reason": connection.get("reset_reason"),
                            },
                        },
                        merge=True,
                    )
                    update_doc["ota_status"] = {
                        "in_progress": False,
                        "awaiting_reboot": False,
                        "status": "verified_online",
                        "reason": "ota_updated",
                        "verified_fw": reported_fw,
                        "verified_boot_id": connection.get("boot_id"),
                        "verified_at": now_server,
                        "updated_at": now_server,
                    }
                    demo_view_updates["ota_status"] = {
                        "in_progress": False,
                        "awaiting_reboot": False,
                        "status": "verified_online",
                        "reason": "ota_updated",
                        "verified_fw": reported_fw,
                        "updated_at": now_server,
                    }
                    ota_result_status = "verified_online"
                else:
                    # Proteção contra falso rollback (OTA-1): reconexão MQTT no mesmo boot
                    is_same_boot_reconnect = bool(
                        new_boot_id
                        and (
                            (ota_origin_boot_id and new_boot_id == ota_origin_boot_id)
                            or (prev_boot_id and new_boot_id == prev_boot_id)
                        )
                    )
                    if is_same_boot_reconnect:
                        _log(
                            "INFO",
                            "ota_birth_same_boot_skipped_evaluation",
                            command_id=cmd_id,
                            boot_id=new_boot_id,
                            session_seq=new_sess_seq,
                            reported_fw=reported_fw,
                            target_fw=target_ver,
                            ota_status_cur=status_cur,
                        )
                    else:
                        msg = (
                            f"Alerta de Auto-Rollback: a estação reiniciou na versão v{reported_fw} "
                            f"(falha ao validar v{target_ver})"
                        )
                        transaction.set(
                            history_ref,
                            {
                                "type": "error",
                                "source": "system",
                                "device_id": device_id,
                                "command_id": cmd_id,
                                "status": "failed",
                                "result": "failed",
                                "reason": "ota_rollback",
                                "message": msg,
                                "timestamp": now_server,
                                "updated_at": now_server,
                                "details": {
                                    "fw_after_boot": reported_fw,
                                    "part": connection.get("part"),
                                    "failed_target_fw": target_ver,
                                    "boot_id": connection.get("boot_id"),
                                    "reset_reason": connection.get("reset_reason"),
                                },
                            },
                            merge=True,
                        )
                        update_doc["ota_status"] = {
                            "in_progress": False,
                            "awaiting_reboot": False,
                            "status": "rolled_back",
                            "reason": "ota_rollback",
                            "verified_fw": reported_fw,
                            "updated_at": now_server,
                        }
                        demo_view_updates["ota_status"] = {
                            "in_progress": False,
                            "awaiting_reboot": False,
                            "status": "rolled_back",
                            "reason": "ota_rollback",
                            "verified_fw": reported_fw,
                            "updated_at": now_server,
                        }
                        ota_result_status = "rolled_back"

        # v5.28.0: promocao "verifying" -> "verified_online" quando o MESMO boot avisa que a
        # particao foi aprovada (presenca nao-birth com ota_pending_verify=false).
        elif (
            state == "online"
            and kind != "birth"
            and reported_fw
            and snap.exists
            and connection.get("ota_pending_verify") is False
        ):
            ota_status = (dev_data or {}).get("ota_status") or {}
            status_cur = str(ota_status.get("status") or "").lower()
            target_ver = str(ota_status.get("target_version") or "").strip().lstrip("vV")
            prev_ver = str(ota_status.get("previous_version") or "").strip().lstrip("vV")
            verifying_boot = str(ota_status.get("verifying_boot_id") or "").strip()
            cmd_id = str(ota_status.get("last_command_id") or "ota-boot")
            if (
                target_ver
                and reported_fw == target_ver
                and status_cur not in ("verified_online", "rolled_back", "failed")
                and (status_cur == "verifying" or bool(verifying_boot))
                and (not verifying_boot or verifying_boot == new_boot_id)
            ):
                history_ref = doc_ref.collection("history").document(f"ota-boot-{cmd_id}")
                msg = (
                    f"Boot confirmado no novo firmware v{reported_fw} "
                    f"(Self-Test aprovado apos observacao de estabilidade)"
                )
                transaction.set(
                    history_ref,
                    {
                        "type": "ota_verification",
                        "source": "system",
                        "device_id": device_id,
                        "command_id": cmd_id,
                        "status": "done",
                        "result": "success",
                        "reason": "ota_updated",
                        "message": msg,
                        "timestamp": now_server,
                        "updated_at": now_server,
                        "details": {
                            "fw": reported_fw,
                            "part": connection.get("part"),
                            "previous_fw": prev_ver,
                            "boot_id": connection.get("boot_id"),
                            "boot_count": connection.get("boot_count"),
                            "uptime_ms": connection.get("uptime_ms"),
                        },
                    },
                    merge=True,
                )
                update_doc["ota_status"] = {
                    "in_progress": False,
                    "awaiting_reboot": False,
                    "status": "verified_online",
                    "reason": "ota_updated",
                    "verified_fw": reported_fw,
                    "verified_boot_id": connection.get("boot_id"),
                    "verified_at": now_server,
                    "updated_at": now_server,
                }
                demo_view_updates["ota_status"] = {
                    "in_progress": False,
                    "awaiting_reboot": False,
                    "status": "verified_online",
                    "reason": "ota_updated",
                    "verified_fw": reported_fw,
                    "updated_at": now_server,
                }
                ota_result_status = "verified_online"

        transaction.set(doc_ref, update_doc, merge=True)
        if demo_view_snap.exists:
            transaction.set(demo_view_ref, demo_view_updates, merge=True)
        return ota_result_status, False

    tx = db.transaction()
    return _tx_presence(tx)


def lambda_handler(event: Any, context: Any) -> Dict[str, Any]:
    request_id = getattr(context, "aws_request_id", "n/a")
    _current_request_id.set(request_id)
    _request_start_ns.set(time.perf_counter_ns())
    _current_device_id.set(None)

    try:
        trusted_device_id, origin_err = _extract_trusted_presence_origin(event)
        if origin_err or not trusted_device_id:
            _log(
                "ERROR",
                "presence_untrusted_origin_blocked",
                reason=origin_err or "invalid_origin",
                event_keys=sorted(event.keys())[:20] if isinstance(event, dict) else [],
            )
            return {"ok": False, "error": origin_err or "invalid_origin"}

        _current_device_id.set(trusted_device_id)

        try:
            device_id, connection = _normalize_presence(event, trusted_device_id)
        except ValueError as val_err:
            _log("ERROR", "presence_validation_failed", error=str(val_err))
            return {"ok": False, "error": str(val_err)}

        state = connection.get("state")
        if not state:
            _log("WARN", "presence_missing_state")
            return {"ok": False, "error": "missing_state"}

        db = _get_firestore_client()
        t0_tx = time.perf_counter()
        ota_post_boot_status, stale_ignored = _apply_presence_and_ota_audit_transactional(
            db=db,
            device_id=device_id,
            connection=connection,
        )
        tx_ms = round((time.perf_counter() - t0_tx) * 1000.0, 2)

        _log(
            "INFO",
            "presence_updated_transactional",
            state=state,
            kind=connection.get("kind"),
            fw=connection.get("fw"),
            part=connection.get("part"),
            boot_count=connection.get("boot_count"),
            session_seq=connection.get("session_seq"),
            stale_presence_ignored=stale_ignored,
            ota_post_boot_status=ota_post_boot_status,
            tx_latency_ms=tx_ms,
        )

        return {
            "ok": True,
            "device_id": device_id,
            "state": state,
            "kind": connection.get("kind"),
            "fw": connection.get("fw"),
            "part": connection.get("part"),
            "stale_presence_ignored": stale_ignored,
            "ota_verification": ota_post_boot_status,
            "request_id": request_id,
        }

    except Exception as e:
        _log("ERROR", "presence_handler_failed", error_type=type(e).__name__, error=str(e))
        raise