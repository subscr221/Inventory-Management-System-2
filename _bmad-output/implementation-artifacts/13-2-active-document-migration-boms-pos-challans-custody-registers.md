---
baseline_commit: 7e0f88c338b2c7c24d9672179d188d6a873f7a92
---
# Story 13.2: Active Document Migration - BOMs, POs, Challans, Custody Registers

Status: in-progress

## Story

As a migration lead,
I want active BOMs, open POs, job-work challans with source references, and custody and loan registers migrated with department-head verification per domain,
so that in-flight operations continue seamlessly in the new system.

## Sequencing

Story 13.2 is the second of the three pilot-gate stories. Story 13.1 (opening stock) is implemented and in review on the uncommitted working tree at `7e0f88c`; this story builds on top of that tree and reuses its `migration` stream, its CSV import mechanics, its `migration_import` and `migration_stage` tables, its RBAC helpers and its test closure set. Story 13.3 consumes one thing this story builds: the per-site, per-domain verification status (`unverified` or `verified`) for the four document domains, exposed as one TypeScript function and one read route. Build the status derivation once, in one place, and let 13.3 import it.

The pilot wave verifies four domains: `active_boms`, `open_pos`, `jobwork_challans`, `custody_registers`. The domain set is a constant; a later wave (Epic 10 loan registers, Epic 4 native POs) adds a source kind, not a new mechanism.

## Acceptance Criteria

1. **Given** a domain's migration output (FR-DM-02)
   **When** the domain verification run executes
   **Then** active BOMs, open POs, job-work challans with source references, and custody and loan registers pass referential-integrity checks - every migrated document's item, location, supplier, and source-document references resolve - and per-domain reconciliation counts (source records vs migrated records) are produced on the domain verification report

2. **Given** a migrated document with an unresolvable reference - e.g., an open-PO line whose item is absent from the item master, or a challan source reference that cannot be matched (FR-DM-02)
   **When** the domain verification run executes
   **Then** the document is quarantined with `error_code: "UNKNOWN_REFERENCE"` and listed on the domain verification report the department head reviews - it does not count as migrated

3. **Given** migrated open-PO balances (FR-DM-01)
   **When** the open-PO domain is verified
   **Then** each migrated open-PO line (ordered, received, and open quantities with line tolerances) reconciles against the Story 2.9 ERP inbound reference projection, and every mismatch is listed on the domain verification report

4. **Given** migrated documents in a domain (FR-DM-02)
   **When** the department head reviews them
   **Then** a verification sign-off is recorded per domain before that domain is considered migrated

5. **Given** a domain without a department-head sign-off (FR-DM-02)
   **When** the domain's verification status is queried
   **Then** the domain reports status `unverified` - this per-domain status is queryable at any time and is the input Story 13.3's go-live gate consumes

## Prerequisites

- Baseline is the Story 13.1 working tree on `master` at `7e0f88c` plus the uncommitted 13.1 files (20 modified, 13 untracked). Full suite 2151/2151 green with `--test-concurrency=1`, `npm run build` 0, `npm run lint` 0, `tsc --noEmit` 0. Any red test after this story is a regression this story introduced. If 13.1 is committed before this story starts, the baseline is that commit; nothing in this story depends on which.
- Story 5.2 is done: legacy kits migrate through `POST /api/v1/boms/legacy-kit-migration` and land as `bom` rows with `origin = 'legacy_kit'`, `kit_ref` and `remediation_flag`. That route is the BOM migration execution path; this story verifies its output and never re-implements it.
- Story 2.9 is done: `erp_purchase_order` and `erp_purchase_order_line` are the pilot's only purchase-order records. In the pilot wave the ERP stays the PO master and native POs (Epic 4, code present, not pilot) are out of scope.
- Epic 9 is done and closed: `service_order`, `jobwork_material_receipt` (the inbound challan), `jobwork_return_clock` and `custody_ledger_entry` are the migrated-document tables for the two job-work domains.
- Epic 10 is backlog with no code. The `custody_registers` domain in this story verifies job-work custody ledgers only (epic dev note); Epic 10 loan registers are a later wave.

## Tasks / Subtasks

- [ ] Task 0: baseline and inventory before writing code (AC: all)
  - [ ] 0.1 Confirm the 13.1 tree builds and the full suite is 2151/2151; record the figure. Do not start with a red baseline.
  - [ ] 0.2 Grep `src`, `test`, `read` for every code this story mints before minting it: `MANIFEST_REQUIRED`, `VERIFICATION_STALE`, `VERIFICATION_UNRESOLVED`, `RECONCILIATION_MISMATCH`, `SIGNOFF_ACTOR_CONFLICT`, `DOMAIN_UNSUPPORTED`. At story creation none existed. Reuse `UNKNOWN_REFERENCE`, `MALFORMED_ROW`, `TEMPLATE_VERSION_UNSUPPORTED`, `STAGE_LOCKED`, `INVALID_STATE`, `LOCATION_ACCESS_DENIED`, `MODULE_ACCESS_DENIED`, `FUNCTION_ACCESS_DENIED`, `DUPLICATE_EVENT`, `INVALID_PARAMS` with their existing meanings.
  - [ ] 0.3 Read before touching: `src/api/v1/migration.ts:67-68,120-150,176-262,592-720,778-801,1162-1173`; `src/compliance/migration-opening-stock.ts:44-63,107-125,285-347,356-395`; `src/events/schema.ts:5152-5225,6253-6273`; `src/events/store.ts:539-562,1262-1267`; `read/projections/migration_stage.sql`, `read/projections/migration_import.sql:37,45-52`, `read/projections/migration_import_rejection.sql:21,33-34`; `read/projections/bom.sql:16-44`, `read/projections/bom_line.sql:9-37`; `read/projections/erp_purchase_order.sql:19-52`; `read/projections/service_order.sql:22-51,79`, `read/projections/jobwork_material_receipt.sql:25-51`, `read/projections/jobwork_return_clock.sql:40-60`, `read/projections/custody_ledger_entry.sql:26-62,87-89`; `src/compliance/custody-ledger.ts:803-813` (the balance SUM); `src/compliance/receiving.ts:410-430` (the tolerance predicate).

