# 0004 — Signed OTA with rollback, without Secure Boot

**Status:** accepted

**Context.** Firmware must be updatable remotely without letting anyone install their own image. ESP32 Secure Boot and Flash Encryption are stronger, but they burn eFuses irreversibly; a mistake during a learning project could brick the only station.

**Decision.** Sign images with ECDSA P-256 and verify the signature and hash in firmware, before download and again before switching partitions, with an observation window and automatic rollback.

**Consequences.**
- Remote updates are protected against tampering in transit and at the source (3/3 tampering tests rejected).
- Physical attackers with access to the board are out of scope; Secure Boot remains a documented option for a production device.
