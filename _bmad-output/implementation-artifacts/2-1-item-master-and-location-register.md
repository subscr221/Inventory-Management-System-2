# Story 2.1: Item Master and Location Register

Status: ready-for-dev

## Story

As an inventory controller,
I want to create and manage item master records and location register records,
so that every subsequent transaction references validated items and locations and no stock movement posts against an undefined master.

## Acceptance Criteria

1. **Given** an inventory controller creates an item with `sku: "RM-0042"`, `lot_controlled: true`, `valuation_method: "weighted_average"`, `business_stream: "production"`, **when** the item is saved, **then** `GET /api/v1/items/RM-0042` returns the item with all fields and a `created_at` timestamp.
2. **Given** a write request attempts to create a stock movement referencing `sku: "NONEXISTENT"`, **when** the event handler processes the command, **then** the write is rejected with `error_code: "ITEM_NOT_FOUND"`.
3. **Given** a location is created with `zone_type: "hazmat"` and `temperature_class: "cold"`, **when** any stock movement event attempts to place a non-hazmat item into that location, **then** the movement response carries `warning_code: "ZONE_INCOMPATIBLE"` before the placement is confirmed, and the location's zone and temperature attributes are returned by `GET /api/v1/locations/{location_id}`.

## Tasks / Subtasks

- [ ] Task 1: Add item master read model and API (AC: 1, 2)
  - [ ] 1.1 Add `read/projections/item_master.sql` with `CREATE TABLE IF NOT EXISTS`, idempotent constraint blocks, indexes, and guarded grants for `app_user` and `readonly_user`.
  - [ ] 1.2 Model items with internal `item_id UUID` plus unique API-facing `sku TEXT`; do not use SKU as `stream_id` because `EventEnvelope.stream_id` must remain UUID.
  - [ ] 1.3 Persist fields required by this story and downstream Epic 2: `sku`, `uom`, `lot_controlled`, `serial_controlled`, `hazmat`, `quarantine_required`, `bis_licence_required`, `valuation_method`, `business_stream`, `status`, `created_at`, and `updated_at`.
  - [ ] 1.4 Block invalid valuation methods, especially `lifo`; allowed initial values are `fifo`, `weighted_average`, and `specific_identification`.
  - [ ] 1.5 Validate `business_stream` against the existing business-stream vocabulary from Story 1.5; do not create a second enum or CHECK constraint.
  - [ ] 1.6 Add `src/read/projections/item_master.ts` with create, update, read-by-SKU, read-by-ID, and existence helpers that accept an optional `PoolClient`.
  - [ ] 1.7 Add `src/api/v1/items.ts` and register `POST /api/v1/items`, `PATCH /api/v1/items/:sku`, and `GET /api/v1/items/:sku` in `src/server.ts`.
  - [ ] 1.8 Wrap create and update in one caller-owned transaction: projection row write, `persistEvent()`, and audit entry must commit or roll back together.
  - [ ] 1.9 Emit dot-separated past-tense events such as `item.created` and `item.updated` with `stream_type: "item_master"`.

- [ ] Task 2: Add location register read model and API (AC: 3)
  - [ ] 2.1 Add `read/projections/location_register.sql` for warehouse topology master data, separate from the existing Story 1.6 lot-location projection.
  - [ ] 2.2 Model `location_id UUID` plus unique human-readable `location_code TEXT` such as `BIN-A43`; existing Story 1.6 `asserted_location` and `expected_location` text values must remain readable.
  - [ ] 2.3 Support hierarchy levels `site`, `zone`, `aisle`, `rack`, and `bin`, with parent-child validation. A child must not be created unless its parent exists.
  - [ ] 2.4 Persist attributes needed by this story and Epic 3: `zone_type`, `temperature_class`, `hazmat_allowed`, `quarantine`, `site_id`, `status`, `created_at`, and `updated_at`.
  - [ ] 2.5 Add `src/read/projections/location_register.ts` with create, update, read-by-ID, read-by-code, parent validation, and compatibility lookup helpers.
  - [ ] 2.6 Add location-register handlers and register `POST /api/v1/locations`, `PATCH /api/v1/locations/:locationId`, and `GET /api/v1/locations/:locationId`.
  - [ ] 2.7 Preserve the Story 1.6 current-lot-location API by moving it to an explicit route such as `GET /api/v1/lots/:lotId/location` and `POST /api/v1/lots/:lotId/location/expected`; update tests and the spine route allowlist accordingly.
  - [ ] 2.8 Do not keep both `GET /api/v1/locations/:lotId` and `GET /api/v1/locations/:locationId`; parameter names do not affect router matching.
  - [ ] 2.9 Emit `location_register.created` and `location_register.updated` events with `stream_type: "location_register"`.

