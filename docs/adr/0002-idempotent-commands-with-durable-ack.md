# 0002 — Idempotent commands with a durable ACK and receipt

**Status:** accepted

**Context.** Networks retry. A duplicated "open valve" must never water twice, and the user must know whether the station really acted, not just whether the cloud accepted the request.

**Decision.** Every command carries a unique `command_id`. The station keeps a ledger of recent IDs and ignores repeats; it rejects expired commands. After acting, it sends an ACK that is stored in NVS until the cloud returns a receipt. Commands never confirmed are flagged as "unconfirmed" by a periodic cloud check.

**Consequences.**
- Retries are safe; the audit trail reflects what physically happened.
- Slightly higher latency when the ledger must be written before reusing a slot (≈ 130 ms instead of ≈ 45 ms), accepted for safety.
