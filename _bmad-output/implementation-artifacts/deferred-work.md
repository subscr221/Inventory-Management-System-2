## Deferred from: code review of 1-1-core-infrastructure-deployment-and-event-store-schema.md (2026-07-12)

- No authentication or authorization anywhere [src/server.ts:515] — deferred, pre-existing (Story 1.2 scope)
- `readStream` has no pagination or limit [src/events/store.ts:396-421] — deferred, pre-existing (Not required in Story 1.1)
- Global idempotency uniqueness is likely too broad [events/domain_events.sql:20] — deferred, pre-existing (Matches spec requirements)
- `trace_id` is generated fresh per error and never logged [src/middleware/error.ts:455] — deferred, pre-existing
- Migration has no versioning and a brittle path [src/events/migrate.ts:210] — deferred, pre-existing (Full migration system out of scope)
- Extra/unknown properties are silently accepted [src/events/store.ts] — deferred, pre-existing
