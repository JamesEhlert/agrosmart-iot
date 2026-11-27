# Security overview

The station controls a physical valve, so security here means **data protection and physical safety**. The design assumes the network, the browser and any guest can be hostile (zero trust).

## Threat model (STRIDE, summarized)
| Threat | Example | Mitigation |
|---|---|---|
| **S**poofing | A script pretends to be the station or a user | One X.509 certificate per station (mutual TLS); Firebase JWT verified on every API call |
| **T**ampering | A forged or replayed command opens the valve | Unique `command_id` deduplicated on the station; commands expire; reserved prefixes per source; forged commands raise a security alert |
| **R**epudiation | "I never sent that command" | Audit history for every command with source, user role, timestamps and the station's own confirmation |
| **I**nformation disclosure | A guest reads another user's data | Device ownership checked on the server for every route (no IDOR); Firestore rules tested for owner, guest, intruder and anonymous |
| **D**enial of service | Command flooding | Per-device rate limit and API Gateway throttling; schedules capped |
| **E**levation of privilege | A guest acts as the owner | Guests get a temporary, revocable pass with a separate session and a reduced set of actions; revocation is checked on every call |

## Physical safety
- Maximum valve-open time enforced on the station itself.
- Safe OFF state after reboot, brownout or lost connection.
- Commands that arrive late (after an outage) are not executed.

## Firmware integrity
- OTA images signed with ECDSA P-256; the private key never leaves the author's computer.
- Signature and hash verified before download and again before switching partitions; automatic rollback.

## Secrets and supply chain
- Cloud secrets in AWS SSM Parameter Store (SecureString); nothing secret in the web bundle.
- Python dependencies pinned by hash and audited (0 known vulnerabilities at release).
- This public repository is produced by an exporter with an allowlist, a private list of forbidden values, secret-pattern scanning and a self-test; gitleaks and GitHub push protection run as extra layers.

## Tests that back these claims
| Test | Result |
|---|---|
| Firestore security rules (emulator) | 51/51 |
| MQTT injection (forged, replayed, over-limit commands) | 12/12 handled as expected |
| OTA tampering (bad signature, modified image, old version) | 3/3 rejected |
| 7-minute network outage | 0 readings lost, stale command not executed |
| Web app automated tests | 271 passing |

Found a problem? See [SECURITY.md](../SECURITY.md).
