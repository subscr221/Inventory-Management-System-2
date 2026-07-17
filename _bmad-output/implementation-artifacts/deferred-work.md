## Deferred from: code review of 1-1-core-infrastructure-deployment-and-event-store-schema.md (2026-07-12)

- No authentication or authorization anywhere [src/server.ts:515] — deferred, pre-existing (Story 1.2 scope)
- `readStream` has no pagination or limit [src/events/store.ts:396-421] — deferred, pre-existing (Not required in Story 1.1)
- Global idempotency uniqueness is likely too broad [events/domain_events.sql:20] — deferred, pre-existing (Matches spec requirements)
- `trace_id` is generated fresh per error and never logged [src/middleware/error.ts:455] — deferred, pre-existing
- Migration has no versioning and a brittle path [src/events/migrate.ts:210] — deferred, pre-existing (Full migration system out of scope)
- Extra/unknown properties are silently accepted [src/events/store.ts] — deferred, pre-existing

## Deferred from: code review of 1-3-statutory-edit-log.md (2026-07-14)

- Archival retention math uses calendar-year subtraction, not financial-year boundaries [src/cli/archive-audit-log.ts] — deferred, pre-existing open question in spec (story's own "Open Questions for the Team" already flags the FY start date as unconfirmed)
- `range_digest` is computed at read-time over the returned page, not via write-time hash chaining [src/api/v1/audit.ts:42-44] — deferred, matches existing spec design (Dev Notes define `range_digest` this way); strengthening to cryptographic chaining is an architecture-level change beyond this story's scope