- [ ] Task 1: schema (AC: 1, 2, 4, 5)
  - [ ] 1.1 Widen `chk_migration_import_domain` in `read/projections/migration_import.sql` (both the inline CHECK at `:37` and the guarded block at `:45-52`) to `domain IN ('opening_stock','active_boms','open_pos','jobwork_challans','custody_registers')` using the DROP-then-ADD pattern from `read/projections/bom.sql` (`ALTER TABLE ... DROP CONSTRAINT IF EXISTS ...; ALTER TABLE ... ADD CONSTRAINT ...` inside one `DO $$` block). A plain CHECK edit never propagates to an existing database (deferred-work 220). Mirror in `deploy/compose/init-db.sql`.
  - [ ] 1.2 Extend `read/projections/migration_stage.sql` with guarded `ALTER TABLE migration_stage ADD COLUMN IF NOT EXISTS` for `latest_load_id UUID`, `latest_run_id UUID`, `verified_run_id UUID`, `verified_at TIMESTAMPTZ`, `verified_event_id UUID`, `verified_by_actor_id UUID` (precedent `read/projections/bom.sql:42-44`). Leave `stage` and its CHECK untouched: document domains never promote, their `stage` stays `staging`, and the stage column keeps its 13.1 meaning.
  - [ ] 1.3 Create `read/projections/migration_document_manifest_row.sql`: `(row_id UUID PK, load_id UUID NOT NULL, site_id UUID NOT NULL, domain TEXT NOT NULL, line_no INT NOT NULL, document_ref_ext TEXT NOT NULL, line_ref TEXT NOT NULL, sku TEXT, quantity NUMERIC(18,6), attributes JSONB NOT NULL, content_hash TEXT NOT NULL, source_event_id UUID NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, business_date DATE NOT NULL, created_at)`. Unique `(load_id, document_ref_ext, line_ref)`; index `(site_id, domain, load_id)`. Same domain CHECK vocabulary as 1.1 minus `opening_stock`. Grants: `app_user` INSERT, SELECT; `readonly_user` SELECT. No UPDATE: a manifest is immutable once loaded and is replaced by a new load.
  - [ ] 1.4 Create `read/projections/migration_domain_verification.sql`: `(run_id UUID PK, site_id UUID NOT NULL, domain TEXT NOT NULL, load_id UUID NOT NULL, source_count INT NOT NULL, migrated_count INT NOT NULL, quarantined_count INT NOT NULL, mismatch_count INT NOT NULL, waived_count INT NOT NULL DEFAULT 0, run_by_actor_id UUID NOT NULL, findings_sha256 TEXT NOT NULL, source_event_id UUID NOT NULL, occurred_at, business_date, created_at)`. Index `(site_id, domain, created_at DESC)`. Grants INSERT, SELECT, UPDATE for `app_user` (UPDATE for `waived_count`).
  - [ ] 1.5 Create `read/projections/migration_domain_verification_finding.sql`: `(finding_id UUID PK, run_id UUID NOT NULL, site_id UUID NOT NULL, domain TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('unknown_reference','missing_in_platform','missing_in_source','field_mismatch','state_mismatch')), error_code TEXT NOT NULL CHECK (error_code IN ('UNKNOWN_REFERENCE','RECONCILIATION_MISMATCH')), document_ref_ext TEXT NOT NULL, line_ref TEXT NOT NULL, platform_ref TEXT, field TEXT, source_value TEXT, platform_value TEXT, details JSONB NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','waived')), waiver_narrative TEXT, waived_event_id UUID, created_at)`. Unique `(run_id, kind, document_ref_ext, line_ref, field) NULLS NOT DISTINCT`; index `(run_id, status)`. Grants INSERT, SELECT, UPDATE.
  - [ ] 1.6 Append the three new files to the tail of `MIGRATIONS` in `src/events/migrate.ts` (after `:303`) under a Story 13.2 comment block; mirror every CREATE TABLE, ALTER, CHECK, index and grant into `deploy/compose/init-db.sql`; pin the three tables in `test/unit/schema-drift.test.ts` in the `{ canonical, table, constraints, indexes, appUserGrant }` shape at `:2060-2119`, update the `migration_stage` pin if its constraint list changes, and add a widened-CHECK fragment pin for `chk_migration_import_domain` against both canonical and `init-db.sql` (pattern `:2174-2206`). Run `node --env-file=.env.test --import tsx src/events/migrate.ts` twice; the second run is a no-op.

- [ ] Task 2: events (AC: 1, 4)
  - [ ] 2.1 In `src/events/schema.ts` widen `MigrationImportCompletedPayload.domain` (`:5155`) from `'opening_stock'` to the `MigrationDomain` union `'opening_stock' | 'active_boms' | 'open_pos' | 'jobwork_challans' | 'custody_registers'`; declare and export that union once beside the 13.1 interfaces. `MigrationStagePromotedPayload.domain` (`:5213`) stays `'opening_stock'`: only opening stock promotes.
  - [ ] 2.2 Declare payload and envelope interfaces for the three events in Table 1, following the `XxxPayload` plus `XxxEnvelope extends Omit<EventEnvelope,'payload'>` pattern at `:5211-5225`. Every payload carries `site_id` and `business_date`.
  - [ ] 2.3 Append the three entries to the tail of `SUPPORTED_EVENT_TYPES` (after `:6271`, before `} as const;`) as `{ streamType: 'migration', requiresBusinessStream: false }`, verbatim shape of `'migration.stage.promoted'`. Add the three names to `MIGRATION_EVENT_TYPES` in `src/compliance/migration-opening-stock.ts:48-54`. Do not add them to any `EDGE_*_EVENT_TYPES`, `REBASE_SAFE_EVENT_TYPES` or `PERMANENT_ERROR_CODES` set; both event doors already bar the whole `migration` stream (`src/api/v1/events.ts:405-419`, `src/api/v1/edge.ts:384-391`) and Task 8.5 proves it still holds for the new names.
  - [ ] 2.4 Create `src/compliance/migration-documents.ts` exporting `assertMigrationDocumentEventShape(envelope)` (pure) and `applyMigrationDocumentProjection(envelope, client, eventId, auditCtx)`. Wire the assert as a call from inside `assertMigrationEventShape` (one entry point in the seam, dispatching by type, so `store.ts:561` is untouched) and the applier as new `case` arms in `applyMigrationProjection`'s switch (`migration-opening-stock.ts:307-332`) that delegate to the new module. Nothing in the seam or the switch is reordered.
  - [ ] 2.5 Shape rules: `domain` in the four document domains (`INVALID_EVENT_STREAM` is wrong here; use 400 `DOMAIN_UNSUPPORTED` with `details.supported`); `rows[]` and `findings[]` are arrays capped at 10,000 entries; `quantity` strings match `NUMERIC_18_6_REGEX` (`migration-opening-stock.ts:80`, reuse, never restate); `run_id`, `load_id`, `finding_id` UUIDs; `waivers[]` entries carry a UUID `finding_id` and a non-empty `narrative` of at most 2,000 characters.

