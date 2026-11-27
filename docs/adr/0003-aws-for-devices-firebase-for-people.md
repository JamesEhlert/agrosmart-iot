# 0003 — AWS for devices, Firebase for people

**Status:** accepted

**Context.** The project needs device messaging with strong identity, cheap time-series storage, user login, real-time screens and free hosting — all within free tiers.

**Decision.** AWS IoT Core, Lambda and DynamoDB handle the device side; Firebase Auth, Firestore and Hosting handle the user side. API Gateway verifies Firebase tokens so both clouds share one identity.

**Consequences.**
- Each side uses the strongest managed service for its job, at zero cost for this scale.
- Two clouds mean two sets of credentials and rules to secure; this is mitigated by a single identity (Firebase JWT), server-side ownership checks and tested Firestore rules.
