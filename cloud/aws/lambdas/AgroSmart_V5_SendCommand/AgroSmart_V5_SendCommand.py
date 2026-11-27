"""
=====================================================================================
ARQUIVO: backend/LambdasFuncs/AgroSmart_V5_SendCommand/AgroSmart_V5_SendCommand.py
PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5)
RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 3 / Parte A — OTA Assinado + Anti-Downgrade)
DATA DE CRIACAO: 2026-02-18 06:00
ULTIMA ATUALIZACAO: 2026-11-24T23:00:00Z (UTC)
VERSAO: v5.38.0 — Configuração do display e do botão da estação (firmware 5.27.0)
=====================================================================================
CHANGELOG v5.38.0 (2026-11-24, firmware 5.27.0):
- `action="config"` aceita `display_mode` (on|off|default_on|default_off),
  `display_minutes` (1..120, obrigatório só com `on`) e `btn_irrig_min` (1..15).
  Não se misturam com intervalo/calibração no mesmo comando (400). Só o titular:
  a Demo continua restrita a on/off (`DEMO_ALLOWED_ACTIONS`).
- Prefixo `loc-` reservado: é o número dos eventos dos botões físicos da estação.
- Metadados `config` no Firestore e a checagem de idempotência incluem os campos novos.
CHANGELOG v5.37.0 (2026-11-24, Fase 4.0-E E1):
- Balde anti-rajada de LIGAR por estação (titular e Demo), espelhando o firmware
  5.26.0: até `DEVICE_ON_BURST` (6) LIGAR seguidos e depois 1 a cada
  `DEVICE_ON_REFILL_SEC` (30 s). Estado em `devices/{id}.cmd_guard`
  (`on_credit_ms`, `updated_ms`), lido e gravado DENTRO da transação que já existe
  (zero idas extras ao Firestore). Só consome em LIGAR novo que reserva a válvula;
  OFF, repetição idempotente, retry de publish_failed e recusas não consomem.
- Recusa: HTTP 429 `reason=device_rate_limited`, `retry_after_sec` e `Retry-After`,
  com mensagem clara em português. Nada é gravado e nada é publicado no MQTT.
- `DEVICE_ON_BURST=0` desliga o limite (chave de emergência, sem novo deploy).
- CHANGELOG v5.35.0/v5.36.0 (aquecimento e leitura em lote) no fim do arquivo.
CHANGELOG v5.34.0 (2026-11-23, Fase 2C.2):
- `POST /demo/claim` (rota sem Authorizer) passa a verificar o cabeçalho
  `X-Firebase-AppCheck` ANTES de qualquer acesso ao DynamoDB/Firestore:
  * Validação local com PyJWT (layer): RS256 via JWKS oficial do App Check (cache 6 h),
    `iss` = https://firebaseappcheck.googleapis.com/<numero>, `aud` contendo
    `projects/<numero>`, `typ` JWT, `exp`/`iat`/`sub` obrigatórios e `sub` na
    allowlist `APPCHECK_APP_IDS`.
  * `APPCHECK_MODE`: `off` | `log` (padrão: só registra) | `enforce` (recusa com
    HTTP 401 `reason=app_check_failed`, atraso uniforme e `no-store`).
  * Log `demo_claim_appcheck` com status/motivo; o token NUNCA é registrado.
- CORS: `Access-Control-Allow-Headers` passa a incluir `X-Firebase-AppCheck`.
- Nenhuma mudança em POST /command, no contrato MQTT, no OTA ou nas regras Demo.

CHANGELOG v5.33.0 (2026-11-23, Fase 3C item 5):
- `publish_ota_release` (rota administrativa interna, só via IAM/CloudShell):
  * `device_id` passa a ser OBRIGATÓRIO e validado por `DEVICE_ID_RE`; vazio e "all"
    são recusados (antes publicavam a release em TODOS os documentos `devices`,
    inclusive estações de teste).
  * A estação precisa existir em `devices/{id}` e ter `owner_uid`; antes, um ID
    inexistente criava um documento fantasma via `set(merge=True)`.
  * Recusas devolvem HTTP 400 com `reason` estável (`device_id_required`,
    `device_id_invalid`, `device_not_found`, `device_without_owner`) e log WARN
    `publish_ota_release_rejected`; nada é gravado no Firestore.
  * Nenhuma mudança na rota HTTP POST /command, no Demo ou no contrato MQTT.

CHANGELOG v5.32.0 (2026-11-22):
- Fase 3 / Parte A (Blindagem OTA — Assinatura ECDSA P-256 + Anti-Downgrade):
  * Adiciona `OTA_REQUIRE_SIGNATURE` (padrão True; aceita "false"/"0"/"no" para
    desligar) e `OTA_SIGNING_PUBKEY_PEM_B64` (opcional, defesa em profundidade).
  * Adiciona `_parse_semver_strict(v)` aceitando somente X.Y.Z sem pré-release.
  * Fixa caminho S3 em `firmware/v{versao}/firmware.bin`, rejeitando `s3_key` na
    rota HTTP POST /command (400) e qualquer override divergente no servidor.
  * Valida metadados S3 `signature` (base64 8..72 bytes), `sig-alg`
    ("ecdsa-p256-sha256-v1") e `fw-version`, com verificação ECDSA P-256 opcional
    via import tardio de `cryptography`, propagando `sig` e `sig_alg` no MQTT
    e garantindo limite de 2400 bytes no payload MQTT.
  * Usa `devices/{id}.available_ota` como fonte única na rota HTTP POST /command
    e aplica anti-downgrade transacional dentro de `_tx_body` (outcome "rejected"
    -> HTTP 409 sem travar nem publicar MQTT).
  * Torna releases imutáveis em `_handle_internal_publish_ota_release` (bloqueia
    versão inferior ou mesma versão com sha256 diferente; grava `sig_alg` e
    `signed: true`, nunca grava `signature` em Firestore/demo_view).
  * Sanitiza logs OTA (apenas `sha256[:12]`, `len(sig)` e versões; nunca URL/sig).

CHANGELOG v5.31.0 (2026-11-22):
- Fase 1C (Isolamento da Porta de Entrada Demo e Redução de PII):
  * Suporte à rota dedicada `POST /demo/claim` (sem Authorizer no API Gateway),
    detectada via `event["resource"]` ou `requestContext.resourcePath`: aceita apenas
    `action == "claim_demo_pass"` com `demo_pass_token` no corpo, ignora o cabeçalho
    `Authorization` e o contexto do Authorizer, devolve HTTP 400 ("Requisição inválida.")
    para qualquer outra ação sem tocar no DynamoDB/Firestore/IoT, e responde HTTP 204
    com cabeçalhos CORS em requisições `OPTIONS`.
  * Adiciona flag de transição `LEGACY_CLAIM_ON_COMMAND` (env, padrão `"true"`; só
    `"false"` desliga): quando desligada, o resgate legado em `POST /command` responde
    HTTP 403 genérico sem tocar no Firestore e emite `demo_pass_claim_legacy_route_disabled`.
  * Torna as respostas HTTP de bloqueio (`temporarily_locked` e `locked_now`) idênticas
    às de passe inválido (HTTP 403 com apenas a mensagem genérica e atraso uniforme de
    0,35 s), removendo `reason` e `locked_until_epoch` da resposta anônima enquanto
    mantém ambos nos logs e espelhados em `demo_summary.locked_until_epoch`.
  * Resolve a conta Demo prioritariamente por `DEMO_AUTH_UID` (`^[A-Za-z0-9]{1,128}$`)
    via `fb_auth.get_user(uid)` (sem chamar `get_user_by_email`), com fallback para
    `DEMO_PRIMARY_EMAIL` + aviso único por container `demo_auth_uid_env_missing` e
    erros sem e-mail ("Conta de demonstração indisponível.").
  * Remove a gravação do campo `email` em novos documentos `users/{demo_uid}` em
    `_sync_demo_user_profile_after_claim`.
  * Torna a precisão das coordenadas em `demo_view/current` configurável por
    `DEMO_COORD_DECIMALS` (padrão 1 ≈ 11 km; faixa 0..3; fora da faixa volta a 1).
  * Documenta que `DEMO_ON_COOLDOWN_SEC` tem padrão 60 s no código (fail-safe) e
    vale 15 s em produção via variável de ambiente.

CHANGELOG v5.30.0 (2026-11-22):
- Fase 1B: `reason`/`retry_after_sec` em limites Demo, `demo_summary.locked_until_epoch`,
  teto de `DEMO_MAX_PASS_MINUTES` em 1440 e `_safe_demo_sid_prefix` em `"h:" + sha256[:8]`.

CHANGELOG v5.29.0 (2026-11-22):
- A1 (Namespace/autoria `command_id`), A2 (Limites Demo: 300s/ON, cooldown padrão 60s
  no código / `DEMO_ON_COOLDOWN_SEC=15` em produção via env, 1800s/sessão; OFF sempre
  permitido; `publish_failed` não devolve cota), M1 (Resgate atômico), M2 e B1.
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
import random
import re
import secrets
import time
import uuid
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


from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

# =====================================================================================
# CONTEXTVARS E LOG ESTRUTURADO JSON COM CRONÔMETRO DE EXECUÇÃO (ELAPSED_MS)
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


def _safe_demo_sid_prefix(demo_sid: Optional[str]) -> Optional[str]:
    """Retorna hash truncado (`h:<sha256[:8]>`) do `demo_sid` para correlação segura em log."""
    if not isinstance(demo_sid, str):
        return None
    clean = demo_sid.strip()
    if not clean:
        return None
    return "h:" + hashlib.sha256(clean.encode("utf-8")).hexdigest()[:8]


def _log(level: str, event_name: str, **fields: Any) -> None:
    """
    Emite log estruturado em JSON para o CloudWatch com injeção automática de `request_id`,
    `user_id`, `device_id` e `elapsed_ms`.
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
        "component": "SendCommand",
        "fw_backend": "v5.38.0",
        "event_name": event_name,
        "elapsed_ms": elapsed_ms,
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **{k: v for k, v in fields.items() if v is not None},
    }
    print(json.dumps(payload, ensure_ascii=False, default=str))


def _env_int(
    name: str,
    default: int,
    *,
    min_val: Optional[int] = None,
    max_val: Optional[int] = None,
    clamp_max: bool = True,
) -> int:
    """
    Lê variável de ambiente inteira com fallback seguro para valores inválidos ou abaixo
    de `min_val`. Acima de `max_val`, prende em `max_val` quando `clamp_max=True` ou
    retorna `default` quando `clamp_max=False`.
    """
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
        return max_val if clamp_max else default
    return parsed


def _env_flag_default_true(name: str) -> bool:
    """
    Lê flag booleana de transição com padrão `True`: apenas `"false"` (case-insensitive,
    ignorando espaços) desliga; qualquer outro valor mantém ligado.
    """
    raw = os.getenv(name)
    if raw is None:
        return True
    return raw.strip().lower() != "false"


def _env_bool_default_true(name: str) -> bool:
    """Lê flag booleana defensiva com padrão `True`; aceita "false", "0" ou "no" para desligar."""
    raw = os.getenv(name)
    if raw is None:
        return True
    return raw.strip().lower() not in ("false", "0", "no")


# =====================================================================================
# IMPORTAÇÃO SEGURA DA LAYER FIREBASE / GOOGLE CLOUD FIRESTORE / FIREBASE AUTH
# =====================================================================================
try:
    import firebase_admin
    from firebase_admin import auth as fb_auth
    from firebase_admin import credentials, firestore
    from google.cloud import firestore as gcf_firestore

    FIREBASE_AVAILABLE = True
except ImportError:
    firebase_admin = None
    fb_auth = None
    credentials = None
    firestore = None
    gcf_firestore = None
    FIREBASE_AVAILABLE = False
    _log(
        "WARN",
        "firebase_layer_missing",
        message="Layer Firebase ausente. Firestore tracking desativado.",
    )


# =====================================================================================
# CONFIGURAÇÕES E CONSTANTES DE SEGURANÇA
# =====================================================================================
AWS_REGION = os.getenv("AWS_REGION", "us-east-2")
IOT_TOPIC_PREFIX = os.getenv("IOT_TOPIC_PREFIX", "agrosmart/v5").strip().strip("/")
IOT_DATA_ENDPOINT_URL = (
    os.getenv("IOT_DATA_ENDPOINT_URL", "").strip()
    or os.getenv("IOT_DATA_ENDPOINT", "").strip()
    or None
)
RATE_LIMIT_TABLE = os.getenv("RATE_LIMIT_TABLE", "AgroSmart_RateLimit_V5").strip()

MAX_DURATION_SECONDS = _env_int("MAX_DURATION_SECONDS", 900, min_val=1, max_val=900)
COMMAND_TTL_SECONDS = _env_int("COMMAND_TTL_SECONDS", 120, min_val=10)
PENDING_RETRY_AFTER_SEC = _env_int("PENDING_RETRY_AFTER_SEC", 30, min_val=1)
STALE_LOCK_GRACE_SEC = _env_int("STALE_LOCK_GRACE_SEC", 15, min_val=0)
OTA_LOCK_TTL_SECONDS = _env_int("OTA_LOCK_TTL_SECONDS", 300, min_val=30)
CONFLICT_RETRY_AFTER_SEC = _env_int("CONFLICT_RETRY_AFTER_SEC", 30, min_val=1)

# Limites físicos e de cota da sessão Demo (A2 + Fase 1B)
# Cooldown: padrão do código = 60 s (fail-safe); em produção vale DEMO_ON_COOLDOWN_SEC=15 via env.
DEMO_MAX_ON_DURATION_SEC = _env_int(
    "DEMO_MAX_ON_DURATION_SEC", 300, min_val=1, max_val=MAX_DURATION_SECONDS
)
DEMO_ON_COOLDOWN_SEC = _env_int("DEMO_ON_COOLDOWN_SEC", 60, min_val=0)

# v5.37.0 (Fase 4.0-E E1): balde anti-rajada de LIGAR por estação (espelha o firmware 5.26.0).
# DEVICE_ON_BURST=0 desliga o limite. Recarga mínima de 5 s para nunca virar divisão por zero.
DEVICE_ON_BURST = _env_int("DEVICE_ON_BURST", 6, min_val=0, max_val=60)
DEVICE_ON_REFILL_SEC = _env_int("DEVICE_ON_REFILL_SEC", 30, min_val=5, max_val=3600)
DEVICE_GUARD_MAX_SKEW_MS = 60_000
DEMO_MAX_ON_SECONDS_PER_SESSION = _env_int("DEMO_MAX_ON_SECONDS_PER_SESSION", 1800, min_val=1)
MIN_DEMO_PASS_MINUTES = 5
DEMO_MAX_PASS_MINUTES = _env_int(
    "DEMO_MAX_PASS_MINUTES", 240, min_val=MIN_DEMO_PASS_MINUTES, max_val=1440
)

# Precisão das coordenadas GPS na projeção Demo (padrão 1 ≈ 11 km; faixa 0..3; fora volta a 1)
DEMO_COORD_DECIMALS = _env_int(
    "DEMO_COORD_DECIMALS", 1, min_val=0, max_val=3, clamp_max=False
)

# Flag de transição do resgate legado em POST /command (Fase 1C)
LEGACY_CLAIM_ON_COMMAND = _env_flag_default_true("LEGACY_CLAIM_ON_COMMAND")

# Rate limit por IP e lockout temporário por passe (M1)
MAX_IP_CLAIM_ATTEMPTS_PER_MIN = _env_int("MAX_IP_CLAIM_ATTEMPTS_PER_MIN", 6, min_val=1)
DEMO_FAIL_WINDOW_SEC = _env_int("DEMO_FAIL_WINDOW_SEC", 900, min_val=1)
MAX_DEMO_FAILED_ATTEMPTS = _env_int("MAX_DEMO_FAILED_ATTEMPTS", 30, min_val=1)
DEMO_LOCK_SEC = _env_int("DEMO_LOCK_SEC", 600, min_val=1)
CLAIM_REJECTION_DELAY_SEC = 0.35

MAX_IDEMPOTENCY_KEY_LEN = 256
MAX_BODY_BYTES = 16384
MAX_ESP32_OTA_URL_LEN = 1598
MAX_TRACKED_IPS = 1000

MIN_TELEMETRY_INTERVAL_MS = 10000
MAX_TELEMETRY_INTERVAL_MS = 3600000
SOIL_ADC_MIN_VALID = 100
SOIL_ADC_MAX_VALID = 4080
SOIL_CALIB_MIN_DELTA = 100

OTA_S3_BUCKET = os.getenv("OTA_S3_BUCKET", "").strip()
OTA_PRESIGNED_URL_TTL_SEC = _env_int("OTA_PRESIGNED_URL_TTL_SEC", 600, min_val=30)
OTA_REQUIRE_SIGNATURE = _env_bool_default_true("OTA_REQUIRE_SIGNATURE")
OTA_SIGNING_PUBKEY_PEM_B64 = os.getenv("OTA_SIGNING_PUBKEY_PEM_B64", "").strip()
OTA_SIG_ALG_V1 = "ecdsa-p256-sha256-v1"
OTA_SIG_CONTEXT_V1 = "agrosmart-ota-v1"
OTA_SIG_DEVICE_CLASS_V1 = "agrosmart-v5-station"
MAX_ESP32_OTA_MQTT_BYTES = 2400
_OTA_INVALID_SIG_MSG = "Release sem assinatura válida. Publique com o comando de release."

ALLOWED_ACTIONS = {"on", "off", "config", "ota"}
DEMO_ALLOWED_ACTIONS = {"on", "off"}
RESERVED_CLIENT_CMD_PREFIXES = ("sched-", "demo-", "man-", "ota-boot", "overflow-", "loc-")
# v5.38.0: display e botão da estação (firmware 5.27.0)
LOCAL_DISPLAY_MODES = ("on", "off", "default_on", "default_off")
DISPLAY_MINUTES_MIN, DISPLAY_MINUTES_MAX = 1, 120
BTN_IRRIG_MIN_MINUTES, BTN_IRRIG_MAX_MINUTES = 1, 15
CONFIG_METADATA_KEYS = (
    "telemetry_interval_ms", "soil_raw_dry", "soil_raw_wet",
    "display_mode", "display_minutes", "btn_irrig_min",
)
DEMO_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