- [ ] Task 3: manifest import, one route for four domains (AC: 1)
  - [ ] 3.1 Create `src/migration/document-templates.ts` with four byte-exact v1 header constants (Table 2) and `DOCUMENT_TEMPLATES: Record<DocumentDomain, { v1: readonly string[] }>`, `MIGRATION_DOCUMENT_DOMAINS = ['active_boms','open_pos','jobwork_challans','custody_registers'] as const`, `DOMAIN_MODULE` (Table 3), `DOMAIN_SIGNOFF_ROLES` (Table 3), and per-domain `toManifestRow(cells, line_no)` that returns `{ document_ref_ext, line_ref, sku, quantity, attributes }` or a typed `MALFORMED_ROW` failure with `details.column`. Reuse `parseCsv` from `src/migration/csv.ts`, `fileSha256` and the SHA-256 content-hash helper from `src/migration/opening-stock-template.ts:96-107` (generalise its name if needed; do not write a second hasher). Reuse `MAX_OPENING_STOCK_IMPORT_ROWS` by renaming it `MAX_IMPORT_ROWS` in place and updating the two 13.1 references.
  - [ ] 3.2 `POST /api/v1/migration/documents/imports` in `src/api/v1/migration.ts`. Body `{ site_id, domain, file_name, template_version: 'v1', csv, idempotency_key }`. Gate with the existing `write` wrapper and `requireMigrationWriteActor(req, site_id)` (`migration.ts:176-203`), so role, module, scope and site bind to one assignment. `domain` outside the set is 400 `DOMAIN_UNSUPPORTED`. Header mismatch is 400 `TEMPLATE_VERSION_UNSUPPORTED` with `details.expected_header`. Replaying `idempotency_key` returns the stored `migration_import` header with 200 (`findEventByIdempotencyKey`, `:264-276`).
  - [ ] 3.3 Per row: (a) cell count and typed parse (`MALFORMED_ROW`, `details.column`); (b) `site_code` resolves to the request's `site_id` (`UNKNOWN_REFERENCE`, `details.reference: 'site_code'`) - this is the ONLY reference resolved at import; item, PO, order and challan references are resolved by the verification run (Task 4) so that a manifest row for a document the platform lacks is reported as `missing_in_platform`, not silently rejected; (c) a `(document_ref_ext, line_ref)` pair seen earlier in the file is `MALFORMED_ROW` with `details.reason: 'duplicate_manifest_key'` and `details.first_line_no` (the rejection table's CHECK is not widened for this).
  - [ ] 3.4 Persist ONE `migration.document_manifest.loaded` event carrying every accepted row (stream `site_id`, `idempotency_key = 'migration:manifest:{site_id}:{domain}:{file_sha256}'`, `causation_id = load_id`) and then ONE `migration.import.completed` (existing event, `domain` widened, `mode: 'initial'`, `suppressed_count: 0`, `superseded_count: 0`, full `rejections[]`). A re-submitted identical file is a `DUPLICATE_EVENT` on the manifest event; catch it and return the existing header with 200. A differing file for the same site and domain is a new load that becomes `latest_load_id`; the previous manifest stays queryable by `load_id` and is never deleted (no DELETE grant).
  - [ ] 3.5 Applier for `migration.document_manifest.loaded`: insert every row into `migration_document_manifest_row` with `source_event_id = eventId`; `lockMigrationStage(site_id, domain, client)` (`migration-opening-stock.ts:356`, inserts `staging` if absent) and set `latest_load_id`. Do not touch `stage`.
  - [ ] 3.6 Read routes: `GET /api/v1/migration/documents/imports/:load_id` (reuse `getOpeningStockImportBase` `:727` by widening it to any domain, so one handler serves both), `GET /api/v1/migration/documents/rows?site_id=&domain=&load_id=` (paged, `LIMIT` capped at 500).

- [ ] Task 4: verification run, one SQL per domain, one dispatcher (AC: 1, 2, 3)
  - [ ] 4.1 Create `src/read/projections/migration_domain_verification.ts` exporting `computeDomainFindings(domain, siteId, loadId, client): Promise<{ source_count, migrated_count, quarantined_count, mismatch_count, findings: DomainFinding[] }>` that dispatches to four per-domain SQL statements and one shared post-processor. `DomainFinding = { kind, error_code, document_ref_ext, line_ref, platform_ref, field, source_value, platform_value, details }`. All quantities compare as NUMERIC in SQL, never as JS floats.
  - [ ] 4.2 `active_boms`: source = manifest rows grouped by `kit_ref`; platform = `bom` rows with `origin = 'legacy_kit'` joined to `bom_revision` (`current_revision_id`) and `bom_line`. Findings: `missing_in_platform` (kit_ref with no `bom`); `state_mismatch` (`status <> 'released'`, or `remediation_flag = true`, `field: 'status'`); `field_mismatch` per `(kit_ref, component_sku)` on `quantity_per` and `line_uom`, plus a manifest component with no matching non-placeholder `bom_line` (`field: 'component_sku'`); `unknown_reference` when `parent_item_id` or any non-placeholder `component_item_id` has no `item_master` row with `status = 'active'` (`details.reference`); `missing_in_source` (a `legacy_kit` bom whose `kit_ref` is in no manifest row of this load). `migrated_count` = kits matched with zero findings. BOMs carry no `site_id`; the run is enterprise-wide against the site's manifest (Open Question 1).
  - [ ] 4.3 `open_pos` (AC 3): source = manifest rows keyed `(po_number_ext, line_no)`; platform = `erp_purchase_order_line` joined to `erp_purchase_order` with `status = 'open'`. Compare `sku`, `ordered_qty`, `open_qty`, `over_receipt_tolerance_pct`, `under_receipt_tolerance_pct` (null on both sides is equal), `supplier_ref_ext` on the header, and the manifest `received_qty` against the projection-derived `ordered_qty - open_qty` (`field: 'received_qty'`). Findings: `missing_in_platform` (no open line), `missing_in_source` (open line in no manifest row), `field_mismatch` per differing field, `unknown_reference` when the line's `sku` has no active `item_master` row (`sync.ts:184 assertSkuActive` refuses this at sync time, so it arises only when the item is deactivated afterwards; the test deactivates one). The ERP projection carries no site; same enterprise-wide rule as 4.2.
  - [ ] 4.4 `jobwork_challans`: source = manifest rows keyed `(challan_number_ext, order_number_ext, sku)`; platform = `jobwork_material_receipt` joined to `service_order` on `service_order_id` where `service_order.site_id = $site` and matched on `(challan_number_ext, order_number_ext, sku)`. Compare `challan_date`, `challan_qty`, `uom`, `challan_class`, `customer_party_code`. `state_mismatch` when no `jobwork_return_clock` row exists for the receipt or its `challan_date` differs (`field: 'return_clock'`), because the GST 365/1095-day clock runs from the legacy challan date (`src/compliance/jobwork-return-clock.ts:46-47`). `unknown_reference` when the receipt's `sku` is not an active item, its `lot_id` is non-null and absent from `lot_master.lot_number`, its `grn_line_id` has no `grn_line`, or its `service_order_id` has no `service_order` (`details.reference`). `missing_in_source` for receipts at the site with no manifest row.
  - [ ] 4.5 `custody_registers`: source = manifest rows keyed `(order_number_ext, customer_party_code, sku)` with `custody_qty`; platform = `SUM(quantity_delta)` over `custody_ledger_entry` where `ownership = 'customer'` grouped by `(service_order_id, sku)`, joined to `service_order` at the site (the same SUM `src/compliance/custody-ledger.ts:803-813` uses; do not re-derive the sign convention). Compare balance and `uom`. `unknown_reference` when an entry's `sku` is not active, its `location_id` is non-null and absent from `location_register`, or its `service_order_id` resolves to no order. `missing_in_source` for a non-zero platform balance with no manifest row; `missing_in_platform` for a manifest row with no entries.
  - [ ] 4.6 Shared post-processor: a document with any `unknown_reference` finding is quarantined - it is excluded from `migrated_count`, all its other findings are still listed, and `quarantined_count` counts documents, not findings. `mismatch_count` counts findings of the other four kinds. `findings_sha256` is SHA-256 over the canonical JSON of the sorted findings.
  - [ ] 4.7 `POST /api/v1/migration/domains/:domain/verification-runs` body `{ site_id, idempotency_key }`. `requireMigrationWriteActor`. 409 `MANIFEST_REQUIRED` when `migration_stage.latest_load_id` is null for `(site_id, domain)`. Compute 4.1 in the handler, persist `migration.domain.verification_run` (stream `site_id`, `idempotency_key = 'migration:verify:{site_id}:{domain}:{key}'`) carrying counts, `load_id`, `findings[]`, `findings_sha256`. Applier: `lockMigrationStage`, refuse 409 `VERIFICATION_STALE` if `payload.load_id <> latest_load_id`, insert the run header and every finding with `status = 'open'`, set `latest_run_id`. The applier trusts the payload's findings (the event is the durable record of what the head reviewed) and does not recompute; a re-run is a new event.
  - [ ] 4.8 Report routes: `GET /api/v1/migration/domains/:domain/verification-runs?site_id=` (headers, newest first) and `GET /api/v1/migration/domains/:domain/verification-runs/:run_id?kind=&status=` (header plus findings, paged, `LIMIT` capped at 500). Both `read` scope with `requireSiteReadAccess`.

