# 0001 — MQTT with mutual TLS and one certificate per station

**Status:** accepted

**Context.** The station is on a home network and must send readings and receive commands continuously. HTTP polling would add latency and constant traffic; a shared password would let one leaked device impersonate all others.

**Decision.** Use AWS IoT Core over MQTT with mutual TLS. Each station has its own X.509 certificate and a policy that only allows its own topics.

**Consequences.**
- Commands reach the station in well under a second; the click-to-confirmation round trip is ≈ 1.2 s.
- A leaked certificate affects one station only and can be revoked individually.
- Certificates must be provisioned per device and kept out of source control.