- [ ] Task 3: Add central inventory master validation at `persistEvent()` (AC: 2, 3)
  - [ ] 3.1 Add `src/compliance/inventory-master.ts` as the single validation seam for SKU existence, location existence, and zone compatibility.
  - [ ] 3.2 Invoke the validator from `src/events/store.ts` near the existing business-stream, calibration, and location checks so HTTP events, edge uploads, and future adapters are covered.
  - [ ] 3.3 Gate validation narrowly to inventory movement events that actually reference `sku`, target location, or placement location fields; DOA, SCIM, audit, notification, business-stream config, item-master, and location-register streams must pass through untouched.
  - [ ] 3.4 Reject unknown SKU with `AppError(400, "ITEM_NOT_FOUND", ...)` before consuming an idempotency key or writing `domain_events`.
  - [ ] 3.5 Reject unknown target location with a stable error code such as `LOCATION_NOT_FOUND`; include the supplied location identifier in `details`.
  - [ ] 3.6 Implement `ZONE_INCOMPATIBLE` as a non-blocking warning response, not as an error. Persist the event only after the caller confirms placement with the warning.
  - [ ] 3.7 If the current backend cannot return warnings from `persistEvent()` directly, implement a small success envelope or two-step confirmation command for inventory movements instead of hiding the warning in an error response.
  - [ ] 3.8 Validate actor `location_id` against the new register where the actor is site-scoped; close the deferred Story 1.6 gap where wildcard users can stamp arbitrary audit locations.

- [ ] Task 4: Wire migrations, deployment mirror, and route-surface guards (AC: 1, 2, 3)
  - [ ] 4.1 Add `item_master.sql` and `location_register.sql` to the fixed migration list in `src/events/migrate.ts`.
  - [ ] 4.2 Mirror both schemas and all guarded grants in `deploy/compose/init-db.sql`; each file must be self-sufficient for a fresh database.
  - [ ] 4.3 Update all integration test truncation lists that need the new tables, using `CASCADE` where FK relationships are present.
  - [ ] 4.4 Update Story 1.9 route-surface tests for every deliberate route addition or route move.
  - [ ] 4.5 Add a lightweight drift guard if practical, asserting the canonical migration files and compose mirror both contain the expected table and grant names.

- [ ] Task 5: Add complete tests and preserve existing behavior (AC: 1, 2, 3)
  - [ ] 5.1 Add `test/integration/story-2-1.test.ts` covering item create, item read, duplicate SKU, invalid valuation method, invalid business stream, and audit rollback on failure.
  - [ ] 5.2 Cover location create, location read, hierarchy parent validation, duplicate location code, and zone and temperature attribute retrieval.
  - [ ] 5.3 Cover unknown item rejection through `POST /api/v1/events` and through `POST /api/v1/edge/events` if the edge path accepts an inventory movement shape in tests.
  - [ ] 5.4 Cover non-inventory events remaining unaffected by item and location validation.
  - [ ] 5.5 Cover `ZONE_INCOMPATIBLE` as a warning that precedes confirmed placement, and verify confirmation persists only once.
  - [ ] 5.6 Update existing Story 1.6 tests after moving the current-lot-location route; keep asserted-vs-expected, stale-event guarding, and `location.disputed` behavior green.
  - [ ] 5.7 Cover RBAC for module `inventory`, read versus write function scopes, and location-scoped access.
  - [ ] 5.8 Run the full verification battery: `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm test`, `npm run spine-acceptance-contract`, and `git diff --check`.

## Dev Notes

### Current Repository State

- Story 2.1 is the first backlog story in Epic 2. Epic 2 currently starts after the complete Epic 1 platform foundation. [Source: `_bmad-output/implementation-artifacts/sprint-status.yaml` lines 115-134]
- Epic 2 depends on Epic 1. Epic 1 is now done through Story 1.11, with SSO/RBAC, statutory edit log, DOA registry, business-stream tagging, event-sourced location, calibration lockout, offline edge shell, CI/CD, and notifications already implemented. [Source: `_bmad-output/planning-artifacts/epics.md` lines 351-359]
- The current backend has no item master API, no item master projection, and no location register projection. The only existing `location` projection is Story 1.6's current lot-location read model. [Source: `src/api/v1/location.ts` lines 74-77]
- `src/server.ts` currently registers `GET /api/v1/locations/:lotId` for current lot location. Story 2.1's required `GET /api/v1/locations/{location_id}` conflicts with that route and must be resolved deliberately. [Source: `src/server.ts` lines 66-67]

### Previous Story Intelligence