- [ ] Task 5: department-head sign-off, one parameterised flow (AC: 4)
  - [ ] 5.1 `POST /api/v1/migration/domains/:domain/sign-off` body `{ site_id, run_id, waivers: [{ finding_id, narrative }], idempotency_key }`. Register it under the `read` wrapper of module `migration` the way the approve route is (`migration.ts:1172`) because the real gate is role-and-module: the caller must hold an assignment with `role` in `DOMAIN_SIGNOFF_ROLES[domain]` (`department_head` for every pilot domain), `module` equal to `DOMAIN_MODULE[domain]` or `'*'`, `functionScope: 'write'`, and `locationId` equal to `site_id` or `'*'`. Otherwise 403 `FUNCTION_ACCESS_DENIED` with `details.required_roles` and `details.required_module`. The module is the platform's only department concept: an engineering head signs BOMs, a procurement head signs POs, a job-work head signs challans and custody. Write a `requireDomainSignoffActor(req, domain, siteId)` beside `requireMigrationWriteActor` and give it the same shape.
  - [ ] 5.2 SOD-07 (access matrix): the signer must not be `run_by_actor_id` of the run nor `created_by_actor_id` of the run's manifest load, else 403 `SIGNOFF_ACTOR_CONFLICT` with `details.conflicting_role`. Add a `{ transactionType: 'migration.domain_signoff', setterRole: 'migration_lead', approverRole: 'department_head' }` pair to `SEGREGATED_ROLE_PAIRS` in `src/cli/verify-segregated-roles-core.ts:53` with a comment in the 13.1 style, so the separation is also checked at provisioning time.
  - [ ] 5.3 Gate, in the route AND in the applier: 409 `VERIFICATION_STALE` unless `run_id = latest_run_id` and the run's `load_id = latest_load_id`; 409 `VERIFICATION_UNRESOLVED` with `details.quarantined: [{ finding_id, document_ref_ext, details }]` if `quarantined_count > 0` (an `unknown_reference` finding can never be waived: the document must be fixed and the domain re-run); 409 `VERIFICATION_UNRESOLVED` with `details.unwaived: [...]` if any open finding of another kind lacks a waiver in the body; 400 `INVALID_PARAMS` for a waiver naming a finding outside the run. The department head is the authority for waivers per the access matrix ("Sign off domain balances: A"), so no DOA resolution is involved.
  - [ ] 5.4 Persist `migration.domain.verified` (stream `site_id`, `idempotency_key = 'migration:signoff:{site_id}:{domain}:{key}'`) with `run_id`, `waivers[]`, `signed_off_by_actor_id` and `signed_off_role` taken from the authorising assignment, never from the body. Applier: re-run the 5.2 and 5.3 checks with `refuse(...)` self-audit (`migration-opening-stock.ts:334-347`), flip each waived finding to `status = 'waived'` with `waiver_narrative` and `waived_event_id`, set `waived_count` on the run, and stamp `migration_stage.verified_run_id`, `verified_at`, `verified_event_id`, `verified_by_actor_id`. Replay of the same key is a 200 replay.

- [ ] Task 6: per-domain status, one derivation (AC: 5)
  - [ ] 6.1 Export `getDomainVerificationStatuses(siteId, client): Promise<DomainVerificationStatus[]>` from `src/read/projections/migration_domain_verification.ts`: one SQL statement returning one row per domain in `MIGRATION_DOCUMENT_DOMAINS`, with `status = 'verified'` if and only if `verified_run_id IS NOT NULL AND verified_run_id = latest_run_id AND (SELECT load_id FROM migration_domain_verification WHERE run_id = latest_run_id) = latest_load_id`, else `'unverified'`. A domain with no `migration_stage` row is `unverified`. A new manifest load or a new run after sign-off makes the domain `unverified` again (SM-48 says verified, not once-verified). Story 13.3 imports this function; it does not re-derive the rule (Story 11.5 D1 lesson).
  - [ ] 6.2 `GET /api/v1/migration/domains?site_id=` returns `{ site_id, domains: [{ domain, status, latest_load_id, latest_run_id, verified_run_id, verified_at, verified_by_actor_id, source_count, migrated_count, quarantined_count, mismatch_count, waived_count }] }` for the four domains, `read` scope, site-scoped.
  - [ ] 6.3 Extend `listMigrationStagesBase` (`migration.ts:778-801`) so the default `staging` row is synthesised for every domain in `MIGRATION_DOMAINS` (`opening_stock` plus the four), not only `opening_stock`.

