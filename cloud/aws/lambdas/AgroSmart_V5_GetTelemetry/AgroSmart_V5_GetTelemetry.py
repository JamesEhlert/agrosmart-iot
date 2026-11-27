"""
=====================================================================================
ARQUIVO: backend/LambdasFuncs/AgroSmart_V5_GetTelemetry/AgroSmart_V5_GetTelemetry.py
PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5)
RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1 & 3 — F1.1, F1.5, F3.3, F3.4)
DATA DE CRIACAO: 2026-02-18 06:45
ULTIMA ATT: 2026-11-21T02:05:00Z (UTC)
VERSAO: v5.27.0 (private/demo_auth + Revogacao Imediata Demo + TOKEN_SECRET Fail-Closed)
=====================================================================================
PROPÓSITO ARQUITETURAL:
Função AWS Lambda acionada pelo Amazon API Gateway (`GET /telemetry`) para consultar
séries temporais de telemetria armazenadas na tabela `AgroTelemetryData_V5` do Amazon
DynamoDB, com validação estrita de propriedade Multi-Tenant (`owner_uid`) ou sessão
temporária Zero-Credential (`demo_sid` e `demo_device_id`) via `private/demo_auth`.

CHANGELOG v5.27.0 (2026-11-21):
- F1.1 & F1.5: Valida sessão Demo exclusivamente contra `devices/{id}/private/demo_auth`
  com corte inclusivo (`now_epoch >= demo_exp`) e cache demo desativado por padrão
  (`DEMO_OWNERSHIP_CACHE_TTL_SEC = 0`) para revogação imediata. Remove `shared_uids`
  e fallback legado `ALLOW_LEGACY_DEMO_AUTH`.
- F3.3: Exige `TOKEN_SECRET` dedicado (env var ou parâmetro SSM `/...`) em modo
  fail-closed, eliminando o reuso inseguro da chave privada RSA do Google e a chave
  efêmera em RAM. Remove cliente ocioso de `secretsmanager`.
- F3.4: Omite `Access-Control-Allow-Origin` quando `Origin` não está na allowlist.
=====================================================================================
"""

from __future__ import annotations

import base64
import contextvars
import datetime
import hashlib
import hmac
import json
import math
import os
import re
import time
from decimal import Decimal
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


from boto3.dynamodb.conditions import Key
from botocore.config import Config as BotoConfig

# =====================================================================================
# CONTEXTVARS E LOG ESTRUTURADO JSON COM CRONÓMETRO DE EXECUÇÃO (ELAPSED_MS)
# =====================================================================================
_current_request_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "request_id", default=None
)
_request_start_ns: contextvars.ContextVar[Optional[int]] = contextvars.ContextVar(
    "request_start_ns", default=None
)
_current_user_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "user_id", default=None
)
_current_device_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "device_id", default=None
)

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").strip().upper()
_LOG_RANK = {"DEBUG": 10, "INFO": 20, "WARN": 30, "WARNING": 30, "ERROR": 40}


def _log(level: str, event_name: str, **fields: Any) -> None:
    """
    Emite log estruturado em JSON no CloudWatch com `request_id`, `user_id`,
    `device_id` e `elapsed_ms` injetados automaticamente via `contextvars`.
    """
    lvl_upper = level.upper()
    if _LOG_RANK.get(lvl_upper, 20) < _LOG_RANK.get(LOG_LEVEL, 20):
        return

    rid = _current_request_id.get()
    if rid and "request_id" not in fields:
        fields["request_id"] = rid

    uid = _current_user_id.get()
    if uid and "user_id" not in fields:
        fields["user_id"] = uid

    did = _current_device_id.get()
    if did and "device_id" not in fields:
        fields["device_id"] = did

    start_ns = _request_start_ns.get()
    elapsed_ms: Optional[float] = None
    if start_ns is not None:
        elapsed_ms = round((time.perf_counter_ns() - start_ns) / 1_000_000.0, 2)

    payload = {
        "level": lvl_upper,
        "component": "GetTelemetry",
        "fw_backend": "v5.27.0",
        "event_name": event_name,
        "elapsed_ms": elapsed_ms,
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **{k: v for k, v in fields.items() if v is not None},
    }
    print(json.dumps(payload, ensure_ascii=False, default=str))


# =====================================================================================
# CONFIGURAÇÕES E CONSTANTES DE SEGURANÇA, PERFORMANCE E PAGINAÇÃO
# =====================================================================================
AWS_REGION = os.getenv("AWS_REGION", "us-east-2")
TABLE_NAME = os.getenv("DYNAMODB_TABLE", "AgroTelemetryData_V5")

