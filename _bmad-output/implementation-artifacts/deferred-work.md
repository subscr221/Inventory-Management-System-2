# Deferred Work

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

## Deferred from: code review of 1-3-statutory-edit-log.md (2026-07-18)

- SCIM directory mutations commit before the event+audit write, so a crash between the two transactions leaves an access-rights change with no audit entry [src/adapters/iam/scim.ts:62] - deferred, pre-existing two-phase design from Story 1.2 with an in-code follow-up note ("bring the event into the same transaction as the directory write")
- Audit `location_id` is client-supplied for wildcard-grant callers; a `*` grant matches any UUID, so a wildcard admin can stamp an arbitrary location into the audit row [src/api/v1/events.ts:75] - deferred, blocked on the location register (Stories 1.6/2.1) for server-side validation
- Archive CLI loads the entire eligible row set into memory with no batching [src/cli/archive-audit-log.ts:19] - deferred, no eligible rows can exist until 8 financial years after go-live; add batching before the retention horizon
- `read/projections/users.sql` carries no grants (they live only in `deploy/compose/init-db.sql`), so a migrate-only-provisioned database cannot execute SCIM writes as `app_user` - same split-brain class the audit tables just had fixed [read/projections/users.sql] - deferred, pre-existing Story 1.2 scope; apply the same canonical-file grant pattern there
- SCIM real-change paths commit the directory mutation before persistEvent, so a persistEvent failure yields a committed change with a 500 and no edit-log record (failure-path AC1 hole) [src/adapters/iam/scim.ts] - deferred, same pre-existing two-phase design already tracked above; the fix (single transaction) covers both entries

## Deferred from: code review of 1-7-calibration-lockout-enforcement (2026-07-19)

- `location.disputed` generated event uses a narrow raw insert instead of the central `persistEvent` path [src/compliance/location.ts:68-81] - closed as by-design, not deferred work. This is the explicit Story 1.6 review decision so operator tagging rules cannot reject a valid generated dispute; reverting to `persistEvent` re-broke the Story 1.6 tagging-immunity regression test. Reopen only if generated events later need audit/idempotency parity without tagging.
- Calibration lockout is a non-transactional TOCTOU read [src/compliance/calibration.ts:32] - deferred, pre-existing architectural pattern shared with the tagging and location assertions; the status-flip window is limited to admin maintenance writes.
- Duplicated DDL and redundant inline-plus-guard constraint blocks between the canonical migration and the compose mirror [read/projections/instrument_calibration.sql, deploy/compose/init-db.sql] - deferred, the mirror duplication is required by the story; drift risk noted for future maintenance.

## Deferred from: code review of 1-8-offline-edge-pwa-shell-and-powersync-sync-layer (2026-07-20)

- `svc_powersync` (WITH REPLICATION) is created only in `deploy/compose/init-db.sql`; the guarded grant in `sync/migrations/powersync.sql` silently skips on a migrate-only, non-compose database - deferred, consistent with this repo's established role-provisioning pattern (all roles are created in init-db.sql; migrations only guard grants).
- AC4 "related balance or state updated exactly once" is not exercised because the duplicate test uses an inert `maintenance` stream with no projection [test/integration/story-1-8.test.ts] - deferred, acceptable under the test-capture scope.
