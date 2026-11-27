# Architecture

AgroSmart V5 connects one ESP32 field station to two clouds: **AWS** handles device traffic (MQTT, telemetry, commands, firmware) and **Firebase** handles people (login, real-time state, audit history, hosting). Each cloud does what it is best at, and the web app talks to both.

## Components
| Component | Responsibility |
|---|---|
| ESP32 station (FreeRTOS) | Reads 6 sensors, drives the valve relay, keeps a write-ahead queue on microSD, stores pending ACKs in NVS, handles physical buttons and the OLED display |
| AWS IoT Core | MQTT over mutual TLS, one X.509 certificate and policy per station, rules that route messages to DynamoDB and Lambda |
| API Gateway + Firebase authorizer | Validates the user's Firebase JWT (RS256, JWKS) before any Lambda runs |
| `SendCommand` | Checks device ownership and rate limits, records the command, publishes it to the station |
| `AckToFirestore` | Applies the station's confirmation to the command and the audit history, then sends an ACK receipt back |
| `GetTelemetry` | Returns readings (latest or downsampled ranges) after checking device ownership |
| `Scheduler_Logic` | Runs weekly schedules in the cloud, skips irrigation when rain is forecast, flags commands the station never confirmed |
| `PresenceToFirestore` | Turns MQTT connect/disconnect events into online/offline status |
| DynamoDB | Time series of readings |
| Firestore | Devices, commands, audit history, schedules, presence; protected by security rules tested in the emulator |
| S3 | Signed firmware images for OTA |

## 1. A manual command (click → valve → confirmation, ≈ 1.2 s)
```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant W as Web app
  participant G as API Gateway + authorizer
  participant S as SendCommand
  participant F as Firestore
  participant I as IoT Core
  participant E as ESP32 station
  participant A as AckToFirestore
  U->>W: Start irrigation (3 min)
  W->>G: POST /command {command_id, action, duration} + JWT
  G->>G: verify Firebase JWT
  G->>S: invoke
  S->>F: owns this device? rate limit ok?
  S->>F: create command (pending)
  S->>I: publish to the station's command topic
  I->>E: deliver (mutual TLS)
  E->>E: dedupe command_id, check expiry, open valve with max-time guard
  E->>I: ACK {command_id, result} (kept in NVS until receipt)
  I->>A: rule triggers
  A->>F: command = confirmed, history entry
  A->>I: ACK receipt
  I->>E: receipt → clear the stored ACK
  F-->>W: real-time update: "confirmed by the station"
```

## 2. Telemetry that survives a network outage
```mermaid
sequenceDiagram
  participant E as ESP32 station
  participant SD as microSD queue
  participant I as IoT Core
  participant D as DynamoDB
  loop every reading
    E->>SD: append (telemetry_seq, boot_id)
    alt connected
      SD->>I: publish oldest first
      I->>D: store
      SD->>SD: mark sent
    else offline
      SD->>SD: keep queued
    end
  end
  Note over E,D: 7-minute outage test: 12 queued readings replayed in ~1 s, 0 gaps, 0 duplicates
```

## 3. Signed firmware update (OTA)
```mermaid
sequenceDiagram
  actor O as Owner
  participant W as Web app
  participant S as SendCommand
  participant E as ESP32 station
  participant B as S3
  O->>W: Update firmware
  W->>S: OTA command (owner only)
  S->>E: signed manifest (version, size, SHA-256, ECDSA P-256 signature)
  E->>E: verify signature and version before downloading
  E->>B: download image over HTTPS
  E->>E: verify hash and signature again before switching partitions
  E->>E: boot new partition, observe for 90 s
  alt healthy
    E->>E: mark image valid
  else failure
    E->>E: automatic rollback to the previous partition
  end
```

## Design decisions
See [adr/](adr/) for the reasoning behind the main choices.