REQUIRE_AUTH = os.getenv("REQUIRE_AUTH", "true").lower() == "true"
ENFORCE_DEVICE_OWNERSHIP = os.getenv("ENFORCE_DEVICE_OWNERSHIP", "true").lower() == "true"

MAX_LIMIT = int(os.getenv("MAX_LIMIT", "200"))
MAX_RANGE_LIMIT = int(os.getenv("MAX_RANGE_LIMIT", "3000"))
MAX_RAW_SCAN_ITEMS = int(os.getenv("MAX_RAW_SCAN_ITEMS", "3000"))
MAX_CHART_RAW_SCAN_ITEMS = int(os.getenv("MAX_CHART_RAW_SCAN_ITEMS", "6000"))
MAX_INTERNAL_DYNAMO_PAGES = int(os.getenv("MAX_INTERNAL_DYNAMO_PAGES", "6"))
MAX_TIME_WINDOW_SEC = int(os.getenv("MAX_TIME_WINDOW_SEC", str(90 * 86400)))

MAX_QUERY_TIME_SEC = float(os.getenv("MAX_QUERY_TIME_SEC", "2.5"))
SAFE_REMAINING_TIME_MS = int(os.getenv("SAFE_REMAINING_TIME_MS", "1800"))

OWNERSHIP_CACHE_TTL_SEC = int(os.getenv("OWNERSHIP_CACHE_TTL_SEC", "30"))
# Cache demo = 0s por padrão para garantir revogação imediata sincronizada com o Firestore
DEMO_OWNERSHIP_CACHE_TTL_SEC = int(os.getenv("DEMO_OWNERSHIP_CACHE_TTL_SEC", "0"))
FIRESTORE_INIT_RETRY_COOLDOWN_SEC = 15.0

MIN_DOWNSAMPLE_POINTS = 10
MAX_DOWNSAMPLE_POINTS = 1500

TOKEN_TTL_SEC = int(os.getenv("TOKEN_TTL_SEC", "3600"))

DEFAULT_ALLOWED_ORIGINS = (
    "https://agrosmart-v5.web.app,"
    "https://agrosmart-v5.firebaseapp.com,"
    "http://localhost:5173,"
    "http://127.0.0.1:5173"
)
ALLOWED_ORIGINS_RAW = os.getenv("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).strip()

DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")

_DEFAULT_BOTO_CONFIG = BotoConfig(
    connect_timeout=3,
    read_timeout=3,
    retries={"max_attempts": 2, "mode": "standard"},
)

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION, config=_DEFAULT_BOTO_CONFIG)
table = dynamodb.Table(TABLE_NAME)

try:
    import firebase_admin
    from firebase_admin import credentials, firestore

    FIREBASE_AVAILABLE = True
except ImportError:
    firebase_admin = None
    credentials = None
    firestore = None
    FIREBASE_AVAILABLE = False
    _log(
        "WARN",
        "firebase_layer_missing",
        message="Layer Firebase ausente. Ownership não pode ser verificado.",
    )

_firestore_client: Optional[Any] = None
_firestore_retry_after_mono: float = 0.0
_cached_sa_obj: Optional[Dict[str, Any]] = None

# Cache em memória para autorização de leitura do Operador Titular: {(device_id, user_uid): (True, expires_mono)}
_ownership_cache: Dict[Tuple[str, str], Tuple[bool, float]] = {}

_token_hmac_key_cache: Optional[bytes] = None


# =====================================================================================
# SERIALIZAÇÃO DECIMAL SEGURA E RESPOSTAS HTTP / CORS
# =====================================================================================
class DecimalEncoder(json.JSONEncoder):
    """Converte objetos `Decimal` do DynamoDB para `int` ou `float` nativos do JSON."""

    def default(self, obj: Any) -> Any:
        if isinstance(obj, Decimal):
            if obj.is_nan() or obj.is_infinite():
                return None
            return int(obj) if obj % 1 == 0 else float(obj)
        return super().default(obj)


def _get_headers(event: Dict[str, Any]) -> Dict[str, str]:
    """Normaliza os cabeçalhos HTTP do evento para chaves em letras minúsculas."""
    headers = (event or {}).get("headers", {}) if isinstance(event, dict) else {}
    if not isinstance(headers, dict):
        return {}
    return {
        k.lower(): v
        for k, v in headers.items()
        if isinstance(k, str) and isinstance(v, str)
    }