- Story 1.11 proved the standard end-to-end pattern for a new domain area: canonical SQL projection, projection helpers, domain/service module where needed, REST handler, route registration, migration list update, compose schema mirror, integration tests, and route-surface allowlist update. [Source: `_bmad-output/implementation-artifacts/1-11-notification-and-alerting-foundation.md` lines 245-263]
- Story 1.11 exposed a missing `CASCADE` in an older test harness after adding new FK-referencing tables. Story 2.1 will also add tables that other records may reference, so harness truncation must be reviewed before running the full suite. [Source: `_bmad-output/implementation-artifacts/1-11-notification-and-alerting-foundation.md` lines 224-232]
- Story 1.11 updated the Story 1.9 exact production route-surface allowlist after new routes landed. Story 2.1 must do the same for item and location routes. [Source: `_bmad-output/implementation-artifacts/1-11-notification-and-alerting-foundation.md` lines 231-232]
- Reuse distinct role strings in tests. Story 1.11 found that business role names and module-access role names share `user_role_assignments`, so careless fixture role reuse causes false authorization or false routing. [Source: `_bmad-output/implementation-artifacts/1-11-notification-and-alerting-foundation.md` lines 241-242]

### Architecture Compliance

- This story lives in the `inventory` capability. The architecture places core inventory under `inventory/` and governs it by AD-1, AD-14, and AD-15. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 248-253]
- Read models are shared projections. Do not make downstream modules query private item or location event streams. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 148-152]
- Every event keeps the existing envelope shape: UUID event and stream IDs, dot-separated past-tense event types, JSONB payload, actor metadata, UTC `occurred_at`, and schema version. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 278-298]
- Use UUIDv4 internal IDs, stable error codes, and REST under `/api/v1/`. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 172-188 and 328-337]
- Event-sourced location with asserted and expected facts remains separate from this story's location register. The current location projection is derived state, not the warehouse topology master. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 154-158]
- Business-stream vocabulary is existing reference data from Story 1.5. Item master must validate against it instead of duplicating stream definitions. [Source: `src/compliance/business-stream.ts` lines 48-63]

### UX Requirements