DEMO_AUTH_UID_RE = re.compile(r"^[A-Za-z0-9]{1,128}$")
_DEMO_AUTH_UID_RAW = os.getenv("DEMO_AUTH_UID", "").strip()
DEMO_AUTH_UID = _DEMO_AUTH_UID_RAW if DEMO_AUTH_UID_RE.match(_DEMO_AUTH_UID_RAW) else ""
DEMO_PRIMARY_EMAIL = os.getenv("DEMO_PRIMARY_EMAIL", "demo@agrosmart.com").strip() or "demo@agrosmart.com"

_GENERIC_CLAIM_DENIED_MSG = "Código de convite inválido, expirado ou já utilizado."
_GENERIC_DEMO_UNAVAILABLE_MSG = "Conta de demonstração indisponível."
_NO_STORE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}

REQUIRE_AUTH = os.getenv("REQUIRE_AUTH", "true").lower() == "true"
ENFORCE_DEVICE_OWNERSHIP = os.getenv("ENFORCE_DEVICE_OWNERSHIP", "true").lower() == "true"

DEFAULT_ALLOWED_ORIGINS = (
    "https://agrosmart-v5.web.app,"
    "https://agrosmart-v5.firebaseapp.com,"
    "http://localhost:5173,"
    "http://127.0.0.1:5173"
)
ALLOWED_ORIGINS_RAW = os.getenv("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).strip()

# Firebase App Check (Fase 2C.2) — usado na rota sem Authorizer `POST /demo/claim`
_APPCHECK_MODE_RAW = os.getenv("APPCHECK_MODE", "log").strip().lower()
APPCHECK_MODE = _APPCHECK_MODE_RAW if _APPCHECK_MODE_RAW in ("off", "log", "enforce") else "log"
APPCHECK_PROJECT_NUMBER = os.getenv("APPCHECK_PROJECT_NUMBER", "").strip()
APPCHECK_APP_IDS = frozenset(
    a.strip() for a in os.getenv("APPCHECK_APP_IDS", "").split(",") if a.strip()
)
_APPCHECK_JWKS_URL = "https://firebaseappcheck.googleapis.com/v1/jwks"
_APPCHECK_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
_appcheck_jwks_client: Any = None

DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9:_-]{1,80}$")
COMMAND_ID_RE = re.compile(r"^[A-Za-z0-9:_-]{1,47}$")
OTA_VERSION_RE = re.compile(r"^([0-9]+)\.([0-9]+)\.([0-9]+)$")
SHA256_HEX_RE = re.compile(r"^[a-fA-F0-9]{64}$")
DEMO_INVITE_PASS_RE = re.compile(r"^AGRO-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$")

_LEGACY_SETTINGS_DEMO_KEYS = (
    "settings.demo_token",
    "settings.demo_token_hash",
    "settings.demo_token_hint",
    "settings.demo_session_id",
    "settings.demo_pass_claimed",
    "settings.demo_expires_epoch",
    "settings.demo_failed_attempts",
    "settings.demo_last_failed_epoch",
    "settings.demo_claimed_at",
)

# =====================================================================================
# CLIENTES AWS COM TIMEOUT E RETRY PADRÃO E SINGLETON FIRESTORE
# =====================================================================================
_DEFAULT_BOTO_CONFIG = BotoConfig(
    connect_timeout=5,
    read_timeout=5,
    retries={"max_attempts": 3, "mode": "standard"},
)

_S3_BOTO_CONFIG = BotoConfig(
    signature_version="s3v4",
    connect_timeout=5,
    read_timeout=5,
    retries={"max_attempts": 3, "mode": "standard"},
)

if IOT_DATA_ENDPOINT_URL:
    _normalized_iot_ep = (
        IOT_DATA_ENDPOINT_URL
        if IOT_DATA_ENDPOINT_URL.startswith("https://")
        else f"https://{IOT_DATA_ENDPOINT_URL}"
    )
    iot_data = boto3.client(
        "iot-data",
        region_name=AWS_REGION,
        endpoint_url=_normalized_iot_ep,
        config=_DEFAULT_BOTO_CONFIG,
    )
else:
    iot_data = boto3.client(
        "iot-data",
        region_name=AWS_REGION,
        config=_DEFAULT_BOTO_CONFIG,
    )

s3_client = boto3.client(
    "s3",
    region_name=AWS_REGION,
    config=_S3_BOTO_CONFIG,
)

ddb_client = boto3.client(
    "dynamodb",
    region_name=AWS_REGION,
    config=BotoConfig(
        connect_timeout=2,
        read_timeout=2,
        retries={"max_attempts": 2, "mode": "standard"},
    ),
)

_firestore_client: Optional[Any] = None
_cached_demo_account_uid: Optional[str] = None
_demo_auth_uid_env_warned: bool = False

# Fallback local em RAM (janela deslizante de 60 s do rate limit de IP) usado só se o DynamoDB falhar
_ip_claim_attempt_tracker: Dict[str, List[float]] = {}


# =====================================================================================
# FUNÇÕES PURAS DE SEGURANÇA E REGRAS DE NEGÓCIO (A1, A2, M1, FASE 1C)
# =====================================================================================
def _is_demo_claim_route(event: Any) -> bool:
    """
    Identifica requisições destinadas à rota dedicada `POST /demo/claim` por
    `event["resource"]` ou, na falta dele, por `event["requestContext"]["resourcePath"]`.
    """
    if not isinstance(event, dict):
        return False
    resource = event.get("resource")
    if isinstance(resource, str) and resource.strip():
        return resource.strip() == "/demo/claim"
    rc = event.get("requestContext")
    if isinstance(rc, dict):
        res_path = rc.get("resourcePath")
        if isinstance(res_path, str) and res_path.strip():
            return res_path.strip() == "/demo/claim"
    return False


def _safe_nonneg_int(raw_val: Any, default: int = 0) -> int:
    """Converte um valor armazenado em inteiro não-negativo de forma segura."""
    if raw_val is None or isinstance(raw_val, bool):
        return default
    try:
        val = int(raw_val)
        return val if val >= 0 else default
    except (TypeError, ValueError):
        return default


def _has_reserved_client_cmd_prefix(command_id: str) -> bool:
    """Retorna True se o `command_id` do cliente usar algum prefixo reservado (case-insensitive)."""
    if not isinstance(command_id, str):
        return False
    lowered = command_id.strip().lower()
    return any(lowered.startswith(prefix) for prefix in RESERVED_CLIENT_CMD_PREFIXES)


def _hash_demo_sid(demo_sid: str) -> str:
    """Retorna o resumo SHA-256 truncado (16 chars hex) do identificador de sessão Demo."""
    return hashlib.sha256(demo_sid.encode("utf-8")).hexdigest()[:16]


def _derive_demo_command_id(demo_sid: str, device_id: str, client_key: str) -> str:
    """
    Deriva determinística e exclusivamente no servidor o `command_id` para chamadas Demo:
    `demo-<sha256(demo_sid:device_id:client_key)[:24]>` (29 chars <= 47).
    """
    raw = f"{demo_sid}:{device_id}:{client_key}".encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()[:24]
    return f"demo-{digest}"


def _build_requested_by(
    user_id: Optional[str],
    is_demo: bool,
    demo_sid: str = "",
) -> Optional[dict[str, Any]]:
    """Constrói o objeto canônico `requested_by` gravado no documento do comando."""
    if not user_id:
        return None
    if is_demo:
        return {
            "user_id": user_id,
            "kind": "demo",
            "demo_sid_hash": _hash_demo_sid(demo_sid),
        }
    return {
        "user_id": user_id,
        "kind": "owner",
    }


def _is_same_command_author(
    existing_cmd: dict[str, Any],
    caller_uid: Optional[str],
    caller_is_demo: bool,
    caller_demo_sid: str = "",
) -> bool:
    """
    Verifica autoria de um comando já existente (A1):
      - Exige `requested_by` preenchido (legados sem `requested_by` falham de propósito);
      - Exige `requested_by.user_id == caller_uid`;
      - Para Demo, exige também que `requested_by.demo_sid_hash` coincida com o hash
        da sessão Demo atual;
      - Para Titular, impede colisão com comandos marcados como `kind == "demo"`.
    """
    if not isinstance(existing_cmd, dict) or not caller_uid:
        return False

    req_by = existing_cmd.get("requested_by")
    if not isinstance(req_by, dict):
        return False

    stored_uid = req_by.get("user_id")
    if not isinstance(stored_uid, str) or not stored_uid.strip():
        return False

    if not hmac.compare_digest(stored_uid.strip(), caller_uid.strip()):
        return False

    stored_kind = str(req_by.get("kind") or "").strip().lower()
    if caller_is_demo:
        if stored_kind and stored_kind != "demo":
            return False
        stored_sid_hash = req_by.get("demo_sid_hash")
        if (
            not isinstance(stored_sid_hash, str)
            or not stored_sid_hash.strip()
            or not caller_demo_sid
        ):
            return False
        expected_sid_hash = _hash_demo_sid(caller_demo_sid)
        return hmac.compare_digest(stored_sid_hash.strip().lower(), expected_sid_hash)

    if stored_kind == "demo":
        return False

    return True


def _evaluate_demo_on_limits(
    auth_data: dict[str, Any],
    duration: int,
    now_epoch: int,
) -> Tuple[bool, Optional[str], Optional[int]]:
    """
    Avalia os limites físicos e de cota da sessão Demo para `action="on"` (A2).
    Retorna `(ok, reason, retry_after)`:
      - `demo_duration_limit`: duração excede `DEMO_MAX_ON_DURATION_SEC` (HTTP 403);
      - `demo_cooldown`: intervalo desde último ON menor que `DEMO_ON_COOLDOWN_SEC`
        (HTTP 429; padrão 60 s no código, em produção vale `DEMO_ON_COOLDOWN_SEC=15` via env);
      - `demo_quota_exhausted`: soma `demo_on_seconds_used + duration` excede
        `DEMO_MAX_ON_SECONDS_PER_SESSION` (HTTP 403).
    """
    safe_auth = auth_data if isinstance(auth_data, dict) else {}

    if duration > DEMO_MAX_ON_DURATION_SEC:
        return (False, "demo_duration_limit", None)

    last_on_epoch = _safe_nonneg_int(safe_auth.get("demo_last_on_epoch"), 0)
    if last_on_epoch > 0 and DEMO_ON_COOLDOWN_SEC > 0:
        unlock_epoch = last_on_epoch + DEMO_ON_COOLDOWN_SEC
        if now_epoch < unlock_epoch:
            retry_after = max(1, unlock_epoch - now_epoch)
            return (False, "demo_cooldown", retry_after)

    used_seconds = _safe_nonneg_int(safe_auth.get("demo_on_seconds_used"), 0)
    if (used_seconds + duration) > DEMO_MAX_ON_SECONDS_PER_SESSION:
        return (False, "demo_quota_exhausted", None)

    return (True, None, None)