def _resolve_cors_origin(event: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """Resolve a origem permitida para CORS, omitindo o cabeçalho para origens não autorizadas (F3.4)."""
    if ALLOWED_ORIGINS_RAW == "*":
        return "*"
    allowed = [o.strip() for o in ALLOWED_ORIGINS_RAW.split(",") if o.strip()]
    if not allowed:
        return None
    if not event:
        return allowed[0]
    req_origin = _get_headers(event).get("origin", "").strip()
    if not req_origin:
        return allowed[0]
    if req_origin in allowed:
        return req_origin
    return None


def build_response(
    status_code: int, body: Dict[str, Any], event: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Constrói resposta HTTP padronizada mantendo compatibilidade total com Web."""
    if status_code >= 400 and isinstance(body, dict):
        if "error" in body and "message" not in body:
            body["message"] = body["error"]
        elif "message" in body and "error" not in body:
            body["error"] = body["message"]

    cors_origin = _resolve_cors_origin(event)
    headers_out: Dict[str, str] = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Vary": "Origin",
    }
    if cors_origin:
        headers_out["Access-Control-Allow-Origin"] = cors_origin

    return {
        "statusCode": status_code,
        "headers": headers_out,
        "body": json.dumps(body, cls=DecimalEncoder, ensure_ascii=False),
    }


def _get_http_method(event: Dict[str, Any]) -> str:
    """Extrai o método HTTP do evento do API Gateway (suporta v1 e v2)."""
    if isinstance(event, dict) and "httpMethod" in event:
        return (event.get("httpMethod") or "").upper()
    rc = event.get("requestContext", {}) if isinstance(event, dict) else {}
    http = (rc.get("http", {}) if isinstance(rc, dict) else {}) or {}
    return (http.get("method") or "").upper()


def _extract_auth_context(event: Dict[str, Any]) -> Dict[str, str]:
    """
    Extrai `user_uid`, `auth_mode`, `demo_sid`, `demo_device_id` e `is_demo` do
    contexto do Custom Authorizer.
    """
    out: Dict[str, str] = {
        "user_uid": "",
        "auth_mode": "firebase_jwt",
        "demo_sid": "",
        "demo_device_id": "",
        "is_demo": "false",
    }
    if not isinstance(event, dict):
        return out

    rc = event.get("requestContext", {}) or {}
    auth = rc.get("authorizer", {}) or {}
    if not isinstance(auth, dict):
        return out

    out["auth_mode"] = str(auth.get("auth_mode") or "firebase_jwt").strip()
    out["demo_sid"] = str(auth.get("demo_sid") or "").strip()
    out["demo_device_id"] = str(auth.get("demo_device_id") or "").strip()
    out["is_demo"] = "true" if str(auth.get("is_demo") or "").strip().lower() == "true" else "false"

    uid = auth.get("uid") or auth.get("user_id") or auth.get("sub") or auth.get("principalId")
    jwt = auth.get("jwt")
    if not uid and isinstance(jwt, dict):
        claims = jwt.get("claims", {}) or {}
        if isinstance(claims, dict):
            uid = claims.get("user_id") or claims.get("sub")

    if isinstance(uid, str) and uid.strip() and uid.strip() not in ("user", "demo-pass-claim"):
        clean_uid = uid.strip()
        out["user_uid"] = clean_uid
        _current_user_id.set(clean_uid)

    return out


# =====================================================================================
# FIRESTORE CLIENT, CHAVE HMAC SEGURA E VERIFICAÇÃO DE OWNERSHIP / DEMO VIEWER
# =====================================================================================
def _get_secret_arn() -> str:
    """Retorna o caminho SSM/ARN da Service Account do Firebase configurado no ambiente."""
    return (
        os.getenv("FIREBASE_SA_SECRET_ARN", "").strip()
        or os.getenv("GCP_SECRET_ARN", "").strip()
    )


def _load_service_account_json() -> Optional[Dict[str, Any]]:
    """Carrega e faz cache em memória do JSON da Service Account a partir do SSM."""
    global _cached_sa_obj
    if _cached_sa_obj is not None:
        return _cached_sa_obj

    secret_arn = _get_secret_arn()
    if not secret_arn:
        sa_raw = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
        if sa_raw:
            try:
                _cached_sa_obj = json.loads(sa_raw)
                return _cached_sa_obj
            except Exception as e:
                _log("ERROR", "firebase_sa_env_json_invalid", error=str(e))
        return None

    try:
        resp = _agro_fetch_secret_or_ssm(secret_arn, AWS_REGION, _DEFAULT_BOTO_CONFIG)
        if resp.get("SecretString"):
            _cached_sa_obj = json.loads(resp["SecretString"])
            return _cached_sa_obj
        if resp.get("SecretBinary"):
            decoded = base64.b64decode(resp["SecretBinary"]).decode("utf-8", errors="replace")
            _cached_sa_obj = json.loads(decoded)
            return _cached_sa_obj
    except Exception as e:
        _log("ERROR", "secret_fetch_failed", error=str(e))
        return None
    return None


def _get_token_hmac_key() -> bytes:
    """
    Obtém a chave criptográfica dedicada de 32 bytes para assinatura HMAC-SHA256 dos
    cursores de paginação (`next_token`) em modo fail-closed (F3.3).
    Suporta valor direto em `TOKEN_SECRET` ou caminho SSM iniciando por `/`.
    """
    global _token_hmac_key_cache
    if _token_hmac_key_cache is not None:
        return _token_hmac_key_cache

    env_secret = os.getenv("TOKEN_SECRET", "").strip()
    if env_secret.startswith("/"):
        resp = _agro_fetch_secret_or_ssm(env_secret, AWS_REGION, _DEFAULT_BOTO_CONFIG)
        secret_val = str(resp.get("SecretString") or "").strip()
        if len(secret_val) >= 16:
            _token_hmac_key_cache = hashlib.sha256(secret_val.encode("utf-8")).digest()
            return _token_hmac_key_cache
        raise RuntimeError("Parâmetro SSM de TOKEN_SECRET ausente ou curto demais.")

    if len(env_secret) >= 16:
        _token_hmac_key_cache = hashlib.sha256(env_secret.encode("utf-8")).digest()
        return _token_hmac_key_cache

    raise RuntimeError(
        "TOKEN_SECRET não configurado (mínimo 16 caracteres) para assinatura HMAC dos cursores."
    )


def _get_firestore() -> Optional[Any]:
    """
    Inicializa e retorna a instância Singleton do cliente Firestore, aplicando um
    cooldown temporizado de 15s em caso de falha transitória.
    """
    global _firestore_client, _firestore_retry_after_mono

    if not FIREBASE_AVAILABLE:
        return None
    if _firestore_client is not None:
        return _firestore_client

    now_mono = time.monotonic()
    if now_mono < _firestore_retry_after_mono:
        return None

    if getattr(firebase_admin, "_apps", None) and firebase_admin._apps:
        _firestore_client = firestore.client()
        return _firestore_client

    secret_arn = _get_secret_arn()
    sa_obj = _load_service_account_json()

    if secret_arn and not sa_obj:
        _firestore_retry_after_mono = now_mono + FIRESTORE_INIT_RETRY_COOLDOWN_SEC
        return None

    try:
        if sa_obj:
            cred = credentials.Certificate(sa_obj)
            firebase_admin.initialize_app(cred)
        else:
            firebase_admin.initialize_app()

        _firestore_client = firestore.client()
        _firestore_retry_after_mono = 0.0
        return _firestore_client

    except Exception as e:
        _log("ERROR", "firebase_init_failed", error=str(e))
        _firestore_retry_after_mono = now_mono + FIRESTORE_INIT_RETRY_COOLDOWN_SEC
        return None


def _assert_device_ownership(
    device_id: str,
    user_uid: str,
    caller_demo_sid: str = "",
    caller_demo_device_id: str = "",
    caller_is_demo_jwt: bool = False,
) -> bool:
    """
    Valida no Firestore se o usuário autenticado possui permissão de leitura da estação:
      - Operador Titular: `devices/{device_id}.owner_uid == user_uid` (cache 30s);
      - Sessão Demo: `devices/{device_id}/private/demo_auth` com `pass_claimed == True`,
        `now_epoch < expires_epoch` e `session_id == caller_demo_sid` (sem cache por padrão).
    """
    if not user_uid:
        return False

    db = _get_firestore()
    if db is None:
        return False

    now_mono = time.monotonic()

    # Caminho 1: Sessão Demo Zero-Credential (F1.1 + F1.5 — revogação imediata)
    if caller_is_demo_jwt:
        if not caller_demo_device_id or caller_demo_device_id != device_id or not caller_demo_sid:
            return False
        try:
            auth_doc = (
                db.collection("devices")
                .document(device_id)
                .collection("private")
                .document("demo_auth")
                .get()
            )
            if not auth_doc.exists:
                return False

            auth_data = auth_doc.to_dict() or {}
            now_epoch = int(time.time())
            try:
                demo_exp = int(auth_data.get("expires_epoch") or 0)
            except Exception:
                demo_exp = 0

            if demo_exp <= 0 or now_epoch >= demo_exp:
                _log(
                    "WARN",
                    "demo_viewer_pass_expired_or_revoked",
                    user_id=user_uid,
                    device_id=device_id,
                    demo_expires_epoch=demo_exp,
                )
                return False

            expected_sid = str(auth_data.get("session_id") or "").strip()
            is_claimed = bool(auth_data.get("pass_claimed") is True)
            if (
                not is_claimed
                or not expected_sid
                or not hmac.compare_digest(expected_sid, caller_demo_sid)
            ):
                _log(
                    "WARN",
                    "demo_viewer_session_id_mismatch",
                    user_id=user_uid,
                    device_id=device_id,
                    has_caller_sid=bool(caller_demo_sid),
                )
                return False

            _log(
                "INFO",
                "demo_viewer_telemetry_authorized",
                user_id=user_uid,
                device_id=device_id,
            )
            return True
        except Exception as e:
            _log("ERROR", "demo_ownership_check_error", error=str(e))
            return False

    # Caminho 2: Operador Titular (com cache positivo curto)
    cache_key = (device_id, user_uid)
    cached_entry = _ownership_cache.get(cache_key)
    if cached_entry is not None:
        is_allowed_cached, expires_at = cached_entry
        if now_mono < expires_at and is_allowed_cached:
            return True

    try:
        doc_snap = db.collection("devices").document(device_id).get()
        if not doc_snap.exists:
            _ownership_cache.pop(cache_key, None)
            return False

        data = doc_snap.to_dict() or {}
        owner = data.get("owner_uid") or data.get("ownerUid")
        is_owner = isinstance(owner, str) and owner == user_uid

        if is_owner:
            _ownership_cache[cache_key] = (True, now_mono + float(OWNERSHIP_CACHE_TTL_SEC))
        else:
            _ownership_cache.pop(cache_key, None)

        return is_owner

    except Exception as e:
        _log("ERROR", "ownership_check_error", error=str(e))
        return False


# =====================================================================================
# ASSINATURA E VERIFICAÇÃO ESTRITA HMAC-SHA256 DO TOKEN DE PAGINAÇÃO
# =====================================================================================
def _parse_int(value: Any, default: int) -> int:
    """Converte um parâmetro de entrada em inteiro rejeitando booleanos, NaN e decimais."""
    if value is None:
        return default
    if isinstance(value, bool):
        raise ValueError("invalid int (bool)")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError("decimal or non-finite not allowed")
        return int(value)
    if isinstance(value, str) and value.strip():
        f_val = float(value.strip())
        if not math.isfinite(f_val) or not f_val.is_integer():
            raise ValueError("decimal or non-finite not allowed")
        return int(f_val)
    return default


def _encode_next_token(
    last_evaluated_key: Dict[str, Any],
    device_id: str,
    user_uid: Optional[str] = None,
    start_ts: Optional[int] = None,
    end_ts: Optional[int] = None,
) -> str:
    """
    Empacota `LastEvaluatedKey` assinado com HMAC-SHA256 em Base64 URL-safe,
    vinculando o cursor ao dispositivo, ao usuário e à janela temporal da consulta.
    """
    hmac_key = _get_token_hmac_key()
    payload_obj = {
        "lek": last_evaluated_key,
        "d": device_id,
        "u": user_uid or "",
        "st": start_ts,
        "et": end_ts,
        "t": int(time.time()),
    }
    raw_bytes = json.dumps(
        payload_obj, cls=DecimalEncoder, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    sig = hmac.new(hmac_key, raw_bytes, hashlib.sha256).hexdigest()

    envelope = {
        "p": json.loads(raw_bytes.decode("utf-8")),
        "s": sig,
    }
    envelope_bytes = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(envelope_bytes).decode("utf-8")


def _decode_next_token(
    token: str,
    expected_device_id: str,
    expected_user_uid: Optional[str] = None,
    expected_start_ts: Optional[int] = None,
    expected_end_ts: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Decodifica e exige obrigatoriamente a assinatura HMAC-SHA256 válida, o prazo de
    expiração (`TOKEN_TTL_SEC`) e a vinculação estrita ao `expected_device_id`,
    ao `expected_user_uid` e à janela temporal `(expected_start_ts, expected_end_ts)`.
    """
    if not token or len(token) > 2048:
        raise ValueError("Token inválido")

    hmac_key = _get_token_hmac_key()

    padded = token + "=" * (-len(token) % 4)
    decoded_str = base64.urlsafe_b64decode(padded.encode("utf-8")).decode(
        "utf-8", errors="strict"
    )
    decoded_obj = json.loads(decoded_str, parse_float=Decimal)

    if not isinstance(decoded_obj, dict) or "p" not in decoded_obj or "s" not in decoded_obj:
        raise ValueError("Formato de token inválido ou não assinado")

    payload_obj = decoded_obj["p"]
    sig_received = str(decoded_obj["s"])

    if not isinstance(payload_obj, dict):
        raise ValueError("Payload do token inválido")

    raw_bytes = json.dumps(
        payload_obj, cls=DecimalEncoder, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    expected_sig = hmac.new(hmac_key, raw_bytes, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(sig_received, expected_sig):
        raise ValueError("Assinatura do token inválida")

    now_ts = int(time.time())
    issued_at = int(payload_obj.get("t") or 0)
    if issued_at <= 0 or (now_ts - issued_at) > TOKEN_TTL_SEC or issued_at > (now_ts + 60):
        raise ValueError("Token de paginação expirado ou com data inválida")

    if payload_obj.get("d") != expected_device_id:
        raise ValueError("Token não pertence a este dispositivo")

    token_uid = payload_obj.get("u")
    if token_uid and expected_user_uid and token_uid != expected_user_uid:
        raise ValueError("Token não pertence ao usuário autenticado")

    if "st" in payload_obj or "et" in payload_obj:
        tok_st = int(payload_obj["st"]) if payload_obj.get("st") is not None else None
        tok_et = int(payload_obj["et"]) if payload_obj.get("et") is not None else None
        if tok_st != expected_start_ts or tok_et != expected_end_ts:
            raise ValueError("Token não corresponde à janela temporal solicitada")

    lek = payload_obj.get("lek")
    if not isinstance(lek, dict) or lek.get("device_id") != expected_device_id:
        raise ValueError("Chave de paginação inválida")

    lek_ts = lek.get("timestamp")
    if lek_ts is None or isinstance(lek_ts, bool):
        raise ValueError("Timestamp da chave de paginação inválido")
    lek_ts_int = int(lek_ts)
    if expected_start_ts is not None and expected_end_ts is not None:
        if not (expected_start_ts <= lek_ts_int <= expected_end_ts):
            raise ValueError("Cursor fora dos limites da janela temporal")

    return lek


# =====================================================================================
# PAGINAÇÃO INTERNA COM GUARDA DE TIMEOUT E DOWNSAMPLING PARA GRÁFICOS
# =====================================================================================
def _downsample_items_uniform(
    items: List[Dict[str, Any]], target_count: int
) -> List[Dict[str, Any]]:
    """Reduz uniformemente uma lista de registos preservando extremos."""
    n = len(items)
    if target_count <= 0 or n <= target_count:
        return items

    if target_count == 1:
        return [items[0]]

    step = (n - 1) / float(target_count - 1)
    selected_indices: List[int] = []
    last_idx = -1

    for i in range(target_count):
        idx = int(round(i * step))
        if idx >= n:
            idx = n - 1
        if idx != last_idx:
            selected_indices.append(idx)
            last_idx = idx

    if selected_indices[-1] != (n - 1):
        selected_indices[-1] = n - 1

    return [items[i] for i in selected_indices]


def _has_enough_lambda_time(context: Any) -> bool:
    """Verifica se restam pelo menos `SAFE_REMAINING_TIME_MS` antes do Timeout da Lambda."""
    if context is None or not hasattr(context, "get_remaining_time_in_millis"):
        return True
    try:
        remaining_ms = int(context.get_remaining_time_in_millis())
        return remaining_ms > SAFE_REMAINING_TIME_MS
    except Exception:
        return True


def _query_dynamodb_window(
    key_condition: Any,
    target_items_limit: int,
    exclusive_start_key: Optional[Dict[str, Any]] = None,
    allow_multi_page: bool = False,
    lightweight_chart_projection: bool = False,
    context: Any = None,
) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]], int, bool]:
    """Executa a consulta na tabela do DynamoDB com projeção leve opcional e guarda de tempo."""
    collected: List[Dict[str, Any]] = []
    current_lek: Optional[Dict[str, Any]] = exclusive_start_key
    pages_fetched = 0
    truncated_by_1mb = False
    t_start = time.perf_counter()

    while True:
        remaining = target_items_limit - len(collected)
        if remaining <= 0:
            break

        query_params: Dict[str, Any] = {
            "KeyConditionExpression": key_condition,
            "ScanIndexForward": False,
            "Limit": remaining,
        }
        if current_lek:
            query_params["ExclusiveStartKey"] = current_lek

        if lightweight_chart_projection:
            query_params["ProjectionExpression"] = "device_id, #ts, #sensors"
            query_params["ExpressionAttributeNames"] = {
                "#ts": "timestamp",
                "#sensors": "sensors",
            }

        response = table.query(**query_params)
        pages_fetched += 1

        batch = response.get("Items", []) or []
        collected.extend(batch)
        current_lek = response.get("LastEvaluatedKey")

        if pages_fetched == 1 and current_lek is not None and len(batch) < remaining:
            truncated_by_1mb = True

        if not allow_multi_page or not current_lek:
            break

        elapsed_s = time.perf_counter() - t_start
        if (
            pages_fetched >= MAX_INTERNAL_DYNAMO_PAGES
            or elapsed_s >= MAX_QUERY_TIME_SEC
            or not _has_enough_lambda_time(context)
        ):
            break

    return collected, current_lek, pages_fetched, truncated_by_1mb


# =====================================================================================
# HANDLER PRINCIPAL DA LAMBDA
# =====================================================================================
def lambda_handler(event: Any, context: Any) -> Dict[str, Any]:
    """Orquestra a validação, verificação de propriedade e leitura de telemetria no DynamoDB."""
    request_id = getattr(context, "aws_request_id", "n/a")
    _current_request_id.set(request_id)
    _request_start_ns.set(time.perf_counter_ns())
    _current_user_id.set(None)
    _current_device_id.set(None)

    method = _get_http_method(event or {})
    if method == "OPTIONS":
        return build_response(200, {"ok": True}, event)

    params = (event or {}).get("queryStringParameters", {}) or {}

    device_id = params.get("device_id")
    if not device_id or not isinstance(device_id, str) or not device_id.strip():
        return build_response(400, {"error": "device_id obrigatório"}, event)
    device_id = device_id.strip()
    if not DEVICE_ID_RE.fullmatch(device_id):
        return build_response(400, {"error": "device_id inválido"}, event)
    _current_device_id.set(device_id)

    next_token = params.get("next_token")
    start_time_raw = params.get("start_time")
    end_time_raw = params.get("end_time")

    has_start = start_time_raw is not None and str(start_time_raw).strip() != ""
    has_end = end_time_raw is not None and str(end_time_raw).strip() != ""

    if has_start != has_end:
        return build_response(
            400,
            {"error": "Informe ambos start_time e end_time para consulta por janela temporal"},
            event,
        )

    has_time_window = bool(has_start and has_end)

    downsample_raw = params.get("downsample") or params.get("downsample_max_points")
    downsample_target: Optional[int] = None
    if downsample_raw is not None and str(downsample_raw).strip() != "":
        try:
            ds_val = _parse_int(downsample_raw, default=0)
            if ds_val < 1:
                return build_response(400, {"error": "downsample inválido"}, event)
            downsample_target = max(
                MIN_DOWNSAMPLE_POINTS, min(ds_val, MAX_DOWNSAMPLE_POINTS)
            )
        except Exception:
            return build_response(400, {"error": "downsample inválido"}, event)

    effective_max_limit = MAX_RANGE_LIMIT if has_time_window else MAX_LIMIT

    try:
        limit = _parse_int(params.get("limit"), default=50)
        if limit < 1:
            limit = 1
        if limit > effective_max_limit:
            limit = effective_max_limit
    except Exception:
        return build_response(400, {"error": "limit inválido"}, event)

    auth_ctx = _extract_auth_context(event or {})
    if auth_ctx.get("auth_mode") == "demo_pass_claim":
        return build_response(403, {"message": "Forbidden"}, event)

    user_uid = auth_ctx.get("user_uid") or ""
    if REQUIRE_AUTH and not user_uid:
        return build_response(401, {"message": "Unauthorized"}, event)

    if ENFORCE_DEVICE_OWNERSHIP:
        if _get_firestore() is None:
            return build_response(
                503,
                {"message": "Serviço de verificação temporariamente indisponível"},
                event,
            )

        ok = _assert_device_ownership(
            device_id=device_id,
            user_uid=user_uid,
            caller_demo_sid=auth_ctx.get("demo_sid", ""),
            caller_demo_device_id=auth_ctx.get("demo_device_id", ""),
            caller_is_demo_jwt=(auth_ctx.get("is_demo") == "true"),
        )
        if not ok:
            return build_response(403, {"message": "Forbidden"}, event)

    try:
        key_condition = Key("device_id").eq(device_id)
        t_start: Optional[int] = None
        t_end: Optional[int] = None

        if has_time_window:
            try:
                t_start = _parse_int(start_time_raw, default=0)
                t_end = _parse_int(end_time_raw, default=0)
            except Exception:
                return build_response(
                    400, {"error": "start_time ou end_time inválido"}, event
                )
            if t_start <= 0 or t_end <= 0:
                return build_response(
                    400, {"error": "start_time e end_time devem ser inteiros positivos"}, event
                )
            if t_start > t_end:
                t_start, t_end = t_end, t_start
            if (t_end - t_start) > MAX_TIME_WINDOW_SEC:
                return build_response(
                    400,
                    {"error": "A janela temporal solicitada excede o máximo permitido (90 dias)"},
                    event,
                )
            key_condition = key_condition & Key("timestamp").between(t_start, t_end)

        decoded_start_key: Optional[Dict[str, Any]] = None
        if next_token:
            try:
                decoded_start_key = _decode_next_token(
                    token=next_token,
                    expected_device_id=device_id,
                    expected_user_uid=user_uid,
                    expected_start_ts=t_start,
                    expected_end_ts=t_end,
                )
            except Exception as token_err:
                _log("WARN", "invalid_pagination_token", error=str(token_err))
                return build_response(
                    400, {"error": "Token inválido ou expirado"}, event
                )

        is_downsample_mode = bool(downsample_target is not None and has_time_window)
        scan_limit = (
            MAX_CHART_RAW_SCAN_ITEMS
            if is_downsample_mode
            else min(limit, MAX_RAW_SCAN_ITEMS)
        )
        allow_multi_page = has_time_window

        t0_dynamo = time.perf_counter()
        raw_items, lek, pages_fetched, truncated_by_1mb = _query_dynamodb_window(
            key_condition=key_condition,
            target_items_limit=scan_limit,
            exclusive_start_key=decoded_start_key,
            allow_multi_page=allow_multi_page,
            lightweight_chart_projection=is_downsample_mode,
            context=context,
        )
        dynamo_ms = round((time.perf_counter() - t0_dynamo) * 1000.0, 2)

        raw_count = len(raw_items)
        final_items = raw_items
        was_downsampled = False

        if downsample_target is not None and raw_count > downsample_target:
            final_items = _downsample_items_uniform(raw_items, downsample_target)
            was_downsampled = True

        encoded_next_token: Optional[str] = None
        if lek and not is_downsample_mode:
            encoded_next_token = _encode_next_token(
                last_evaluated_key=lek,
                device_id=device_id,
                user_uid=user_uid,
                start_ts=t_start,
                end_ts=t_end,
            )

        covered_end_ts = int(raw_items[0]["timestamp"]) if raw_items and "timestamp" in raw_items[0] else None
        covered_start_ts = int(raw_items[-1]["timestamp"]) if raw_items and "timestamp" in raw_items[-1] else None

        _log(
            "INFO",
            "telemetry_query_completed",
            has_time_window=has_time_window,
            requested_limit=limit,
            downsample_target=downsample_target,
            lightweight_projection=is_downsample_mode,
            raw_scanned_count=raw_count,
            returned_count=len(final_items),
            was_downsampled=was_downsampled,
            pages_fetched=pages_fetched,
            dynamo_latency_ms=dynamo_ms,
        )

        result: Dict[str, Any] = {
            "data": final_items,
            "count": len(final_items),
            "raw_scanned_count": raw_count,
            "downsampled": was_downsampled,
            "truncated_by_1mb": truncated_by_1mb,
            "partial_window": bool(is_downsample_mode and lek is not None),
            "covered_start_ts": covered_start_ts,
            "covered_end_ts": covered_end_ts,
            "next_token": encoded_next_token,
        }

        return build_response(200, result, event)

    except Exception as e:
        _log("ERROR", "dynamo_query_failed", error=str(e))
        return build_response(500, {"error": "Internal Server Error"}, event)


# =====================================================================================
# Aquecimento (EventBridge Scheduler a cada 5 min) — 2026-11-23
# So reage a {"agrosmart_warmup": true} no NIVEL MAIS ALTO do evento. Eventos do API
# Gateway trazem o corpo como texto em "body": a internet nao chega aqui, e este caminho
# nao executa comando nenhum (so devolve {"warmup": "ok"}).
# Tambem deixa pronto o cliente do Firestore, a parte mais lenta do inicio a frio.
# =====================================================================================
import time as _agrosmart_time

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
        return {"warmup": "ok", "firestore": _estado,
                "ms": int((_agrosmart_time.perf_counter() - _t0) * 1000)}
    return _agrosmart_handler_original(event, context)