- There is no dedicated item-master or location-register screen in the current UX artifacts. Treat this story as backend/API plus testable contracts unless the implementation chooses to add a minimal admin UI.
- If a UI is added, it must use the internal custom UI system with React and TailwindCSS, not an external design-system dependency. [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md` lines 28-31]
- Any frontline or tablet-facing placement confirmation must keep the header sync badge visible, use 44 by 44 px minimum touch targets, and never rely on color alone. [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md` lines 357-361 and 596-627]
- Warning copy for `ZONE_INCOMPATIBLE` must be actionable and explicit, following the error recovery pattern. [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md` lines 151-158 and 516-549]

### Existing Files to Read Before Editing

- `src/events/store.ts`: central write path, transaction joining, audit logging, and error mapping. Preserve idempotency and stream conflict behavior. [Source: `src/events/store.ts` lines 147-270]
- `src/compliance/business-stream.ts`: preferred central invariant pattern, gated by stream type so unrelated streams remain unaffected. [Source: `src/compliance/business-stream.ts` lines 6-20 and 48-86]
- `src/api/v1/location.ts`: current lot-location API and explicit note that Epic 2 owns real location masters. [Source: `src/api/v1/location.ts` lines 74-77]
- `src/server.ts`: current route registrations and the existing route collision. [Source: `src/server.ts` lines 48-82]
- `src/events/migrate.ts`: fixed migration array that must include new projection SQL files. [Source: `src/events/migrate.ts` lines 8-17]
- `read/projections/location.sql` and `src/read/projections/location.ts`: current lot-location projection. Do not convert these files into the location register.
- `read/projections/instrument_calibration.sql` and `src/read/projections/instrument_calibration.ts`: good precedent for an internal UUID plus unique external text identifier.
- `src/api/v1/doa.ts` and `src/read/projections/doa_registry.ts`: transaction pattern for row write plus event plus audit.
- `test/integration/story-1-6.test.ts` and `test/unit/location.test.ts`: regression coverage for the existing event-sourced location invariant.
- `test/integration/story-1-9.test.ts`: route-surface guard to update after route changes.

### Anti-Patterns to Avoid

- Do not overload `read/projections/location.sql` with warehouse master data. It is the Story 1.6 current-location projection and must remain focused.
- Do not add item/location validation only in HTTP handlers. It must live on the central `persistEvent()` path so edge uploads and future adapters cannot bypass it.
- Do not trust request-body actor fields for audited user, role, or location. Use authenticated context and authorized assignment.
- Do not hard-code business-stream values in item-master code.
- Do not introduce LIFO as an accepted valuation method.
- Do not silently preserve `GET /api/v1/locations/:lotId` if `GET /api/v1/locations/:locationId` is added. Those routes are ambiguous.
- Do not make `ZONE_INCOMPATIBLE` a hard rejection. The story requires a warning before placement is confirmed.
- Do not create a new dependency for validation, queues, schedulers, or UI components. Existing TypeScript, Node, PostgreSQL, and repo utilities are enough.

### Testing Requirements

- Baseline from the previous completed story: backend tests 157/157, spine gate 6/6, TypeScript, ESLint, build, edge checks, and `git diff --check` clean. Preserve or improve this baseline. [Source: `_bmad-output/implementation-artifacts/sprint-status.yaml` lines 51-60]
- Integration tests require the PostgreSQL test container to be running and use serial execution via `--test-concurrency=1`. [Source: `package.json` lines 13-15]
- New integration tests must use the existing auth/RBAC and SCIM test setup, not mock authentication.
- `ITEM_NOT_FOUND` must be tested before any domain event row is inserted for the rejected movement.
- `ZONE_INCOMPATIBLE` must prove that the warning is visible before confirmed placement, and that confirmed placement is not duplicated when retried with the same idempotency key.
- Regression tests must prove Story 1.6 current-location reads and `location.disputed` still work after route changes.
- Route-surface and spine acceptance tests must remain green; do not add item/location master to the five spine invariants.

### Latest Technical Information

- Use the versions already pinned in this repository: Node.js 24 or newer, TypeScript 5.8, `pg` 8.16, ESLint 9, and PostgreSQL 18.4 in the integration environment. [Source: `package.json` lines 6-42]
- No new npm package is required for Story 2.1.
- PostgreSQL DDL must be idempotent and safe on databases that already contain data.
- If effective dates are added during implementation, format local business dates from local year, month, and day components rather than UTC slicing.

### Project Context Reference

- BMad Phase 4 implementation is active. The pilot slice includes Epics 1, 2, 3, 5, 7, 8, 9, Story 11.2, and Epic 13.
- This story starts Epic 2. Its item and location masters become dependencies for stock balances, lot and serial traceability, valuation, warehouse topology, BOM release gates, BIS licence coverage, and migration sign-off.
- Markdown in this repository follows `FORMATTING_RULES.md`: one H1 first, sequential headings, hyphens instead of em dashes, no arrow sequences in prose, wrapped links only, and referenced tables.

### Open Clarifications Saved for Dev Judgment

- The epics say "lot/serial control flag" but later stories treat lot control and serial control separately. Implement separate booleans unless a product owner explicitly collapses them.
- The acceptance criteria specify GET endpoints but not POST/PATCH payloads. Implement minimal create/update payloads needed to satisfy the ACs and downstream fields listed in this story.
- The exact warning envelope for `ZONE_INCOMPATIBLE` is not established elsewhere. Make it explicit, tested, and stable.
- Decide whether location compatibility is based on `location_id`, `location_code`, or both in inventory movement payloads. Preserve existing text location codes while adding UUID register IDs.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` Epic 2 goal and dependency lines 351-359]
- [Source: `_bmad-output/planning-artifacts/epics.md` Story 2.1 lines 915-935]
- [Source: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md` circular dependency correction lines 517-537]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` AD-14, AD-15, AD-16, stack, event envelope, API contract]
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md` sections 1, 3, 5, 6, and 7]
- [Source: `_bmad-output/implementation-artifacts/1-11-notification-and-alerting-foundation.md` previous story patterns and completion notes]
- [Source: `_bmad-output/implementation-artifacts/deferred-work.md` location register deferred validation gap]
- [Source: `src/events/store.ts` central write path]
- [Source: `src/compliance/business-stream.ts` central invariant pattern]
- [Source: `src/api/v1/location.ts` existing location projection API]
- [Source: `src/server.ts` route registration]
- [Source: `src/events/migrate.ts` migration list]
- [Source: `package.json` scripts and dependencies]

## Dev Agent Record

### Agent Model Used

fugu-ultra-20260615

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Activation workflow resolved successfully. No activation prepend or append steps were configured.
- Persistent facts glob `**/project-context.md` matched no files in this workspace.
- Artifact discovery loaded the sprint status, epics, architecture spine, PRD archive, UX design, UX experience specification, previous story, and repository source patterns.
- Web research was not required: Story 2.1 uses only the repository's existing Node.js, TypeScript, PostgreSQL, and `pg` stack, with no new external library.

### File List

## Change Log

- 2026-07-21: Created Story 2.1 as ready-for-dev with item master, location register, central inventory master validation, route collision, migration, test, and regression guardrails.