- [ ] Task 7: wiring and docs (AC: all)
  - [ ] 7.1 Register every new route in the Story 13.1 block of `createAppRouter()` (`src/server.ts:575-591`) under a `// Story 13.2` comment; add each route string to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts:226-234`. Run `npm run spine-acceptance-contract`.
  - [ ] 7.2 Write `docs/migration/document-manifest-templates-v1.md` (apply `FORMATTING_RULES.md`): the four header contracts, one worked row per domain, the finding kinds and their `details` keys, the waiver rule (quarantine cannot be waived), the sign-off actor rules (role, module, SOD-07), and the status rule from 6.1. Add a row per document domain to the stage table in `docs/migration/opening-stock-template-v1.md` section 6 pointing here.
  - [ ] 7.3 Record in `deferred-work.md`: (a) `src/compliance/receiving.ts:410-430` computes over-receipt from cumulative `grn_line` only and ignores `erp_purchase_order_line.open_qty`, so a line with legacy-received quantity can be over-received post-cutover by the legacy amount; this story reports the fact on the open-PO report (`received_qty` mismatch) but does not change receiving; (b) the ERP projection and `bom` carry no site, so `missing_in_source` is enterprise-wide; (c) Epic 10 loan registers are a second source kind for `custody_registers`.

- [ ] Task 8: tests (AC: all)
  - [ ] 8.1 `test/integration/story-13-2.test.ts`, self-contained per the never-import-cross-story rule; copy the closure set from `test/integration/story-13-1.test.ts:1-120` (`makeRequest`, `provisionUser`, `authFor`, `SCIM_HEADERS`, `run` suffix, admin pool teardown). Fixtures: one site with two bins; items including one lot-controlled and one to be deactivated mid-test; a legacy kit migrated through `POST /api/v1/boms/legacy-kit-migration` (released outcome) and a second with `draft_remediation`; two ERP POs pushed through `POST /api/v1/erp/sync` with tolerances; one service order created and confirmed through `/api/v1/service-orders` with two challan receipts through `/receipts` (which mints the `grn_line`, receipt, return clock and custody entries in one go) and one consumption; users via SCIM for `migration_lead` (module `migration`, write and read, the site), a `department_head` per module (`engineering`, `procurement`, `jobwork`), a `department_head` for another site, and a `gate_officer`.
  - [ ] 8.2 AC 1: import a correct manifest per domain, run each domain, assert `source_count`, `migrated_count` and zero findings; assert `GET .../verification-runs/:run_id` lists the header; assert the run event exists once in `domain_events` and that the applier wrote every finding row (drive a second run with a seeded mismatch and count rows).
  - [ ] 8.3 AC 2, per domain: deactivate the item on one PO line and re-run `open_pos`; obsolete-proof a BOM by deactivating a component item and re-run `active_boms`; delete-proof a challan by inserting a receipt whose `service_order_id` is random through the admin pool and re-run `jobwork_challans`; insert a custody entry with an unknown `location_id` and re-run `custody_registers`. Assert each is `kind: 'unknown_reference'`, `error_code: 'UNKNOWN_REFERENCE'`, `quarantined_count = 1`, `migrated_count` excludes it, and sign-off is refused `VERIFICATION_UNRESOLVED` with `details.quarantined` even when the body waives it.
  - [ ] 8.4 AC 3: manifest with one line whose `ordered_qty`, `open_qty`, `received_qty`, `over_receipt_tolerance_pct` and `supplier_ref_ext` each differ, one line absent from ERP, and one open ERP line absent from the manifest; assert five `field_mismatch` findings with `source_value` and `platform_value` as NUMERIC strings, one `missing_in_platform`, one `missing_in_source`; a null tolerance on both sides is not a finding.
  - [ ] 8.5 AC 4 and SOD-07: the `migration_lead` signing off is 403 `FUNCTION_ACCESS_DENIED`; the jobwork `department_head` signing `active_boms` is 403 `FUNCTION_ACCESS_DENIED` with `required_module: 'engineering'`; the other-site head is 403; a head who also ran the verification (provision one such user) is 403 `SIGNOFF_ACTOR_CONFLICT`; a sign-off with all mismatches waived succeeds and `GET .../domains` reports `verified` with `waived_count`; a sign-off on a run that is no longer latest is 409 `VERIFICATION_STALE`; a replay is 200 with one event. Prove the gate lives in the applier by driving `persistEvent` for `migration.domain.verified` directly with an unwaived finding and asserting refusal.
  - [ ] 8.6 AC 5: before any run every domain is `unverified`; after sign-off `verified`; after a new manifest import `unverified` again; after a new run without sign-off `unverified`; `getDomainVerificationStatuses` called directly agrees with the route.
  - [ ] 8.7 Security arms: `gate_officer` on any migration route is 403 `MODULE_ACCESS_DENIED`; `POST /api/v1/events` with a `migration.domain.verified` envelope is 400 `INVALID_EVENT_STREAM` and consumes no idempotency key; the edge door refuses the same with `CENTRAL_ONLY_OPERATION`; a `migration.domain.verified` envelope on stream `jobwork` is refused by the shape assert.
  - [ ] 8.8 Mutation-verify the two applier guards (sign-off gate, SOD check) by inverting each and watching the named test go red, then restore; record both in the Dev Agent Record.
  - [ ] 8.9 Gates before declaring done: `npm run build`, `npm run lint`, `npm run format:check` (with the autocrlf caveat from 13.1), `db:migrate` twice, `test/unit/schema-drift.test.ts`, `test/unit/edge-permanent-error-parity.test.ts`, `npm run spine-acceptance-contract`, `story-13-1`, `story-13-2`, `story-5-2`, `story-2-9`, `story-9-2`, `story-9-3`, `segregated-roles`, then the full suite with `--test-concurrency=1`. Report the count.

## Dev Notes

### What this story is and is not

The epic is explicit: migration execution belongs to the module epics; this story owns verification, reconciliation counts, quarantine and the per-domain sign-off event. In this codebase the executed migrations already have a physical form: a legacy kit is a `bom` row with `origin = 'legacy_kit'` (Story 5.2), an open PO is an `erp_purchase_order` projection row (Story 2.9), a challan is a `jobwork_material_receipt` with its `jobwork_return_clock` (Story 9.2, 9.5), and a custody register is the customer-ownership balance of `custody_ledger_entry` (Story 9.3). What the platform lacks is the source side: the legacy extract listing what should be there. This story adds that as a per-domain manifest (a CSV, imported through the 13.1 mechanics) and defines verification as manifest versus platform. Reconciliation counts are manifest documents versus matched platform documents. Nothing here creates, edits or deletes a BOM, PO, challan or ledger entry.

Not in scope: native POs (Epic 4, later wave), Epic 10 loan registers (later wave; the domain name `custody_registers` stays and gains a second source kind then), sales orders (Story 2.9 projections, verified there), gate passes (Epic 20), finance sign-off and the go-live unblock (13.3), and any change to receiving tolerance behaviour (Task 7.3 records the gap).

### Binding decisions

1. **Manifest, not re-import.** A department head cannot verify a domain against nothing. The source side is a per-domain CSV manifest of legacy records; the platform side is whatever the module epic's migration path produced. The manifest is never posted anywhere; it exists to be compared. This is the only way to produce "source records vs migrated records" honestly, and it keeps execution where the epic put it.
2. **Import resolves only the site.** Every other reference is resolved by the verification run so that unresolvable documents become findings the head sees (AC 2), not silent import rejections.
3. **One manifest event per file, not one per row.** 13.1 needed per-row events because `lot_trace` keys on `event_id`. Nothing keys on a manifest row, and a 10,000-row payload is about 2 MB of JSONB, so one event is correct and about fifty times faster.
4. **Findings live in the event payload and in a projection.** The head signs off a specific run; the event carrying the findings and their digest is the durable record auditors check, and the projection is the queryable copy. The applier does not recompute at apply time: a re-run is a new event.
5. **Quarantine is not waivable.** AC 2 says a quarantined document does not count as migrated. A head can waive a mismatch with a narrative (the analog of 13.1's variance explanation, without DOA because the head is the domain authority per the access matrix), but an unresolved reference must be fixed at source and re-run.
6. **The module is the department.** RBAC has no department; assignments have a module. `DOMAIN_MODULE` maps each domain to the module whose routes own the documents (`engineering`, `procurement`, `jobwork`, `jobwork`), and the sign-off requires `department_head` with a write assignment on that module at the site. `migration_lead` is excluded by role and by SOD-07.
7. **Verified means verified now.** Status is derived, not stored as a flag: sign-off on the latest run of the latest manifest. Any later load or run reverts the domain to `unverified`. 13.3 imports the derivation.
8. **The two enterprise-wide domains are documented, not hacked.** `bom` and `erp_purchase_order` carry no site. `missing_in_source` is computed across the enterprise for those two domains; in the pilot there is one site. A multi-site wave scopes the manifest, not the query (Open Question 1).
9. **Open-PO received quantity is reconciled as derived.** The projection has no received column; `ordered_qty - open_qty` is the ERP's own received figure, compared with the legacy register's `received_qty`. The tolerance columns are compared as-is, including null.
10. **Job-work challans verify their statutory clock.** A migrated challan without a `jobwork_return_clock` at the legacy `challan_date` would silently reset the Rule 45 clock; that is a `state_mismatch`, and it is the reason the challan template carries `challan_date`.

### Source tree components to touch

Table 1 lists the three events this story registers, all on stream `migration` with `stream_id = site_id`.

| Event type | Producer | Applier writes |
|---|---|---|
| `migration.document_manifest.loaded` | manifest import route, once per file | `migration_document_manifest_row`; `migration_stage.latest_load_id` |
| `migration.domain.verification_run` | verification-run route | `migration_domain_verification`, `migration_domain_verification_finding`; `migration_stage.latest_run_id` |
| `migration.domain.verified` | sign-off route | findings `waived`; run `waived_count`; `migration_stage.verified_*` |

Table 2 lists the four v1 manifest headers. Column order is the contract; a second version is a second constant.

| Domain | `document_ref_ext` | `line_ref` | Header |
|---|---|---|---|
| `active_boms` | `kit_ref` | `component_sku` | `site_code,kit_ref,parent_sku,revision_code,component_sku,quantity_per,line_uom` |
| `open_pos` | `po_number_ext` | `line_no` | `site_code,po_number_ext,line_no,sku,supplier_ref_ext,ordered_qty,received_qty,open_qty,over_receipt_tolerance_pct,under_receipt_tolerance_pct` |
| `jobwork_challans` | `challan_number_ext` | `order_number_ext\|sku` | `site_code,challan_number_ext,challan_date,order_number_ext,customer_party_code,sku,challan_qty,uom,challan_class` |
| `custody_registers` | `order_number_ext` | `sku` | `site_code,order_number_ext,customer_party_code,sku,custody_qty,uom` |

Table 3 lists the sign-off binding per domain.

| Domain | `DOMAIN_MODULE` | `DOMAIN_SIGNOFF_ROLES` | Platform tables read |
|---|---|---|---|
| `active_boms` | `engineering` | `department_head` | `bom`, `bom_revision`, `bom_line`, `item_master` |
| `open_pos` | `procurement` | `department_head` | `erp_purchase_order`, `erp_purchase_order_line`, `item_master` |
| `jobwork_challans` | `jobwork` | `department_head` | `service_order`, `jobwork_material_receipt`, `jobwork_return_clock`, `grn_line`, `lot_master`, `item_master` |
| `custody_registers` | `jobwork` | `department_head` | `service_order`, `custody_ledger_entry`, `location_register`, `item_master` |

Table 4 lists the files to create or modify.

| File | Change |
|---|---|
| `read/projections/migration_import.sql` | MODIFIED: `chk_migration_import_domain` widened, DROP-then-ADD |
| `read/projections/migration_stage.sql` | MODIFIED: six guarded ADD COLUMN |
| `read/projections/migration_document_manifest_row.sql` | NEW |
| `read/projections/migration_domain_verification.sql` | NEW |
| `read/projections/migration_domain_verification_finding.sql` | NEW |
| `deploy/compose/init-db.sql` | MODIFIED: mirrors |
| `src/events/migrate.ts` | MODIFIED: three tail entries |
| `src/events/schema.ts` | MODIFIED: `MigrationDomain` union, three payload/envelope pairs, three tail registry entries |
| `src/compliance/migration-opening-stock.ts` | MODIFIED: `MIGRATION_EVENT_TYPES`, assert delegation, three switch arms |
| `src/compliance/migration-documents.ts` | NEW: shape assert, three appliers, sign-off gate, SOD check |
| `src/migration/document-templates.ts` | NEW: headers, domains, module map, row typing |
| `src/migration/opening-stock-template.ts` | MODIFIED: shared hash and row cap generalised |
| `src/read/projections/migration_domain_verification.ts` | NEW: `computeDomainFindings`, `getDomainVerificationStatuses` |
| `src/api/v1/migration.ts` | MODIFIED: seven routes, `requireDomainSignoffActor`, stages default for all domains |
| `src/server.ts` | MODIFIED: route registrations |
| `src/cli/verify-segregated-roles-core.ts` | MODIFIED: `migration_lead` versus `department_head` pair |
| `test/unit/schema-drift.test.ts` | MODIFIED: three pins, CHECK fragment |
| `test/integration/story-1-9.test.ts` | MODIFIED: spine allowlist |
| `test/integration/story-13-2.test.ts` | NEW |
| `docs/migration/document-manifest-templates-v1.md` | NEW |
| `docs/migration/opening-stock-template-v1.md` | MODIFIED: stage table rows |
| `_bmad-output/implementation-artifacts/deferred-work.md` | MODIFIED: Task 7.3 items |

### Current state of the code being modified

- `src/api/v1/migration.ts` (1173 lines): eight routes; `MIGRATION_WRITE_ROLES` `:68`; `requireMigrationWriteActor` `:176-203` binds role, module `migration`, scope `write` and site to one assignment; `requireSiteReadAccess` `:205-223`; `siteEnvelope` `:237-262` builds a `migration`-stream envelope with `stream_id = siteId`; `findEventByIdempotencyKey` `:264-276`; stages handler `:778-801` synthesises a `staging` default only for `opening_stock`; wrappers `:1162-1173`. Preserve every 13.1 route and its behaviour; extend, never fork, the helpers.
- `src/compliance/migration-opening-stock.ts` (858 lines): `assertMigrationEventShape` `:107-301` refuses a `migration.*` name on a foreign stream and a foreign name on the `migration` stream with `INVALID_EVENT_STREAM`, then dispatches per type; the `stage.promoted` arm `:285-300` pins `domain = 'opening_stock'` and must keep doing so. `applyMigrationProjection` `:307-332` is a switch with a silent default. `refuse` `:334-347` is the self-audit helper. `lockMigrationStage` `:356-375` inserts `staging` if absent and locks `FOR UPDATE`; `app_user` holds UPDATE on `migration_stage`, so the lock is legal (the Story 7.7 trap does not apply).
- `read/projections/migration_stage.sql`: PK `(site_id, domain)`, `stage` CHECK `('staging','dry_run')`; header comment already names the four document domains.
- `read/projections/migration_import.sql:37,45-52`: `domain = 'opening_stock'` twice; both must change. `migration_import_rejection.sql:21,33-34`: three-code CHECK, unchanged by this story (Task 3.3c).
- `src/events/schema.ts` (6273 lines): 13.1 interfaces `:5111-5225`, registry tail `:6253-6271`, `} as const;` at `:6273`.
- `src/events/store.ts`: `assertMigrationEventShape` at `:561` runs first in the seam; `applyMigrationProjection` at `:1266` runs last in the switch. Neither line changes.
- `read/projections/bom.sql:16-44`: `origin IN ('native','legacy_kit')`, `status IN ('draft','released','on_hold','obsolete')`, `remediation_flag`, `kit_ref`, `current_revision_id`; no site, no FK. `bom_line.sql:9-37`: `component_item_id` nullable for placeholders, `component_sku`, `quantity_per`, `line_uom`; unique `(revision_id, line_no)`.
- `read/projections/erp_purchase_order.sql:19-52`: header PK `po_number_ext`, `supplier_ref_ext` verbatim (no supplier resolution exists on the platform: `src/compliance/three-way-match.ts:226-234`), `status IN ('open','closed')`; line PK `(po_number_ext, line_no)`, `ordered_qty`, `open_qty`, `unit_price`, two nullable tolerance columns, no received column. Soft-close is header-only (deferred-work 138): a closed header's lines still exist, which is why 4.3 joins on `status = 'open'`.
- `read/projections/service_order.sql`: unique `(order_number_ext, site_id)` `:79`; `customer_party_code` regex `:51`. `jobwork_material_receipt.sql:25-40`: `challan_number_ext`, `challan_date`, `sku`, `lot_id` (lot NUMBER), `challan_qty`, `uom`, `site_id`, `grn_line_id` unique. `jobwork_return_clock.sql`: one per `receipt_id`, `challan_date`, `expiry_date`. `custody_ledger_entry.sql`: `ownership IN ('customer','processor')`, `quantity_delta` signed, index `(service_order_id, ownership, sku)` `:89`.
- `src/cli/verify-segregated-roles-core.ts:53-75`: `SEGREGATED_ROLE_PAIRS` entries `{ transactionType, setterRole, approverRole, reason }`.

### Previous story intelligence (13.1, this tree)

- Projections live at `read/projections/`, not `src/read/projections/`; `migrate.ts` resolves `../../read/projections/`. TypeScript read helpers live at `src/read/projections/*.ts`.
- An ESM import cycle (`stock-balance` to `store` to `migration-opening-stock` to `migration_variance` to `stock-balance`) broke two unit files at module load; 13.1 fixed it by resolving class lists at call time. The new `migration-documents.ts` and `migration_domain_verification.ts` must import only `pg` types, `AppError`, `AuditCtx` and the migration modules; never import a compliance module that imports `store.ts`.
- `format:check` is red on this checkout because of `core.autocrlf=true`; use `--end-of-line auto` and touch only files this story changes. Save new files with LF.
- The fresh-database boot from `init-db.sql` found two latent defects (a subquery CHECK, a `FOR UPDATE` without UPDATE grant). Every DDL change here must boot on a fresh `postgres:18.4` container, not only migrate onto the long-lived one.
- `findMatchingDoaEntry` bands on `value > value_min` (deferred-work 798). Not used by this story; the sign-off has no DOA on purpose.
- Roles are free-form text; `department_head` is registered in the access matrix (`:52`) and is not yet used by any production code (only by Story 4.x test fixtures under suffixed names). Provision it in the test with `{ role: 'department_head', module: '<domain module>', functionScope: 'write', locationId: siteId }` plus a `migration` read assignment so the head can read the report.
- Rows and events are scoped by a per-run suffix in tests; dates relative to today; teardown through the admin pool.

### Git intelligence

Last commits: `7e0f88c 13 commence`, `d9fb465 fix(security): gate the three Story 3.7 dispatch actions on BOTH event doors`, `7826322 fix(security): sweep the edge-sync door for site scope and fix the IRN gate`, `59349eb feat(11-5): branch transfer valuation and GST documents, with a three-chunk code review`. The 13.1 work is uncommitted on top. The last month's pattern is door parity and applier-side gates; this story adds no new door exposure and puts both new gates (sign-off, SOD) in the applier as well as the route. Commit each review round under its own message.

### Testing standards

- Test DB: docker `ims-postgres-test`, PostgreSQL 18.4, host port 5442, booted from `deploy/compose/init-db.sql`; `.env.test` carries `DB_PORT=5442`, `PORT=3999`, `AUDIT_LOG_ENABLED=true`.
- One file: `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-13-2.test.ts`. Never raise concurrency.
- `db:migrate` needs the env file: `node --env-file=.env.test --import tsx src/events/migrate.ts`.
- Fixture creation goes through the public routes wherever one exists (legacy-kit migration, ERP sync, service-order receipts); the admin pool is used only to fabricate the broken references AC 2 needs and for teardown.

### Project Structure Notes

- DDL is one file per table under `read/projections/*.sql`, appended to `MIGRATIONS`, mirrored into `init-db.sql`, pinned by `schema-drift`. `app_user` never gets DELETE.
- Write-path rules live in `src/compliance/<domain>.ts` reached from `persistEvent`; read helpers in `src/read/projections/<name>.ts`; routes in `src/api/v1/<domain>.ts` wrapped by `requireRole`; template contracts in `src/migration/`.
- Error envelope `{ error_code, message, details, trace_id }`; NUMERIC values travel as strings.
- Variance from 13.1: no `mode` on manifest imports (a manifest is replaced whole), no per-row events, no promotion for document domains.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md:3498-3531`] Story 13.2 statement, ACs, dev notes.
- [Source: `_bmad-output/planning-artifacts/epics.md:241-243,323,327,401,485-493,1786-1795`] FR-DM-01 to 03, deferral note, pilot PO rule, Epic 5 migration prep, Epic 13 goal and critical note, Story 5.2 legacy-kit migration.
- [Source: `_bmad-output/planning-artifacts/epics.md:3535-3564`] Story 13.3, the consumer of the domain status.
- [Source: `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md:52,90-92,230-238,254`] `department_head`, `finance_controller`, `migration_lead`, migration-gate RACI, SOD-07.
- [Source: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md:443,505-511`] SM-48, data migration section.
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:88-92,160-164,181-184,278-297`] AD-4 BOM mastery, AD-16 idempotency, `_ext` convention, event envelope.
- [Source: `_bmad-output/implementation-artifacts/13-1-opening-stock-migration-and-verification.md`] binding decisions 3, 4, 7, 10; deviations 1, 2, 8; testing standards.
- [Source: `src/api/v1/migration.ts:67-68,120-150,176-276,592-720,778-801,1162-1173`] 13.1 route module and helpers.
- [Source: `src/compliance/migration-opening-stock.ts:44-80,107-125,285-347,356-395`] stream constants, shape assert, switch, refuse, stage lock.
- [Source: `src/events/schema.ts:5111-5225,6253-6273`, `src/events/store.ts:539-562,1262-1267`] envelope pattern, registry tail, seam and switch positions.
- [Source: `read/projections/migration_stage.sql`, `migration_import.sql:37,45-52`, `migration_import_rejection.sql:21`] tables to extend.
- [Source: `read/projections/bom.sql:16-44,68`, `bom_line.sql:9-37,127`, `src/compliance/bom.ts:117-120,976-990`, `src/server.ts:757,768`] legacy-kit BOM shape, released item rule, migration route.
- [Source: `read/projections/erp_purchase_order.sql:9-52`, `src/adapters/erp/sync.ts:78-94,184,230-318`, `src/compliance/receiving.ts:410-430`, `src/compliance/three-way-match.ts:226-234`] PO projection, sync validation, tolerance predicate, supplier namespace gap.
- [Source: `read/projections/service_order.sql:22-51,79`, `jobwork_material_receipt.sql:25-51`, `jobwork_return_clock.sql:40-60`, `custody_ledger_entry.sql:26-62,87-89`, `src/compliance/custody-ledger.ts:803-813`, `src/compliance/jobwork-return-clock.ts:46-47`] job-work tables, balance SUM, clock durations.
- [Source: `src/middleware/rbac.ts:16-66`, `src/cli/verify-segregated-roles-core.ts:53-75`] RBAC and provisioning-time SOD pairs.
- [Source: `test/integration/story-13-1.test.ts:1-120,308-360,416-436,873-878`, `test/integration/story-1-9.test.ts:226-234`, `test/unit/schema-drift.test.ts:2060-2119,2174-2206`] test closure, fixtures, allowlist, pins.
- [Source: `_bmad-output/implementation-artifacts/deferred-work.md` items 138, 151, 220, 798, 799] header-only soft-close, under-receipt tolerance unenforced, CHECK widening, DOA banding, lot-number uniqueness.

## Open Questions

None block development; each has a default the tasks follow.

1. **Enterprise-wide domains.** Default: `active_boms` and `open_pos` run `missing_in_source` across the enterprise because neither table has a site. If a second site is in a later wave, add an optional `document_ref_prefix` filter to the manifest header, not a site column to the projections.
2. **Open-PO received quantity after cutover.** Default: report the mismatch only; receiving keeps its current cumulative-`grn_line` rule and the gap is recorded in deferred-work (Task 7.3a). Changing receiving is an Epic 3 ruling.
3. **Waiver authority.** Default: the department head alone, with a narrative, no DOA. If finance wants a second signature on waived value, 13.3's finance sign-off is where it lands.
4. **Custody versus opening stock cross-check.** Default: not done. Custody balances and `stock_balance` rows of class `job_work` are separately verified (13.1 and this story); a cross-foot between them is a 13.3 final-reconciliation candidate.
5. **Draft-remediation kits.** Default: a `legacy_kit` bom with `remediation_flag = true` is a `state_mismatch`, waivable; the head decides whether a kit can go live in draft. It is never `unknown_reference` unless a component item is actually missing.
6. **Manifest payload size.** Default: one event with up to 10,000 rows. If a measured payload exceeds 8 MB, split the file into two loads; do not add per-row events.

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

## Change Log

Table 5 records every change to this story file.

| Date | Change |
|---|---|
| 2026-09-10 | Story created by the create-story workflow from the uncommitted Story 13.1 tree on `7e0f88c`: 5 ACs, 9 tasks, 10 binding decisions, 6 open questions with defaults. Research found that every migrated document already has a platform table (legacy-kit BOMs, ERP PO projections, job-work receipts and custody entries) but no source-side record, so the story adds per-domain manifests and defines verification as manifest versus platform; `department_head` exists in the access matrix but in no production code; the platform has no supplier resolution and no site on BOMs or ERP POs. |