def _evaluate_device_on_bucket(
    guard: Any,
    now_ms: int,
    burst: Optional[int] = None,
    refill_sec: Optional[int] = None,
) -> Tuple[bool, int, Optional[dict[str, Any]]]:
    """
    Balde de créditos (em ms) para LIGAR por estação (v5.37.0, Fase 4.0-E E1).
    Cada LIGAR custa `refill_ms`; o crédito recarrega 1 ms por ms até `burst * refill_ms`.
    Retorna `(ok, retry_after_sec, novo_guard)`; `novo_guard` só vem quando ok.
    Estado ausente, corrompido ou com relógio muito no futuro = balde cheio (fail-open
    controlado: o firmware 5.26.0 mantém o mesmo limite como segunda barreira).
    """
    b = DEVICE_ON_BURST if burst is None else int(burst)
    r = DEVICE_ON_REFILL_SEC if refill_sec is None else int(refill_sec)
    if b <= 0 or r <= 0:
        return (True, 0, None)
    refill_ms = r * 1000
    cap_ms = b * refill_ms
    g = guard if isinstance(guard, dict) else {}
    last_ms = _safe_nonneg_int(g.get("updated_ms"), 0)
    credit = _safe_nonneg_int(g.get("on_credit_ms"), cap_ms)
    if last_ms <= 0 or last_ms > now_ms + DEVICE_GUARD_MAX_SKEW_MS:
        credit = cap_ms
    else:
        credit = min(cap_ms, min(credit, cap_ms) + max(0, now_ms - last_ms))
    if credit < refill_ms:
        retry_sec = max(1, -(-(refill_ms - credit) // 1000))
        return (False, int(retry_sec), None)
    return (True, 0, {"on_credit_ms": int(credit - refill_ms), "updated_ms": int(now_ms), "schema": 1})


def _evaluate_claim_lock(auth_data: dict[str, Any], now: int) -> bool:
    """Retorna True enquanto o passe estiver sob bloqueio temporário (`now < locked_until_epoch`)."""
    if not isinstance(auth_data, dict):
        return False
    locked_until = _safe_nonneg_int(auth_data.get("locked_until_epoch"), 0)
    return locked_until > 0 and now < locked_until


def _next_claim_failure_state(auth_data: dict[str, Any], now: int) -> dict[str, Any]:
    """
    Calcula o próximo estado de falhas do resgate em janela FIXA (`DEMO_FAIL_WINDOW_SEC`),
    sem destruir o passe (M1b). Ao atingir `MAX_DEMO_FAILED_ATTEMPTS`, ativa
    `locked_until_epoch = now + DEMO_LOCK_SEC` e zera o contador de falhas.
    """
    safe_auth = auth_data if isinstance(auth_data, dict) else {}
    window_start = _safe_nonneg_int(safe_auth.get("fail_window_start_epoch"), 0)
    prev_attempts = _safe_nonneg_int(safe_auth.get("failed_attempts"), 0)

    within_fixed_window = window_start > 0 and (now - window_start) < DEMO_FAIL_WINDOW_SEC
    if within_fixed_window:
        effective_window_start = window_start
        next_attempts = prev_attempts + 1
    else:
        effective_window_start = now
        next_attempts = 1

    if next_attempts >= MAX_DEMO_FAILED_ATTEMPTS:
        return {
            "fail_window_start_epoch": 0,
            "failed_attempts": 0,
            "locked_until_epoch": now + DEMO_LOCK_SEC,
            "last_failed_epoch": now,
        }

    return {
        "fail_window_start_epoch": effective_window_start,
        "failed_attempts": next_attempts,
        "locked_until_epoch": 0,
        "last_failed_epoch": now,
    }


# =====================================================================================
# HELPERS: HTTP / CORS / RATE LIMIT ATÔMICO DISTRIBUÍDO (DYNAMODB + TTL) / PARSING
# =====================================================================================
def _resolve_cors_origin(event: Optional[dict[str, Any]] = None) -> Optional[str]:
    """
    Resolve o cabeçalho Access-Control-Allow-Origin com whitelist estrita (F3.4):
      - Se `Origin` estiver presente e constar na allowlist, devolve essa origem;
      - Se `Origin` estiver presente e NÃO constar na allowlist, retorna `None`;
      - Se não houver header `Origin`, devolve `allowed[0]`.
    """
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


def _build_cors_headers(
    event: Optional[dict[str, Any]] = None,
    extra_headers: Optional[dict[str, str]] = None,
) -> dict[str, str]:
    """Monta os cabeçalhos HTTP e CORS padronizados com base na allowlist."""
    cors_origin = _resolve_cors_origin(event)
    headers_out: dict[str, str] = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key, X-Idempotency-Key, X-Firebase-AppCheck",
        "Access-Control-Expose-Headers": "Retry-After",
        "Vary": "Origin",
    }
    if cors_origin:
        headers_out["Access-Control-Allow-Origin"] = cors_origin
    if extra_headers:
        headers_out.update(extra_headers)
    return headers_out


def build_response(
    status_code: int,
    body: dict[str, Any],
    event: Optional[dict[str, Any]] = None,
    extra_headers: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """Constrói resposta HTTP padronizada para o API Gateway com cabeçalhos CORS seguros."""
    if status_code >= 400 and isinstance(body, dict):
        if "message" in body and "error" not in body:
            body["error"] = body["message"]
        elif "error" in body and "message" not in body:
            body["message"] = body["error"]

    headers_out = _build_cors_headers(event, extra_headers)

    _log(
        "DEBUG",
        "http_response_built",
        status_code=status_code,
        cors_origin=headers_out.get("Access-Control-Allow-Origin"),
        response_keys=list(body.keys()) if isinstance(body, dict) else [],
    )

    return {
        "statusCode": status_code,
        "headers": headers_out,
        "body": json.dumps(body, ensure_ascii=False),
    }


def _get_http_method(event: dict[str, Any]) -> str:
    """Extrai o método HTTP tanto de eventos REST API v1 quanto HTTP API v2."""
    if isinstance(event, dict) and "httpMethod" in event:
        return event["httpMethod"] or ""
    rc = (event or {}).get("requestContext", {}) if isinstance((event or {}).get("requestContext", {}), dict) else {}
    http = (rc.get("http", {}) if isinstance(rc, dict) else {}) or {}
    return http.get("method", "") or ""


def _get_headers(event: dict[str, Any]) -> dict[str, str]:
    """Normaliza todos os cabeçalhos HTTP para chaves em letras minúsculas."""
    headers = (event or {}).get("headers", {}) if isinstance(event, dict) else {}
    if not isinstance(headers, dict):
        return {}
    return {
        k.lower(): v
        for k, v in headers.items()
        if isinstance(k, str) and isinstance(v, str)
    }


def _extract_source_ip(event: dict[str, Any]) -> str:
    """
    Extrai o endereço IP do cliente exclusivamente do `requestContext` autoritativo
    do Amazon API Gateway (REST v1 `identity.sourceIp` ou HTTP v2 `http.sourceIp`).
    """
    if not isinstance(event, dict):
        return "unknown"
    rc = event.get("requestContext")
    if isinstance(rc, dict):
        ident = rc.get("identity")
        if isinstance(ident, dict) and isinstance(ident.get("sourceIp"), str):
            ip = ident["sourceIp"].strip()
            if ip:
                return ip
        http_blk = rc.get("http")
        if isinstance(http_blk, dict) and isinstance(http_blk.get("sourceIp"), str):
            ip = http_blk["sourceIp"].strip()
            if ip:
                return ip
    return "unknown"


def _hash_ip(source_ip: str) -> str:
    """Gera identificador pseudonimizado do IP (SHA-256 truncado) para chave de rate limit."""
    return hashlib.sha256(source_ip.encode("utf-8")).hexdigest()[:24]


def _purge_expired_ip_trackers(now_m: float) -> None:
    """Remove entradas de IPs com timestamps expirados (> 60 s da janela de IP) para evitar memory leak."""
    for ip_key in list(_ip_claim_attempt_tracker.keys()):
        valid_ts = [t for t in _ip_claim_attempt_tracker.get(ip_key, []) if (now_m - t) < 60.0]
        if valid_ts:
            _ip_claim_attempt_tracker[ip_key] = valid_ts
        else:
            _ip_claim_attempt_tracker.pop(ip_key, None)


def _consume_ram_ip_claim_attempt(ip_hash: str) -> bool:
    """Limitador local em RAM com janela deslizante de 60 s por minuto de IP (fallback do DynamoDB)."""
    now_m = time.monotonic()
    if len(_ip_claim_attempt_tracker) >= MAX_TRACKED_IPS:
        _purge_expired_ip_trackers(now_m)
    if len(_ip_claim_attempt_tracker) >= MAX_TRACKED_IPS and ip_hash not in _ip_claim_attempt_tracker:
        oldest_ip = next(iter(_ip_claim_attempt_tracker))
        _ip_claim_attempt_tracker.pop(oldest_ip, None)

    recent = [t for t in _ip_claim_attempt_tracker.get(ip_hash, []) if (now_m - t) < 60.0]
    if len(recent) >= MAX_IP_CLAIM_ATTEMPTS_PER_MIN:
        _ip_claim_attempt_tracker[ip_hash] = recent
        return False

    recent.append(now_m)
    _ip_claim_attempt_tracker[ip_hash] = recent
    return True


def _consume_ip_claim_attempt(source_ip: str) -> bool:
    """
    Consome atomicamente 1 tentativa do orçamento por minuto do IP no DynamoDB (M1a):
      - `UpdateItem` com `ConditionExpression` garantindo limite estrito sob concorrência;
      - `ConditionalCheckFailedException` -> `False` (orçamento esgotado -> HTTP 429);
      - Qualquer outro erro do DynamoDB (ou tabela não configurada) -> fallback para
        limitador deslizante em RAM (janela de 60 s por minuto de IP) com log `WARN`.
    """
    ip_hash = _hash_ip(source_ip)

    if not RATE_LIMIT_TABLE:
        _log("WARN", "demo_rate_limit_fallback_ram", reason="rate_limit_table_unconfigured", ip_hash=ip_hash)
        return _consume_ram_ip_claim_attempt(ip_hash)

    now_epoch = int(time.time())
    bucket = now_epoch // 60
    rl_key = f"claim_ip:{ip_hash}:{bucket}"
    ttl_epoch = (bucket + 2) * 60

    try:
        ddb_client.update_item(
            TableName=RATE_LIMIT_TABLE,
            Key={"rl_key": {"S": rl_key}},
            UpdateExpression=(
                "ADD attempt_count :one "
                "SET expires_at = if_not_exists(expires_at, :exp), last_attempt_epoch = :now"
            ),
            ConditionExpression="attribute_not_exists(attempt_count) OR attempt_count < :max",
            ExpressionAttributeValues={
                ":one": {"N": "1"},
                ":max": {"N": str(MAX_IP_CLAIM_ATTEMPTS_PER_MIN)},
                ":exp": {"N": str(ttl_epoch)},
                ":now": {"N": str(now_epoch)},
            },
        )
        return True
    except ClientError as exc:
        err_code = exc.response.get("Error", {}).get("Code", "")
        if err_code == "ConditionalCheckFailedException":
            return False
        _log(
            "WARN",
            "demo_rate_limit_fallback_ram",
            reason="dynamodb_client_error",
            error_code=err_code or "unknown",
            ip_hash=ip_hash,
        )
        return _consume_ram_ip_claim_attempt(ip_hash)
    except Exception as exc:
        _log(
            "WARN",
            "demo_rate_limit_fallback_ram",
            reason="dynamodb_unexpected_error",
            error_type=type(exc).__name__,
            ip_hash=ip_hash,
        )
        return _consume_ram_ip_claim_attempt(ip_hash)


def parse_json_body(event: dict[str, Any]) -> dict[str, Any]:
    """
    Decodifica e valida o corpo JSON da requisição HTTP com limite estrito de bytes UTF-8.
    Em eventos HTTP (`requestContext`, `httpMethod` ou `resource`), `body` ausente ou
    `None` lança `ValueError("Body vazio")` (B1). Invocações diretas (ex.: CloudShell)
    continuam retornando o dicionário do evento.
    """
    if not isinstance(event, dict):
        raise ValueError("Evento de entrada não é um dicionário")

    is_http_event = ("requestContext" in event) or ("httpMethod" in event) or ("resource" in event)

    if "body" not in event or event["body"] is None:
        if is_http_event:
            raise ValueError("Body vazio")
        return event

    raw = event["body"]
    if isinstance(raw, dict):
        return raw

    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("Body vazio")

    if len(raw.encode("utf-8", errors="replace")) > MAX_BODY_BYTES * 2:
        raise ValueError(f"Payload excede o limite máximo permitido ({MAX_BODY_BYTES} bytes)")

    is_b64 = bool(event.get("isBase64Encoded") is True)
    if is_b64:
        try:
            decoded_bytes = base64.b64decode(raw)
        except Exception:
            raise ValueError("Falha ao decodificar Base64 do body")
        if len(decoded_bytes) > MAX_BODY_BYTES:
            raise ValueError(f"Payload excede o limite máximo permitido ({MAX_BODY_BYTES} bytes)")
        raw = decoded_bytes.decode("utf-8", errors="replace")
    else:
        if len(raw.encode("utf-8", errors="replace")) > MAX_BODY_BYTES:
            raise ValueError(f"Payload excede o limite máximo permitido ({MAX_BODY_BYTES} bytes)")

    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("Body JSON deve ser um objeto")
        return parsed
    except json.JSONDecodeError:
        raise ValueError("Body não é um JSON válido")


def parse_int(value: Any, default: int = 0) -> int:
    """Converte um valor para inteiro rejeitando booleanos ou decimais fracionários."""
    if value is None:
        return default
    if isinstance(value, bool):
        raise ValueError("Valor inválido (bool não permitido para inteiros)")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError("Valor decimal não permitido onde inteiro é esperado")
        return int(value)
    if isinstance(value, str):
        v = value.strip()
        if v == "":
            return default
        try:
            f_val = float(v)
            if not math.isfinite(f_val) or not f_val.is_integer():
                raise ValueError("Valor decimal não permitido onde inteiro é esperado")
            return int(f_val)
        except ValueError:
            pass
    raise ValueError("Valor inválido para número inteiro")


# =====================================================================================
# PROJEÇÃO SANITIZADA `demo_view/current` (F1.2 + FASE 1C — PRIVACIDADE POR DESIGN)
# =====================================================================================
def _coarsen_coordinate(raw_val: Any, min_v: float, max_v: float) -> float:
    """
    Arredonda coordenadas GPS para `DEMO_COORD_DECIMALS` casas decimais (padrão 1 ≈ 11 km;
    faixa permitida 0..3) na projeção Demo, mantendo a previsão meteorológica funcional
    para a região da estação sem expor localização precisa.
    """
    try:
        if raw_val is None or isinstance(raw_val, bool):
            return 0.0
        val = float(raw_val)
        if not math.isfinite(val) or val < min_v or val > max_v:
            return 0.0
        if val == 0.0:
            return 0.0
        decimals = (
            DEMO_COORD_DECIMALS
            if isinstance(DEMO_COORD_DECIMALS, int) and 0 <= DEMO_COORD_DECIMALS <= 3
            else 1
        )
        return float(round(val, decimals))
    except Exception:
        return 0.0


def _build_sanitized_demo_view_doc(
    device_id: str,
    dev_data: dict[str, Any],
    demo_expires_epoch: int,
    demo_pass_claimed: bool,
    now_server: Any,
) -> dict[str, Any]:
    """
    Constrói o documento `devices/{device_id}/demo_view/current` contendo apenas dados
    operacionais seguros para demonstração:
      - SEM `owner_uid`, SEM `connection.ip`, SEM `boot_id`/`session_seq`;
      - SEM `demo_token`, `demo_token_hash`, `demo_session_id` ou `s3_key`;
      - Coordenadas `latitude`/`longitude` arredondadas por `DEMO_COORD_DECIMALS`
        (padrão 1 casa decimal ≈ 11 km) para manter clima regional.
    """
    raw_settings = dev_data.get("settings") or {}
    raw_conn = dev_data.get("connection") or {}
    raw_state = dev_data.get("state") or {}
    raw_ota = dev_data.get("ota_status") or {}
    raw_avail_ota = dev_data.get("available_ota") or {}

    safe_settings: dict[str, Any] = {
        "device_name": raw_settings.get("device_name") or "Estação AgroSmart",
        "target_soil_moisture": raw_settings.get("target_soil_moisture", 60),
        "manual_valve_duration": raw_settings.get("manual_valve_duration", 5),
        "timezone_offset": raw_settings.get("timezone_offset", -3),
        "enable_weather_control": bool(raw_settings.get("enable_weather_control", False)),
        "capabilities": raw_settings.get("capabilities") or ["air", "soil", "light", "rain", "uv"],
        "telemetry_interval_ms": raw_settings.get("telemetry_interval_ms", 30000),
        "soil_raw_dry": raw_settings.get("soil_raw_dry", 3000),
        "soil_raw_wet": raw_settings.get("soil_raw_wet", 1200),
        "latitude": _coarsen_coordinate(raw_settings.get("latitude"), -90.0, 90.0),
        "longitude": _coarsen_coordinate(raw_settings.get("longitude"), -180.0, 180.0),
        "demo_expires_epoch": int(demo_expires_epoch or 0),
        "demo_pass_claimed": bool(demo_pass_claimed),
    }

    safe_conn = {
        k: raw_conn.get(k)
        for k in ("state", "kind", "fw", "part", "boot_count", "reset_reason", "updatedAt")
        if raw_conn.get(k) is not None
    }

    safe_state = {
        k: raw_state.get(k)
        for k in (
            "valve_open",
            "valve_pending",
            "reservation_expires_epoch",
            "valve_origin",
            "current_command_id",
            "valve_ends_at",
            "confirmation_source",
            "execution_evidence",
            "reconciled_command_id",
        )
        if k in raw_state
    }

    safe_ota = {
        k: raw_ota.get(k)
        for k in (
            "in_progress",
            "awaiting_reboot",
            "status",
            "target_version",
            "previous_version",
            "verified_fw",
            "reason",
            "updated_at",
        )
        if k in raw_ota
    }

    safe_avail_ota = {
        k: raw_avail_ota.get(k)
        for k in ("version", "file_size", "release_notes", "released_at")
        if k in raw_avail_ota
    }

    return {
        "device_id": device_id,
        "online": bool(dev_data.get("online", False)),
        "connection_state": dev_data.get("connection_state"),
        "last_seen_at": dev_data.get("last_seen_at"),
        "connection": safe_conn,
        "settings": safe_settings,
        "state": safe_state,
        "ota_status": safe_ota,
        "available_ota": safe_avail_ota,
        "updated_at": now_server,
    }


def _pause_active_demo_schedules_best_effort(db: Any, device_ref: Any) -> int:
    """
    Pausa (coloca em quarentena) agendamentos `created_by_demo == True` ativos ao gerar
    ou revogar um passe temporário, mantendo a lista limpa entre sessões (F1.3).
    """
    paused = 0
    try:
        q = (
            device_ref.collection("schedules")
            .where("created_by_demo", "==", True)
            .where("enabled", "==", True)
            .limit(50)
        )
        for doc_snap in q.stream():
            doc_snap.reference.set({"enabled": False}, merge=True)
            paused += 1
    except Exception as err:
        _log("WARN", "demo_schedules_quarantine_warn", error=str(err))
    return paused


# =====================================================================================
# TÓPICOS MQTT, IDEMPOTÊNCIA E CONTEXTO DE AUTENTICAÇÃO
# =====================================================================================
def build_topics(device_id: str) -> dict[str, str]:
    """Gera os tópicos MQTT de comando e ACK específicos do dispositivo (uso interno)."""
    base = IOT_TOPIC_PREFIX
    return {
        "command_topic": f"{base}/{device_id}/command",
        "ack_topic": f"{base}/{device_id}/ack",
    }


def _command_id_from_idempotency_key(device_id: str, key: str) -> str:
    """Gera um `command_id` determinístico a partir do cabeçalho `Idempotency-Key`."""
    raw = f"{device_id}:{key}".encode("utf-8")
    h = hashlib.sha1(raw).hexdigest()[:16]
    return f"man-{h}"


def _extract_auth_details(event: dict[str, Any]) -> dict[str, str]:
    """
    Extrai `user_id`, `auth_mode`, `demo_sid`, `demo_device_id` e `is_demo` injetados
    pelo Custom Authorizer.
    """
    out: dict[str, str] = {
        "user_id": "",
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
    is_demo = str(auth.get("is_demo") or "false").strip().lower()
    out["is_demo"] = "true" if is_demo == "true" else "false"

    uid = auth.get("uid") or auth.get("user_id") or auth.get("sub") or auth.get("principalId")
    if isinstance(uid, str) and uid.strip() and uid.strip() not in ("user", "demo-pass-claim"):
        clean_uid = uid.strip()
        out["user_id"] = clean_uid
        _current_user_id.set(clean_uid)

    return out


def _extract_user_context(event: dict[str, Any]) -> dict[str, str]:
    """Compatibilidade com o builder de payload de comandos."""
    details = _extract_auth_details(event)
    if details.get("user_id"):
        return {"user_id": details["user_id"]}
    return {}


# =====================================================================================
# VALIDAÇÃO SINTÁTICA E RESOLUÇÃO DE ARTEFATO OTA NO AMAZON S3 (SEM DIRECT URL — F3.3)
# =====================================================================================
def _parse_semver_strict(v: Any) -> Optional[Tuple[int, int, int]]:
    """
    Valida e converte versão SemVer estrita X.Y.Z (sem pré-release) em tupla
    (major, minor, patch), após remover prefixo opcional v/V.
    """
    if not isinstance(v, str):
        return None
    clean = v.strip()
    if clean[:1] in ("v", "V"):
        clean = clean[1:]
    if not clean or len(clean) > 23:
        return None
    match = OTA_VERSION_RE.fullmatch(clean)
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def _build_ota_signing_message(version: str, sha256_hex: str, file_size: int) -> bytes:
    """Constrói a mensagem ASCII canônica v1 assinada por ECDSA P-256 (sem \n no final)."""
    return (
        f"{OTA_SIG_CONTEXT_V1}|{OTA_SIG_DEVICE_CLASS_V1}|{version}|{sha256_hex.lower()}|{int(file_size)}"
    ).encode("ascii")


def _verify_ota_signature_server_side(
    version: str,
    sha256_hex: str,
    file_size: int,
    sig_bytes: bytes,
) -> None:
    """
    Defesa em profundidade: se `OTA_SIGNING_PUBKEY_PEM_B64` estiver configurada e a
    biblioteca `cryptography` estiver instalada, verifica a assinatura ECDSA P-256
    sobre o contrato v1. Se a lib estiver ausente, apenas loga WARN e prossegue
    (o firmware é a autoridade final). Chave malformada ou assinatura inválida -> ValueError.
    """
    pubkey_b64 = (OTA_SIGNING_PUBKEY_PEM_B64 or "").strip()
    if not pubkey_b64:
        return

    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
    except ImportError:
        _log("WARN", "ota_server_sig_verify_unavailable", version=version)
        return

    try:
        pem_bytes = base64.b64decode(pubkey_b64, validate=True)
        pubkey = serialization.load_pem_public_key(pem_bytes)
        if not isinstance(pubkey, ec.EllipticCurvePublicKey) or not isinstance(
            pubkey.curve, ec.SECP256R1
        ):
            raise ValueError("Curva pública não é P-256.")
    except Exception as key_err:
        _log(
            "WARN",
            "ota_signing_pubkey_invalid",
            version=version,
            error_type=type(key_err).__name__,
        )
        raise ValueError("Chave pública de assinatura OTA inválida ou malformada.")

    if not sig_bytes:
        _log("WARN", "ota_signature_validation_failed", reason="missing_signature", version=version)
        raise ValueError(_OTA_INVALID_SIG_MSG)

    signing_msg = _build_ota_signing_message(version, sha256_hex, file_size)
    try:
        pubkey.verify(sig_bytes, signing_msg, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        _log(
            "WARN",
            "ota_signature_validation_failed",
            reason="ecdsa_verify_failed",
            version=version,
            sha256_prefix=sha256_hex[:12],
            sig_len=len(sig_bytes),
        )
        raise ValueError(_OTA_INVALID_SIG_MSG)
    except Exception as ver_err:
        _log(
            "WARN",
            "ota_signature_validation_failed",
            reason="ecdsa_verify_error",
            version=version,
            error_type=type(ver_err).__name__,
        )
        raise ValueError(_OTA_INVALID_SIG_MSG)


def _validate_ota_params_syntax(
    version: Any,
    s3_key_override: Optional[str] = None,
    sha256_override: Optional[str] = None,
) -> dict[str, Optional[str]]:
    """Valida sintaticamente os parâmetros de atualização remota OTA (100% em CPU)."""
    if not isinstance(version, str) or not version.strip():
        raise ValueError("O campo 'version' (ex: '5.24.0') é obrigatório para action='ota'")

    semver_tuple = _parse_semver_strict(version)
    if semver_tuple is None:
        raise ValueError(
            "Versão inválida para OTA: use apenas X.Y.Z (pré-releases não são aceitas)."
        )
    clean_ver = f"{semver_tuple[0]}.{semver_tuple[1]}.{semver_tuple[2]}"

    fixed_s3_key = f"firmware/v{clean_ver}/firmware.bin"
    if s3_key_override is not None and str(s3_key_override).strip():
        candidate_key = str(s3_key_override).strip().lstrip("/")
        if candidate_key != fixed_s3_key:
            raise ValueError(
                "s3_key inválida: o caminho da release OTA é fixo no servidor."
            )

    sha256_clean = (sha256_override or "").strip().lower()
    if sha256_clean and not SHA256_HEX_RE.match(sha256_clean):
        raise ValueError("sha256 inválido (deve conter exatamente 64 caracteres hexadecimais)")

    return {
        "clean_ver": clean_ver,
        "s3_key": fixed_s3_key,
        "sha256_clean": sha256_clean or None,
    }


def _resolve_ota_artifact(
    version: str,
    s3_key_override: Optional[str] = None,
    sha256_override: Optional[str] = None,
) -> dict[str, Any]:
    """
    Inspeciona os metadados da imagem de firmware exclusivamente no bucket privado S3
    (`OTA_S3_BUCKET`) em caminho fixo, valida assinatura v1 (ECDSA P-256) e gera
    Pre-Signed URL HTTPS temporária. Nunca registra a URL ou a assinatura em log.
    """
    validated = _validate_ota_params_syntax(
        version=version,
        s3_key_override=s3_key_override,
        sha256_override=sha256_override,
    )
    clean_ver = validated["clean_ver"] or ""
    s3_key = validated["s3_key"] or ""
    sha256_clean = validated["sha256_clean"] or ""

    if not OTA_S3_BUCKET:
        raise ValueError("Cofre S3 de atualização OTA não está configurado.")

    t0_s3 = time.perf_counter()
    try:
        head = s3_client.head_object(Bucket=OTA_S3_BUCKET, Key=s3_key)
        s3_head_ms = round((time.perf_counter() - t0_s3) * 1000.0, 2)
    except Exception as e:
        _log("WARN", "ota_s3_object_not_found", version=clean_ver, error_type=type(e).__name__)
        raise ValueError(
            f"Arquivo de firmware 'v{clean_ver}' ({s3_key}) ainda não foi publicado no cofre de atualizações."
        )

    raw_metadata = head.get("Metadata") or {}
    metadata = {
        str(k).strip().lower(): str(v).strip()
        for k, v in raw_metadata.items()
        if isinstance(k, str) and v is not None
    }
    s3_sha256 = (metadata.get("sha256") or metadata.get("sha-256") or "").lower()
    final_sha256 = sha256_clean or s3_sha256
    file_size = int(head.get("ContentLength") or 0)

    if not final_sha256 or not SHA256_HEX_RE.match(final_sha256):
        raise ValueError(
            "Metadado SHA-256 ausente no artefato S3. Publique o firmware usando o comando de release."
        )

    if sha256_clean and s3_sha256 and sha256_clean != s3_sha256:
        raise ValueError("Conflito de integridade: o sha256 informado difere do registrado no servidor.")

    if file_size <= 0:
        raise ValueError("Arquivo de firmware no servidor está vazio (0 bytes).")

    sig_b64 = metadata.get("signature", "").strip()
    sig_alg = metadata.get("sig-alg", "").strip()
    fw_version_meta = metadata.get("fw-version", "").strip()
    sig_bytes = b""

    if OTA_REQUIRE_SIGNATURE or sig_b64:
        if not sig_b64:
            _log("WARN", "ota_signature_validation_failed", reason="missing_signature", version=clean_ver)
            raise ValueError(_OTA_INVALID_SIG_MSG)

        try:
            sig_bytes = base64.b64decode(sig_b64, validate=True)
        except Exception:
            _log("WARN", "ota_signature_validation_failed", reason="invalid_base64", version=clean_ver)
            raise ValueError(_OTA_INVALID_SIG_MSG)

        if not (8 <= len(sig_bytes) <= 72):
            _log(
                "WARN",
                "ota_signature_validation_failed",
                reason="invalid_sig_length",
                version=clean_ver,
                sig_len=len(sig_bytes),
            )
            raise ValueError(_OTA_INVALID_SIG_MSG)

        if sig_alg != OTA_SIG_ALG_V1:
            _log(
                "WARN",
                "ota_signature_validation_failed",
                reason="invalid_sig_alg",
                version=clean_ver,
                sig_alg=sig_alg or "missing",
            )
            raise ValueError(_OTA_INVALID_SIG_MSG)

        if fw_version_meta != clean_ver:
            _log(
                "WARN",
                "ota_signature_validation_failed",
                reason="fw_version_mismatch",
                version=clean_ver,
                meta_fw_version=fw_version_meta or "missing",
            )
            raise ValueError(_OTA_INVALID_SIG_MSG)

        _verify_ota_signature_server_side(
            version=clean_ver,
            sha256_hex=final_sha256,
            file_size=file_size,
            sig_bytes=sig_bytes,
        )

    _log(
        "DEBUG",
        "ota_s3_head_object_ok",
        version=clean_ver,
        s3_head_latency_ms=s3_head_ms,
        file_size_bytes=file_size,
        sha256_prefix=final_sha256[:12],
        sig_len=len(sig_b64),
        sig_alg=sig_alg or None,
    )

    presigned_url = s3_client.generate_presigned_url(
        ClientMethod="get_object",
        Params={"Bucket": OTA_S3_BUCKET, "Key": s3_key},
        ExpiresIn=OTA_PRESIGNED_URL_TTL_SEC,
    )

    if len(presigned_url) > MAX_ESP32_OTA_URL_LEN:
        raise ValueError(
            f"Pre-Signed URL gerada ({len(presigned_url)} chars) excede o limite do buffer embarcado ({MAX_ESP32_OTA_URL_LEN})."
        )

    return {
        "version": clean_ver,
        "s3_key": s3_key,
        "ota_url": presigned_url,
        "sha256": final_sha256,
        "file_size": file_size,
        "sig": sig_b64,
        "sig_alg": sig_alg,
    }


# =====================================================================================
# INICIALIZAÇÃO DO FIRESTORE E GERENCIAMENTO ZERO-CREDENTIAL DE PASSES DEMO
# =====================================================================================
def _load_service_account_json() -> Optional[dict[str, Any]]:
    """Carrega as credenciais do Firebase Admin prioritariamente do AWS SSM Parameter Store."""
    secret_arn = (
        os.getenv("FIREBASE_SA_SECRET_ARN", "").strip()
        or os.getenv("GCP_SECRET_ARN", "").strip()
    )
    if secret_arn:
        try:
            resp = _agro_fetch_secret_or_ssm(secret_arn, AWS_REGION, _DEFAULT_BOTO_CONFIG)
            if "SecretString" in resp and resp["SecretString"]:
                return json.loads(resp["SecretString"])
            if "SecretBinary" in resp and resp["SecretBinary"]:
                decoded = base64.b64decode(resp["SecretBinary"]).decode("utf-8", errors="replace")
                return json.loads(decoded)
        except Exception as e:
            _log("ERROR", "secret_fetch_failed", error=str(e))
            return None

    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if sa_json:
        try:
            return json.loads(sa_json)
        except Exception as e:
            _log("ERROR", "firebase_sa_json_invalid", error=str(e))
            return None

    return None


def _get_firestore() -> Optional[Any]:
    """Obtém a instância Singleton do cliente Firestore (reutilizada entre Warm Starts)."""
    global _firestore_client

    if not FIREBASE_AVAILABLE:
        return None

    if _firestore_client is not None:
        return _firestore_client

    if getattr(firebase_admin, "_apps", None) and firebase_admin._apps:
        _firestore_client = firestore.client()
        return _firestore_client

    sa_obj = _load_service_account_json()
    if sa_obj:
        cred = credentials.Certificate(sa_obj)
        firebase_admin.initialize_app(cred)
        _log("INFO", "firebase_init_ok", mode="ssm_parameter_store", project_id=sa_obj.get("project_id"))
    else:
        try:
            firebase_admin.initialize_app()
            _log("INFO", "firebase_init_ok", mode="default_credentials")
        except Exception:
            _log("WARN", "firebase_no_credentials", message="Sem credenciais Firebase.")
            return None

    _firestore_client = firestore.client()
    return _firestore_client


def _verify_app_check_token(event: dict[str, Any]) -> dict[str, Any]:
    """
    Verifica o cabeçalho `X-Firebase-AppCheck` (Fase 2C.2). Nunca lança exceção e nunca
    registra o token. Retorna {"status": valid|missing|invalid|off, "reason"?, "app"?}.
    """
    global _appcheck_jwks_client

    if APPCHECK_MODE == "off":
        return {"status": "off"}
    token = (_get_headers(event).get("x-firebase-appcheck") or "").strip()
    if not token:
        return {"status": "missing"}
    if len(token) > 4096 or not _APPCHECK_TOKEN_RE.match(token):
        return {"status": "invalid", "reason": "malformed"}
    if not re.fullmatch(r"[0-9]{6,20}", APPCHECK_PROJECT_NUMBER) or not APPCHECK_APP_IDS:
        return {"status": "invalid", "reason": "config_missing"}
    try:
        import jwt  # PyJWT (layer agrosmart-firebase-admin-py311)
    except Exception:
        return {"status": "invalid", "reason": "lib_missing"}
    try:
        header = jwt.get_unverified_header(token)
        if header.get("typ") != "JWT" or header.get("alg") != "RS256":
            return {"status": "invalid", "reason": "bad_header"}
        if _appcheck_jwks_client is None:
            _appcheck_jwks_client = jwt.PyJWKClient(
                _APPCHECK_JWKS_URL, cache_keys=True, lifespan=21600, timeout=3
            )
        signing_key = _appcheck_jwks_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=f"projects/{APPCHECK_PROJECT_NUMBER}",
            issuer=f"https://firebaseappcheck.googleapis.com/{APPCHECK_PROJECT_NUMBER}",
            leeway=5,
            options={"require": ["exp", "iat", "sub", "aud", "iss"]},
        )
        app_id = str(claims.get("sub") or "")
        if app_id not in APPCHECK_APP_IDS:
            return {"status": "invalid", "reason": "app_not_allowed", "app": app_id[-24:]}
        return {"status": "valid", "app": app_id[-24:]}
    except Exception as exc:  # noqa: BLE001 — qualquer falha vira "invalid" com o tipo do erro
        return {"status": "invalid", "reason": type(exc).__name__[:60]}


def _resolve_demo_uid_only() -> str:
    """
    Obtém e revalida o UID da conta de Usuário Teste via Firebase Auth sem tocar no
    Firestore antes de validar o código de convite (Fase 1C):
      - Se `DEMO_AUTH_UID` estiver presente e válida (`^[A-Za-z0-9]{1,128}$`), consulta
        apenas `fb_auth.get_user(uid)` (nunca `get_user_by_email`);
      - Caso contrário, usa fallback por `DEMO_PRIMARY_EMAIL` emitindo o aviso
        `WARN demo_auth_uid_env_missing` uma única vez por container (sem PII).
    Nunca inclui endereços de e-mail em mensagens de erro ou exceções.
    """
    global _cached_demo_account_uid, _demo_auth_uid_env_warned

    configured_uid = (
        DEMO_AUTH_UID.strip()
        if isinstance(DEMO_AUTH_UID, str) and DEMO_AUTH_UID_RE.match(DEMO_AUTH_UID.strip())
        else ""
    )

    if configured_uid:
        if fb_auth is None:
            raise RuntimeError(_GENERIC_DEMO_UNAVAILABLE_MSG)

        if _cached_demo_account_uid and _cached_demo_account_uid != configured_uid:
            _cached_demo_account_uid = None

        try:
            user_rec = fb_auth.get_user(configured_uid)
            if user_rec and getattr(user_rec, "uid", None) and not getattr(user_rec, "disabled", False):
                resolved_uid = str(user_rec.uid).strip()
                _cached_demo_account_uid = resolved_uid
                return resolved_uid
            _cached_demo_account_uid = None
        except Exception as auth_lookup_err:
            _cached_demo_account_uid = None
            _log("WARN", "demo_auth_lookup_failed", error_type=type(auth_lookup_err).__name__)

        raise RuntimeError(_GENERIC_DEMO_UNAVAILABLE_MSG)

    # Fallback legado por e-mail quando DEMO_AUTH_UID está ausente ou inválida (aviso único por container)
    if not _demo_auth_uid_env_warned:
        _demo_auth_uid_env_warned = True
        _log(
            "WARN",
            "demo_auth_uid_env_missing",
            fallback="email_lookup",
        )

    demo_uid = _cached_demo_account_uid
    if demo_uid and fb_auth is not None:
        try:
            cached_rec = fb_auth.get_user(demo_uid)
            if not cached_rec or getattr(cached_rec, "disabled", False):
                _cached_demo_account_uid = None
                demo_uid = None
        except Exception:
            _cached_demo_account_uid = None
            demo_uid = None

    if not demo_uid and fb_auth is not None:
        try:
            user_record = fb_auth.get_user_by_email(DEMO_PRIMARY_EMAIL)
            if user_record and getattr(user_record, "uid", None) and not getattr(user_record, "disabled", False):
                demo_uid = str(user_record.uid).strip()
                _cached_demo_account_uid = demo_uid
        except Exception as auth_lookup_err:
            _log("WARN", "demo_auth_lookup_failed", error_type=type(auth_lookup_err).__name__)

    if not demo_uid:
        raise RuntimeError(_GENERIC_DEMO_UNAVAILABLE_MSG)

    return demo_uid


def _sync_demo_user_profile_after_claim(db: Any, demo_uid: str, device_id: str) -> None:
    """
    Sincroniza o documento `users/{demo_uid}` no Firestore definindo `my_devices = [device_id]`
    exclusivamente APÓS o passe temporário ter sido validado e reivindicado com sucesso.
    Não grava o campo `email` em documentos novos nem acrescenta `email` em existentes (Fase 1C).
    """
    try:
        user_ref = db.collection("users").document(demo_uid)
        user_snap = user_ref.get()
        now_server = firestore.SERVER_TIMESTAMP
        if not user_snap.exists:
            user_ref.set(
                {
                    "uid": demo_uid,
                    "name": "Usuário Teste AgroSmart",
                    "role": "recruiter",
                    "my_devices": [device_id],
                    "created_at": now_server,
                    "updated_at": now_server,
                }
            )
        else:
            u_data = user_snap.to_dict() or {}
            user_ref.set(
                {
                    "role": u_data.get("role") or "recruiter",
                    "my_devices": [device_id],
                    "updated_at": now_server,
                },
                merge=True,
            )
    except Exception as prof_err:
        _log("WARN", "ensure_demo_user_profile_warn", error=str(prof_err))


def _generate_high_entropy_demo_code() -> Tuple[str, str]:
    """Gera código criptograficamente seguro (`AGRO-XXXX-XXXX`) via módulo `secrets`."""
    part1 = "".join(secrets.choice(DEMO_CODE_ALPHABET) for _ in range(4))
    part2 = "".join(secrets.choice(DEMO_CODE_ALPHABET) for _ in range(4))
    return f"AGRO-{part1}-{part2}", f"AGRO-****-{part2}"


def _handle_owner_generate_demo_pass(
    body: dict[str, Any],
    event: dict[str, Any],
    auth_details: dict[str, str],
) -> dict[str, Any]:
    """
    Ação exclusiva do Operador Titular (`action == "generate_demo_pass"` — A2e, M1d, Fase 1B):
      1. Verifica propriedade estrita (`owner_uid == user_id`, `is_demo != "true"`);
      2. Valida `MIN_DEMO_PASS_MINUTES <= duration_minutes <= DEMO_MAX_PASS_MINUTES`;
      3. Gera código de alta entropia no servidor e inicializa `private/demo_auth`
         com contadores de cota (`demo_on_seconds_used=0`, `demo_last_on_epoch=0`)
         e lockout (`fail_window_start_epoch=0`, `failed_attempts=0`, `locked_until_epoch=0`);
      4. Atualiza `devices/{id}.demo_summary` zerando `locked_until_epoch=0` e
         gravando `token_hash_prefix=""`, além de limpar campos legados `settings.demo_*`;
      5. Cria/atualiza a projeção sanitizada `devices/{id}/demo_view/current`;
      6. Pausa agendas demo ativas de sessões anteriores.
    """
    user_id = auth_details.get("user_id") or ""
    if not user_id or auth_details.get("is_demo") == "true":
        return build_response(403, {"message": "Forbidden"}, event, extra_headers=_NO_STORE_HEADERS)

    device_id = str(body.get("device_id") or "").strip()
    if not device_id or not DEVICE_ID_RE.match(device_id):
        return build_response(400, {"message": "device_id obrigatório e válido."}, event, extra_headers=_NO_STORE_HEADERS)
    _current_device_id.set(device_id)

    try:
        duration_minutes = parse_int(body.get("duration_minutes"), default=60)
    except ValueError:
        return build_response(400, {"message": "duration_minutes inválido."}, event, extra_headers=_NO_STORE_HEADERS)

    if duration_minutes < MIN_DEMO_PASS_MINUTES or duration_minutes > DEMO_MAX_PASS_MINUTES:
        return build_response(
            400,
            {"message": f"duration_minutes deve estar entre {MIN_DEMO_PASS_MINUTES} e {DEMO_MAX_PASS_MINUTES}."},
            event,
            extra_headers=_NO_STORE_HEADERS,
        )

    db = _get_firestore()
    if db is None:
        return build_response(
            503,
            {"message": "Serviço temporariamente indisponível."},
            event,
            extra_headers=_NO_STORE_HEADERS,
        )

    plain_code, masked_hint = _generate_high_entropy_demo_code()
    sha256_hash = hashlib.sha256(plain_code.encode("utf-8")).hexdigest().lower()
    now_epoch = int(time.time())
    expires_epoch = now_epoch + (duration_minutes * 60)
    now_server = firestore.SERVER_TIMESTAMP

    device_ref = db.collection("devices").document(device_id)
    demo_auth_ref = device_ref.collection("private").document("demo_auth")
    demo_view_ref = device_ref.collection("demo_view").document("current")

    @gcf_firestore.transactional
    def _tx_generate(transaction: Any) -> str:
        dev_snap = device_ref.get(transaction=transaction)
        if not dev_snap.exists:
            return "not_found"
        dev_data = dev_snap.to_dict() or {}
        owner = dev_data.get("owner_uid") or dev_data.get("ownerUid")
        if not isinstance(owner, str) or owner != user_id:
            return "forbidden"

        transaction.set(
            demo_auth_ref,
            {
                "token_hash": sha256_hash,
                "token_hint": masked_hint,
                "expires_epoch": expires_epoch,
                "pass_claimed": False,
                "session_id": "",
                "fail_window_start_epoch": 0,
                "failed_attempts": 0,
                "locked_until_epoch": 0,
                "last_failed_epoch": 0,
                "demo_on_seconds_used": 0,
                "demo_last_on_epoch": 0,
                "created_by_uid": user_id,
                "created_at": now_server,
                "updated_at": now_server,
            },
        )

        cleanup_and_summary: dict[str, Any] = {
            "demo_summary": {
                "active": True,
                "token_hint": masked_hint,
                "token_hash_prefix": "",
                "expires_epoch": expires_epoch,
                "pass_claimed": False,
                "failed_attempts": 0,
                "locked_brute_force": False,
                "locked_until_epoch": 0,
                "updated_at": now_server,
            },
            "updated_at": now_server,
        }
        for legacy_key in _LEGACY_SETTINGS_DEMO_KEYS:
            cleanup_and_summary[legacy_key] = gcf_firestore.DELETE_FIELD
        transaction.update(device_ref, cleanup_and_summary)

        demo_view_doc = _build_sanitized_demo_view_doc(
            device_id=device_id,
            dev_data=dev_data,
            demo_expires_epoch=expires_epoch,
            demo_pass_claimed=False,
            now_server=now_server,
        )
        transaction.set(demo_view_ref, demo_view_doc)
        return "ok"

    tx_status = _tx_generate(db.transaction())
    if tx_status == "not_found":
        return build_response(404, {"message": "Estação não encontrada."}, event, extra_headers=_NO_STORE_HEADERS)
    if tx_status == "forbidden":
        return build_response(403, {"message": "Forbidden"}, event, extra_headers=_NO_STORE_HEADERS)

    paused_count = _pause_active_demo_schedules_best_effort(db, device_ref)
    _log(
        "INFO",
        "demo_pass_generated_by_owner",
        duration_minutes=duration_minutes,
        expires_epoch=expires_epoch,
        token_hint=masked_hint,
        old_demo_schedules_paused=paused_count,
    )

    return build_response(
        200,
        {
            "ok": True,
            "message": "Passe temporário gerado com sucesso no servidor.",
            "device_id": device_id,
            "plain_code": plain_code,
            "token_hint": masked_hint,
            "expires_epoch": expires_epoch,
            "old_demo_schedules_paused": paused_count,
        },
        event,
        extra_headers=_NO_STORE_HEADERS,
    )


def _handle_owner_revoke_demo_pass(
    body: dict[str, Any],
    event: dict[str, Any],
    auth_details: dict[str, str],
) -> dict[str, Any]:
    """
    Ação exclusiva do Operador Titular (`action == "revoke_demo_pass"` — F1.1, F1.4, Fase 1B):
    invalida imediatamente o passe e a sessão ativa em `private/demo_auth`, zera
    `demo_summary.locked_until_epoch` e demais campos, atualiza `demo_view/current`,
    limpa campos legados e pausa agendas demo.
    """
    user_id = auth_details.get("user_id") or ""
    if not user_id or auth_details.get("is_demo") == "true":
        return build_response(403, {"message": "Forbidden"}, event, extra_headers=_NO_STORE_HEADERS)

    device_id = str(body.get("device_id") or "").strip()
    if not device_id or not DEVICE_ID_RE.match(device_id):
        return build_response(400, {"message": "device_id obrigatório e válido."}, event, extra_headers=_NO_STORE_HEADERS)
    _current_device_id.set(device_id)

    db = _get_firestore()
    if db is None:
        return build_response(
            503,
            {"message": "Serviço temporariamente indisponível."},
            event,
            extra_headers=_NO_STORE_HEADERS,
        )

    now_server = firestore.SERVER_TIMESTAMP
    device_ref = db.collection("devices").document(device_id)
    demo_auth_ref = device_ref.collection("private").document("demo_auth")
    demo_view_ref = device_ref.collection("demo_view").document("current")

    @gcf_firestore.transactional
    def _tx_revoke(transaction: Any) -> str:
        dev_snap = device_ref.get(transaction=transaction)
        demo_view_snap = demo_view_ref.get(transaction=transaction)
        if not dev_snap.exists:
            return "not_found"
        dev_data = dev_snap.to_dict() or {}
        owner = dev_data.get("owner_uid") or dev_data.get("ownerUid")
        if not isinstance(owner, str) or owner != user_id:
            return "forbidden"

        transaction.set(
            demo_auth_ref,
            {
                "token_hash": "",
                "token_hint": "",
                "expires_epoch": 0,
                "pass_claimed": False,
                "session_id": "",
                "fail_window_start_epoch": 0,
                "failed_attempts": 0,
                "locked_until_epoch": 0,
                "last_failed_epoch": 0,
                "demo_on_seconds_used": 0,
                "demo_last_on_epoch": 0,
                "revoked_by_uid": user_id,
                "updated_at": now_server,
            },
            merge=True,
        )

        cleanup_and_summary: dict[str, Any] = {
            "demo_summary": {
                "active": False,
                "token_hint": "",
                "token_hash_prefix": "",
                "expires_epoch": 0,
                "pass_claimed": False,
                "failed_attempts": 0,
                "locked_brute_force": False,
                "locked_until_epoch": 0,
                "updated_at": now_server,
            },
            "updated_at": now_server,
        }
        for legacy_key in _LEGACY_SETTINGS_DEMO_KEYS:
            cleanup_and_summary[legacy_key] = gcf_firestore.DELETE_FIELD
        transaction.update(device_ref, cleanup_and_summary)

        if demo_view_snap.exists:
            transaction.set(
                demo_view_ref,
                {
                    "settings": {
                        "demo_expires_epoch": 0,
                        "demo_pass_claimed": False,
                    },
                    "updated_at": now_server,
                },
                merge=True,
            )
        return "ok"

    tx_status = _tx_revoke(db.transaction())
    if tx_status == "not_found":
        return build_response(404, {"message": "Estação não encontrada."}, event, extra_headers=_NO_STORE_HEADERS)
    if tx_status == "forbidden":
        return build_response(403, {"message": "Forbidden"}, event, extra_headers=_NO_STORE_HEADERS)

    paused_count = _pause_active_demo_schedules_best_effort(db, device_ref)
    _log("INFO", "demo_pass_revoked_by_owner", old_demo_schedules_paused=paused_count)

    return build_response(
        200,
        {
            "ok": True,
            "message": "Acesso de Usuário Teste revogado imediatamente no servidor.",
            "device_id": device_id,
            "old_demo_schedules_paused": paused_count,
        },
        event,
        extra_headers=_NO_STORE_HEADERS,
    )


def _rollback_demo_claim_on_token_error(
    db: Any,
    device_ref: Any,
    demo_auth_ref: Any,
    demo_view_ref: Any,
    expected_session_id: str,
) -> None:
    """
    Rollback compensatório (F3.2): caso `create_custom_token` falhe após o commit da
    transação de resgate, devolve o passe ao estado não consumido (`pass_claimed = False`)
    somente se a sessão ainda corresponder a `expected_session_id`.
    """
    now_server = firestore.SERVER_TIMESTAMP

    @gcf_firestore.transactional
    def _tx_undo(transaction: Any) -> None:
        auth_snap = demo_auth_ref.get(transaction=transaction)
        view_snap = demo_view_ref.get(transaction=transaction)
        if not auth_snap.exists:
            return
        auth_data = auth_snap.to_dict() or {}
        if str(auth_data.get("session_id") or "") != expected_session_id:
            return
        transaction.update(
            demo_auth_ref,
            {
                "pass_claimed": False,
                "session_id": "",
                "updated_at": now_server,
            },
        )
        transaction.update(
            device_ref,
            {
                "demo_summary.pass_claimed": False,
                "demo_summary.updated_at": now_server,
            },
        )
        if view_snap.exists:
            transaction.set(
                demo_view_ref,
                {"settings": {"demo_pass_claimed": False}, "updated_at": now_server},
                merge=True,
            )

    try:
        _tx_undo(db.transaction())
        _log("WARN", "demo_pass_claim_rolled_back_after_token_error")
    except Exception as undo_err:
        _log("ERROR", "demo_pass_claim_rollback_failed", error=str(undo_err))


def _handle_claim_demo_pass(
    body: dict[str, Any],
    event: dict[str, Any],
    *,
    ignore_auth_header: bool = False,
) -> dict[str, Any]:
    """
    Valida em Transação ACID o código de convite de uso único (`AGRO-XXXX-XXXX`) contra
    `devices/{device_id}/private/demo_auth` (M1 + Fase 1B + Fase 1C):
      - Exige `device_id` explícito;
      - Consome atomicamente orçamento de tentativas por IP no DynamoDB ANTES da
        checagem de formato e de qualquer acesso ao Firestore;
      - Quando `ignore_auth_header=True` (`POST /demo/claim`), lê o passe exclusivamente
        de `body["demo_pass_token"]`, ignorando o cabeçalho `Authorization`;
      - Aplica lockout temporário por passe (janela fixa, sem destruir o passe),
        espelhando `demo_summary.locked_until_epoch` no bloqueio e zerando no sucesso;
      - Responde com HTTP 403 genérico idêntico (`{"message": _GENERIC_CLAIM_DENIED_MSG}`)
        e atraso uniforme (0,35 s) em TODAS as rejeições (incluindo passe bloqueado),
        sem expor `reason` nem `locked_until_epoch` ao cliente anônimo;
      - Envia `Cache-Control: no-store`, atualiza `demo_view/current` e zera cota Demo;
      - Executa rollback compensatório caso `create_custom_token` falhe.
    """
    device_id = str(body.get("device_id") or "").strip()
    if not device_id or not DEVICE_ID_RE.match(device_id):
        time.sleep(CLAIM_REJECTION_DELAY_SEC)
        return build_response(
            400,
            {"message": "Informe um identificador de estação (device_id) válido."},
            event,
            extra_headers=_NO_STORE_HEADERS,
        )
    _current_device_id.set(device_id)

    source_ip = _extract_source_ip(event)
    if not _consume_ip_claim_attempt(source_ip):
        _log("WARN", "demo_pass_claim_ip_budget_exhausted", ip_hash=_hash_ip(source_ip))
        time.sleep(CLAIM_REJECTION_DELAY_SEC)
        return build_response(
            429,
            {
                "message": "Muitas tentativas incorretas a partir deste endereço IP. Aguarde 1 minuto antes de tentar novamente."
            },
            event,
            extra_headers={**_NO_STORE_HEADERS, "Retry-After": "60"},
        )

    if ignore_auth_header:
        candidate_token = str(body.get("demo_pass_token") or "").strip().upper()
    else:
        headers = _get_headers(event)
        raw_auth = headers.get("authorization", "").strip()
        bearer_token = (
            raw_auth[7:].strip()
            if raw_auth.lower().startswith("bearer ")
            else raw_auth
        )
        candidate_token = str(body.get("demo_pass_token") or bearer_token or "").strip().upper()

    if not DEMO_INVITE_PASS_RE.match(candidate_token):
        time.sleep(CLAIM_REJECTION_DELAY_SEC)
        return build_response(
            400,
            {
                "message": "Formato de código inválido. Use o padrão AGRO-XXXX-XXXX fornecido pelo administrador."
            },
            event,
            extra_headers=_NO_STORE_HEADERS,
        )

    db = _get_firestore()
    if db is None or fb_auth is None:
        return build_response(
            503,
            {"message": "Serviço de autenticação temporariamente indisponível."},
            event,
            extra_headers=_NO_STORE_HEADERS,
        )

    try:
        demo_uid = _resolve_demo_uid_only()
    except RuntimeError as cfg_err:
        _log("ERROR", "demo_account_missing_in_firebase_auth", error=str(cfg_err))
        return build_response(
            503,
            {"message": _GENERIC_DEMO_UNAVAILABLE_MSG},
            event,
            extra_headers=_NO_STORE_HEADERS,
        )

    candidate_hash = hashlib.sha256(candidate_token.encode("utf-8")).hexdigest().lower()
    now_epoch = int(time.time())
    now_server = firestore.SERVER_TIMESTAMP
    new_session_id = f"dsid-{secrets.token_hex(12)}"
    device_ref = db.collection("devices").document(device_id)
    demo_auth_ref = device_ref.collection("private").document("demo_auth")
    demo_view_ref = device_ref.collection("demo_view").document("current")

    @gcf_firestore.transactional
    def _tx_claim(transaction: Any) -> Tuple[str, int]:
        dev_snap = device_ref.get(transaction=transaction)
        auth_snap = demo_auth_ref.get(transaction=transaction)
        if not dev_snap.exists:
            return ("device_not_found", 0)
        if not auth_snap.exists:
            return ("no_active_pass", 0)

        dev_data = dev_snap.to_dict() or {}
        auth_data = auth_snap.to_dict() or {}

        stored_hash = str(auth_data.get("token_hash") or "").strip().lower()
        expires_epoch = _safe_nonneg_int(auth_data.get("expires_epoch"), 0)
        is_claimed = bool(auth_data.get("pass_claimed") is True)

        if not stored_hash or expires_epoch <= 0:
            return ("no_active_pass", 0)

        if now_epoch >= expires_epoch:
            return ("expired", expires_epoch)

        if is_claimed:
            return ("already_claimed", expires_epoch)

        if _evaluate_claim_lock(auth_data, now_epoch):
            return ("temporarily_locked", _safe_nonneg_int(auth_data.get("locked_until_epoch"), 0))

        if not hmac.compare_digest(stored_hash, candidate_hash):
            next_fail_state = _next_claim_failure_state(auth_data, now_epoch)
            is_now_locked = next_fail_state["locked_until_epoch"] > now_epoch

            transaction.update(
                demo_auth_ref,
                {
                    **next_fail_state,
                    "updated_at": now_server,
                },
            )
            transaction.update(
                device_ref,
                {
                    "demo_summary.failed_attempts": next_fail_state["failed_attempts"],
                    "demo_summary.locked_brute_force": is_now_locked,
                    "demo_summary.locked_until_epoch": next_fail_state["locked_until_epoch"],
                    "demo_summary.updated_at": now_server,
                },
            )

            if is_now_locked:
                return ("locked_now", next_fail_state["locked_until_epoch"])

            remaining = max(0, MAX_DEMO_FAILED_ATTEMPTS - next_fail_state["failed_attempts"])
            return ("invalid_code", remaining)

        # Hash SHA-256 validado! Queima o convite (Uso Único), vincula a sessão e zera cota/falhas
        transaction.update(
            demo_auth_ref,
            {
                "pass_claimed": True,
                "session_id": new_session_id,
                "fail_window_start_epoch": 0,
                "failed_attempts": 0,
                "locked_until_epoch": 0,
                "last_failed_epoch": 0,
                "demo_on_seconds_used": 0,
                "demo_last_on_epoch": 0,
                "claimed_at": now_server,
                "updated_at": now_server,
            },
        )
        transaction.update(
            device_ref,
            {
                "demo_summary.pass_claimed": True,
                "demo_summary.token_hash_prefix": "",
                "demo_summary.failed_attempts": 0,
                "demo_summary.locked_brute_force": False,
                "demo_summary.locked_until_epoch": 0,
                "demo_summary.claimed_at": now_server,
                "demo_summary.updated_at": now_server,
            },
        )
        demo_view_doc = _build_sanitized_demo_view_doc(
            device_id=device_id,
            dev_data=dev_data,
            demo_expires_epoch=expires_epoch,
            demo_pass_claimed=True,
            now_server=now_server,
        )
        transaction.set(demo_view_ref, demo_view_doc)
        return ("claimed_ok", expires_epoch)

    status_code_str, aux_val = _tx_claim(db.transaction())

    if status_code_str != "claimed_ok":
        time.sleep(CLAIM_REJECTION_DELAY_SEC)

        if status_code_str in ("temporarily_locked", "locked_now"):
            _log(
                "WARN",
                "demo_pass_temporarily_locked",
                reason=status_code_str,
                locked_until_epoch=aux_val,
                ip_hash=_hash_ip(source_ip),
            )
        else:
            _log(
                "WARN",
                "demo_pass_claim_rejected",
                reason=status_code_str,
                remaining_attempts=aux_val if status_code_str == "invalid_code" else None,
                ip_hash=_hash_ip(source_ip),
            )

        # Resposta 403 estritamente genérica para o anônimo (sem reason nem locked_until_epoch)
        return build_response(
            403,
            {"message": _GENERIC_CLAIM_DENIED_MSG},
            event,
            extra_headers=_NO_STORE_HEADERS,
        )

    developer_claims = {
        "is_demo": True,
        "demo_sid": new_session_id,
        "demo_device_id": device_id,
    }
    try:
        raw_custom_token = fb_auth.create_custom_token(demo_uid, developer_claims=developer_claims)
        custom_token_str = (
            raw_custom_token.decode("utf-8")
            if isinstance(raw_custom_token, (bytes, bytearray))
            else str(raw_custom_token)
        )
    except Exception as tok_err:
        _log("ERROR", "demo_custom_token_creation_failed", error_type=type(tok_err).__name__)
        _rollback_demo_claim_on_token_error(
            db=db,
            device_ref=device_ref,
            demo_auth_ref=demo_auth_ref,
            demo_view_ref=demo_view_ref,
            expected_session_id=new_session_id,
        )
        return build_response(
            503,
            {"message": "Falha temporária ao emitir sessão de teste. Tente novamente."},
            event,
            extra_headers=_NO_STORE_HEADERS,
        )

    _sync_demo_user_profile_after_claim(db, demo_uid, device_id)

    _log(
        "INFO",
        "demo_pass_claimed_custom_token_issued",
        demo_uid=demo_uid,
        demo_sid_prefix=_safe_demo_sid_prefix(new_session_id),
        expires_epoch=aux_val,
    )

    return build_response(
        200,
        {
            "ok": True,
            "message": "Passe temporário validado com sucesso.",
            "custom_token": custom_token_str,
            "demo_session_id": new_session_id,
            "expires_epoch": aux_val,
            "device_id": device_id,
        },
        event,
        extra_headers=_NO_STORE_HEADERS,
    )


class _OtaPublishRejected(ValueError):
    """v5.33.0: recusa controlada da publicação OTA, com motivo estável para o CloudShell."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def _handle_internal_publish_ota_release(event: dict[str, Any]) -> dict[str, Any]:
    """
    Ação administrativa invocada diretamente via AWS CloudShell (`aws lambda invoke`)
    após o upload de um novo `firmware.bin` para o Amazon S3.
    """
    raw_version = str(event.get("version") or "").strip()
    release_notes = str(
        event.get("release_notes")
        or f"Firmware v{raw_version.lstrip('vV')} verificado com SHA-256 no Amazon S3."
    ).strip()[:280]
    target_device_id = str(event.get("device_id") or "").strip()

    # v5.33.0 (Fase 3C item 5): publicação sempre para UMA estação explícita.
    if not target_device_id or target_device_id.lower() == "all":
        raise _OtaPublishRejected(
            "device_id_required",
            "Informe o device_id da estação; publicação para todas foi desativada.",
        )
    if not DEVICE_ID_RE.match(target_device_id):
        raise _OtaPublishRejected("device_id_invalid", "device_id em formato inválido.")

    ota_info = _resolve_ota_artifact(
        version=raw_version,
        s3_key_override=event.get("s3_key"),
        sha256_override=event.get("sha256"),
    )

    db = _get_firestore()
    if db is None:
        raise RuntimeError("Firestore indisponível na Lambda para publicar release OTA.")

    new_ver_tuple = _parse_semver_strict(ota_info["version"])
    if new_ver_tuple is None:
        raise ValueError("Versão inválida para publicação OTA.")

    target_snaps: List[Tuple[Any, Optional[dict[str, Any]]]] = []
    doc_ref = db.collection("devices").document(target_device_id)
    snap = doc_ref.get()
    if not snap.exists:
        raise _OtaPublishRejected("device_not_found", "Estação não encontrada em devices/.")
    dev_data = snap.to_dict() or {}
    if not str(dev_data.get("owner_uid") or "").strip():
        raise _OtaPublishRejected("device_without_owner", "Estação sem titular (owner_uid).")
    target_snaps.append((doc_ref, dev_data))

    # Versões imutáveis: bloqueia downgrade de release e reescrita com SHA diferente
    for _, dev_dict in target_snaps:
        if not isinstance(dev_dict, dict):
            continue
        existing_avail = dev_dict.get("available_ota")
        if not isinstance(existing_avail, dict) or not existing_avail.get("version"):
            continue
        existing_tuple = _parse_semver_strict(existing_avail.get("version"))
        if existing_tuple is None:
            continue
        if new_ver_tuple < existing_tuple:
            raise ValueError(
                f"Não é permitido publicar versão menor (v{ota_info['version']}) que a release atual (v{existing_avail.get('version')})."
            )
        if new_ver_tuple == existing_tuple:
            existing_sha = str(existing_avail.get("sha256") or "").strip().lower()
            if existing_sha != ota_info["sha256"]:
                raise ValueError(
                    f"A versão v{ota_info['version']} já foi publicada com outro hash SHA-256; gere uma versão nova."
                )

    now_server = firestore.SERVER_TIMESTAMP
    is_signed = bool(ota_info.get("sig") and ota_info.get("sig_alg"))
    available_ota_map = {
        "version": ota_info["version"],
        "s3_key": ota_info["s3_key"],
        "sha256": ota_info["sha256"],
        "file_size": ota_info["file_size"],
        "sig_alg": ota_info.get("sig_alg") or "",
        "signed": is_signed,
        "release_notes": release_notes,
        "released_at": now_server,
        "updated_at": now_server,
    }
    demo_available_ota_map = {
        "version": ota_info["version"],
        "file_size": ota_info["file_size"],
        "sig_alg": ota_info.get("sig_alg") or "",
        "signed": is_signed,
        "release_notes": release_notes,
        "released_at": now_server,
    }

    updated_devices: List[str] = []
    for doc_ref, _ in target_snaps:
        doc_ref.set({"available_ota": available_ota_map, "updated_at": now_server}, merge=True)
        demo_view_ref = doc_ref.collection("demo_view").document("current")
        if demo_view_ref.get().exists:
            demo_view_ref.set(
                {"available_ota": demo_available_ota_map, "updated_at": now_server},
                merge=True,
            )
        updated_devices.append(doc_ref.id)

    _log(
        "INFO",
        "ota_release_published_to_firestore",
        version=ota_info["version"],
        sha256_prefix=ota_info["sha256"][:12],
        sig_len=len(ota_info.get("sig") or ""),
        sig_alg=ota_info.get("sig_alg") or None,
        file_size=ota_info["file_size"],
        updated_devices=updated_devices,
    )

    return {
        "statusCode": 200,
        "ok": True,
        "message": f"Release OTA v{ota_info['version']} publicada com sucesso no Firestore!",
        "version": ota_info["version"],
        "sha256": ota_info["sha256"],
        "file_size": ota_info["file_size"],
        "s3_key": ota_info["s3_key"],
        "updated_devices": updated_devices,
    }


def _fetch_owner_device_available_ota(
    device_id: str, user_id: Optional[str]
) -> Tuple[str, Optional[dict[str, Any]]]:
    """
    Verifica propriedade estrita (`owner_uid == user_id`) e lê `available_ota` do
    Firestore como fonte única da release OTA para `POST /command`.
    Retorna `(status, available_ota)` onde status é "ok", "forbidden" ou "unavailable".
    """
    if ENFORCE_DEVICE_OWNERSHIP and not user_id:
        return ("forbidden", None)

    db = _get_firestore()
    if db is None:
        return ("unavailable", None)

    try:
        snap = db.collection("devices").document(device_id).get()
        if not snap.exists:
            return ("forbidden", None)
        data = snap.to_dict() or {}
        if ENFORCE_DEVICE_OWNERSHIP:
            owner = data.get("owner_uid") or data.get("ownerUid")
            if not (isinstance(owner, str) and owner == user_id):
                return ("forbidden", None)
        avail = data.get("available_ota")
        return ("ok", avail if isinstance(avail, dict) else None)
    except Exception as e:
        _log("ERROR", "ota_precheck_firestore_error", device_id=device_id, error_type=type(e).__name__)
        return ("unavailable", None)


def _precheck_device_ownership_for_ota(device_id: str, user_id: Optional[str]) -> bool:
    """Compatibilidade: verifica se o chamador é proprietário da estação para OTA."""
    status, _ = _fetch_owner_device_available_ota(device_id, user_id)
    return status == "ok"


def _is_valve_lock_still_active(state: dict[str, Any], now_utc: datetime.datetime) -> bool:
    """
    A reserva pendente e a abertura confirmada bloqueiam novos comandos ON.
    Caso `reservation_expires_epoch` esteja ausente/inválido num registro legado,
    aplica fallback seguro a partir de `reserved_epoch` para impedir bloqueio infinito.
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
                + MAX_DURATION_SECONDS
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


def _is_ota_lock_still_active(ota_status: dict[str, Any], now_epoch: int) -> bool:
    """
    Verifica se `ota_status.in_progress == True` ou `awaiting_reboot == True` ainda
    está dentro da janela de proteção (`OTA_LOCK_TTL_SECONDS`).
    """
    if not isinstance(ota_status, dict):
        return False
    is_active_flag = (
        ota_status.get("in_progress") is True or ota_status.get("awaiting_reboot") is True
    )
    if not is_active_flag:
        return False

    expires_epoch = int(ota_status.get("expires_epoch") or 0)
    started_epoch = int(ota_status.get("started_epoch") or 0)

    if expires_epoch <= 0 and started_epoch <= 0:
        return False

    effective_deadline = (
        expires_epoch if expires_epoch > 0 else (started_epoch + OTA_LOCK_TTL_SECONDS)
    )
    return now_epoch <= effective_deadline


def _has_idempotency_metadata_conflict(
    action: str,
    existing_cmd: dict[str, Any],
    config_metadata: Optional[dict[str, Any]],
    ota_metadata: Optional[dict[str, Any]],
) -> Optional[str]:
    """
    Verifica se uma repetição com o mesmo `command_id` alterou os parâmetros de
    `config` (intervalo/limites ADC) ou `ota` (versão/s3_key/sha256).
    """
    if action == "config":
        existing_cfg = existing_cmd.get("config") or {}
        incoming_cfg = config_metadata or {}
        for k in CONFIG_METADATA_KEYS:
            if existing_cfg.get(k) != incoming_cfg.get(k):
                return f"config:{existing_cfg}!={incoming_cfg}"

    elif action == "ota":
        existing_ota = existing_cmd.get("ota") or {}
        incoming_ota = ota_metadata or {}
        for k in ("target_version", "s3_key", "sha256"):
            ex_val = existing_ota.get(k)
            in_val = incoming_ota.get(k)
            if ex_val and in_val and str(ex_val).strip() != str(in_val).strip():
                return f"ota:{existing_ota.get('target_version')}!={incoming_ota.get('target_version')}"

    return None


def _execute_atomic_command_reservation(
    device_id: str,
    command_id: str,
    action: str,
    duration: int,
    origin: str,
    user_id: Optional[str],
    topics: dict[str, str],
    request_id: str,
    enforce_ownership: bool,
    ota_metadata: Optional[dict[str, Any]] = None,
    config_metadata: Optional[dict[str, Any]] = None,
    command_expires_epoch: Optional[int] = None,
    caller_demo_sid: str = "",
    caller_demo_device_id: str = "",
    caller_is_demo_jwt: bool = False,
) -> Tuple[str, Optional[str], Optional[str], int, int, Optional[int]]:
    """
    Executa Transação Atômica ACID no Firestore (`@gcf_firestore.transactional`):
      1. Valida propriedade do Titular ou sessão ativa Demo em `private/demo_auth`;
      2. Verifica autoria de comandos existentes (`_is_same_command_author`, A1d) antes
         de qualquer checagem de idempotência/parâmetros;
      3. Aplica limites físicos/cota da Demo (`_evaluate_demo_on_limits`, A2) para
         comandos ON novos (OFF é sempre permitido e não consome cota);
      4. Reserva travas de válvula/OTA, espelha `demo_view/current` e grava cota Demo
         em `private/demo_auth` somente no outcome `"created"`.
    """
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_epoch = int(time.time())
    default_expires_epoch = command_expires_epoch or (now_epoch + COMMAND_TTL_SECONDS)

    db = _get_firestore()
    if db is None:
        if action in ("on", "ota"):
            return ("unavailable", "firestore_unavailable", None, now_epoch, default_expires_epoch, None)
        if enforce_ownership:
            return ("forbidden", "firestore_unavailable", None, now_epoch, default_expires_epoch, None)
        return ("proceed", None, None, now_epoch, default_expires_epoch, None)

    now_server = firestore.SERVER_TIMESTAMP

    device_ref = db.collection("devices").document(device_id)
    cmd_ref = device_ref.collection("commands").document(command_id)
    demo_auth_ref = device_ref.collection("private").document("demo_auth")
    demo_view_ref = device_ref.collection("demo_view").document("current")

    requested_by_obj = _build_requested_by(
        user_id=user_id,
        is_demo=caller_is_demo_jwt,
        demo_sid=caller_demo_sid,
    )

    doc_data: dict[str, Any] = {
        "device_id": device_id,
        "command_id": command_id,
        "origin": origin,
        "requested_action": action,
        "requested_duration": duration,
        "action": action,
        "duration": duration,
        "status": "pending",
        "last_status": "pending",
        "created_at": now_server,
        "created_epoch": now_epoch,
        "updated_at": now_server,
        "requested_by": requested_by_obj,
        "mqtt": {"topic": topics["command_topic"], "qos": 1},
        "request": {"request_id": request_id},
        "ota": ota_metadata if ota_metadata else None,
        "config": config_metadata if config_metadata else None,
        "schema_version": 2,
        "on_expires_epoch": default_expires_epoch if action == "on" else None,
        "valve_reservation_schema": 1 if action == "on" and duration > 0 else None,
    }
    doc_data = {k: v for k, v in doc_data.items() if v is not None}

    @gcf_firestore.transactional
    def _tx_body(transaction: Any) -> Tuple[str, Optional[str], Optional[str], int, int, Optional[int]]:
        # AGROSMART_LEITURA_EM_LOTE (v5.36.0): 1 ida ao Firestore em vez de 4 (trava mais curta).
        _agro_refs = [device_ref, cmd_ref, demo_view_ref]
        if caller_is_demo_jwt:
            _agro_refs.append(demo_auth_ref)
        _agro_snaps = {_s.reference.path: _s for _s in transaction.get_all(_agro_refs) if _s is not None}
        device_snap = _agro_snaps.get(device_ref.path)
        cmd_snap = _agro_snaps.get(cmd_ref.path)
        demo_view_snap = _agro_snaps.get(demo_view_ref.path)
        demo_auth_snap = _agro_snaps.get(demo_auth_ref.path) if caller_is_demo_jwt else None
        if device_snap is None:
            device_snap = device_ref.get(transaction=transaction)
        if cmd_snap is None:
            cmd_snap = cmd_ref.get(transaction=transaction)
        if demo_view_snap is None:
            demo_view_snap = demo_view_ref.get(transaction=transaction)
        if caller_is_demo_jwt and demo_auth_snap is None:
            demo_auth_snap = demo_auth_ref.get(transaction=transaction)

        if not device_snap.exists:
            return ("forbidden", "device_not_found", None, now_epoch, default_expires_epoch, None)

        device_data = device_snap.to_dict() or {}
        demo_auth_data = (
            (demo_auth_snap.to_dict() or {})
            if (demo_auth_snap is not None and demo_auth_snap.exists)
            else {}
        )
        owner = device_data.get("owner_uid") or device_data.get("ownerUid")
        conn_map = device_data.get("connection") or {}
        current_fw = conn_map.get("fw")
        current_boot_id = str(conn_map.get("boot_id") or "").strip() or None
        state = device_data.get("state") or {}
        ota_status = device_data.get("ota_status") or {}

        # 1. Validação Zero-Trust Unificada (Titular ou Demo validada em private/demo_auth)
        if enforce_ownership:
            is_owner = isinstance(owner, str) and owner == user_id and not caller_is_demo_jwt
            if not is_owner:
                if not user_id or not caller_is_demo_jwt:
                    return ("forbidden", "owner_mismatch", None, now_epoch, default_expires_epoch, None)

                if action not in DEMO_ALLOWED_ACTIONS:
                    return ("forbidden", "demo_action_not_allowed", None, now_epoch, default_expires_epoch, None)

                if not caller_demo_device_id or caller_demo_device_id != device_id:
                    return ("forbidden", "demo_session_mismatch", None, now_epoch, default_expires_epoch, None)

                if demo_auth_snap is None or not demo_auth_snap.exists:
                    return ("forbidden", "demo_session_mismatch", None, now_epoch, default_expires_epoch, None)

                demo_exp = _safe_nonneg_int(demo_auth_data.get("expires_epoch"), 0)
                if demo_exp <= 0 or now_epoch >= demo_exp:
                    return ("forbidden", "demo_pass_expired", None, now_epoch, default_expires_epoch, None)

                expected_sid = str(demo_auth_data.get("session_id") or "").strip()
                if (
                    not expected_sid
                    or demo_auth_data.get("pass_claimed") is not True
                    or not caller_demo_sid
                    or not hmac.compare_digest(expected_sid, caller_demo_sid)
                ):
                    return ("forbidden", "demo_session_mismatch", None, now_epoch, default_expires_epoch, None)

        # 2. Verificação de Autoria (A1d), Idempotência e Imutabilidade Completa do Comando
        is_retry = False
        new_retry_count = 0
        existing_cmd: dict[str, Any] = {}
        effective_issued_at = now_epoch
        effective_expires_at = default_expires_epoch

        if cmd_snap.exists:
            existing_cmd = cmd_snap.to_dict() or {}

            # Checagem de autoria ANTES de qualquer inspeção de status/parâmetros (A1d)
            if not _is_same_command_author(
                existing_cmd=existing_cmd,
                caller_uid=user_id,
                caller_is_demo=caller_is_demo_jwt,
                caller_demo_sid=caller_demo_sid,
            ):
                return ("conflict_foreign", None, None, now_epoch, default_expires_epoch, None)

            existing_action = str(
                existing_cmd.get("requested_action") or existing_cmd.get("action") or ""
            ).strip().lower()
            existing_duration = int(
                existing_cmd.get("requested_duration")
                if existing_cmd.get("requested_duration") is not None
                else (existing_cmd.get("duration") or 0)
            )

            if existing_action and (existing_action != action or existing_duration != duration):
                return (
                    "conflict_params",
                    f"{existing_action}:{existing_duration}",
                    None,
                    now_epoch,
                    default_expires_epoch,
                    None,
                )

            meta_conflict = _has_idempotency_metadata_conflict(
                action=action,
                existing_cmd=existing_cmd,
                config_metadata=config_metadata,
                ota_metadata=ota_metadata,
            )
            if meta_conflict:
                return ("conflict_params", meta_conflict, None, now_epoch, default_expires_epoch, None)

            existing_status = str(
                existing_cmd.get("last_status") or existing_cmd.get("status") or ""
            ).strip().lower()
            created_epoch = int(existing_cmd.get("created_epoch") or 0)
            age_sec = (now_epoch - created_epoch) if created_epoch > 0 else 999

            if existing_cmd.get("reservation_released_by_off_id"):
                return ("idempotent", existing_status, None, now_epoch, default_expires_epoch, None)

            if existing_status == "publish_failed" or (
                existing_status == "pending" and age_sec >= PENDING_RETRY_AFTER_SEC
            ):
                is_retry = True
                new_retry_count = int(existing_cmd.get("retry_count") or 0) + 1
                prior_on_exp = int(existing_cmd.get("on_expires_epoch") or 0)
                if created_epoch > 0 and prior_on_exp > now_epoch:
                    effective_issued_at = created_epoch
                    effective_expires_at = prior_on_exp
            else:
                return ("idempotent", existing_status, None, now_epoch, default_expires_epoch, None)

        valve_locked = _is_valve_lock_still_active(state, now_utc)
        ota_locked = _is_ota_lock_still_active(ota_status, now_epoch)

        same_valve_holder = str(state.get("current_command_id") or "") == command_id
        same_ota_holder = str(ota_status.get("last_command_id") or "") == command_id

        # 3. Anti-Downgrade e Proteção de Segurança Física/Concorrência para OTA (Fase 3)
        if action == "ota":
            target_ver = (ota_metadata or {}).get("target_version")
            current_tuple = _parse_semver_strict(current_fw)
            target_tuple = _parse_semver_strict(target_ver)
            if current_tuple is None:
                return ("rejected", "ota_current_version_unknown", None, effective_issued_at, effective_expires_at, None)
            if target_tuple is None:
                return ("rejected", "ota_invalid_target_version", None, effective_issued_at, effective_expires_at, None)
            if target_tuple == current_tuple:
                return ("rejected", "ota_same_version", None, effective_issued_at, effective_expires_at, None)
            if target_tuple < current_tuple:
                return ("rejected", "ota_downgrade_blocked", None, effective_issued_at, effective_expires_at, None)

            if valve_locked:
                locked_origin = str(state.get("valve_origin") or "manual")
                return ("locked", f"valve_open:{locked_origin}", None, effective_issued_at, effective_expires_at, None)
            if ota_locked and not same_ota_holder:
                active_ota_cmd = str(ota_status.get("last_command_id") or "ota")
                return ("locked", f"ota_in_progress:{active_ota_cmd}", None, effective_issued_at, effective_expires_at, None)
            ota_reservation_doc: dict[str, Any] = {
                "in_progress": True,
                "awaiting_reboot": False,
                "last_command_id": command_id,
                "status": "pending",
                "reason": None,
                "error": None,
                "target_version": target_ver,
                "previous_version": current_fw,
                "sha256": (ota_metadata or {}).get("sha256"),
                "file_size": (ota_metadata or {}).get("file_size"),
                "started_epoch": effective_issued_at,
                "expires_epoch": now_epoch + OTA_LOCK_TTL_SECONDS,
                "updated_at": now_server,
            }
            if current_boot_id:
                ota_reservation_doc["origin_boot_id"] = current_boot_id

            transaction.set(device_ref, {"ota_status": ota_reservation_doc}, merge=True)
            if demo_view_snap.exists:
                transaction.set(
                    demo_view_ref,
                    {
                        "ota_status": {
                            "in_progress": True,
                            "awaiting_reboot": False,
                            "status": "pending",
                            "target_version": target_ver,
                            "previous_version": current_fw,
                            "reason": None,
                            "updated_at": now_server,
                        },
                        "updated_at": now_server,
                    },
                    merge=True,
                )

        # 4. Limites Demo (A2) e Reserva Atômica de State Lock para comandos ON
        if action == "on" and duration > 0:
            if caller_is_demo_jwt and not is_retry:
                demo_ok, limit_reason, limit_retry_after = _evaluate_demo_on_limits(
                    demo_auth_data, duration, now_epoch
                )
                if not demo_ok:
                    resolved_reason = limit_reason or "demo_duration_limit"
                    return (
                        resolved_reason,
                        resolved_reason,
                        None,
                        effective_issued_at,
                        effective_expires_at,
                        limit_retry_after,
                    )

            if ota_locked:
                return ("locked", "ota_in_progress", None, effective_issued_at, effective_expires_at, None)

            if same_valve_holder and state.get("valve_open") is True:
                return ("idempotent", "started", None, effective_issued_at, effective_expires_at, None)

            if valve_locked and not (same_valve_holder and is_retry):
                locked_origin = str(state.get("valve_origin") or "manual")
                return ("locked", locked_origin, None, effective_issued_at, effective_expires_at, None)

            # v5.37.0 (E1): limite anti-rajada por estação (titular e Demo). OFF nunca passa aqui.
            device_guard_update: Optional[dict[str, Any]] = None
            if not is_retry and DEVICE_ON_BURST > 0:
                guard_ok, guard_retry, device_guard_update = _evaluate_device_on_bucket(
                    device_data.get("cmd_guard"), int(time.time() * 1000)
                )
                if not guard_ok:
                    return (
                        "device_rate_limited",
                        "device_rate_limited",
                        None,
                        effective_issued_at,
                        effective_expires_at,
                        guard_retry,
                    )

            reservation_deadline = (
                effective_expires_at + duration + STALE_LOCK_GRACE_SEC
            )
            new_state_map = {
                "valve_open": False,
                "valve_pending": True,
                "reservation_expires_epoch": reservation_deadline,
                "valve_origin": origin,
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
            _agro_device_update: dict[str, Any] = {"state": new_state_map}
            if device_guard_update is not None:
                _agro_device_update["cmd_guard"] = device_guard_update
            transaction.set(device_ref, _agro_device_update, merge=True)
            if demo_view_snap.exists:
                transaction.set(
                    demo_view_ref,
                    {"state": new_state_map, "updated_at": now_server},
                    merge=True,
                )

            # Atualiza cota Demo em `private/demo_auth` SOMENTE para comando novo (`created`)
            if caller_is_demo_jwt and not is_retry:
                prev_used = _safe_nonneg_int(demo_auth_data.get("demo_on_seconds_used"), 0)
                transaction.set(
                    demo_auth_ref,
                    {
                        "demo_on_seconds_used": prev_used + duration,
                        "demo_last_on_epoch": now_epoch,
                        "updated_at": now_server,
                    },
                    merge=True,
                )

        # 5. Vinculação do OFF à reserva pendente ou ativa atual (OFF Demo sempre permitido)
        off_context: dict[str, Any] = {}
        cancel_target_id: Optional[str] = None
        if action == "off":
            active_or_pending_id = state.get("current_command_id")
            if (
                isinstance(active_or_pending_id, str)
                and active_or_pending_id
                and active_or_pending_id != command_id
                and (state.get("valve_pending") is True or state.get("valve_open") is True)
            ):
                cancel_target_id = active_or_pending_id

            if state.get("valve_pending") is True:
                target_id = state.get("current_command_id")
                reserved_at = state.get("reserved_at")
                if (
                    isinstance(target_id, str)
                    and target_id
                    and isinstance(reserved_at, datetime.datetime)
                    and not existing_cmd.get("off_pending_target")
                ):
                    off_context["off_pending_target"] = {
                        "command_id": target_id,
                        "reserved_at": reserved_at,
                    }

        # 6. Criação ou Atualização Atômica do Documento do Comando
        if is_retry:
            transaction.set(
                cmd_ref,
                {
                    "status": "pending",
                    "last_status": "pending",
                    "updated_at": now_server,
                    "retry_count": new_retry_count,
                    **({"on_expires_epoch": effective_expires_at} if action == "on" else {}),
                    **off_context,
                    "valve_reservation_schema": 1 if action == "on" and duration > 0 else None,
                },
                merge=True,
            )
            return ("proceed", "retried", cancel_target_id, effective_issued_at, effective_expires_at, None)

        transaction.set(cmd_ref, {**doc_data, **off_context})
        return ("proceed", "created", cancel_target_id, effective_issued_at, effective_expires_at, None)

    transaction = db.transaction()
    return _tx_body(transaction)


def _firestore_mark_publish_failed_and_rollback_lock(
    device_id: str, command_id: str, action: str, message: str
) -> None:
    """
    Registra falha de publicação sem sobrescrever um ACK já processado.
    Nota de segurança (A2c): a cota `demo_on_seconds_used` não é devolvida em
    `publish_failed` (decisão conservadora).
    """
    db = _get_firestore()
    if db is None:
        return
    now_server = firestore.SERVER_TIMESTAMP if FIREBASE_AVAILABLE else None
    device_ref = db.collection("devices").document(device_id)
    cmd_ref = device_ref.collection("commands").document(command_id)
    demo_view_ref = device_ref.collection("demo_view").document("current")

    @gcf_firestore.transactional
    def _tx_rollback(transaction: Any) -> None:
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
                "error": {"type": "iot_publish_error", "message": str(message)[:500]},
            },
            merge=True,
        )
        if not snap.exists:
            return

        dev_dict = snap.to_dict() or {}
        if action == "on":
            state = dev_dict.get("state") or {}
            if state.get("current_command_id") == command_id and state.get("valve_pending") is not True:
                cleared_state = {
                    "valve_open": False,
                    "valve_origin": None,
                    "current_command_id": None,
                    "reserved_epoch": 0,
                    "valve_ends_at": now_server,
                }
                transaction.set(device_ref, {"state": cleared_state}, merge=True)
                if demo_view_snap.exists:
                    transaction.set(
                        demo_view_ref,
                        {"state": cleared_state, "updated_at": now_server},
                        merge=True,
                    )
        elif action == "ota":
            ota_st = dev_dict.get("ota_status") or {}
            if (
                ota_st.get("last_command_id") == command_id
                and str(ota_st.get("status") or "pending").strip().lower() == "pending"
            ):
                cleared_ota = {
                    "in_progress": False,
                    "awaiting_reboot": False,
                    "status": "publish_failed",
                    "updated_at": now_server,
                }
                transaction.set(device_ref, {"ota_status": cleared_ota}, merge=True)
                if demo_view_snap.exists:
                    transaction.set(
                        demo_view_ref,
                        {"ota_status": cleared_ota, "updated_at": now_server},
                        merge=True,
                    )

    try:
        tx = db.transaction()
        _tx_rollback(tx)
        _log("INFO", "lock_rolled_back_transactional", device_id=device_id, command_id=command_id)
    except Exception as e:
        _log("WARN", "firestore_rollback_tx_error", device_id=device_id, command_id=command_id, error=str(e))


def _publish_to_iot_with_retry(topic: str, mqtt_json_str: str) -> float:
    """Publica o payload JSON no tópico MQTT do AWS IoT Core com QoS 1 e Backoff + Jitter."""
    t0_pub = time.perf_counter()
    try:
        iot_data.publish(topic=topic, qos=1, payload=mqtt_json_str)
    except ClientError as e:
        err_code = e.response.get("Error", {}).get("Code", "")
        if err_code in (
            "ThrottlingException",
            "InternalFailureException",
            "ServiceUnavailableException",
        ):
            backoff_sec = round(0.4 + random.random() * 0.4, 3)
            time.sleep(backoff_sec)
            iot_data.publish(topic=topic, qos=1, payload=mqtt_json_str)
        else:
            raise

    return round((time.perf_counter() - t0_pub) * 1000.0, 2)


# =====================================================================================
# VALIDAÇÃO DE ENTRADA E CONSTRUÇÃO DO PAYLOAD MQTT
# =====================================================================================
def validate_and_build_command(
    body: dict[str, Any],
    event: dict[str, Any],
    resolve_s3_immediately: bool = False,
    auth_details: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """
    Valida todos os campos de entrada do comando, bloqueia prefixos reservados no
    `command_id` do cliente (A1a), deriva `command_id` no servidor para sessões Demo
    (A1b) e constrói o payload de publicação MQTT.
    """
    if not isinstance(body, dict):
        raise ValueError("JSON inválido")

    device_id = body.get("device_id")
    action = body.get("action")
    duration_raw = body.get("duration", 0)

    headers = _get_headers(event)
    idempotency_key = headers.get("idempotency-key") or headers.get("x-idempotency-key")
    raw_body_command_id = body.get("command_id")

    if isinstance(idempotency_key, str) and len(idempotency_key) > MAX_IDEMPOTENCY_KEY_LEN:
        raise ValueError(
            f"Idempotency-Key excede o tamanho máximo ({MAX_IDEMPOTENCY_KEY_LEN} caracteres)"
        )

    if not isinstance(device_id, str) or not device_id.strip():
        raise ValueError("device_id é obrigatório")
    device_id = device_id.strip()

    if not DEVICE_ID_RE.match(device_id):
        raise ValueError("device_id inválido")

    _current_device_id.set(device_id)

    if not isinstance(action, str) or not action.strip():
        raise ValueError("action é obrigatório")
    action = action.strip().lower()

    if action not in ALLOWED_ACTIONS:
        raise ValueError(f"action inválido. Permitidos: {sorted(ALLOWED_ACTIONS)}")

    duration = parse_int(duration_raw, default=0)
    if duration < 0:
        raise ValueError("duration não pode ser negativo")
    if duration > MAX_DURATION_SECONDS:
        raise ValueError(f"duration acima do máximo permitido ({MAX_DURATION_SECONDS}s)")
    if action == "on" and duration < 1:
        raise ValueError("Para action='on', duration deve ser de pelo menos 1 segundo")
    if action in ("off", "ota", "config"):
        duration = 0

    origin = "manual"

    resolved_auth = auth_details if isinstance(auth_details, dict) else _extract_auth_details(event)
    is_demo_caller = resolved_auth.get("is_demo") == "true"
    caller_demo_sid = str(resolved_auth.get("demo_sid") or "").strip()

    clean_body_command_id: Optional[str] = None
    if isinstance(raw_body_command_id, str) and raw_body_command_id.strip():
        clean_body_command_id = raw_body_command_id.strip()
        if _has_reserved_client_cmd_prefix(clean_body_command_id):
            _log(
                "WARN",
                "command_id_reserved_prefix_rejected",
                is_demo=is_demo_caller,
                demo_sid_prefix=_safe_demo_sid_prefix(caller_demo_sid) if is_demo_caller else None,
                command_id_prefix=clean_body_command_id[:16],
            )
            raise ValueError("command_id usa prefixo reservado pelo servidor.")
        if not COMMAND_ID_RE.match(clean_body_command_id):
            raise ValueError("command_id inválido (máximo de 47 caracteres alfanuméricos)")

    clean_idempotency_key = (
        idempotency_key.strip()
        if isinstance(idempotency_key, str) and idempotency_key.strip()
        else None
    )

    if is_demo_caller:
        if not caller_demo_sid:
            raise ValueError("Sessão de Usuário Teste sem identificador válido.")
        client_key = clean_body_command_id or clean_idempotency_key or uuid.uuid4().hex
        command_id = _derive_demo_command_id(caller_demo_sid, device_id, client_key)
    else:
        if clean_body_command_id is not None:
            command_id = clean_body_command_id
        elif clean_idempotency_key is not None:
            command_id = _command_id_from_idempotency_key(device_id, clean_idempotency_key)
        else:
            command_id = f"cmd-{uuid.uuid4().hex[:24]}"

    if not COMMAND_ID_RE.match(command_id):
        raise ValueError("command_id inválido (máximo de 47 caracteres alfanuméricos)")

    user_ctx = {"user_id": resolved_auth["user_id"]} if resolved_auth.get("user_id") else {}
    now_ts = int(time.time())

    payload: dict[str, Any] = {
        "device_id": device_id,
        "action": action,
        "duration": duration,
        "origin": origin,
        "command_id": command_id,
        "issued_at": now_ts,
        "expires_at": now_ts + COMMAND_TTL_SECONDS,
        **user_ctx,
    }

    if action == "config":
        has_any_cfg = False
        if "telemetry_interval_ms" in body and body["telemetry_interval_ms"] is not None:
            t_int = parse_int(body["telemetry_interval_ms"])
            if t_int < MIN_TELEMETRY_INTERVAL_MS or t_int > MAX_TELEMETRY_INTERVAL_MS:
                raise ValueError(
                    f"telemetry_interval_ms deve estar entre {MIN_TELEMETRY_INTERVAL_MS} (10s) e {MAX_TELEMETRY_INTERVAL_MS} (1h)"
                )
            payload["telemetry_interval_ms"] = t_int
            has_any_cfg = True

        dry_val = (
            parse_int(body["soil_raw_dry"])
            if ("soil_raw_dry" in body and body["soil_raw_dry"] is not None)
            else None
        )
        wet_val = (
            parse_int(body["soil_raw_wet"])
            if ("soil_raw_wet" in body and body["soil_raw_wet"] is not None)
            else None
        )

        if dry_val is not None or wet_val is not None:
            if dry_val is None or wet_val is None:
                raise ValueError("Informe ambos 'soil_raw_dry' e 'soil_raw_wet' para calibrar o solo")
            if (
                dry_val < SOIL_ADC_MIN_VALID
                or dry_val > SOIL_ADC_MAX_VALID
                or wet_val < SOIL_ADC_MIN_VALID
                or wet_val > SOIL_ADC_MAX_VALID
            ):
                raise ValueError(
                    f"Limites ADC devem estar entre {SOIL_ADC_MIN_VALID} e {SOIL_ADC_MAX_VALID}"
                )
            if (dry_val - wet_val) < SOIL_CALIB_MIN_DELTA:
                raise ValueError(
                    f"soil_raw_dry ({dry_val}) deve ser pelo menos {SOIL_CALIB_MIN_DELTA} unidades maior que soil_raw_wet ({wet_val})"
                )
            payload["soil_raw_dry"] = dry_val
            payload["soil_raw_wet"] = wet_val
            has_any_cfg = True

        # v5.38.0: display e botão da estação (não se misturam com sensores/intervalo).
        has_local_cfg = False
        raw_mode = body.get("display_mode")
        raw_minutes = body.get("display_minutes")
        raw_btn = body.get("btn_irrig_min")
        if raw_mode is not None:
            if not isinstance(raw_mode, str) or raw_mode.strip().lower() not in LOCAL_DISPLAY_MODES:
                raise ValueError("display_mode inválido. Use: on, off, default_on ou default_off")
            mode = raw_mode.strip().lower()
            payload["display_mode"] = mode
            if mode == "on":
                if raw_minutes is None or isinstance(raw_minutes, bool):
                    raise ValueError("Informe display_minutes (1 a 120) para ligar o display")
                minutes = parse_int(raw_minutes)
                if minutes < DISPLAY_MINUTES_MIN or minutes > DISPLAY_MINUTES_MAX:
                    raise ValueError("display_minutes deve estar entre 1 e 120")
                payload["display_minutes"] = minutes
            elif raw_minutes is not None:
                raise ValueError("display_minutes só vale com display_mode='on'")
            has_local_cfg = True
        elif raw_minutes is not None:
            raise ValueError("display_minutes exige display_mode='on'")
        if raw_btn is not None:
            if isinstance(raw_btn, bool):
                raise ValueError("btn_irrig_min deve ser um número de 1 a 15")
            btn_min = parse_int(raw_btn)
            if btn_min < BTN_IRRIG_MIN_MINUTES or btn_min > BTN_IRRIG_MAX_MINUTES:
                raise ValueError("btn_irrig_min deve estar entre 1 e 15 minutos")
            payload["btn_irrig_min"] = btn_min
            has_local_cfg = True
        if has_local_cfg and has_any_cfg:
            raise ValueError("Display/botão e sensores/intervalo vão em comandos separados")
        has_any_cfg = has_any_cfg or has_local_cfg

        if not has_any_cfg:
            raise ValueError("Informe ao menos um parâmetro de configuração para action='config'")

    if action == "ota":
        raw_version = body.get("version") or body.get("target_version")
        ota_syntax = _validate_ota_params_syntax(
            version=raw_version,
            s3_key_override=None,
            sha256_override=body.get("sha256"),
        )
        payload["version"] = ota_syntax["clean_ver"]
        payload["s3_key"] = ota_syntax["s3_key"]

        if resolve_s3_immediately:
            ota_info = _resolve_ota_artifact(
                version=raw_version,
                s3_key_override=None,
                sha256_override=body.get("sha256"),
            )
            payload["version"] = ota_info["version"]
            payload["ota_url"] = ota_info["ota_url"]
            payload["sha256"] = ota_info["sha256"]
            payload["file_size"] = ota_info["file_size"]
            payload["s3_key"] = ota_info["s3_key"]
            if ota_info.get("sig"):
                payload["sig"] = ota_info["sig"]
            if ota_info.get("sig_alg"):
                payload["sig_alg"] = ota_info["sig_alg"]

    return payload


# =====================================================================================
# HANDLER PRINCIPAL DA LAMBDA
# =====================================================================================
def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    """
    Orquestra:
      1. Chamadas internas do AWS CloudShell (`publish_ota_release`);
      2. Rota dedicada `POST /demo/claim` (sem Authorizer — exclusiva para `claim_demo_pass`);
      3. Resgate legado em `POST /command` controlado por `LEGACY_CLAIM_ON_COMMAND`;
      4. Geração e Revogação de Passe Demo exclusivas do Titular (`generate_demo_pass` / `revoke_demo_pass`);
      5. Requisições REST HTTP POST vindas do API Gateway (`/command`).
    """
    request_id = getattr(context, "aws_request_id", "n/a")
    _current_request_id.set(request_id)
    _request_start_ns.set(time.perf_counter_ns())
    _current_user_id.set(None)
    _current_device_id.set(None)

    # 1. Rota Administrativa Interna (invocada exclusivamente via IAM / AWS CloudShell)
    if (
        isinstance(event, dict)
        and "requestContext" not in event
        and "httpMethod" not in event
        and "resource" not in event
        and event.get("admin_action") == "publish_ota_release"
    ):
        try:
            return _handle_internal_publish_ota_release(event)
        except _OtaPublishRejected as e:
            _log("WARN", "publish_ota_release_rejected", reason=e.reason, error=str(e))
            return {
                "statusCode": 400,
                "ok": False,
                "error": "Falha ao publicar release OTA.",
                "reason": e.reason,
            }
        except Exception as e:
            _log("ERROR", "publish_ota_release_failed", error=str(e))
            return {"statusCode": 400, "ok": False, "error": "Falha ao publicar release OTA."}

    method = _get_http_method(event)
    is_demo_claim_route = _is_demo_claim_route(event)

    if method.upper() == "OPTIONS":
        if is_demo_claim_route:
            return {
                "statusCode": 204,
                "headers": _build_cors_headers(event),
                "body": "",
            }
        return build_response(200, {"ok": True}, event)

    try:
        body = parse_json_body(event)
        raw_action = str(body.get("action") or "").strip().lower()

        # 2. Rota Dedicada `POST /demo/claim` (Fase 1C — sem Authorizer; ignora Authorization)
        if is_demo_claim_route:
            # Fase 2C.2: App Check ANTES de qualquer acesso ao DynamoDB/Firestore
            appcheck = _verify_app_check_token(event)
            _log(
                "INFO" if appcheck.get("status") in ("valid", "off") else "WARN",
                "demo_claim_appcheck",
                mode=APPCHECK_MODE,
                status=appcheck.get("status"),
                reason=appcheck.get("reason"),
                app=appcheck.get("app"),
            )
            if APPCHECK_MODE == "enforce" and appcheck.get("status") != "valid":
                time.sleep(CLAIM_REJECTION_DELAY_SEC)
                return build_response(
                    401,
                    {
                        "message": "Não foi possível verificar o aplicativo. Recarregue a página e tente novamente.",
                        "reason": "app_check_failed",
                    },
                    event,
                    extra_headers=_NO_STORE_HEADERS,
                )
            if raw_action != "claim_demo_pass":
                return build_response(
                    400,
                    {"message": "Requisição inválida."},
                    event,
                    extra_headers=_NO_STORE_HEADERS,
                )
            return _handle_claim_demo_pass(body, event, ignore_auth_header=True)

        auth_details = _extract_auth_details(event)

        # 3. Fluxo Legado de Resgate de Passe em `POST /command` (controlado por LEGACY_CLAIM_ON_COMMAND)
        if raw_action == "claim_demo_pass" or auth_details.get("auth_mode") == "demo_pass_claim":
            if not LEGACY_CLAIM_ON_COMMAND:
                _log(
                    "WARN",
                    "demo_pass_claim_legacy_route_disabled",
                    ip_hash=_hash_ip(_extract_source_ip(event)),
                )
                time.sleep(CLAIM_REJECTION_DELAY_SEC)
                return build_response(
                    403,
                    {"message": _GENERIC_CLAIM_DENIED_MSG},
                    event,
                    extra_headers=_NO_STORE_HEADERS,
                )
            if raw_action != "claim_demo_pass" or auth_details.get("auth_mode") != "demo_pass_claim":
                return build_response(
                    403,
                    {"message": "Forbidden"},
                    event,
                    extra_headers=_NO_STORE_HEADERS,
                )
            return _handle_claim_demo_pass(body, event, ignore_auth_header=False)

        # 4. Fluxos Administrativos do Titular para Passes Demo (F1.4)
        if raw_action == "generate_demo_pass":
            return _handle_owner_generate_demo_pass(body, event, auth_details)

        if raw_action == "revoke_demo_pass":
            return _handle_owner_revoke_demo_pass(body, event, auth_details)

        caller_is_demo_jwt = auth_details.get("is_demo") == "true"
        caller_demo_sid = auth_details.get("demo_sid", "")

        if caller_is_demo_jwt and not caller_demo_sid:
            return build_response(
                403,
                {
                    "message": "Sessão Inválida: Este passe temporário foi encerrado ou substituído pelo administrador."
                },
                event,
            )

        payload = validate_and_build_command(
            body,
            event,
            resolve_s3_immediately=False,
            auth_details=auth_details,
        )

        device_id = payload["device_id"]
        topics = build_topics(device_id)
        topic = topics["command_topic"]
        action = payload["action"]
        user_id = payload.get("user_id")

        if (REQUIRE_AUTH or ENFORCE_DEVICE_OWNERSHIP) and not user_id:
            return build_response(401, {"message": "Unauthorized"}, event)

        ota_meta_for_firestore: Optional[dict[str, Any]] = None
        config_meta_for_firestore: Optional[dict[str, Any]] = None

        if action == "config":
            config_meta_for_firestore = {
                k: payload[k]
                for k in CONFIG_METADATA_KEYS
                if k in payload
            }

        if action == "ota":
            if caller_is_demo_jwt:
                return build_response(
                    403,
                    {
                        "message": "Modo Usuário Teste: Atualização OTA é exclusiva do administrador da estação."
                    },
                    event,
                )

            owner_ota_status, available_ota = _fetch_owner_device_available_ota(device_id, user_id)
            if owner_ota_status == "forbidden":
                return build_response(
                    403,
                    {
                        "message": "Modo Usuário Teste: Atualização OTA é exclusiva do administrador da estação."
                    },
                    event,
                )
            if owner_ota_status == "unavailable":
                return build_response(
                    503,
                    {"message": "Estação indisponível para validar a release OTA."},
                    event,
                )

            if "s3_key" in body and body.get("s3_key") is not None:
                return build_response(
                    400,
                    {"message": "Campo s3_key não é aceito."},
                    event,
                )

            if (
                not isinstance(available_ota, dict)
                or not available_ota.get("version")
                or not available_ota.get("sha256")
            ):
                return build_response(
                    409,
                    {"message": "Nenhuma release publicada para esta estação."},
                    event,
                )

            avail_ver_tuple = _parse_semver_strict(available_ota.get("version"))
            if avail_ver_tuple is None:
                return build_response(
                    409,
                    {"message": "Release publicada inválida para esta estação."},
                    event,
                )
            avail_ver = f"{avail_ver_tuple[0]}.{avail_ver_tuple[1]}.{avail_ver_tuple[2]}"
            avail_sha256 = str(available_ota.get("sha256") or "").strip().lower()

            if payload["version"] != avail_ver:
                return build_response(
                    409,
                    {"message": "Versão solicitada não corresponde à release publicada."},
                    event,
                )

            body_sha256 = str(body.get("sha256") or "").strip().lower()
            if body_sha256 and body_sha256 != avail_sha256:
                return build_response(
                    409,
                    {"message": "Integridade divergente da release publicada."},
                    event,
                )

            ota_info = _resolve_ota_artifact(
                version=avail_ver,
                s3_key_override=None,
                sha256_override=avail_sha256,
            )
            payload["version"] = ota_info["version"]
            payload["ota_url"] = ota_info["ota_url"]
            payload["sha256"] = ota_info["sha256"]
            payload["file_size"] = ota_info["file_size"]
            payload["s3_key"] = ota_info["s3_key"]
            if ota_info.get("sig"):
                payload["sig"] = ota_info["sig"]
            if ota_info.get("sig_alg"):
                payload["sig_alg"] = ota_info["sig_alg"]

            ota_preview_mqtt = {
                k: v for k, v in payload.items() if k not in ("s3_key", "user_id")
            }
            if len(json.dumps(ota_preview_mqtt, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_ESP32_OTA_MQTT_BYTES:
                return build_response(
                    400,
                    {"message": "Payload OTA excede o limite de tamanho aceito pelo firmware."},
                    event,
                )

            ota_meta_for_firestore = {
                "target_version": payload.get("version"),
                "s3_key": payload.get("s3_key"),
                "sha256": payload.get("sha256"),
                "file_size": payload.get("file_size"),
                "sig_alg": payload.get("sig_alg") or "",
                "signed": bool(payload.get("sig") and payload.get("sig_alg")),
            }

        (
            outcome,
            detail,
            cancel_target_id,
            effective_issued_at,
            effective_expires_at,
            limit_retry_after,
        ) = _execute_atomic_command_reservation(
            device_id=device_id,
            command_id=payload["command_id"],
            action=action,
            duration=payload["duration"],
            origin=payload.get("origin", "manual"),
            user_id=user_id,
            topics=topics,
            request_id=request_id,
            enforce_ownership=ENFORCE_DEVICE_OWNERSHIP,
            ota_metadata=ota_meta_for_firestore,
            config_metadata=config_meta_for_firestore,
            command_expires_epoch=payload["expires_at"],
            caller_demo_sid=caller_demo_sid,
            caller_demo_device_id=auth_details.get("demo_device_id", ""),
            caller_is_demo_jwt=caller_is_demo_jwt,
        )

        payload["issued_at"] = effective_issued_at
        payload["expires_at"] = effective_expires_at

        mqtt_payload = {
            k: v for k, v in payload.items() if k not in ("s3_key", "user_id")
        }

        if outcome == "unavailable":
            return build_response(
                503, {"message": "Estação indisponível para reservar o comando."}, event
            )

        if outcome == "forbidden":
            if detail == "demo_action_not_allowed":
                return build_response(
                    403,
                    {
                        "message": "Modo Usuário Teste: Apenas acionamento e parada da válvula (on/off) são permitidos."
                    },
                    event,
                )
            if detail == "demo_pass_expired":
                return build_response(
                    403,
                    {
                        "message": "Sessão Expirada: O tempo do seu Passe Temporário de Usuário Teste encerrou."
                    },
                    event,
                )
            if detail == "demo_session_mismatch":
                return build_response(
                    403,
                    {
                        "message": "Sessão Inválida: Este passe temporário foi encerrado ou substituído pelo administrador."
                    },
                    event,
                )
            return build_response(403, {"message": "Forbidden"}, event)

        if outcome == "conflict_foreign":
            _log(
                "WARN",
                "command_id_foreign_author_conflict",
                command_id=payload["command_id"],
                is_demo=caller_is_demo_jwt,
                demo_sid_prefix=_safe_demo_sid_prefix(caller_demo_sid) if caller_is_demo_jwt else None,
            )
            return build_response(
                409,
                {"message": "Conflict: command_id já utilizado."},
                event,
            )

        if outcome in ("demo_duration_limit", "demo_cooldown", "demo_quota_exhausted"):
            _log(
                "WARN",
                "demo_limit_rejected",
                reason=outcome,
                duration=payload["duration"],
                retry_after=limit_retry_after,
                demo_sid_prefix=_safe_demo_sid_prefix(caller_demo_sid),
            )
            if outcome == "demo_duration_limit":
                max_min = DEMO_MAX_ON_DURATION_SEC // 60
                return build_response(
                    403,
                    {
                        "message": (
                            f"Modo Usuário Teste: a duração máxima permitida por acionamento é de "
                            f"{max_min} min ({DEMO_MAX_ON_DURATION_SEC}s)."
                        ),
                        "reason": "demo_duration_limit",
                    },
                    event,
                )
            if outcome == "demo_quota_exhausted":
                max_sess_min = DEMO_MAX_ON_SECONDS_PER_SESSION // 60
                return build_response(
                    403,
                    {
                        "message": (
                            f"Modo Usuário Teste: a cota máxima de irrigação desta sessão "
                            f"({max_sess_min} min) foi atingida."
                        ),
                        "reason": "demo_quota_exhausted",
                    },
                    event,
                )
            retry_sec = max(1, int(limit_retry_after or DEMO_ON_COOLDOWN_SEC or 1))
            return build_response(
                429,
                {
                    "message": (
                        f"Modo Usuário Teste: aguarde {retry_sec}s antes de iniciar outra irrigação."
                    ),
                    "reason": "demo_cooldown",
                    "retry_after_sec": retry_sec,
                },
                event,
                extra_headers={"Retry-After": str(retry_sec)},
            )

        if outcome == "device_rate_limited":
            retry_sec = max(1, int(limit_retry_after or DEVICE_ON_REFILL_SEC or 1))
            _log(
                "WARN",
                "device_rate_limited",
                device_id=device_id,
                retry_after=retry_sec,
                is_demo=caller_is_demo_jwt,
            )
            return build_response(
                429,
                {
                    "message": (
                        f"Muitos acionamentos seguidos. Para proteger a válvula e o relé, "
                        f"aguarde {retry_sec} s para ligar de novo. Desligar continua liberado."
                    ),
                    "reason": "device_rate_limited",
                    "retry_after_sec": retry_sec,
                },
                event,
                extra_headers={"Retry-After": str(retry_sec)},
            )

        if outcome == "rejected":
            reject_code = str(detail or "ota_rejected")
            _log(
                "WARN",
                "ota_command_rejected",
                command_id=payload["command_id"],
                reason=reject_code,
                target_version=payload.get("version"),
            )
            if reject_code == "ota_current_version_unknown":
                reject_msg = "Não é possível atualizar: versão atual do firmware da estação desconhecida."
            elif reject_code == "ota_same_version":
                reject_msg = "A estação já está executando esta versão de firmware."
            elif reject_code == "ota_downgrade_blocked":
                reject_msg = "Downgrade bloqueado: a versão alvo deve ser superior à versão instalada na estação."
            else:
                reject_msg = "Solicitação OTA recusada pelas regras de segurança de versão."
            return build_response(
                409,
                {"message": reject_msg, "reason": reject_code},
                event,
            )

        if outcome == "conflict_params":
            return build_response(
                409,
                {
                    "message": "Conflict: Este command_id já foi utilizado com parâmetros diferentes.",
                    "existing_command": detail,
                },
                event,
            )

        if outcome == "locked":
            detail_str = str(detail or "manual")
            if detail_str.startswith("ota_in_progress"):
                conflict_msg = (
                    "Conflict: Atualização de firmware (OTA) em andamento na estação. Aguarde a conclusão."
                )
            elif action == "ota":
                conflict_msg = (
                    f"Conflict: Não é possível iniciar atualização OTA com uma irrigação ou reserva ativa ({detail_str}). "
                    "Aguarde o término da rega."
                )
            else:
                conflict_msg = (
                    f"Conflict: Estação ocupada por uma irrigação ou reserva ({detail_str}). "
                    "Envie action='off' para forçar fechamento."
                )

            return build_response(
                409,
                {
                    "message": conflict_msg,
                    "locked_by": detail_str,
                    "retry_after_seconds": CONFLICT_RETRY_AFTER_SEC,
                },
                event,
                extra_headers={"Retry-After": str(CONFLICT_RETRY_AFTER_SEC)},
            )

        if outcome == "idempotent":
            return build_response(
                200,
                {
                    "message": "Comando já existente (idempotent). Não foi republicado.",
                    "target": device_id,
                    "command_id": payload["command_id"],
                    "status": detail,
                },
                event,
            )

        if action == "off" and cancel_target_id:
            mqtt_payload["cancel_command_id"] = cancel_target_id

        mqtt_json_str = json.dumps(mqtt_payload, ensure_ascii=False, separators=(",", ":"))
        if action == "ota" and len(mqtt_json_str.encode("utf-8")) > MAX_ESP32_OTA_MQTT_BYTES:
            _firestore_mark_publish_failed_and_rollback_lock(
                device_id,
                payload["command_id"],
                action,
                "ota_mqtt_payload_too_large",
            )
            return build_response(
                400,
                {"message": "Payload OTA excede o limite de tamanho aceito pelo firmware."},
                event,
            )

        publish_attempted = True
        pub_ms = _publish_to_iot_with_retry(topic=topic, mqtt_json_str=mqtt_json_str)

        _log(
            "INFO",
            "command_publish_success",
            command_id=payload["command_id"],
            action=action,
            cancel_command_id=cancel_target_id,
            version=payload.get("version") if action == "ota" else None,
            sha256_prefix=(str(payload.get("sha256") or "")[:12] or None) if action == "ota" else None,
            sig_len=len(str(payload.get("sig") or "")) if action == "ota" else None,
            iot_publish_latency_ms=pub_ms,
        )

        return build_response(
            200,
            {
                "message": "Comando enviado com sucesso",
                "target": device_id,
                "command_id": payload["command_id"],
                "action": action,
                "cancel_command_id": cancel_target_id,
                "version": payload.get("version"),
                "sha256": payload.get("sha256"),
                "file_size": payload.get("file_size"),
                "expires_at": payload["expires_at"],
            },
            event,
        )

    except ValueError as e:
        _log("WARN", "send_command_validation_error", error=str(e))
        return build_response(
            400,
            {"message": str(e)},
            event,
            extra_headers=_NO_STORE_HEADERS if is_demo_claim_route else None,
        )

    except Exception as e:
        _log("ERROR", "send_command_internal_error", error_type=type(e).__name__, error=str(e))
        try:
            if locals().get("publish_attempted", False):
                _firestore_mark_publish_failed_and_rollback_lock(
                    payload["device_id"],
                    payload["command_id"],
                    payload["action"],
                    str(e),
                )
        except Exception:
            pass

        return build_response(
            500,
            {"message": "Erro interno na Lambda"},
            event,
            extra_headers=_NO_STORE_HEADERS if is_demo_claim_route else None,
        )


# =====================================================================================
# Aquecimento (EventBridge Scheduler a cada 5 min) — 2026-11-23 (v5.35.0)
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
