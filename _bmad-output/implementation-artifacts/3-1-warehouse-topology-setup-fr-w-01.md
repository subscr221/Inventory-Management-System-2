---
baseline_commit: 7cd3dc74bab7180b15b57f0e3ecb19d9eb63515b
---

# Story 3.1: Warehouse Topology Setup (FR-W-01)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a warehouse manager,
I want to define and manage the warehouse topology (sites, zones, aisles, racks, bins) with temperature, hazmat, and quarantine zone attributes,
so that every putaway task, pick path, and location override references a real, validated physical location in the system.

## Acceptance Criteria

1. **Given** a warehouse manager creates a zone `ZONE-COLD` with `temperature_class: "cold"` at `site-A`
   **When** `GET /api/v1/locations?site=site-A` is called
   **Then** `ZONE-COLD` appears in the response with its zone type and temperature class (FR-W-01)

2. **Given** a bin `BIN-A43` is created under aisle `AISLE-A`, rack `RACK-4`, zone `ZONE-AMBIENT`
   **When** `GET /api/v1/locations/BIN-A43` is called
   **Then** the response returns the bin with its full hierarchy path (`site-A > ZONE-AMBIENT > AISLE-A > RACK-4 > BIN-A43`) and its attributes (size class, temperature class, hazmat flag) — verifiable at this story's completion; putaway-task consumption of the path is exercised in Stories 3.4/3.5 (FR-W-01)

3. **Given** a quarantine zone `ZONE-QC-HOLD` is marked `access_restricted: true`
   **When** any location-assignment write targeting `ZONE-QC-HOLD` is attempted by a user without the `qc_inspector` role
   **Then** the system rejects the write with `error_code: "ZONE_ACCESS_RESTRICTED"` — the rule is enforced at the location service, so putaway tasks built in Stories 3.4/3.5 inherit it without re-implementation

## Tasks / Subtasks

- [x] Task 1 (AC: 1)
  - [x] Implement zone creation API endpoint
  - [x] Add temperature_class attribute to zones
  - [x] Implement GET /api/v1/locations endpoint with site filtering
- [x] Task 2 (AC: 2)
  - [x] Implement hierarchical location structure (site > zone > aisle > rack > bin)
  - [x] Add size class, temperature class, and hazmat flag attributes to locations
  - [x] Implement GET /api/v1/locations/{locationId} endpoint with full hierarchy path
- [x] Task 3 (AC: 3)
  - [x] Add access_restricted flag to zones
  - [x] Implement role-based access control for restricted zones
  - [x] Return ZONE_ACCESS_RESTRICTED error for unauthorized users

## Dev Notes

- This is the first story in Epic 3: Warehouse Operations and Frontline Capture Flows
- The story establishes the foundational location hierarchy that will be used by subsequent stories in this epic
- Must integrate with existing RBAC system from Epic 1 and item master from Epic 2
- Follow the event-sourced architecture pattern established in previous epics
- Zone types and attributes should be configurable to support different warehouse layouts

### Project Structure Notes

- Location-related APIs should follow the existing REST API patterns in `/api/v1/locations`
- Database schema should align with existing entity naming conventions
- Events should be stored in the domain_events table with appropriate stream types
- Follow the established error code naming conventions (UPPER_SNAKE_CASE)

### References

- Epic 3 requirements: [epics.md#epic-3]
- Location hierarchy design: [epics.md#story-31]
- RBAC integration: [epics.md#story-12]
- Event-sourced architecture: [epics.md#story-11]

## Dev Agent Record

### Agent Model Used

fugu-ultra-20260615

### Debug Log References

- Red phase: `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-3-1.test.ts` failed before implementation with missing list route, UUID-only detail route, and missing restricted-zone enforcement.
- Green phase: Story 3.1 targeted test passed after implementing schema, projection, API, and route changes.
- Validation: `npm run build`, `npm run lint`, targeted guardrails, and full `npm test` passed.
- Review fix: moved restricted-zone enforcement into the location service path, tightened PATCH and inherited descendant checks, made restricted-flag management consistent after local re-review findings, and final re-review returned no findings.

### Completion Notes List

- Implemented `GET /api/v1/locations?site=...` with site code or UUID lookup and ordered site topology listing.
- Extended `location_register` with `size_class` and `access_restricted`, mirrored in canonical SQL and compose init SQL with idempotent live-database alters.
- Implemented code-aware `GET /api/v1/locations/{locationId}` with full hierarchy path output for bins and other location levels.
- Added restricted-zone write enforcement so non-`qc_inspector` location writes under `access_restricted` ancestors return `ZONE_ACCESS_RESTRICTED` on create and patch paths.
- Added Story 3.1 integration coverage for all acceptance criteria and updated route-surface/schema drift guardrails.

### File List

- `_bmad-output/implementation-artifacts/3-1-warehouse-topology-setup-fr-w-01.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `deploy/compose/init-db.sql`
- `read/projections/location_register.sql`
- `src/api/v1/location-register.ts`
- `src/read/projections/location_register.ts`
- `src/server.ts`
- `test/integration/story-1-9.test.ts`
- `test/integration/story-3-1.test.ts`

### Change Log

- 2026-07-22: Implemented warehouse topology list/detail APIs, extended location attributes, restricted-zone enforcement, and Story 3.1 tests; moved story to review.
- 2026-07-22: Addressed re-review findings for service-level restricted-zone enforcement, consistent restricted-flag permissions, and recursive ancestor lookup; final re-review and full regression passed; moved story to done.