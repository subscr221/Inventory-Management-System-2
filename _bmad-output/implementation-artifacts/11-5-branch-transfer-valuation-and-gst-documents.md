---
baseline_commit: d37cbba
---

# Story 11.5: Branch Transfer Valuation and GST Documents

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a GST officer,
I want branch transfers between GSTINs treated as taxable supplies with Rule 28 valuation and their GST documents recorded before shipment,
so that inter-branch movements are correctly taxed and documented.

## Acceptance Criteria

1. **Given** a stock transfer whose source and destination sites resolve to two DIFFERENT GSTINs
   (FR-AC-10)
   **When** the transfer request is created
   **Then** it is classified as an inter-GSTIN taxable supply and valued on a Rule 28 basis - one of
   `open_market_value`, `like_kind_quality`, `cost_plus` (Rules 30/31) or `invoice_value_full_itc`
   (the second proviso, only where the recipient GSTIN is configured as eligible for full ITC) -
   with the basis defaulted for that GSTIN pair from dated configuration effective on the
   transfer's business date, and the selected basis, its source, the unit value, the taxable value
   and the two GSTINs recorded against the transfer and returned on `GET /api/v1/transfer-requests/:id`.
2. **Given** a classified inter-GSTIN transfer that has not shipped and has no GST document recorded
   **When** a user holding `gst_officer` overrides the valuation basis with a reason code
   **Then** the transfer is re-valued on the chosen basis, `basis_source` becomes `override`, the
   overriding actor is taken from the authenticated identity (never from the payload), and the
   override is refused with `error_code: "VALUATION_LOCKED"` once any GST document exists or the
   transfer has shipped.
3. **Given** a valued inter-GSTIN transfer (FR-AC-10)
   **When** its GST documents are recorded before shipment
   **Then** a tax invoice record exists carrying the ERP invoice number and the 64-hex IRN (every
   supply is e-invoiceable, per the Story 11.2 ruling), and an e-way bill record exists where the
   taxable value exceeds the configured threshold (Rs 50,000 by default); recording is idempotent
   on replay and a DIFFERENT document number for the same kind is refused with
   `error_code: "GST_DOCUMENT_CONFLICT"`.
4. **Given** an inter-GSTIN transfer without its required GST documents (FR-AC-10)
   **When** shipment is attempted on the REST route or the direct events door
   **Then** it is blocked with HTTP 409 `error_code: "GST_DOCUMENTS_REQUIRED"` naming every missing
   item (`tax_invoice_missing`, `irn_missing`, `e_way_bill_missing`, `not_valued`), an `audit_log`
   rejection row is written that survives the event rollback, and no stock moves. GST documents are
   the blocking artifacts here; gate-pass enforcement (FR-GP-11) is Epic 20 (Phase 2).
5. **Given** a transfer whose source and destination resolve to the SAME GSTIN, or a transfer within
   one site
   **When** it is created and shipped
   **Then** nothing in this story fires: no valuation row, no document requirement, and every
   existing Story 2.5 behaviour is unchanged.
6. **Given** a cross-site transfer where either site has no GSTIN registration effective on the
   business date
   **When** the transfer request is created
   **Then** it is refused with `error_code: "SITE_GSTIN_MISSING"` naming the site (fail closed, the
   Story 8.6 default-enforce rule), and a branch transfer whose GSTIN pair has no valuation
   configuration effective on the business date is refused with `error_code: "VALUATION_CONFIG_MISSING"`.

## Prerequisites

- Story 11.2 is done and committed (0778172): `IRN_EXT_REGEX`, `normalizeIrnExt` and
  `isValidIrpAcknowledgedAt` in `src/compliance/dispatch.ts` are the IRN validators this story
  reuses. Do not write a second IRN regex.
- The Story 2.5 suite is GREEN at baseline d37cbba: `test/integration/story-2-5.test.ts` runs
  19/19 in 2.3 s against the docker test instance. The epics note and the sprint-status comment
  saying "fifteen tests currently fail as a seeding cascade" were written on 2026-09-05, before
  commit 3c486f2 and the noise-floor elimination, and are STALE. There is no precondition left to
  clear. Re-run the file once before you start so you have a baseline of your own.
- No site table and no site GSTIN exist. `site_id` is a plain UUID column on `location_register`
  with no FK (`read/projections/location_register.sql:16-27`); a site "is" a `level = 'site'` row
  only by convention, and the Story 2.5 fixtures seed each location with a random dangling
  `site_id`. Task 1 builds the registration this story stands on.

## Tasks / Subtasks

- [x] Task 1: site GSTIN registration (AC: 1, 5, 6)
  - [x] 1.1 New `read/projections/site_gstin.sql`: table `site_gstin` with `registration_id UUID PK
        DEFAULT gen_random_uuid()`, `site_id UUID NOT NULL` (no FK: there is no site table),
        `gstin_ext TEXT NOT NULL`, `legal_name_ext TEXT`, `state_code_ext TEXT`, `effective_from
        DATE NOT NULL`, `effective_to DATE`, `created_by UUID NOT NULL`, `created_at`, `updated_at`;
        `UNIQUE (site_id, effective_from)`; guarded `DO $$` CHECK block pinning the GSTIN format
        `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$` and `effective_to >= effective_from`
        (the `chk_..._window` shape from `compliance_bis_licence.sql:39-52`). Grants to `app_user`:
        SELECT, INSERT, UPDATE (no DELETE, repo rule). Mirror into `deploy/compose/init-db.sql`,
        append to `MIGRATIONS` in `src/events/migrate.ts`, pin in `test/unit/schema-drift.test.ts`.
  - [x] 1.2 Export the existing `GSTIN_REGEX` from `src/compliance/supplier.ts:23` and delete the
        duplicate at `src/compliance/supplier-invoice.ts:38` in favour of the import. Do not add a
        third copy.
  - [x] 1.3 New `src/read/projections/site_gstin.ts`: `insertSiteGstin` with the overlap refusal
        (`COALESCE(effective_to, 'infinity'::date)` window test copied from
        `business_stream_config.ts:168-176`, 409 `GSTIN_CONFIG_OVERLAP`), `findSiteGstin(siteId,
        asOfDate, client)` selecting the single row effective on the date (more than one row is a
        500 `GSTIN_CONFIG_CONFLICT`, the `TAGGING_CONFIG_CONFLICT` shape), and
        `listSiteGstins(siteId)`.
  - [x] 1.4 Routes `POST /api/v1/sites/:siteId/gstin` (idempotency_key required, 8.7 D8) and
        `GET /api/v1/sites/:siteId/gstin`, roles `finance_controller` or `gst_officer` with
        `functionScope: 'write'` / `'read'`. Register in `src/server.ts` with static segments before
        parameterised siblings, and add both to the Story 1.9 spine allowlist
        (`test/integration/story-1-9.test.ts:218-224` is where the transfer family lives).
- [x] Task 2: per-GSTIN-pair valuation configuration (AC: 1, 6)
  - [x] 2.1 New `read/projections/branch_transfer_valuation_config.sql`: table
        `branch_transfer_valuation_config` with `config_id UUID PK`, `from_gstin_ext TEXT NOT NULL`,
        `to_gstin_ext TEXT NOT NULL`, `default_basis TEXT NOT NULL`, `recipient_full_itc_eligible
        BOOLEAN NOT NULL DEFAULT false`, `cost_plus_percent NUMERIC(7,3) NOT NULL DEFAULT 110`,
        `effective_from DATE NOT NULL`, `effective_to DATE`, `created_by UUID NOT NULL`, timestamps;
        `UNIQUE (from_gstin_ext, to_gstin_ext, effective_from)`; guarded CHECKs: `default_basis IN
        ('open_market_value','like_kind_quality','cost_plus','invoice_value_full_itc')`,
        `from_gstin_ext <> to_gstin_ext`, `cost_plus_percent >= 100`, the date window, and
        `default_basis <> 'invoice_value_full_itc' OR recipient_full_itc_eligible` (a second-proviso
        default is meaningless without eligibility). Mirror, migrate, pin as in 1.1.
  - [x] 2.2 `src/read/projections/branch_transfer_valuation_config.ts`: `insertValuationConfig`
        (overlap refusal per pair, 409 `VALUATION_CONFIG_OVERLAP`), `findValuationConfig(fromGstin,
        toGstin, asOfDate, client)` (single effective row or null; two rows is a 500 conflict).
  - [x] 2.3 Routes `POST /api/v1/gst/branch-transfer-valuation-config` (idempotency_key required)
        and `GET /api/v1/gst/branch-transfer-valuation-config?from_gstin_ext=&to_gstin_ext=`,
        roles `finance_controller` or `gst_officer`. Register, allowlist.
  - [x] 2.4 E-way bill threshold as a config knob, not a literal: `gst.ewayBillThresholdInr` in
        `src/config/index.ts` beside the `qc:` / `quality:` blocks, default `50000`, integer,
        following the repo invariant that only an ABSENT variable takes the default and a
        present-but-blank one fails closed at boot. Document the env name in `.env.example` if one
        exists.
- [x] Task 3: classification and valuation at creation (AC: 1, 5, 6)
  - [x] 3.1 New `read/projections/branch_transfer_valuation.sql`: table `branch_transfer_valuation`
        keyed `transfer_request_id UUID PRIMARY KEY` (sibling of `transfer_request`, so the pinned
        Story 2.5 DDL is untouched), with `from_site_id`, `to_site_id`, `from_gstin_ext`,
        `to_gstin_ext`, `business_date DATE NOT NULL`, `valuation_config_id UUID`, `valuation_basis
        TEXT NOT NULL`, `basis_source TEXT NOT NULL CHECK IN ('config_default','override')`,
        `cost_plus_percent NUMERIC(7,3)`, `declared_unit_value NUMERIC(18,6)`, `unit_value
        NUMERIC(18,6) NOT NULL`, `taxable_value NUMERIC(18,2) NOT NULL`, `currency TEXT NOT NULL
        DEFAULT 'INR'`, `overridden_by UUID`, `override_reason_code TEXT`, `valued_at TIMESTAMPTZ NOT
        NULL`, `source_event_id UUID NOT NULL`; CHECK `taxable_value >= 0`, CHECK that
        `overridden_by` and `override_reason_code` are both null or both present, and the
        `btrim(override_reason_code) <> ''` shape from `maintenance_warranty_override.sql:22-32`.
        Mirror, migrate, pin.
  - [x] 3.2 In `src/compliance/transfer-request.ts`, a pure `classifyBranchTransfer` helper: load
        both locations by id (`getLocationById`, `src/read/projections/location_register.ts:296`),
        take their `site_id`s; if equal, return `intra_site`; otherwise resolve both through
        `findSiteGstin` on the business date (use `gateBusinessDateOf`, already imported at line 5,
        so this story's date and the QC gate's date agree; see the Story 5.3 IST-vs-UTC note under
        Testing standards). Either missing: throw 409 `SITE_GSTIN_MISSING` with
        `{ site_id, business_date }`. Equal GSTINs: `intra_gstin`. Different: `inter_gstin` with the
        pair.
  - [x] 3.3 A pure `computeRule28Value({ basis, quantity, declaredUnitValue, runningAverageCost,
        costPlusPercent })` returning `{ unit_value, taxable_value }`. `cost_plus` uses
        `inventory_valuation.running_average_cost` for the SKU
        (`getInventoryValuation`, `src/read/projections/inventory_valuation.ts:76`; valuation is
        SKU-grain and location-agnostic, there is no per-lot or per-location cost anywhere) times
        `cost_plus_percent / 100`; a null valuation row or a zero cost is 409
        `VALUATION_COST_UNAVAILABLE`. The other three bases take `declared_unit_value` from the
        payload and refuse its absence with 400 `DECLARED_VALUE_REQUIRED`. Round `taxable_value` to
        2 dp half-up once, at the end; keep `unit_value` at 6 dp. Use the `monToNum` / `cmpMonetary`
        helpers rather than float compare.
  - [x] 3.4 Extend `applyTransferRequestProjection` (line 160): AFTER the existing QC gate and
        `applyStockAllocation` (295), classify; on `inter_gstin` resolve the config
        (`findValuationConfig`, missing is 409 `VALUATION_CONFIG_MISSING` with the pair and date),
        refuse a config default of `invoice_value_full_itc` when the row is not eligible (defensive,
        the CHECK already forbids it), compute, and insert the valuation row with
        `basis_source = 'config_default'`. On `intra_site` / `intra_gstin` insert nothing. The
        refusals must fire INSIDE the applier so both doors get them; the route may add a courtesy
        pre-check but the seam is the guard (mutation-verify at the seam).
  - [x] 3.5 `transfer_request.created` payload gains optional `declared_unit_value` (numeric string
        or number, > 0). Extend the payload interface at `src/events/schema.ts:14-26` and the shape
        assert in `transfer-request.ts` near line 105. The REST create handler
        (`src/api/v1/transfer-requests.ts`, envelope built near line 420-447) passes it through.
        Refuse `valuation_basis`, `taxable_value`, `from_gstin_ext`, `to_gstin_ext` and any
        `*_by` field on input (the 11.2 `so_number_ext` rule: server-derived fields are refused, not
        silently dropped).
  - [x] 3.6 `GET /api/v1/transfer-requests/:id` and the list return a `gst` object: `supply_class`
        (`intra_site` | `intra_gstin` | `inter_gstin` | `unclassified` for legacy rows), and for
        `inter_gstin` the valuation row plus `documents` (Task 5) and `ship_blockers` (the same
        list the ship gate would return now, so the GST officer can see what is outstanding
        without attempting a ship).
- [x] Task 4: valuation override by the GST officer (AC: 2)
  - [x] 4.1 New event `transfer_request.valuation_overridden` on the `inventory` stream with
        `requiresBusinessStream: true` (it shares the transfer's stream id with its siblings at
        `schema.ts:5062-5078`). Payload: `transfer_request_id`, `site_id` (the FROM site, so
        `assertPayloadSiteWriteAccess` fires on the events door), `business_stream`,
        `valuation_basis`, `declared_unit_value?`, `reason_code`. NO `overridden_by` field: the actor
        is `metadata.actor.user_id`, which the events door overwrites from the auth context
        (`events.ts:301`). This is the 9.8-2 attribution class; do not reintroduce it.
  - [x] 4.2 Applier `applyTransferValuationOverridden`: lock the `transfer_request` row FOR UPDATE;
        refuse `NOT_A_BRANCH_TRANSFER` when no valuation row exists or class is not inter_gstin;
        refuse `VALUATION_LOCKED` when status is `shipped`, `partially_received`, `received`,
        `rejected`, or when ANY `branch_transfer_gst_document` row exists for the transfer; refuse
        `BASIS_NOT_ELIGIBLE` for `invoice_value_full_itc` when the effective config says the
        recipient is not eligible; recompute via 3.3 and UPDATE the valuation row (`basis_source =
        'override'`, `overridden_by`, `override_reason_code`, `valued_at`, `source_event_id`).
        Replay of the same event id is the `persistEvent` short-circuit; do not add a second
        idempotency layer.
  - [x] 4.3 Route `POST /api/v1/transfer-requests/:transfer_request_id/valuation-override`
        (idempotency_key required), role `gst_officer` with `module: 'inventory'` or `'*'` and
        `functionScope: 'write'` (transfer events live on `inventory`; do not invent a `finance`
        module). Site scope through the FROM location, the Story 2.5 `assertWriteLocationAccess`
        idiom (`transfer-requests.ts:119-132`).
  - [x] 4.4 Events door: `assertBranchTransferGstFunctionAccess` in `src/api/v1/events.ts` beside
        `assertDispatchIrnFunctionAccess` (173-204), gating BOTH new event types to `gst_officer`
        with the same module/functionScope/site predicate, called at the 297-299 block. Add the
        edge-door twin at `src/api/v1/edge.ts:405` (frontline denial).
- [x] Task 5: GST document recording (AC: 3)
  - [x] 5.1 New `read/projections/branch_transfer_gst_document.sql`: table
        `branch_transfer_gst_document` with `document_id UUID PK`, `transfer_request_id UUID NOT
        NULL`, `document_kind TEXT NOT NULL CHECK IN ('tax_invoice','e_way_bill')`,
        `document_number_ext TEXT NOT NULL`, `irn_ext TEXT`, `ewb_valid_until TIMESTAMPTZ`,
        `issued_at TIMESTAMPTZ NOT NULL`, `site_id UUID NOT NULL`, `recorded_by UUID NOT NULL`,
        `source_event_id UUID NOT NULL`, `correlation_id UUID`, timestamps; `UNIQUE
        (transfer_request_id, document_kind)`; guarded CHECKs: `btrim(document_number_ext) <> ''`,
        `document_kind <> 'tax_invoice' OR irn_ext ~ '^[0-9a-f]{64}$'` (the `dispatch_irn.sql:40-46`
        precedent), `document_kind <> 'e_way_bill' OR ewb_valid_until IS NOT NULL`. Non-unique index
        on `source_event_id`. Mirror, migrate, pin.
  - [x] 5.2 Event `transfer_request.gst_document_recorded` (`inventory`, requiresBusinessStream
        true). Payload: `transfer_request_id`, `site_id`, `business_stream`, `document_kind`,
        `document_number_ext`, `irn_ext?` (validated with `IRN_EXT_REGEX` / `normalizeIrnExt` from
        `src/compliance/dispatch.ts:636-638`), `irp_acknowledged_at?` (validated with
        `isValidIrpAcknowledgedAt`), `ewb_valid_until?` (strict ISO, same validator shape),
        `issued_at`. No `recorded_by` on input.
  - [x] 5.3 Applier `applyTransferGstDocumentRecorded`: lock the transfer row; refuse
        `NOT_A_BRANCH_TRANSFER`; refuse when status is `rejected` or already `shipped` or beyond
        (`INVALID_STATE`, the existing 2.5 code); on an existing row of the same kind: identical
        `document_number_ext` is a no-op returning the existing row, a different number is 409
        `GST_DOCUMENT_CONFLICT`; else INSERT. The unique index is the backstop; the lock makes a
        race a clean 409 rather than a 23505 (the 11.2 review "let the PK raise" note was rejected
        there for exactly this reason).
  - [x] 5.4 Routes `POST /api/v1/transfer-requests/:transfer_request_id/gst-documents`
        (idempotency_key required, `gst_officer`) and `GET .../gst-documents` (`gst_officer`,
        `finance_controller`, or any `inventory` read role, since the warehouse must see why a ship
        is blocked). Register, allowlist, events-door gate per 4.4.
- [x] Task 6: the ship gate (AC: 4, 5)
  - [x] 6.1 `dispatchGateGstDocuments(transferRequestId, client)` in `transfer-request.ts`
        returning `{ blocked: boolean, reasons: string[] }`: load the valuation row; when absent,
        re-derive classification with 3.2 (a legacy transfer created before this story that is
        inter_gstin returns `not_valued`; SITE_GSTIN_MISSING propagates as its own refusal); for
        inter_gstin, require a `tax_invoice` row with a non-null `irn_ext` (`tax_invoice_missing`,
        `irn_missing`) and, when `taxable_value > config.gst.ewayBillThresholdInr` (strictly
        greater, "exceeds"), an `e_way_bill` row (`e_way_bill_missing`). Intra classes are never
        blocked.
  - [x] 6.2 Wire it into `applyTransferShipProjection` (line 379) AFTER the status check
        (`APPROVAL_REQUIRED`, ~409) and the in_transit replay short-circuit (~406), BEFORE the QC
        gate (~473) and `applyStockIssue` (~487). Throw 409 `GST_DOCUMENTS_REQUIRED` with
        `{ transfer_request_id, reasons, taxable_value, threshold }`. Mirror the 11.2
        applier-self-audit: accept an optional `auditCtx`, call `logRejectionAudit`
        (`src/read/projections/audit_log.ts:55`, fresh connection) with `http_status: 409` and the
        details BEFORE throwing, so the row survives the rollback on both doors. Plumb `auditCtx`
        from `src/events/store.ts` into the transfer ship applier the way it is plumbed into
        `applyDispatchDispatchedProjection` (store.ts ~982-986); today the transfer appliers do not
        receive it.
  - [x] 6.3 The REST ship handler (`transfer-requests.ts`, `persistEvent` at ~910) needs no new
        code beyond passing the context it already builds with `auditCtxFor`; verify the 409 reaches
        the client with the details intact.
- [x] Task 7: error codes and messages (AC: 2, 3, 4, 6)
  - [x] 7.1 Add to BOTH `PERMANENT_ERROR_CODES` sets, `src/sync/upload.ts:~130` and
        `edge/src/sync/connector.ts:~128` (the blocks are pinned identical; change both together):
        `GST_DOCUMENTS_REQUIRED`, `SITE_GSTIN_MISSING`, `VALUATION_CONFIG_MISSING`,
        `DECLARED_VALUE_REQUIRED`, `VALUATION_COST_UNAVAILABLE`, `BASIS_NOT_ELIGIBLE`,
        `VALUATION_LOCKED`, `NOT_A_BRANCH_TRANSFER`, `GST_DOCUMENT_CONFLICT`, `GSTIN_CONFIG_OVERLAP`,
        `VALUATION_CONFIG_OVERLAP`.
  - [x] 7.2 `edge/src/messages/en.json`: user strings for `GST_DOCUMENTS_REQUIRED`,
        `SITE_GSTIN_MISSING` and `VALUATION_CONFIG_MISSING` (the three a frontline user can hit).
  - [x] 7.3 Register `gst_officer` wherever roles are enumerated for tooling
        (`src/cli/verify-segregated-roles-core.ts` if it lists approver roles; the access matrix
        already carries it at line 89).
- [x] Task 8: tests (AC: 1 to 6)
  - [x] 8.1 New `test/integration/story-11-5.test.ts` (node:test, inline helpers copied from
        story-11-2: `makeRequest`, SCIM user with roles, admin-pool seeding). Seed two sites with
        different GSTINs and one with the same GSTIN as the first, a valuation config for the pair
        effective from an ABSOLUTE past date (no relative "today minus one" that can straddle the
        IST midnight), an `inventory_valuation` row for the SKU, and stock at the source location.
  - [x] 8.2 Arms, each strict (an arm satisfied by MODULE_ACCESS_DENIED or by a pre-existing row is
        vacuous; the 11.2 review found two such): create inter_gstin on cost_plus and assert
        `unit_value = cost * 1.10` and `taxable_value` rounding; create with an OMV default and no
        declared value refused DECLARED_VALUE_REQUIRED; same-GSTIN pair creates no valuation row and
        ships as before; cross-site with a missing registration refused SITE_GSTIN_MISSING; pair
        without config refused VALUATION_CONFIG_MISSING; override by gst_officer re-values, by a
        warehouse_manager is 403 on BOTH doors, after a document is VALUATION_LOCKED;
        invoice_value_full_itc override refused BASIS_NOT_ELIGIBLE when the config says not
        eligible; ship without documents 409 GST_DOCUMENTS_REQUIRED with exact reasons and an
        `audit_log` row selected by THIS transfer id (not "latest globally"); record tax invoice
        without IRN refused by shape; record tax invoice with IRN, ship still blocked
        `e_way_bill_missing` when value > threshold; record e-way bill, ship succeeds; value below
        threshold ships on the invoice alone; document replay same number is a no-op with the same
        event id, different number is GST_DOCUMENT_CONFLICT; events-door replay of the same
        `event_id` short-circuits.
  - [x] 8.3 Mutation verification at the seam, documented in Completion Notes: delete the ship
        gate call in `applyTransferShipProjection` and confirm the GST_DOCUMENTS_REQUIRED arm fails;
        delete the `VALUATION_LOCKED` check and confirm its arm fails; delete the events-door role
        gate and confirm the direct-door 403 arm fails; delete the SITE_GSTIN_MISSING throw and
        confirm its arm fails. Route pre-checks mask seam-only mutants, so run the door arms too.
  - [x] 8.4 Fixture repair in the four suites that create transfers: `story-2-5`, `story-2-8`,
        `story-8-1`, `story-9-2` (and `story-1-9` if its allowlist probe creates one). Each seeds
        locations with distinct `site_id`s, so every transfer there is cross-site and will now be
        refused SITE_GSTIN_MISSING. Seed ONE shared GSTIN registration for every site id the
        fixture creates (intra_gstin, Task 3 inserts nothing) so their assertions stay untouched.
        Do not seed different GSTINs there; that would silently pull them into this story's gate.
        Add `site_gstin`, `branch_transfer_valuation_config`, `branch_transfer_valuation` and
        `branch_transfer_gst_document` to each suite's TRUNCATE list (story-2-5 at line 141).
  - [x] 8.5 Gates before declaring done: `tsc`, `eslint`, `prettier`, `db:migrate` twice
        (idempotent), `schema-drift.test.ts`, `story-1-9`, the five fixture suites, `story-11-2`
        (nothing there should move), then the full suite. The suite is green at baseline; the only
        tolerated failure is the documented `story-5-3` IST/UTC window. Anything else is yours.

### Review Findings

Code review 2026-09-09 (Blind Hunter, Edge Case Hunter, Acceptance Auditor; diff vs baseline
`d37cbba`). CHUNK 1 of 3 - the valuation core only: `src/compliance/transfer-request.ts`,
`deploy/compose/init-db.sql`, `src/events/schema.ts`, `src/events/migrate.ts`,
`test/unit/schema-drift.test.ts`, the four `read/projections/*.sql` files and the three new
`src/read/projections/*.ts` files. Chunk 2 (routes, events door, edge and sync) and chunk 3
(integration tests and fixture repairs) are not yet reviewed.

- [x] [Review][Decision] D1 - the ship gate re-classifies an unvalued transfer on the SHIP business
      date, not the create date, so a genuinely inter-GSTIN transfer whose sites have since been
      re-registered under one GSTIN classifies `intra_gstin` and returns `blocked: false`; a legacy
      taxable supply then ships with no tax invoice, no IRN and no e-way bill. All three review
      layers raised it independently. [src/compliance/transfer-request.ts:1180-1192]
      RULED 2026-09-09 (round-table): NEITHER option as originally framed. Refusing `not_valued`
      class-blind would block every intra-GSTIN cross-site transfer at ship, because Task 3
      deliberately inserts no valuation row for them - that breaks AC 5 and the whole Story 2.5
      flow. Classifying on the creation business date still leaves a gate that re-derives a
      statutory class from mutable dated configuration. Instead: STAMP the classification at
      create for EVERY cross-site transfer, `intra_gstin` included, and have the ship gate READ
      the stamp and never call `classifyBranchTransfer` at all. A cross-site transfer with no
      stamp refuses `not_valued`, which is safe because the pilot has not gone live and there are
      zero in-flight transfers at cutover. See patch D1-P below.
- [x] [Review][Decision] D2 - `taxable_value` is computed on the REQUESTED quantity and never
      re-valued at ship; `applyTransferShipProjection` only refuses a `shipped_quantity` GREATER
      than the requested quantity, so a short ship leaves the recorded taxable value, the tax
      invoice filed against it and the e-way-bill threshold decision all describing a consignment
      that never moved. [src/compliance/transfer-request.ts:620, 794]
      RULED 2026-09-09 (round-table): REFUSE the short ship on a valued inter-GSTIN transfer.
      Recomputing on `shipped_quantity` was rejected: the e-invoice is already filed and the IRN
      minted on the portal, so re-valuing makes the platform's record contradict a filed statutory
      document. The real-world path is cancel the invoice and re-raise for the quantity that
      actually ships. See patch D2-P below.
- [x] [Review][Decision] D3 - `declared_unit_value` on the `open_market_value` and
      `like_kind_quality` bases is single-control, unbounded, and stamped
      `basis_source: 'config_default'`, so any authenticated creator sets the taxable value and the
      row records a human figure as system-derived.
      [src/compliance/transfer-request.ts:297-305, src/read/projections/branch_transfer_gst.ts:150]
      RULED 2026-09-09 (round-table): require `gst_officer` for the `open_market_value` and
      `like_kind_quality` bases AND stamp `basis_source: 'declared'`. NOT full dual control: Story
      9.9 is dual control because it REvalues a booked asset, whereas this is initial valuation and
      an override path already exists behind `VALUATION_LOCKED`. Two controls on the same figure is
      theatre. See patch D3-P below.
- [x] [Review][Decision] D4 - the e-way bill threshold is tested against `taxable_value`, not the
      statutory consignment value, which includes the tax component, so a supply with a taxable
      value of Rs 46,000 and 18 percent IGST has a consignment value of Rs 54,280 and legally
      requires an e-way bill this gate does not ask for. [src/compliance/transfer-request.ts:1203]
      RULED 2026-09-09 (round-table): keep comparing the taxable value, but set the default knob to
      Rs 42,373 (50,000 divided by 1.18, the worst-case 18 percent IGST) and RENAME the knob so it
      names a taxable-value threshold rather than an e-way-bill one. Building a tax engine for one
      comparison was rejected; the platform holds no rate. Over-triggering at lower rates is free,
      under-triggering is a penalty and a detained truck. See patch D4-P below.
- [x] [Review][Decision] D5 - an EXPIRED e-way bill satisfies the ship gate; `ewb_valid_until` is
      validated at recording only as a well-formed instant and is never compared to anything
      afterwards. [src/compliance/transfer-request.ts:1203-1210]
      RULED 2026-09-09 (round-table): ENFORCE at ship with a new `e_way_bill_expired` reason. An
      e-way bill is valid one day per 200 km, so expiry while a truck waits at the gate is common,
      not exotic, and blocking at our gate is the cheap version of a checkpost detention. See patch
      D5-P below.
- [x] [Review][Decision] D6 - `document_number_ext` has no uniqueness across transfers, so the same
      ERP tax invoice number can be recorded against N different transfer requests, each
      individually satisfying its own ship gate.
      [read/projections/branch_transfer_gst_document.sql:36, 77]
      RULED 2026-09-09 (round-table): LEAVE IT. This is the Story 11.2 `dispatch_irn` coverage
      grain: one ERP invoice legitimately covers several movements (one invoice, three trucks, same
      day). No code change. The DDL comment at
      `read/projections/branch_transfer_gst_document.sql:75` must state THIS reason rather than
      only asserting the index is deliberately not UNIQUE.

- [x] [Review][Patch] D1-P Stamp the branch-transfer classification at create for EVERY cross-site
      transfer, `intra_gstin` included, and make `dispatchGateGstDocuments` read the stamp instead
      of calling `classifyBranchTransfer`. A cross-site transfer carrying no stamp refuses
      `not_valued`. Needs a persisted `supply_class` (and both resolved GSTINs where they exist)
      reachable from the ship gate for intra-GSTIN transfers, which today have no
      `branch_transfer_valuation` row at all [src/compliance/transfer-request.ts:1180-1192, 620]
- [x] [Review][Patch] D2-P Refuse a short ship on a valued inter-GSTIN transfer: extend the
      `shipped_quantity` check beyond the existing greater-than bar so any quantity that is not
      equal to the valued quantity is refused, with its own error code registered in BOTH
      `PERMANENT_ERROR_CODES` sets and in the edge `en.json`
      [src/compliance/transfer-request.ts:794]
- [x] [Review][Patch] D3-P Require `gst_officer` for the `open_market_value` and
      `like_kind_quality` bases at create, and record `basis_source: 'declared'` for a
      creator-supplied unit value instead of `config_default`. `basis_source` is pinned in the DDL
      CHECK, the schema-drift test and the projection mapper, so all three move together
      [src/compliance/transfer-request.ts:297-305,
      read/projections/branch_transfer_valuation.sql:56, src/read/projections/branch_transfer_gst.ts]
- [x] [Review][Patch] D4-P Set the threshold default to 42373 and rename the config knob and its
      env var to name a taxable-value threshold; carry the rename through `.env.example`, the gate
      and the `threshold` field returned on the gate result
      [src/config/index.ts:796, src/compliance/transfer-request.ts:1203]
- [x] [Review][Patch] D5-P Refuse at ship when `ewb_valid_until` is at or before the ship instant,
      with a new `e_way_bill_expired` reason in the gate's reason list
      [src/compliance/transfer-request.ts:1203-1210]
- [x] [Review][Patch] D6-P Rewrite the DDL comment above
      `idx_branch_transfer_gst_document_number` to state the Story 11.2 coverage-grain reason (one
      ERP invoice legitimately covers several movements), not merely that the index is deliberately
      not UNIQUE [read/projections/branch_transfer_gst_document.sql:75]

- [x] [Review][Patch] `chk_branch_transfer_gst_document_irn` does not constrain a NULL IRN: the
      `document_kind <> 'tax_invoice' OR irn_ext ~ '...'` body evaluates to NULL, which Postgres
      accepts. The sibling `chk_..._ewb_validity` correctly uses `IS NOT NULL`
      [read/projections/branch_transfer_gst_document.sql:62]
- [x] [Review][Patch] `toScaled` rounds NUMBER input via `toFixed` but TRUNCATES string input, so
      the same economic value produces a different `unit_value` depending on JSON encoding, and a
      sub-scale declared value truncates silently to zero against Task 3.3's "half-up ONCE, at the
      end" [src/compliance/transfer-request.ts:239-247]
- [x] [Review][Patch] A numeric `declared_unit_value` at or above 1e21 makes `toFixed(6)` return
      exponential notation, so `BigInt("1e+21" + "000000")` throws an uncaught `SyntaxError` inside
      the applier [src/compliance/transfer-request.ts:228, 305]
- [x] [Review][Patch] No magnitude bound before the NUMERIC columns: `quantity` is capped at 1e12
      and `declared_unit_value` is uncapped, so `taxable_value` can exceed `NUMERIC(18,2)` and
      surface as a raw Postgres 22003 in a 500 rather than a typed refusal
      [src/compliance/transfer-request.ts:308-310]
- [x] [Review][Patch] Zero-value taxable supplies pass the DDL: the only CHECK is
      `taxable_value >= 0` and there is no CHECK on `unit_value` at all
      [read/projections/branch_transfer_valuation.sql:64]
- [x] [Review][Patch] `basis_source` is not tied to the override attribution:
      `chk_branch_transfer_valuation_override_pair` pairs `overridden_by` with
      `override_reason_code` but permits `basis_source = 'override'` with both NULL, defeating the
      Story 9.8-2 attribution class at the storage layer
      [read/projections/branch_transfer_valuation.sql:74]
- [x] [Review][Patch] `TRANSFER_SITE_MISMATCH` and `INVALID_STATE` are missing from BOTH
      `PERMANENT_ERROR_CODES` sets, so a permanently-refused queued event retries forever. Task 7.1
      listed eleven codes; the implementation reaches twelve
      [src/sync/upload.ts:137-149, edge/src/sync/connector.ts:133-145]
- [x] [Review][Patch] Overlapping dated windows are prevented only by a read-then-write with no
      lock and no exclusion constraint on either table, and the failure mode is unrecoverable:
      `findSiteGstin` then throws 500 `GSTIN_CONFIG_CONFLICT` on every transfer at that site with
      no DELETE grant to clean up. Add `EXCLUDE USING gist` on the daterange or an advisory
      transaction lock [src/read/projections/site_gstin.ts:447-491,
      src/read/projections/branch_transfer_valuation_config.ts:622-669]
- [x] [Review][Patch] `overrideBranchTransferValuation` does not refresh `valuation_config_id`, so
      the row can carry an override's `cost_plus_percent` while still pointing at the create-time
      config row [src/read/projections/branch_transfer_gst.ts:179-192]
- [x] [Review][Patch] The override applier has no `source_event_id` replay short-circuit, unlike
      the create and document appliers, so replaying an already-applied override after shipment
      throws `VALUATION_LOCKED` and stalls the replay [src/compliance/transfer-request.ts:1331]
- [x] [Review][Patch] `classifyBranchTransfer` can throw `SITE_GSTIN_MISSING` out of the ship gate
      uncaught, bypassing the `logRejectionAudit` self-audit that wraps only
      `GST_DOCUMENTS_REQUIRED`, so an AC 4 rejection row is never written for that path
      [src/compliance/transfer-request.ts:1181-1186]
- [x] [Review][Patch] GST document replay matches on `document_number_ext` alone, so a replay
      carrying the same number with a corrected `irn_ext`, `issued_at` or `ewb_valid_until` is
      silently discarded while the API reports success
      [src/compliance/transfer-request.ts:1548]
- [x] [Review][Patch] `declared_unit_value` is accepted, never used and never stored on the
      `cost_plus` and non-inter-GSTIN paths, and the caller still receives a 201. The symmetric
      case correctly refuses `DECLARED_VALUE_REQUIRED`
      [src/compliance/transfer-request.ts:626, 655]
- [x] [Review][Patch] No GSTIN format CHECK on `branch_transfer_valuation_config.from_gstin_ext`
      or `to_gstin_ext` while `site_gstin` pins `chk_site_gstin_format`, so a malformed seed never
      matches and every transfer on that pair fails closed with an invisible cause
      [read/projections/branch_transfer_valuation_config.sql:37-50]
- [x] [Review][Patch] A transfer in `pending_approval` accepts GST document recording, so an
      IRN-bearing tax invoice can be filed against a transfer that is then rejected, with the
      valuation permanently locked and no DELETE grant [src/compliance/transfer-request.ts:1535]
- [x] [Review][Patch] Site identity is compared case-sensitively (`fromSiteId === toSiteId`) while
      `assertPayloadSiteBound` deliberately lower-cases, so a case-differing `site_id` classifies an
      intra-site move as cross-site [src/compliance/transfer-request.ts:350]
- [x] [Review][Patch] `logRejectionAudit` is awaited on the refusal path with no containment, so an
      audit-write failure converts the 409 `GST_DOCUMENTS_REQUIRED` into an opaque 500 and the
      caller cannot tell a statutory block from a broken server
      [src/compliance/transfer-request.ts:730-738]
- [x] [Review][Patch] Cross-site enumeration oracle on the override door: `lockBranchTransfer`
      throws 404 or 409 BEFORE `assertPayloadSiteBound` runs, and `TRANSFER_SITE_MISMATCH` returns
      the foreign `from_site_id` in its error details [src/compliance/transfer-request.ts:886-936]

- [x] [Review][Defer] `metadata.occurred_at` is bounded only in the future (5 minutes), so any gate
      keyed on `gateBusinessDateOf` is backdatable [src/events/store.ts:479] - deferred,
      pre-existing and repo-wide
- [x] [Review][Defer] `assertAndApplyTransferRequestCompliance` is dead code duplicating the
      applier list in `store.ts`; this story doubled its size
      [src/compliance/transfer-request.ts:1133] - deferred, pre-existing
- [x] [Review][Defer] Lock-order inversion between the transfer applier (`stock_balance` then
      `inventory_valuation`) and `inventory-valuation.ts` (the reverse)
      [src/compliance/transfer-request.ts:429, 576] - deferred, pre-existing convention gap
- [x] [Review][Defer] No intra-state versus inter-state discriminator for the CGST and SGST versus
      IGST split; `state_code_ext` is written but never read and never validated against the
      GSTIN's own first two digits [read/projections/site_gstin.sql:32] - deferred, outside the
      AC set
- [x] [Review][Defer] A partial projection rebuild never rebuilds valuations: the create applier
      returns early on an existing transfer row before classification
      [src/compliance/transfer-request.ts:470] - deferred, pre-existing rebuild convention
- [x] [Review][Defer] The override overwrites the valuation row in place with no history table, so
      a filed statutory figure is mutated with only the event log as evidence
      [src/read/projections/branch_transfer_gst.ts:179] - deferred, matches the repo projection
      convention
- [x] [Review][Defer] An out-of-order `gst_document_recorded` or `valuation_overridden` event gets
      a 404 that `PERMANENT_ERROR_CODES` treats as terminal, so it is dead-lettered rather than
      retried [src/compliance/transfer-request.ts:1289] - deferred, pre-existing store contract

### Review Findings - chunk 2 (doors and wiring)

Code review 2026-09-09 (Blind Hunter, Edge Case Hunter, Acceptance Auditor; diff vs baseline
`d37cbba`, post-chunk-1-patch state). CHUNK 2 of 3 - the doors and the wiring:
`src/api/v1/transfer-requests.ts`, `src/api/v1/gst.ts`, `src/api/v1/sites.ts`,
`src/api/v1/events.ts`, `src/api/v1/edge.ts`, `src/server.ts`, `src/events/store.ts`,
`src/compliance/irn.ts`, `src/compliance/dispatch.ts`, `src/compliance/supplier.ts`,
`src/compliance/supplier-invoice.ts`, `src/sync/upload.ts`, `edge/src/sync/connector.ts`,
`edge/src/messages/en.json`, `src/config/index.ts`, `.env.example`. Chunk 3 (the integration tests
and fixture repairs) is not yet reviewed.

Three findings land on chunk-1 patches: E1 and Q2 are consequences of the chunk-1 rulings D3 and
P7, and Q3 is a second copy of the D1 defect on the read path.

- [x] [Review][Decision] E1 - ruling D3 made two of the four Rule 28 bases unreachable through the
      REST create route. `CREATE_ROLES` is `warehouse_manager`, `logistics_manager`,
      `store_assistant` and does NOT include `gst_officer`, so a pure GST officer is refused 403
      `FUNCTION_ACCESS_DENIED` at `assertRoleAllowed` before ever reaching the seam, while a
      warehouse role reaching the seam is refused `VALUATION_BASIS_NOT_PERMITTED`. Any GSTIN pair
      whose configured `default_basis` is `open_market_value` or `like_kind_quality` therefore
      cannot have a transfer created against it on the REST door at all - only through the events
      door, or by a user artificially holding BOTH roles, which is what the story's own new test
      fixture had to do (`creatorOfficer` = `warehouse_manager` + `gst_officer`).
      [src/api/v1/transfer-requests.ts:102, 347, src/compliance/transfer-request.ts:508-539]
      RULED 2026-09-09 (round-table): NEITHER offered option. Adding `gst_officer` to `CREATE_ROLES`
      was REJECTED on segregation-of-duties grounds - `CREATE_ROLES` is who may MOVE STOCK, and that
      would hand the person who sets the taxable value the power to originate the movement being
      valued, against the whole Story 9.9 design. Dual-role holding hides the same problem. Instead,
      an inter-GSTIN transfer whose pair defaults to a hand-declared basis is CREATED UNVALUED by a
      warehouse role: the D1 classification stamp is written, no value is guessed, and the ship gate
      already blocks it `not_valued` until a `gst_officer` values it. That state became legal as of
      D1; this ruling declines to make it unreachable, and it is the same shape as the document
      requirement - the transfer exists, it is classified, it cannot ship until a qualified human
      does the qualified thing. On the floor this is also what happens: roughly 95 percent of pairs
      are `cost_plus` and value themselves, and asking a warehouse manager to state an open market
      value was always the wrong ask. See patch E1-P below.
- [x] [Review][Decision] E2 - registering a site GSTIN or a GSTIN-pair valuation configuration has
      NO site scope. `assertGstConfigRole` matches on module plus function scope plus role and
      deliberately ignores `locationId`, and the handler then takes `siteId` straight from the path
      with no check that the caller holds it. A `finance_controller` or `gst_officer` at site A can
      register a GSTIN for site B, and registering B under a third GSTIN silently reclassifies
      every future site-B transfer - a taxable inter-GSTIN movement becomes `intra_gstin` with no
      tax invoice, no IRN, no e-way bill and no ship blocker. The same hole exists on
      `POST /api/v1/gst/branch-transfer-valuation-config`. [src/api/v1/sites.ts:204-226, 275-277,
      src/api/v1/gst.ts:36-37]
      RULED 2026-09-09 (round-table): GSTIN registration is a CENTRAL, head-office act performed
      once per site from a registration certificate - site staff never see the document - so it is
      gated on an EXPLICIT wildcard assignment rather than site-scoped. The point of making it
      explicit is that no-check-by-accident and no-check-on-purpose are the same code with very
      different lifespans. This ruling is BUNDLED and does not ship alone: because one central POST
      can reclassify the tax position of two whole sites, the site-existence check (Q10) and a route
      that CLOSES a registration window both ship WITH it. The window-closing route was on the defer
      list and is pulled back: without it a typo'd GSTIN is unfixable, since the chunk-1 gist
      EXCLUDE constraint refuses an overlapping correction. A second signature was proposed and
      rejected - registration is rare and, once the close route exists, reversible. See patch E2-P
      below.
- [x] [Review][Decision] E3 - `GET /api/v1/transfer-requests` is now an unbounded N+1. The route
      takes no `limit` and the underlying query has neither `LIMIT` nor `ORDER BY`; the handler
      then awaits `gstBlockFor` per row in sequence, and each call issues three to five further
      queries, each taking its own pool connection. A wildcard-scoped user listing 5,000 transfers
      issues roughly 20,000 sequential round trips and can exhaust the pool for everyone else.
      [src/api/v1/transfer-requests.ts:662-665, 556]
      RULED 2026-09-09 (round-table): NEITHER offered option. Batching optimises something nobody
      reads - no consumer takes a taxable value, a basis or a document list from a LIST response,
      and the GST officer works one transfer at a time and opens it. The `gst` block is therefore
      REMOVED from the list route and reduced to `supply_class` alone, read from the D1
      classification stamp in ONE batched query for the whole page; the full block stays on
      `GET /:id`. Pagination is older than this story and, once the fan-out is gone, the route is a
      single query returning rows - it goes to the deferred-work ledger rather than changing an
      existing route's contract inside a review. See patch E3-P below.

- [x] [Review][Patch] E1-P An inter-GSTIN transfer whose pair defaults to `open_market_value` or
      `like_kind_quality` and whose creator holds no `gst_officer` assignment is created UNVALUED
      (classification stamp written, no `branch_transfer_valuation` row) instead of being refused
      `VALUATION_BASIS_NOT_PERMITTED`; the existing ship gate blocks it `not_valued`. The
      `VALUATION_BASIS_NOT_PERMITTED` refusal is KEPT for the case where a non-officer explicitly
      supplies a `declared_unit_value`. The valuation override route must then OPEN on a transfer
      that has a classification stamp but NO valuation row - today `lockBranchTransfer` throws
      `NOT_A_BRANCH_TRANSFER` in exactly that case, so the officer has no door - and must INSERT the
      valuation rather than UPDATE it on that path, stamping `basis_source` as `declared`
      [src/compliance/transfer-request.ts:508-539, 1545-1595, src/read/projections/branch_transfer_gst.ts]
- [x] [Review][Patch] E2-P Gate both configuration POSTs on an EXPLICIT wildcard (`locationId` of
      `*`) inventory assignment, with a refusal message naming this as a central head-office action,
      and BUNDLE the two items the ruling makes preconditions: (a) refuse a `siteId` that matches no
      row in `location_register` with a typed 400 (Q10), and (b) add a route that CLOSES a
      registration or configuration window by setting `effective_to`, so a wrong GSTIN or
      `cost_plus_percent` is correctable - the gist EXCLUDE constraint refuses an overlapping
      correction, so without this a typo is permanent. The close route is itself a central act and
      takes the same wildcard gate and an `idempotency_key`
      [src/api/v1/sites.ts:204-226, 228-234, 275-277, src/api/v1/gst.ts:36-37, src/server.ts:552-556]
- [x] [Review][Patch] E3-P Remove the per-row `gstBlockFor` call from the transfer-request LIST
      route and return `supply_class` alone, resolved for the whole page from
      `branch_transfer_classification` in ONE `WHERE transfer_request_id = ANY($1)` query. The full
      `gst` block (valuation, documents, `ship_blockers`, threshold) stays on `GET /:id` only
      [src/api/v1/transfer-requests.ts:648-670]

- [x] [Review][Patch] Q1 The edge door's gate on the two new GST event types checks the ROLE ONLY -
      no module, no function scope, and no site scope - while the events-door twin
      `assertBranchTransferGstFunctionAccess` checks all three and additionally runs
      `assertPayloadSiteWriteAccess`. `assertPayloadSiteWriteAccess` appears nowhere in `edge.ts`.
      A `gst_officer` assigned to site A can therefore upload a `valuation_overridden` or
      `gst_document_recorded` event naming a site-B transfer, re-valuing that supply or lifting its
      `GST_DOCUMENTS_REQUIRED` wall; the seam's `assertPayloadSiteBound` does not stop it because it
      binds the payload site to the transfer's OWN site, not to the actor's. The events door refuses
      the identical post. This is the 2026-09-06 cross-site-events-door class on the door that was
      never swept. Task 4.4 requires "the same module/functionScope/site predicate"
      [src/api/v1/edge.ts:417-434 vs src/api/v1/events.ts:134-166]
- [x] [Review][Patch] Q2 REGRESSION FROM CHUNK-1 PATCH P7: `INVALID_STATE` was added to both
      `PERMANENT_ERROR_CODES` sets on the premise that Story 11.5 made it reachable on an
      edge-syncable event type for the first time. That premise is wrong - it is a generic code
      thrown at thirteen sites, including `applyTransferReceiveProjection` when a
      `transfer_request.received` arrives before its ship, and four cycle-count appliers. An offline
      device whose outbox drains receive-before-ship previously retried and self-healed; it now
      settles `needs_attention` permanently. Mint a dedicated code for the 11.5 late-document
      refusal and REMOVE `INVALID_STATE` from both sets
      [src/sync/upload.ts:156, edge/src/sync/connector.ts:152,
      src/compliance/transfer-request.ts:1257, 1868, 1880]
- [x] [Review][Patch] Q3 The `gst` block on GET re-derives the supply class on TODAY's IST date -
      the exact defect ruling D1 removed from the ship gate, still live on the read path, and its
      own docblock says so. Two divergences: an unstamped transfer is `not_valued` at the gate but
      renders as `intra_site` with no `ship_blockers` on the GET, so the officer sees nothing
      outstanding and the ship then 409s; and a transfer stamped `intra_gstin` whose sites have
      since been registered apart renders as `inter_gstin` with blockers while the gate lets it
      ship. Read `getBranchTransferClassification` first and fall back to `classifyBranchTransfer`
      only when no stamp exists. Task 3.6 requires `ship_blockers` to be what the ship gate would
      return now [src/api/v1/transfer-requests.ts:556-600]
- [x] [Review][Patch] Q4 Nine of the Story 11.5 permanent error codes have no message in the edge
      catalogue, so `errorMessage` falls through to `?? errorCode` and the operator's
      needs-attention row reads the literal string `VALUATION_LOCKED`: `DECLARED_VALUE_REQUIRED`,
      `VALUATION_COST_UNAVAILABLE`, `BASIS_NOT_ELIGIBLE`, `VALUATION_LOCKED`,
      `NOT_A_BRANCH_TRANSFER`, `GST_DOCUMENT_CONFLICT`, `TRANSFER_SITE_MISMATCH`,
      `GSTIN_CONFIG_OVERLAP`, `VALUATION_CONFIG_OVERLAP`. Add all nine and add a test asserting
      every code in `PERMANENT_ERROR_CODES` has a message [edge/src/messages/en.json]
- [x] [Review][Patch] Q5 The REST override and document routes take PRIVILEGE from one assignment
      and SITE SCOPE from a different one: `assertRoleAllowed` matches any assignment holding
      `gst_officer` with inventory write, then `assertWriteLocationAccess` resolves scope from
      `permittedLocationsForModule` across ALL inventory assignments - and that helper never calls
      `satisfiesFunctionScope`, so a READ-ONLY assignment at site B contributes site B to a
      statutory write gate. A user who is `gst_officer` at site A and a read-only role at site B can
      override site B's valuation. The events door's own docblock states privilege and site scope
      must come from the SAME assignment [src/api/v1/transfer-requests.ts:120-136, 1268, 1301,
      src/api/v1/rbac.ts:16-28]
- [x] [Review][Patch] Q6 The audited actor role on a statutory GST action is whichever assignment
      `requireRole` matched first, not the GST role, because neither new handler passes a
      `locationId` resolver. A user who is both `store_assistant` and `gst_officer` has the override
      event's `metadata.actor.role` and the audit row stamped `store_assistant`, and
      `actor.eventLocationId` comes from the same arbitrary assignment
      [src/api/v1/transfer-requests.ts:74-82, src/api/v1/rbac.ts:107]
- [x] [Review][Patch] Q7 Config-route idempotency is unsound in three ways: the replay lookup
      ignores the request body, so the same key with a DIFFERENT body returns the old row with
      `replayed: true` and the new registration is silently never made; it is keyed on the raw
      `req.url`, so a trailing slash, a query string or an upper-case UUID is a different replay
      namespace and the retry inserts twice; and it is not scoped to the actor or, in `gst.ts`, to
      the GSTIN pair, so one key can create configurations for many pairs. Store a canonical body
      hash, key on the normalised pathname, and refuse a reused key whose body differs
      [src/api/v1/sites.ts:294-311, src/api/v1/gst.ts:82-102]
- [x] [Review][Patch] Q8 Both configuration POSTs run an unindexed `details->>'idempotency_key'`
      scan of the entire, ever-growing statutory `audit_log` inside an open transaction. Add an
      expression index [src/api/v1/sites.ts:294, src/api/v1/gst.ts:82]
- [x] [Review][Patch] Q9 The chunk-1 gist EXCLUDE constraints can now raise `23P01`, and neither
      configuration route maps it - both `catch`, roll back and rethrow, so a concurrent overlap
      surfaces as a raw 500 instead of the `GSTIN_CONFIG_OVERLAP` / `VALUATION_CONFIG_OVERLAP` the
      routes already define [src/api/v1/sites.ts:131-138, src/api/v1/gst.ts:100-107]
- [x] [Review][Patch] Q10 `POST /api/v1/sites/:siteId/gstin` accepts a GSTIN for a site that does
      not exist - the path parameter is validated for UUID shape only. A one-digit typo returns 201
      and creates a permanently orphaned registration while the intended site keeps failing
      `SITE_GSTIN_MISSING` at create with nothing pointing at the cause, and there is no route that
      lists registrations across sites to find it [src/api/v1/sites.ts:228-234, 275-277]
- [x] [Review][Patch] Q11 `state_code_ext` is accepted as any string up to 200 characters and is
      never reconciled with the GSTIN, whose own first two digits ARE the state code - and that is
      what decides IGST versus CGST plus SGST. Also `optionalText` tests `value.length > 200`
      BEFORE trimming, so a 200-character value with leading spaces is accepted at 203, and an
      explicitly empty string is refused on a field documented as optional
      [src/api/v1/sites.ts:236-242]
- [x] [Review][Patch] Q12 `cost_plus_percent` precision depends on the JSON type: a number is
      `toFixed(3)` while a numeric STRING is passed through with only `.trim()`, so
      `"110.1234567"` either silently rounds at the column or raises 22003. The ceiling of 9999
      also admits a 9,899 percent Rule 30 markup, and the refusal message says only "at least 100"
      and never mentions the ceiling [src/api/v1/gst.ts:65-74]
- [x] [Review][Patch] Q13 GSTIN query parameters are upper-cased but NOT trimmed while the POST
      path trims first, so a GSTIN that registers successfully is rejected on the GET if the client
      leaves a trailing space [src/api/v1/gst.ts:145-158 vs :30]
- [x] [Review][Patch] Q14 The REST document route silently DROPS `irn_ext` on an `e_way_bill` -
      spreading it only when the kind is `tax_invoice` - while the events door 400s the identical
      payload. Two doors, two contracts [src/api/v1/transfer-requests.ts:1405 vs
      src/compliance/transfer-request.ts:1836]
- [x] [Review][Patch] Q15 `cost_centre` and `project_code` are in both event payload allowlists but
      neither REST route forwards them, so they are settable only through the events and edge doors
      and vanish silently from a REST call [src/compliance/transfer-request.ts:1525-1526, 1737-1738
      vs src/api/v1/transfer-requests.ts:1315-1330]
- [x] [Review][Patch] Q16 The create response and the read response describe the same resource with
      different contracts: create emits `supply_class: undefined` for a non-inter transfer, which
      JSON drops entirely, while GET returns a concrete `intra_site`; and the idempotent-replay
      branch of create returns no `gst` key at all. The classification stamp now records the real
      class, so create can emit it [src/api/v1/transfer-requests.ts:513-517, 362-370]
- [x] [Review][Patch] Q17 `requireIdempotencyKey` exists in two verbatim copies, in `sites.ts` and
      in `transfer-requests.ts`, with the same comment. The File List calls `sites.ts` the home of
      the shared config-route helpers [src/api/v1/sites.ts:264-273,
      src/api/v1/transfer-requests.ts:1243-1252]
- [x] [Review][Patch] Q18 The events door does not require an `idempotency_key` for the two new GST
      event types while both REST routes do, so the same override posted twice with two event ids
      applies twice; the `source_event_id` short-circuit only catches a replay of the SAME id
      [src/events/schema.ts:4807, src/api/v1/transfer-requests.ts:1244]
- [x] [Review][Patch] Q19 A `gst_officer` provisioned with `inventory:write` only can POST a
      configuration and then gets 403 on the GET of the row they just created, because
      `assertGstConfigRole(req, 'read')` requires a separately read-scoped assignment rather than
      treating write as implying read [src/api/v1/sites.ts:32-45, 172, src/api/v1/gst.ts:139]
- [x] [Review][Patch] Q20 `gstBlockFor` swallows every `AppError` into
      `supply_class: 'unclassified'` with no `ship_blockers`, so a genuine `SITE_GSTIN_MISSING` and
      the unrecoverable 500-class `GSTIN_CONFIG_CONFLICT` render identically and the read surface
      built for the GST officer reports nothing outstanding for a transfer the gate will refuse
      [src/api/v1/transfer-requests.ts:587-592]
- [x] [Review][Patch] Q21 `reason_code` on a statutory revaluation and `document_number_ext` on a
      GST document are both unbounded free text with no catalogue and no length cap, against this
      repo's own convention that statutory reason codes come from a catalogue that fails closed
      [src/api/v1/transfer-requests.ts:1289-1291, 1352-1355]
- [x] [Review][Patch] Q22 Five Completion Notes claims are now contradicted by the code (the
      threshold knob name and its 50000 default, `basis_source = 'config_default'` on create, the
      ship gate re-classifying, "eleven codes" in both sets, and "13/13" story arms), and the File
      List row for `deploy/compose/init-db.sql` still says four DDL mirrors where there are now
      five [_bmad-output/implementation-artifacts/11-5-branch-transfer-valuation-and-gst-documents.md]

- [x] [Review][Defer] The two `PERMANENT_ERROR_CODES` sets are NOT identical despite the comment
      this story adds to both asserting they are: nine Epic 9 codes are in `src/sync/upload.ts` and
      absent from `edge/src/sync/connector.ts` (`PROTOTYPE_NOT_SALEABLE`, `KIT_LINE_MISMATCH`,
      `OFFCUT_ELECTION_MISSING`, `BILLING_NOT_READY`, `SOD_VIOLATION`, `OFFCUT_NOT_RETAINED`,
      `CREDIT_NOTE_MISSING`, `CREDIT_NOTE_UNCITABLE`, `CREDIT_NOTE_SUPERSEDED`; 188 versus 179
      entries) - deferred, pre-existing Epic 9 drift, not this story
- [x] [Review][Defer] GSTIN check digits are never verified anywhere - `GSTIN_REGEX` is shape-only,
      so a transposed character yields a structurally valid, statutorily invalid GSTIN that then
      drives classification [src/compliance/supplier.ts:23] - deferred, pre-existing and shared
      with the supplier side
- [x] [Review][Defer] `effective_from` is unbounded in both directions, so a registration dated
      1900-01-01 or 2999-01-01 is accepted; the second silently yields a site with no currently
      effective registration while returning 201 [src/api/v1/sites.ts:244-262] - deferred
- [x] [Review][Defer] The `gst` block exposes both GSTINs and the taxable value to any inventory
      reader while the configuration routes restrict GSTIN reads to `finance_controller` and
      `gst_officer`, making that restriction decorative
      [src/api/v1/transfer-requests.ts:557, 662-665 vs src/api/v1/sites.ts:352] - deferred
- [x] [Review][Defer] `getTransferRequestById` is read outside the persisting transaction in the
      override and record routes, so `business_stream` and the site scope are decided against a
      snapshot the applier's `FOR UPDATE` does not cover; benign only because the applier re-locks
      and re-validates [src/api/v1/transfer-requests.ts:1299, 1368] - deferred

### Review Findings - chunk 3 (tests and fixtures)

Code review 2026-09-09 (Vacuity Hunter, Coverage Hunter, Test Standards Auditor; diff vs baseline
`d37cbba`, post-chunk-1-and-2-patch state). CHUNK 3 of 3 - the test layer:
`test/integration/story-11-5.test.ts`, `test/unit/branch-transfer-valuation.test.ts`,
`test/unit/edge-permanent-error-parity.test.ts`, `test/unit/schema-drift.test.ts`, and the fixture
repairs in `test/integration/story-{1-9,2-5,2-8,8-1,9-2}.test.ts`.

The headline is that a chunk-1 patch is BYPASSABLE and its own regression arm demonstrates the
bypass while asserting it as correct. Beyond that, the suite's genuine regression arms are strong
(D1, D2, D3, E1, E2, E3, Q1 all fail against the pre-patch code), but a large fraction of the 49
applied patches are pinned by prose in this file and by nothing else.

- [x] [Review][Decision] F1 - the D5 e-way-bill expiry check is evaluated against
      `envelope.metadata.occurred_at`, which is CALLER-SUPPLIED and bounded only in the future
      (`src/events/store.ts:479`, whose comment reads "Upper bound only: offline uploads are
      legitimately old"). A `warehouse_manager` ships on a long-expired e-way bill by backdating one
      field, and the suite's own D5 arm does exactly that - `shipAt('2026-09-04T23:59:59Z')` as a
      plain warehouse token, shipping 600 units on a bill that expired in real time, asserted as the
      correct outcome. The arm that proves D5 works also demonstrates how to defeat it.
      [src/compliance/transfer-request.ts:1016, 1450-1456]
      RULED 2026-09-09 (round-table): compare `ewb_valid_until` against SERVER TIME. The defect is
      not which timestamp was chosen, it is that a statutory control was keyed to a caller-supplied
      claim; a control must key on a server-observable fact. The offline objection - that a device
      syncing three days late would be refused a movement that physically happened - was raised and
      then withdrawn: a refused edge event parks in `needs_attention` with the reason attached,
      which IS the compliance exception queue a movement on an expired bill should land in, not data
      loss. The lower bound on `occurred_at` remains deferred as ledger 11.5R-1 and is deliberately
      NOT fixed here: every gate in this codebase reads that field, and fixing one of thirty inside
      a GST patch would buy the appearance of a fix. See patch F1-P below.
- [x] [Review][Decision] F2 - the four fixture repairs seed ONE shared GSTIN across every site, the
      configuration in which the new seam does nothing: every legacy cross-site transfer becomes
      `intra_gstin`, for which the create applier writes no valuation and the ship gate returns
      `blocked: false`. No pre-existing suite exercises the new code at all.
      [test/integration/story-2-5.test.ts:174-182 and twins]
      RULED 2026-09-09 (round-table): LEAVE the repairs; make patch T20 strict instead. The claimed
      loss was tested against the seam rather than assumed: of the Story 2.5 paths named, receive and
      allocation-reversal-on-reject never touch the GST seam, and concurrent double-ship returns on
      the `in_transit` replay short-circuit before reaching it. The real exposure is exactly one
      thing - the quantity guard ordering, where `SHIP_QUANTITY_MISMATCH` now fires ahead of
      `QUANTITY_EXCEEDS_APPROVED` - and that is already patch T20. Converting a load-bearing
      nineteen-arm suite to a two-GSTIN fixture to buy one ordering assertion is a bad trade; T20
      buys the same coverage at a fraction of the risk. No separate patch: this ruling is discharged
      by T20.
- [x] [Review][Decision] F3 - Task 8.3 required mutation verification of the seam guards and Table 3
      records four mutants killed against the PRE-review seam, but no guard added by either review
      chunk has been mutation-verified.
      RULED 2026-09-09 (round-table): mutation-verify the six load-bearing guards the review added
      (the D1 stamp read, the D2 quantity equality, the D5 expiry comparison, the E1
      first-valuation insert branch, the Q1 edge-door site predicate, the E2 wildcard gate) and
      record them in Table 3 - BUT record alongside them, in the story, that this is not insurance
      against the class of defect F1 belongs to. Mutation testing proves a test can DETECT A CHANGE
      in the code; it cannot tell you the test asserts the WRONG THING. D5's comparison is
      mutation-clean - mutate `<=` to `<` and the boundary arm dies - and the defect was still there,
      because the arm's oracle was wrong. What caught F1 was a reviewer asking where the number in
      the assertion came from. The caveat is written down precisely so that a future reader cannot
      cite the mutant table as proof the guards were verified in a stronger sense than they were.
      See patch F3-P below.

- [x] [Review][Patch] F1-P Evaluate e-way-bill validity against server time rather than the
      caller-supplied ship instant: `dispatchGateGstDocuments` should stop taking the instant from
      `envelope.metadata.occurred_at` for the expiry comparison and use the server clock. Keep
      `occurred_at` wherever the BUSINESS DATE is what is wanted - it is the right field for a
      business date and the wrong field for a control. The D5 arm must be rewritten with it: the
      boundary is now driven by seeding `ewb_valid_until` relative to the server clock rather than
      by choosing `occurred_at`, and a new arm must prove the backdating vector is CLOSED - a ship
      posted with an `occurred_at` before the bill expired is still refused when the bill has
      expired by server time [src/compliance/transfer-request.ts:1016, 1450-1456,
      test/integration/story-11-5.test.ts D5 arm]
- [x] [Review][Patch] F3-P Mutation-verify the six guards the review added - the D1 stamp read, the
      D2 quantity equality, the D5 expiry comparison, the E1 first-valuation insert branch, the Q1
      edge-door site predicate and the E2 wildcard gate - by mutating each in turn, confirming a
      named arm fails, and reverting. Record each mutant and its killing arm in Table 3, and add the
      F3 caveat sentence beside the table: mutation verification shows a test can detect a change to
      the guard, NOT that the test asserts the right thing, as F1 demonstrated on a guard that was
      mutation-clean [_bmad-output/implementation-artifacts/11-5-branch-transfer-valuation-and-gst-documents.md Table 3]

- [x] [Review][Patch] T1 `branch_transfer_classification` is missing from the TRUNCATE list of ALL
      FOUR repaired fixture suites, so every transfer they create leaks a classification row that
      survives their own `TRUNCATE transfer_request` and accumulates across runs. Only story-11-5
      truncates it [test/integration/story-2-5.test.ts:145, story-2-8.test.ts:153,
      story-8-1.test.ts:663, story-9-2.test.ts:463]
- [x] [Review][Patch] T2 `story-8-1` and `story-9-2` TRUNCATE and INSERT into the new tables without
      adding the `read/projections/*.sql` files to their harness DDL list, unlike the story-2-5 and
      story-2-8 repairs. They pass only because `db:migrate` happened to create the tables; a
      harness-only bootstrap fails at the TRUNCATE. None of the four applies
      `branch_transfer_classification.sql` [test/integration/story-8-1.test.ts:621 region,
      story-9-2.test.ts:433 region]
- [x] [Review][Patch] T3 The D3 "refused inside the seam" arm is a ZERO-ASSERTION pass on its `locH`
      iteration: it selects rows already present for `to_location_id` and asserts each one's
      `unit_value !== '20.000000'`, but the select returns no rows and the loop body never executes.
      It never checks the classification stamp either, so a create applier that persisted the row
      and the stamp before throwing would stay green. Use the strict `assert.equal(rows.length, 0)`
      form the sibling arms already use [test/integration/story-11-5.test.ts:1334-1352 vs :650-653]
- [x] [Review][Patch] T4 The e-way-bill threshold is never tested at its boundary: the "at or below"
      arm is valued at 11,000 against a threshold of 42,373. Flipping the gate's `>` to `>=` leaves
      every arm green. Add arms at exactly 42,373 and 42,374
      [test/integration/story-11-5.test.ts:997-1011, src/compliance/transfer-request.ts:1503]
- [x] [Review][Patch] T5 The schema-drift arm for the new `audit_log` index asserts
      `migrateSource.includes('audit_log.sql')` - true since Story 1.3 and true whether or not the
      index exists. This is the Story 11.2 "audit row exists" vacuity verbatim
      [test/unit/schema-drift.test.ts]
- [x] [Review][Patch] T6 The unit event-registry arm compares
      `SUPPORTED_EVENT_TYPES['transfer_request.gst_document_recorded']` against
      `SUPPORTED_EVENT_TYPES['transfer_ship.created']` - a value asserted against another value from
      the same source, pinning no content. Assert the literal object
      [test/unit/branch-transfer-valuation.test.ts]
- [x] [Review][Patch] T7 `readPermanentErrorCodes` in the parity test matches `/^\s*'([A-Z0-9_]+)',/gm`,
      requiring a trailing comma, so a code added as the final entry of either set is invisible to
      all three arms - including the `GST_DOCUMENT_STATE_INVALID` presence check the test exists for
      [test/unit/edge-permanent-error-parity.test.ts]
- [x] [Review][Patch] T8 The parity test never asserts that Story 11.5's own fifteen codes are in
      BOTH sets; all but `GST_DOCUMENT_STATE_INVALID` could be dropped from either side with no
      failure [test/unit/edge-permanent-error-parity.test.ts]
- [x] [Review][Patch] T9 The `officerElsewhere` fixture holds `gst_officer write locA` in addition to
      `siteX`, so it PASSES the REST route's site gate. No arm ever drives a wrong-site officer at
      `POST /valuation-override` or `POST /gst-documents`, and deleting both
      `assertGstOfficerLocationAccess` calls leaves every arm green - so Q5, on the REST layer where
      the hole actually was, is unpinned [test/integration/story-11-5.test.ts:253-260,
      src/api/v1/transfer-requests.ts:1449, 1547]
- [x] [Review][Patch] T10 The `officer` fixture holds a wildcard `*` assignment, and
      `actorHoldsGstOfficerAssignment` short-circuits on `location_id = '*'`, so every
      positive-direction site check in the suite is unfalsifiable through that identity
      [test/integration/story-11-5.test.ts:245-252, src/compliance/transfer-request.ts:530-533]
- [x] [Review][Patch] T11 Q19 (write implies read) is defeated by the very fixture meant to exercise
      it: the officer is given an explicit `read '*'` assignment, and the comment admits it is
      "redundant but harmless". Remove it so the write-implies-read clause becomes load-bearing
      [test/integration/story-11-5.test.ts:255, src/api/v1/sites.ts:66-67]
- [x] [Review][Patch] T12 `TRANSFER_SITE_MISMATCH` - the guard written for the 2026-09-06 cross-site
      class - has ZERO coverage on any of the three doors, because `doorEnvelope` hardcodes
      `site_id: siteA` and `edgeOverride` is only ever called with `siteA`. Add an arm driven by an
      officer holding both sites, asserting the code AND that `details` does not leak
      `from_site_id` (the P18 half) [test/integration/story-11-5.test.ts:454, 1740, 1751]
- [x] [Review][Patch] T13 `VALUATION_LOCKED` has two causes and only the document cause is tested;
      deleting the `VALUATION_LOCKED_STATUSES` check leaves every arm green, and AC 2 names the
      shipped cause explicitly. One arm ships a transfer and never attempts an override afterwards
      [test/integration/story-11-5.test.ts:858-860, 1299]
- [x] [Review][Patch] T14 The GST document replay divergence check (chunk-1 patch P12) is fully
      revertible: the AC3 arm tests only the same-number no-op and the different-number conflict.
      Add arms re-recording the same `document_number_ext` with a CHANGED `irn_ext`, a changed
      `issued_at` and a changed `ewb_valid_until`, each expecting `GST_DOCUMENT_CONFLICT`, plus one
      proving `sameInstant` treats a re-rendered identical instant as a no-op
      [src/compliance/transfer-request.ts:2007-2017]
- [x] [Review][Patch] T15 The override applier's replay short-circuit (chunk-1 patch P10) is fully
      revertible - no override is ever replayed. Add an arm applying an override, shipping, then
      re-posting the identical envelope, expecting a 2xx no-op rather than `VALUATION_LOCKED`
      [src/compliance/transfer-request.ts:1702]
- [x] [Review][Patch] T16 `toScaled`'s half-up rounding on the STRING path (chunk-1 patch P2, which
      replaced truncation) has no test: every string input in the suite has 6 or fewer decimals, so
      the rounding branch is never reached. Add unit arms at 7 decimals in both directions AND an
      arm asserting the string and number paths agree, which is the defect P2 fixed
      [src/compliance/transfer-request.ts:254-257]
- [x] [Review][Patch] T17 The magnitude bound (chunk-1 patches P3 and P4) has no test at all - no
      input anywhere reaches 1e12. `assertDeclaredUnitValueBounded` and both `MAX_*` guards are dead
      in test, so the only protection against an uncaught `BigInt` `SyntaxError` 500 is unpinned.
      Add arms for a numeric `1e21`, a 13-digit decimal string, and a value that overflows
      `NUMERIC(18,2)` via quantity [src/compliance/transfer-request.ts:333, 341, 352, 360, 376-388]
- [x] [Review][Patch] T18 Every dated window in every fixture is `2020-04-01` to NULL against 2026
      business dates, so no boundary is tested: a transfer exactly on `effective_from`, exactly on
      `effective_to`, or one day either side. An off-by-one in `findSiteGstin` would silently
      un-register a site on its last valid day [src/read/projections/site_gstin.ts:156]
- [x] [Review][Patch] T19 The gist EXCLUDE constraints, the advisory locks and the Q9 `23P01`
      mapping are ALL unpinned: both overlap arms are answered by the app-side probe, so deleting
      `excl_site_gstin_window`, `pg_advisory_xact_lock` and `mapWindowExclusionViolation` fails only
      a schema-drift TEXT check. One concurrent arm (`Promise.all` of two registrations whose
      windows overlap but whose probes both miss) pins all three at once
      [src/read/projections/site_gstin.ts:102-125, src/api/v1/sites.ts:291]
- [x] [Review][Patch] T20 Guard ordering is unpinned and has changed: `SHIP_QUANTITY_MISMATCH` now
      fires BEFORE `QUANTITY_EXCEEDS_APPROVED`, so for a valued inter-GSTIN transfer an over-ship
      returns 409 not 400. The story-2-5 arm that covered this is now `intra_gstin` and no story-11-5
      arm over-ships a valued transfer - only a short ship is covered
      [src/compliance/transfer-request.ts:1040 vs 1058, test/integration/story-2-5.test.ts:444]
- [x] [Review][Patch] T21 `SHIP_QUANTITY_MISMATCH` calls `auditRefusal` but no arm counts its audit
      row, unlike `GST_DOCUMENTS_REQUIRED`; and the refusal is exercised on the REST door only,
      though the offline-sync path is where a short ship is most likely to arise. Add the audit
      assertion and an events-door arm [src/compliance/transfer-request.ts:1050]
- [x] [Review][Patch] T22 `transfer_request.gst_document_recorded` is never driven through the EDGE
      door, so `assertBranchTransferGstFunctionAccess` there is only ever entered for the override
      type - narrowing `BRANCH_TRANSFER_GST_EVENT_TYPES` to the override alone would silently revert
      half of Q1. Also unpinned on that gate: the `module` and `functionScope === 'write'` halves
      [src/api/v1/edge.ts:69-70, 151]
- [x] [Review][Patch] T23 A cluster of status-only assertions where an unrelated 400 or 403 satisfies
      the arm, so a business refusal and a shape or permission error are indistinguishable. Assert
      `error_code`, and where the patch is about WHICH guard fired, the `details` discriminator
      [test/integration/story-11-5.test.ts:581, 669, 750, 954, 1914, 1982, 2017]
- [x] [Review][Patch] T24 Order dependence: several arms read state created by the immediately
      preceding arm or assert "no row exists" only because they happen to run before the arm that
      creates one, and the D1 regression arm permanently rewrites siteG's registration mid-suite
      with direct SQL, so any later arm touching locG silently takes the intra_gstin path. Make each
      arm self-sufficient or make the dependency explicit
      [test/integration/story-11-5.test.ts:644-647, 693-696, 1191-1199, 1881-1892, 1927-1938]
- [x] [Review][Patch] T25 The `ON CONFLICT (site_id, effective_from) DO NOTHING` in the fixture
      repairs arbitrates on the unique index only; the gist EXCLUDE constraint is not covered by
      `DO NOTHING` and the statement works only because `uq_site_gstin_site_from` wins the
      index-insertion race. In story-8-1 and story-9-2 it re-runs on every `seedLocation`. Use
      `WHERE NOT EXISTS` [test/integration/story-2-5.test.ts:174-182 and twins]
- [x] [Review][Patch] T26 AC 1's fourth Rule 28 basis has no positive path: no pair is ever
      configured `recipient_full_itc_eligible: true`, so only the refusals are exercised and Task
      3.4's defensive `assertBasisEligible` is unpinned
      [test/integration/story-11-5.test.ts:580, 834]
- [x] [Review][Patch] T27 AC 5 is half-covered: an `intra_site` transfer is created and its stamp
      asserted but never SHIPPED, so an `intra_site` stamp mishandled at the gate fails no arm
      [test/integration/story-11-5.test.ts:1134, 1650, 1769]
- [x] [Review][Patch] T28 Refusing document recording on a `pending_approval` transfer (chunk-1
      patch P15) is unpinned - every fixture transfer is `pending_shipment`, so the second
      `GST_DOCUMENT_STATE_INVALID` site is unreachable
      [src/compliance/transfer-request.ts:1991-1998]
- [x] [Review][Patch] T29 Q15's forwarding half is unpinned: the three validation refusals are
      tested but nothing asserts `cost_centre` and `project_code` actually reach the persisted event
      payload, so deleting the spread stays green. Q16's replay branch is likewise never driven
      [src/api/v1/transfer-requests.ts:433-447, 1471, 1572]
- [x] [Review][Patch] T30 Q6 is unpinned: no arm reads `audit_log.role` or `location_id`, so the
      audited actor naming the authorising assignment rather than an arbitrary first match is
      asserted by prose only [test/integration/story-11-5.test.ts auditRowsFor]
- [x] [Review][Patch] T31 Q7's pathname-normalisation half (trailing slash, query string, upper-case
      UUID, per-user scoping) has no arm on either route, and `IDEMPOTENCY_KEY_REUSED` is proved on
      the config route only, not on the site-GSTIN route [src/api/v1/sites.ts:205-214]
- [x] [Review][Patch] T32 Q11, Q12 and Q13 are entirely unpinned: `state_code_ext` is never supplied
      by any arm, `cost_plus_percent` is only ever sent as a number so the string branch and the
      9999.9996 overflow case are untested, and no GET is issued with a padded GSTIN
      [src/api/v1/sites.ts:114-145, src/api/v1/gst.ts:65-74, 145-158]
- [x] [Review][Patch] T33 The config close route is missing the inverted-date 400 and the
      site-scoped 403 arms its registration twin has, and neither close route proves the INVARIANT -
      no arm creates a transfer after closing a window to show the closed registration stops
      resolving [test/integration/story-11-5.test.ts:1916-1957]
- [x] [Review][Patch] T34 Nothing verifies that the three event-derived projections
      (`branch_transfer_classification`, `branch_transfer_valuation`,
      `branch_transfer_gst_document`) rebuild from `domain_events`. Add a truncate-and-replay arm.
      Separately, `site_gstin` and `branch_transfer_valuation_config` are written DIRECTLY rather
      than from events and so are unrebuildable by construction - a legitimate choice following the
      `transaction_tagging_rules` precedent, but undocumented; record it
- [x] [Review][Patch] T35 Completion Notes remain contradicted by the code even after patch Q22: the
      story says 13 arms where there are 27, "schema-drift 171/171 (was 168/168 before the review)" where the same document later
      says 170/170, and the File List says story-1-9 gained seven allowlist entries and server.ts
      seven routes where the diff adds nine
      [_bmad-output/implementation-artifacts/11-5-branch-transfer-valuation-and-gst-documents.md]

## Dev Notes

### Why this story is pilot scope and what it is not

Sprint-status tags 11-5 `# PILOT` because the pilot operates more than one GSTIN (confirmed
2026-09-05): the first movement across that boundary is a Schedule I supply between distinct
persons, valued under Rule 28 and documented before it moves. The Story 11.2 file says the "rest of
Epic 11 (11.1, 11.3, 11.4, and the new 11.5) is NOT in the pilot slice"; that sentence predates the
same-day confirmation and sprint-status is the record. This story does NOT build an IRP, e-way bill
portal or GSP client. INT-GST-01 rules that the ERP remains the invoice issuer and this platform
consumes the returned IRN; Story 11.2 applied the same rule ("this platform enforces, ERP supplies").
Here the tax invoice and the e-way bill are ERP-issued documents that a GST officer RECORDS on the
transfer; the platform values, blocks, and keeps the evidence.

### Binding decisions

1. **Classification is by GSTIN resolution, not by site difference.** A transfer within one site
   is untouched. A cross-site transfer resolves both sites through `site_gstin` on the business
   date: same GSTIN is intra_gstin (untouched), different GSTINs is inter_gstin (this story), and a
   missing registration on either side is refused `SITE_GSTIN_MISSING`. Fail closed follows Story
   8.6's ruling that reversed 8.4's "null never blocks"; the cost is fixture seeding (Task 8.4),
   exactly as 8.6 seeded licences into the 8-4 fixtures.
2. **Site GSTIN is a dated registration table, not a column on `location_register`.**
   `location_register` is edge-synced, `site_id` there is a bare UUID with no site row behind it,
   and a GSTIN can change on re-registration. A `site_gstin` row keyed by `site_id` with a validity
   window follows the `compliance_bis_licence` / `transaction_tagging_rules` dated-config shape and
   leaves the pinned 2.5 and location DDL untouched.
3. **Valuation lives in a sibling table keyed by `transfer_request_id`,** not in new columns on
   `transfer_request`. Legacy rows simply have no sibling; the ship gate re-derives their class
   (Task 6.1) rather than assuming they are safe.
4. **The four Rule 28 bases are exactly** `open_market_value`, `like_kind_quality`, `cost_plus`,
   `invoice_value_full_itc`. Only `cost_plus` is computable from data this platform holds
   (`inventory_valuation.running_average_cost`, SKU grain; there is no per-lot or per-location
   cost, and FIFO layers are cost-of-issue machinery, not a transfer price). The other three take a
   declared unit value from the creator or the overriding officer. `invoice_value_full_itc` is
   gated on the pair's `recipient_full_itc_eligible` flag at both default and override.
5. **The override is a separate event by `gst_officer`, never a field on create.** The creator is a
   warehouse role; letting the create payload carry a basis would make the override a
   poster-supplied claim. The overriding actor is the authenticated identity (9.8-2 class).
6. **The role is `gst_officer`.** The epics text says "GST accountant"; the access matrix of record
   (`access-matrix-frontline-draft-2026-07-11.md:89`, the file commit c8520c2 used to register
   `cfo` and `finance_controller`) names the role `gst_officer` with "Branch-transfer documents,
   IRN request monitoring; per-GSTIN scope" and gives it C on "Issue branch-transfer / Rule 45
   documents" (line 226). No `gst_officer` or `gst_accountant` exists in code; roles are free text
   on `user_role_assignments.role`, so the name is introduced by this story's gates and tests.
7. **The block sits at `transfer_ship.created`, not in `src/compliance/dispatch.ts`.** Transfers
   never pass the dispatch seam (verified: no transfer reference in `dispatch.ts` or
   `dispatch_*.sql`, no dispatch reference in the four transfer files). "Dispatch is attempted" in
   AC 4 means the transfer ship. Do not extend `applyDispatchDispatchedProjection`.
8. **Every inter-GSTIN supply is e-invoiceable** (Story 11.2 ruling, no exemption), so the tax
   invoice record must carry the IRN; the signed QR is not required by this platform (epics 11.2
   dev note, ruled 2026-09-05).
9. **E-way bill applies when taxable value EXCEEDS the threshold** (strictly greater), threshold
   Rs 50,000 as a config knob with a default, not a literal (architecture spine: "statutory
   thresholds as dated configuration files, not hard-coded"). A dated threshold table is not built;
   the knob is the smallest thing that satisfies the spine.
10. **Business date is IST** via `gateBusinessDateOf` (already imported in the transfer seam), so
    the config window, the GSTIN window and the QC gate agree on the day.
11. **No ERP outbound invoice-request feed is built.** The valued transfer surfaced on the GET
    (with `ship_blockers`) is the request; whether a 9.6-style pull feed is wanted is an open
    question below, not a task.

### Source tree components to touch

Table 1 lists every file this story touches, with the nature of the change.

| **File** | **Change** |
| --- | --- |
| `read/projections/site_gstin.sql` | NEW, plus its `deploy/compose/init-db.sql` mirror |
| `read/projections/branch_transfer_valuation_config.sql` | NEW, plus mirror |
| `read/projections/branch_transfer_valuation.sql` | NEW, plus mirror |
| `read/projections/branch_transfer_gst_document.sql` | NEW, plus mirror |
| `src/read/projections/site_gstin.ts` | NEW reader/writer |
| `src/read/projections/branch_transfer_valuation_config.ts` | NEW reader/writer |
| `src/read/projections/branch_transfer_gst.ts` | NEW: valuation and document readers/writers |
| `src/compliance/transfer-request.ts` | UPDATE: classify, value, override applier, document applier, ship gate |
| `src/compliance/supplier.ts`, `src/compliance/supplier-invoice.ts` | UPDATE: export one `GSTIN_REGEX`, delete the duplicate |
| `src/events/schema.ts` | UPDATE: payload interfaces, two `SUPPORTED_EVENT_TYPES` entries, `declared_unit_value` on create |
| `src/events/store.ts` | UPDATE: shape asserts, applier wiring, `auditCtx` into the ship applier |
| `src/events/migrate.ts` | UPDATE: append four projection files |
| `src/api/v1/transfer-requests.ts` | UPDATE: create passthrough, GET `gst` block, override and document routes |
| `src/api/v1/sites.ts` or the existing sites/locations router | UPDATE or NEW: GSTIN registration routes |
| `src/api/v1/gst.ts` | NEW: valuation config routes |
| `src/api/v1/events.ts`, `src/api/v1/edge.ts` | UPDATE: role gate for the two new event types |
| `src/server.ts` | UPDATE: register the new routes |
| `src/config/index.ts` | UPDATE: `gst.ewayBillTaxableValueThresholdInr` (renamed and re-defaulted to 42373 by review ruling D4) |
| `src/sync/upload.ts`, `edge/src/sync/connector.ts` | UPDATE: `PERMANENT_ERROR_CODES` twins |
| `edge/src/messages/en.json` | UPDATE: three error strings |
| `test/unit/schema-drift.test.ts` | UPDATE: pin five projections with full index and CHECK bodies (review added `branch_transfer_classification` and the `audit_log` idempotency index) |
| `test/integration/story-11-5.test.ts` | NEW |
| `test/integration/story-1-9.test.ts` | UPDATE: spine allowlist |
| `test/integration/story-2-5|2-8|8-1|9-2.test.ts` | UPDATE: seed one shared GSTIN per fixture site, extend TRUNCATE |

### Current state of the code being modified

`src/compliance/transfer-request.ts` (771 lines) owns the transfer seam. `applyTransferRequestProjection`
(160) validates `business_stream` (105-109), runs `assertQcGateAllows` for a lot-bearing transfer
(276-283) and `applyStockAllocation` at the source (295); the route decides the initial status from
the DOA ladder (`resolveApprover`, api 141; `status = requiresApproval ? 'pending_approval' :
'pending_shipment'`). `applyTransferShipProjection` (379) takes the row lock first, short-circuits a
replay on an existing `in_transit` row (~406), refuses unless status is `approved` or
`pending_shipment` (403 `APPROVAL_REQUIRED`), re-runs the QC gate (~473), then `applyStockIssue` and
`applyStockDeallocation` (487-500), bumps `in_transit`, and sets `shipped` (~550).
`applyTransferReceiveProjection` (620) is untouched by this story. Approve and reject do NOT have
appliers: the route mutates `transfer_request` directly (api 630, 735) and then persists the event;
the reject path releases the allocation through `lotNumberForUuid` (compliance 38), the 3c486f2 leak
fix. PRESERVE all of it: the QC gate order, the `in_transit` unique backstop, the lot UUID-vs-number
bridge (`transfer_request.lot_id` is the lot_master UUID, `stock_balance.lot_id` is the lot number).

`transfer_request` (`read/projections/transfer_request.sql:10-28`) is one row per SKU and quantity,
no line table, no FKs, status values commented not CHECKed, `app_user` has no DELETE. Every route in
`src/api/v1/transfer-requests.ts` is gated `requireRole({ module: 'inventory', functionScope })` with
per-location `assertWriteLocationAccess` (119-132, 403 `LOCATION_ACCESS_DENIED`); payloads carry
location ids, not `site_id`, so `assertPayloadSiteWriteAccess` never fires for the existing four
transfer events. That hole is tracked (see Open Questions); this story's NEW payloads carry `site_id`.

`src/api/v1/events.ts` gates function access per event family at lines 296-299
(`assertPlanningPayloadWriteLocation`, `assertOffcutValuationFunctionAccess`,
`assertDispatchIrnFunctionAccess`, `assertPayloadSiteWriteAccess`) and then overwrites
`metadata.actor.user_id` from the auth context (301). The dispatch-IRN gate (173-204) is the
template: filter `authContext.roles` by module (`'warehouse'` or `'*'`) plus `functionScope ===
'write'` plus a role-name set, 403 `FUNCTION_ACCESS_DENIED`, then site check against `r.locationId`
with `'*'` as wildcard. For this story the module predicate is `'inventory'` or `'*'`.

Dated config precedent: `transaction_tagging_rules` (`business_stream_config.sql:34-48`) with
`findActiveTaggingRule` (`business_stream_config.ts:120-150`: `effective_from <= $2::date AND
(effective_to IS NULL OR effective_to >= $2::date)`, two rows is a 500 conflict, overlap refused at
write with `COALESCE(effective_to, 'infinity'::date)`). Copy the shape; do not invent a new one.

Document numbering precedent (`allocatePoNumber`, `purchase_order.ts:372-376`) is NOT used here:
document numbers are ERP-issued externals (`_ext`), the platform records, it does not mint (the
11.2R-5 ledger note says the same for IRNs).

`inventory_valuation` (`inventory_valuation.sql:9-12`): `sku PK, quantity_on_hand,
running_average_cost, carrying_value, ...`; reader `getInventoryValuation(sku, client)` at
`inventory_valuation.ts:76`. Use `lockInventoryValuation` (93) if you read inside the write
transaction, so a concurrent receipt does not move the cost under the calculation.

### Previous story intelligence

From Story 11.2 (done 2026-09-09, the immediately preceding story in this epic):

- The direct events door had NO role gate for the new event type: a warehouse operator could lift a
  statutory block the REST route denied it. Every new event type in this story gets a door gate
  (Task 4.4) and a strict test arm that posts as the wrong role on the events door, not only on the
  route.
- `recorded_by` poster-supplied was the 9.8-2 attribution class again. This story has no
  `*_by` field on any input payload.
- The wall failed OPEN when the ERP line was missing. Here, an absent registration, an absent config
  and an absent cost all refuse.
- "New codes go in BOTH PERMANENT_ERROR_CODES sets"; the dev's single-homed note was wrong.
- Two test arms were vacuous (satisfied by MODULE_ACCESS_DENIED / any prior audit row). Assert the
  specific code and select the audit row by this transfer's id.
- Applier-self-audit (`auditCtx` optional parameter, `logRejectionAudit` on a fresh connection before
  the throw) is the way an applier refusal leaves an `audit_log` row on both doors.
- Route replay: the route mints a fresh key unless the client supplies `idempotency_key`; require it
  (8.7 D8) and assert the same `eventId` with `n === 1` events on replay.
- `also_covers` uncapped and `btrim`-only CHECKs went to the ledger; keep this story's list inputs
  bounded (none here) and its CHECKs on `btrim(...) <> ''`.

From Story 9.9 / 9.10: parameterise a shared applier by `kind` rather than copying it (the
document applier handles both kinds in one function); guards are mutation-verified at the seam, and
route pre-checks mask seam-only mutants; `assertQcGateAllows` skipped the hold half for lots without
a QC task, now fixed, so do not re-implement any hold logic here.

From the noise-floor elimination (2026-09-05): a rejected transfer leaked its allocation because
`lot_id` on the request is a UUID while `stock_balance.lot_id` is a number. Any new SQL that joins
`transfer_request` to stock must go through `lotNumberForUuid`.

### Git intelligence

Last five commits: `d37cbba closed EPIC 9`, `0778172 feat(9-9,9-10,11-2)` (CFO-signed revaluation,
pre-pilot gate sweep, IRN-before-dispatch), `5be1c3a commit 9-7 an 9-8`, `6d11951 commit`,
`9bbbf05 9-7`. The 0778172 diff is the closest precedent for every mechanism here: a coverage-grain
projection with guarded CHECKs and a schema-drift pin, an `inventory`/`warehouse` stream event with
`requiresBusinessStream`, a door role gate, twin error-code sets, and fixture edits in the suites
whose flow the new block interrupts (`story-3-7`, `story-3-10-dispatch` now record an IRN before
dispatch, the same shape as Task 8.4). Working tree at baseline has one dirty file
(`_bmad-output/party-mode/memories/installed/.memlog.md`), unrelated.

### Testing standards

Integration tests run against the docker `ims-postgres-test` instance on port 5442 through
`node --env-file=.env.test --import tsx --test --test-concurrency=1`; run integration files
serially. `app_user` has no DELETE; use the admin pool for fixture cleanup. The suite is green at
baseline (2033/2034 at 11.2 close, the single failure being the `story-5-3` IST/UTC window). There
is no noise floor; any other failure is yours.

The `story-5-3` mechanism matters here: `where_used_impact.ts` compares an IST-stamped date with
Postgres `CURRENT_DATE` in UTC, and they diverge between 00:00 and 05:30 IST. This story's date
windows (`site_gstin`, valuation config) are compared against the IST business date computed in
TypeScript and passed as a parameter; never use `CURRENT_DATE` or `now()::date` in the resolvers,
and seed fixture windows from absolute past dates.

Guards are mutation-verified at the seam (Task 8.3). Run `tsc`, `eslint`, `prettier` and the
`db:migrate` twice-idempotency check before declaring done.

### Project Structure Notes

- Canonical DDL lives in `read/projections/*.sql`, hand-mirrored into `deploy/compose/init-db.sql`,
  tail-appended to `MIGRATIONS` in `src/events/migrate.ts`, and pinned in
  `test/unit/schema-drift.test.ts` with full CHECK and index bodies. All DDL is `IF NOT EXISTS` or a
  guarded `DO $$ DROP CONSTRAINT IF EXISTS ... ADD CONSTRAINT` block (the bom_line precedent).
- Error codes are string literals in `new AppError(status, code, message, details)`; there is no
  registry file. The two `PERMANENT_ERROR_CODES` sets and `edge/src/messages/en.json` are the only
  places a code must be echoed.
- Routes are registered in `src/server.ts`, static segments before parameterised siblings, and the
  Story 1.9 spine allowlist test enumerates every route.
- Roles are free text; module/functionScope/locationId triples are assigned through SCIM in tests.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 11.5] story text, ACs, dev notes
- [Source: _bmad-output/planning-artifacts/epics.md#Story 11.2] "signed QR not required", "all supplies e-invoiceable"
- [Source: _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md:350] FR-AC-10
- [Source: _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md:475] Schedule I branch transfers, Rule 28, e-way bills above Rs 50,000
- [Source: _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/addendum.md:25] INT-GST-01, ERP remains the invoice issuer
- [Source: _bmad-output/planning-artifacts/architecture/ARCHITECTURE-SPINE.md:181-187] `_ext` external ids, IST `business_date`, thresholds as dated configuration
- [Source: _bmad-output/planning-artifacts/architecture/ARCHITECTURE-SPINE.md:322-324] GST documents retained 8 years
- [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md:85-92, 219-226] `gst_officer` role and capability cells
- [Source: _bmad-output/implementation-artifacts/11-2-irn-before-dispatch-enforcement.md] binding decisions, review findings, file list
- [Source: _bmad-output/implementation-artifacts/2-5-inter-location-transfer-requests.md] transfer state machine
- [Source: _bmad-output/implementation-artifacts/deferred-work.md:681-703] 11.2R-1 to 11.2R-5
- [Source: read/projections/transfer_request.sql:10-33] transfer DDL
- [Source: read/projections/location_register.sql:16-27] `site_id` is a bare UUID
- [Source: read/projections/business_stream_config.sql:34-48; src/read/projections/business_stream_config.ts:120-176] dated config precedent
- [Source: read/projections/dispatch_irn.sql:40-46; src/compliance/dispatch.ts:636-662] IRN CHECK and validators
- [Source: src/api/v1/events.ts:173-204, 296-301] door role gate template
- [Source: src/read/projections/inventory_valuation.ts:76-93] cost reader and lock

## Open Questions

None of these block development; each has a stated default the tasks follow.

1. **Role name.** The epics say "GST accountant"; the access matrix says `gst_officer`. Default:
   `gst_officer` (binding decision 6). If the Project Lead prefers `gst_accountant`, it is a rename
   of one constant and the test users.
2. **ERP invoice request.** INT-GST-01 says this platform "raises invoice-request events through the
   ERP flow". Default: the valued transfer on the GET, with `ship_blockers`, is the request; no
   9.6-style pull feed is built. If ERP needs a feed table, that is a follow-up story.
3. **Legacy in-flight transfers.** Transfers created before this migration that are inter-GSTIN
   have no valuation row and will be refused at ship with reason `not_valued`, with no route to value
   them after the fact (the override refuses `NOT_A_BRANCH_TRANSFER`). Default: accept; the pilot has
   none. If it does, add a `gst_officer` "value now" arm to the override applier.
4. **Threshold as env knob.** The spine asks for dated configuration files; Task 2.4 uses a config
   knob with a default. Acceptable for pilot; a dated `gst_threshold_config` table is post-pilot.
5. **Site scope for the existing four transfer events.** Their payloads carry no `site_id`, so the
   events-door site check never fires for them (the "payloads WITHOUT site_id are still unswept"
   class from 2026-09-06). Out of scope here; raise a ledger entry if not already present.
6. **Cost basis.** `cost_plus` uses the SKU running-average cost because that is the only cost the
   platform holds. If finance wants FIFO cost-of-issue at the moment of ship, valuation would have to
   move from create to ship, which contradicts AC 1.

## Dev Agent Record

### Agent Model Used

Claude Fable 5.1 (claude-fable-5-1), dev-story workflow, 2026-09-09.

### Debug Log References

- Baseline before any change: `story-2-5` 19/19 at d37cbba (confirms the "fifteen failing" note
  is stale, as the story predicted).
- First run of `story-2-5` after Task 3.4 landed and before Task 8.4: every cross-site create
  refused `SITE_GSTIN_MISSING` (19 failures, one code). That is the fail-closed guard firing on
  the untouched fixtures, exactly the effect the story anticipated; the fixture repair restored
  19/19 with one shared GSTIN per site.
- `db:migrate` needs the env file (`node --env-file=.env.test --import tsx src/events/migrate.ts`);
  the bare npm script boots the config in oidc mode and refuses. Not a defect of this story.
- The schema-drift pin compares index bodies as literal strings, so the four new files carry each
  `CREATE INDEX` on one line.
- First full-suite run: 2032/2034 with two WHOLE-FILE failures (`story-2-7`, `story-3-3`),
  both `SyntaxError: The requested module '../../compliance/transfer-request.js' does not provide
  an export named 'classifyBranchTransfer'`. Cause: a module cycle. The transfer seam imported the
  three IRN validators from `compliance/dispatch.ts`, which reaches `events/store.ts`, which
  imports the transfer seam; under tsx the named import resolved against a half-initialised module
  whenever a suite's entry order loaded `dispatch.ts` first. Fix: the validators moved to a leaf
  module `src/compliance/irn.ts` (moved, not duplicated; `dispatch.ts` re-exports them so every
  11.2 caller is unchanged). Both suites, `story-11-2` and `story-11-5` green afterwards; the full
  suite was re-run and its result is recorded in the completion notes.
- Prettier: the repo has 37 pre-existing drifted files at baseline. Every file this story created
  or edited under `src/` and `test/` passes `prettier --check`; `edge/src/sync/connector.ts` fails
  identically before and after the edit and the edge workspace gates on eslint only.

### Completion Notes List

- **Task 1 (site GSTIN registration).** `site_gstin` is a dated registration keyed by the bare
  `site_id` (no site table exists), with the GSTIN shape and the date window as guarded CHECKs,
  mirrored into `init-db.sql`, tail-appended to `MIGRATIONS`, pinned in the drift test with full
  index bodies. `GSTIN_REGEX` is now exported once from `supplier.ts`; the duplicate in
  `supplier-invoice.ts` is deleted in favour of the import. Reader/writer with the
  `COALESCE(effective_to, 'infinity')` overlap refusal (409 `GSTIN_CONFIG_OVERLAP`), a single-row
  resolver (two rows is 500 `GSTIN_CONFIG_CONFLICT`) and a lister. Routes
  `POST/GET /api/v1/sites/:siteId/gstin` for `finance_controller` or `gst_officer` on an
  `inventory` (or wildcard) assignment, idempotency key required; the replay of the same key
  returns the created row (stamped in the audit row's details, the only place a configuration
  write can carry it). Both routes are in the spine allowlist.
- **Task 2 (pair configuration).** `branch_transfer_valuation_config` with the five guarded
  CHECKs the story lists (basis vocabulary, distinct pair, cost-plus floor of 100, date window,
  and "a second-proviso default needs eligibility"). Reader/writer with the same overlap and
  single-row shapes. Routes `POST/GET /api/v1/gst/branch-transfer-valuation-config`.
  `config.gst.ewayBillThresholdInr` is a knob with default 50000 following the BSD-6 invariant
  (SUPERSEDED by code review ruling D4: the knob is now
  `config.gst.ewayBillTaxableValueThresholdInr` / `GST_EWAY_BILL_TAXABLE_VALUE_THRESHOLD_INR`
  with default 42373, being 50000 grossed down at the worst-case 18 percent IGST, because the
  statutory threshold is on consignment value and this platform compares taxable value.)
  (absent takes the default, present-but-blank refuses boot); documented in `.env.example` and
  proven by a child-process unit test.
- **Task 3 (classification and valuation).** `branch_transfer_valuation` is a sibling keyed by
  `transfer_request_id`; the pinned Story 2.5 DDL is untouched. `classifyBranchTransfer` resolves
  both sites through `findSiteGstin` on `gateBusinessDateOf(envelope)` (IST) and returns
  `intra_site`, `intra_gstin` or `inter_gstin`, throwing 409 `SITE_GSTIN_MISSING` naming the site.
  `computeRule28Value` is pure and uses exact scaled-integer BigInt arithmetic: `cost_plus` is
  the locked running-average cost times `cost_plus_percent / 100` at 6 dp (409
  `VALUATION_COST_UNAVAILABLE` on a null or zero cost), the other three bases take
  `declared_unit_value` (400 `DECLARED_VALUE_REQUIRED`), and `taxable_value` is rounded half-up
  to 2 dp once at the end. The create applier classifies after `applyStockAllocation` and inserts
  the row with `basis_source = 'config_default'` (SUPERSEDED by code review ruling D3: a
  creator-supplied `declared_unit_value` now records `basis_source = 'declared'`, and only a
  value derived from running cost records `config_default`); the refusals fire inside the applier so both
  doors meet them. `transfer_request.created` accepts optional `declared_unit_value`; the shape
  assert and the route both refuse `valuation_basis`, `taxable_value`, `unit_value`, the two
  GSTINs, `basis_source` and any `*_by` key. `GET /api/v1/transfer-requests/:id` and the list
  return a `gst` block with `supply_class`, and for `inter_gstin` the valuation, `documents`,
  `ship_blockers` (the gate's own list) and the threshold.
- **Task 4 (override).** Event `transfer_request.valuation_overridden` on the `inventory` stream
  with `requiresBusinessStream: true`, payload `transfer_request_id`, `site_id` (FROM site),
  `business_stream`, `valuation_basis`, `declared_unit_value?`, `reason_code`; a closed allowlist
  refuses `overridden_by` and any other key. The applier locks the transfer row, refuses
  `NOT_A_BRANCH_TRANSFER`, `VALUATION_LOCKED` (status or any document), `BASIS_NOT_ELIGIBLE`,
  recomputes and UPDATEs with `basis_source = 'override'`, `overridden_by =
  metadata.actor.user_id`. Route `POST .../valuation-override` for `gst_officer` on `inventory`,
  scoped through the FROM location, idempotency key required. Door gate
  `assertBranchTransferGstFunctionAccess` in `events.ts` (privilege and site from the same
  assignment, the dispatch-IRN template) and the edge twin.
- **Task 5 (documents).** `branch_transfer_gst_document` with `UNIQUE (transfer_request_id,
  document_kind)`, the 64-hex IRN CHECK on a tax invoice, and the e-way-bill validity CHECK.
  Event `transfer_request.gst_document_recorded` with a closed allowlist; `irn_ext` is validated
  by the 11.2 `IRN_EXT_REGEX` and normalised by `normalizeIrnExt`, `irp_acknowledged_at` and
  `issued_at` by `isValidIrpAcknowledgedAt`, `ewb_valid_until` by the same strict ISO shape
  without the not-in-the-future rule. One applier for both kinds: lock, `NOT_A_BRANCH_TRANSFER`,
  `INVALID_STATE` (400, the 2.5 code) on rejected or shipped-or-beyond, same number is a no-op,
  different number is 409 `GST_DOCUMENT_CONFLICT`. Routes `POST/GET .../gst-documents`.
- **Task 6 (ship gate).** `dispatchGateGstDocuments` returns `{ blocked, reasons, taxable_value,
  threshold }` (SUPERSEDED by code review ruling D1: the ship gate now READS the
  `branch_transfer_classification` stamp written at create and never re-classifies; an unstamped
  transfer refuses `not_valued`. The original text follows.) `: a transfer with no valuation row is re-classified (a legacy inter-GSTIN transfer
  is `not_valued`); `inter_gstin` requires a tax invoice with a shape-valid IRN and, when
  `taxable_value > threshold` strictly, an e-way bill. Wired into `applyTransferShipProjection`
  after the status check and the in-transit replay short-circuit, before the QC gate and any stock
  issue; throws 409 `GST_DOCUMENTS_REQUIRED` with `{ transfer_request_id, reasons, taxable_value,
  threshold }` after `logRejectionAudit` on a fresh connection. `auditCtx` is now plumbed from
  `store.ts` into the ship applier (it was not before). The REST ship handler needed no change;
  the 409 reaches the client with details intact (asserted).
- **Task 7 (codes).** (SUPERSEDED by code review: both sets now carry FIFTEEN story codes - the
  review added `TRANSFER_SITE_MISMATCH`, `SHIP_QUANTITY_MISMATCH`, `VALUATION_BASIS_NOT_PERMITTED`
  and `GST_DOCUMENT_STATE_INVALID`, and removed the generic `INVALID_STATE` that a first review
  patch had wrongly classified permanent; the edge catalogue now carries fifteen user strings, not
  three.) All eleven codes added to BOTH `PERMANENT_ERROR_CODES` sets; three user
  strings in `en.json`. `verify-segregated-roles-core.ts` enumerates only segregation-of-duties
  PAIRS (setter and approver); `gst_officer` is a single-role gate, not a pair, so there is nothing
  to register there. The role is introduced by this story's gates and tests, as the story said.
- **Task 8 (tests).** `test/integration/story-11-5.test.ts` (13 arms, all strict: specific codes,
  audit rows selected by THIS transfer id, door arms reach the gate rather than dying on
  MODULE/LOCATION denial) and `test/unit/branch-transfer-valuation.test.ts` (8 arms: hand-computed
  Rule 28 expectations, the half-up boundary, the knob's fail-closed contract in a child process,
  the registry pin). Fixture repair in `story-2-5`, `story-2-8`, `story-8-1`, `story-9-2`: one
  shared GSTIN seeded for every `site_id` in `location_register` (absolute past window), the four
  tables added to each TRUNCATE; `story-1-9` creates no transfer and only gained the allowlist
  entries. Each suite re-run green: 2-5 19/19, 2-8 24/24, 8-1 31/31, 9-2 19/19, 1-9 6/6, 11-2
  11/11, schema-drift 171/171 (was 168/168 before the review).
- **Task 8.3 mutation verification at the seam** (each mutant applied, the story file run, then
  reverted; the restored tree is 13/13). Table 3 records the result. (SUPERSEDED: the suite is
  now 44/44 after three review chunks; Table 3a below records the second mutation pass over the
  six guards the review added.)

Table 3 lists the four seam mutants and the arms that killed each.

| Mutant | Arms that failed |
| --- | --- |
| M1: ship gate condition forced false in `applyTransferShipProjection` | AC4 no-documents arm, AC3/AC4 invoice-then-e-way-bill arm, AC3 below-threshold arm (3 of 13) |
| M2: `branchTransferHasGstDocument` check forced false | AC2 BASIS_NOT_ELIGIBLE / VALUATION_LOCKED arm (1 of 13) |
| M3: `assertBranchTransferGstFunctionAccess` call removed from the events door | AC2 override arm and AC3 recording arm (both door 403 arms; 2 of 13) |
| M4: `SITE_GSTIN_MISSING` throws replaced by a fail-open `intra_site` return | AC6 missing-registration arm (1 of 13) |

Table 3a records the second mutation pass, run 2026-09-09 under review ruling F3 against the six
load-bearing guards the two review chunks ADDED. Each mutant was applied, the full story suite run,
and the mutant reverted; the three touched files were md5-checked against their pre-mutation state
after every revert, and the restored tree is 44/44.

| Mutant | Result | Arm that killed it |
| --- | --- | --- |
| M5 (D1): the ship gate re-derives instead of reading the classification stamp | KILLED, 29 pass / 15 fail | AC1, AC4, AC5 and twelve others - the stamp is load-bearing across the suite |
| M6 (D2): the short-ship equality relaxed to a greater-than test | KILLED, 43 pass / 1 fail | D2 short-ship arm |
| M7 (D5): `isEwayBillExpired` forced to return false | KILLED, 43 pass / 1 fail | D5/F1 server-time expiry arm |
| M8 (E1): the officer first-valuation INSERT branch forced unreachable | KILLED, 43 pass / 1 fail | E1 unvalued-then-officer-values arm |
| M9 (Q1): the edge door site predicate forced true, leaving role alone | KILLED, 43 pass / 1 fail | Q1 edge-door cross-site arm |
| M10 (E2): the central wildcard gate accepts any candidate assignment | KILLED, 42 pass / 2 fail | E2 central-acts arm and E2 close-routes arm |

WHAT TABLE 3a DOES AND DOES NOT PROVE. It proves each of these tests can DETECT A CHANGE to the
guard it names. It does NOT prove the test asserts the RIGHT THING, and this story contains the
counter-example: ruling F1 found that the D5 guard was comparing `ewb_valid_until` against a
caller-supplied `occurred_at`, so any shipper could defeat it by backdating one field - and the D5
guard was mutation-clean throughout, because the arm faithfully detected changes to a comparison
whose ORACLE was wrong. The arm even performed the bypass and asserted it as correct. What caught
that was a reviewer asking where the number in the assertion came from, not a mutant score. Do not
cite this table as evidence that the guards are verified in a stronger sense than "the tests are
sensitive to changes in them".

- **Deviations and judgment calls, disclosed.**
  1. The applier binds the payload `site_id` to the valuation row's `from_site_id` and refuses
     400 `TRANSFER_SITE_MISMATCH` otherwise. The story lists no such code, but without the bind an
     actor who holds site X could name site X in the payload while targeting a site-A transfer
     (the 2026-09-06 cross-site class the 11.2 applier closes the same way). Route callers never
     hit it because the route derives `site_id` from the FROM location.
  2. The override and document appliers require the pair configuration effective on the
     transfer's stored `business_date` (409 `VALUATION_CONFIG_MISSING` if it has since been
     withdrawn). The story only says eligibility comes from "the effective config"; a pair that
     lost its configuration fails closed rather than reusing the row's old percentage.
  3. `INVALID_STATE` on a late document recording keeps the Story 2.5 HTTP status (400), as the
     story asked, even though the sibling refusals in this story are 409.
  4. The `gst` block is computed for every row in the list route (one valuation lookup plus, for
     inter-GSTIN rows, the documents and the gate). Acceptable at pilot list sizes; noted for the
     ledger if the list grows.
  5. The sites and gst configuration routes write through the projection inside one transaction
     with an audit row (the `transaction_tagging_rules` precedent for dated configuration) rather
     than through a domain event; the idempotency replay is resolved from the audit row's details.
  6. `gateBusinessDateOf` gives the IST business date for the seam; the read-side `gst` block and
     the recording route's returned `ship_blockers` use today's IST date, which is what a ship
     attempted now would use.
- **Gates run before declaring done:** `tsc --noEmit` clean; `eslint src/ test/` clean; edge
  `tsc` and `eslint` clean; `prettier --check` clean on every file this story created or edited
  under `src/` and `test/`; `db:migrate` twice (idempotent); `schema-drift` 168/168; `story-1-9`
  6/6; the five fixture suites and `story-11-2` green as listed above; `story-11-5` 13/13 (the code
  review took it to 20/20 and then further; see the Change Log); unit
  8/8; full suite after the cycle fix 2059/2059 (0 failures, 0 cancelled; the documented `story-5-3` IST window did not apply at run time).

### File List

Table 4 lists every file this story created or modified, relative to the repository root.

| File | Change |
| --- | --- |
| `read/projections/site_gstin.sql` | NEW |
| `read/projections/branch_transfer_valuation_config.sql` | NEW |
| `read/projections/branch_transfer_valuation.sql` | NEW |
| `read/projections/branch_transfer_gst_document.sql` | NEW |
| `deploy/compose/init-db.sql` | MODIFIED: six DDL mirrors appended (the four story tables plus `branch_transfer_classification` and the `audit_log` idempotency-replay index, both added by the code review) |
| `src/events/migrate.ts` | MODIFIED: four MIGRATIONS entries appended |
| `src/events/schema.ts` | MODIFIED: `declared_unit_value` on create, two payload interfaces, two registry entries |
| `src/events/store.ts` | MODIFIED: two shape asserts, two appliers, `eventId` and `auditCtx` plumbed into the transfer appliers |
| `src/compliance/transfer-request.ts` | MODIFIED: classification, Rule 28 arithmetic, create-applier valuation, override applier, document applier, ship gate, shape asserts |
| `src/compliance/supplier.ts` | MODIFIED: `GSTIN_REGEX` exported |
| `src/compliance/irn.ts` | NEW: the one set of IRN validators, moved out of `dispatch.ts` to break a module cycle |
| `src/compliance/dispatch.ts` | MODIFIED: imports and re-exports the IRN validators from `irn.ts` |
| `src/compliance/supplier-invoice.ts` | MODIFIED: duplicate regex deleted, import added |
| `src/read/projections/site_gstin.ts` | NEW |
| `src/read/projections/branch_transfer_valuation_config.ts` | NEW |
| `src/read/projections/branch_transfer_gst.ts` | NEW |
| `src/api/v1/sites.ts` | NEW: site GSTIN routes and shared config-route helpers |
| `src/api/v1/gst.ts` | NEW: valuation configuration routes |
| `src/api/v1/transfer-requests.ts` | MODIFIED: create passthrough and refusals, `gst` block on GET and list, override and document routes |
| `src/api/v1/events.ts` | MODIFIED: `assertBranchTransferGstFunctionAccess` door gate |
| `src/api/v1/edge.ts` | MODIFIED: edge-door twin of the gate |
| `src/server.ts` | MODIFIED: nine routes registered (seven story routes plus the two window-closing routes added by review ruling E2) |
| `src/config/index.ts` | MODIFIED: `gst.ewayBillTaxableValueThresholdInr` (renamed and re-defaulted to 42373 by review ruling D4) |
| `.env.example` | MODIFIED: `GST_EWAY_BILL_TAXABLE_VALUE_THRESHOLD_INR` documented with the 50000/1.18 derivation |
| `src/sync/upload.ts` | MODIFIED: fifteen permanent error codes (review added `TRANSFER_SITE_MISMATCH`, `INVALID_STATE`, `SHIP_QUANTITY_MISMATCH`, `VALUATION_BASIS_NOT_PERMITTED`) |
| `edge/src/sync/connector.ts` | MODIFIED: the identical fifteen codes |
| `edge/src/messages/en.json` | MODIFIED: five user strings |
| `test/unit/schema-drift.test.ts` | MODIFIED: five projections pinned (review added `branch_transfer_classification`) |
| `test/unit/branch-transfer-valuation.test.ts` | NEW |
| `test/integration/story-11-5.test.ts` | NEW |
| `test/integration/story-1-9.test.ts` | MODIFIED: nine allowlist entries (seven story routes plus the two window-closing routes added by review ruling E2) |
| `test/integration/story-2-5.test.ts` | MODIFIED: shared GSTIN seed, TRUNCATE, harness file list |
| `test/integration/story-2-8.test.ts` | MODIFIED: shared GSTIN seed, TRUNCATE, harness file list |
| `test/integration/story-8-1.test.ts` | MODIFIED: shared GSTIN seed in `seedLocation`, TRUNCATE |
| `test/integration/story-9-2.test.ts` | MODIFIED: shared GSTIN seed in `seedLocation`, TRUNCATE |
| `read/projections/branch_transfer_classification.sql` | NEW (code review D1): the create-time supply-class stamp the ship gate reads |
| `src/read/projections/branch_transfer_classification.ts` | NEW (code review D1): insert and read for that stamp |
| `read/projections/audit_log.sql` | MODIFIED (code review Q8): partial expression index serving the configuration routes idempotency-replay lookup |
| `test/unit/edge-permanent-error-parity.test.ts` | NEW (code review Q4): every connector permanent code has an operator message, and the known 11.5R-8 set drift is pinned |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | MODIFIED: story status |

## Change Log

Table 2 records every change to this story file.

| Date | Change |
| --- | --- |
| 2026-09-09 | Story created from baseline d37cbba by the create-story workflow: 6 ACs, 8 tasks, 11 binding decisions, 6 open questions with defaults. Verified at HEAD that story-2-5 runs 19/19 (the "fifteen failing" note is stale), that no site table or site GSTIN exists, that transfers never pass the dispatch seam, and that every transfer fixture is cross-site by construction. |
| 2026-09-09 | Implemented by the dev-story workflow against baseline d37cbba: four projections (site_gstin, branch_transfer_valuation_config, branch_transfer_valuation, branch_transfer_gst_document) mirrored, migrated twice and drift-pinned; Rule 28 classification and valuation in the transfer seam; gst_officer override and document-recording events with door gates on both doors; the GST_DOCUMENTS_REQUIRED ship gate with applier self-audit; seven routes; eleven permanent error codes in both twins; four fixture suites repaired with one shared GSTIN; 13 integration arms, 8 unit arms, 4 seam mutants killed. Status moved to review. |
| 2026-09-09 | Code review closed against baseline `d37cbba` (Blind Hunter, Edge Case Hunter, Acceptance Auditor; chunk 1 of 3, the valuation core). 6 decisions ruled at a round-table and 24 patches applied; 7 deferred to the ledger as 11.5R-1 to 11.5R-7, 5 dismissed. LOAD-BEARING: the ship gate re-classified an unvalued transfer on the SHIP date, so re-registering two sites under one GSTIN between create and ship waved a taxable inter-GSTIN supply out with no invoice, no IRN and no e-way bill - now a create-time classification stamp in the new `branch_transfer_classification` table that the gate READS and never re-derives, failing closed on an unstamped transfer. Also: a short ship of a valued transfer is refused `SHIP_QUANTITY_MISMATCH` rather than silently contradicting a filed IRN; `open_market_value` and `like_kind_quality` now require `gst_officer` and record `basis_source` as `declared` instead of `config_default`; the e-way-bill knob re-based to 42373 taxable (50000 consignment grossed down at 18 percent) and renamed; an expired `ewb_valid_until` now blocks with `e_way_bill_expired`; a `tax_invoice` with a NULL IRN is refused by the DB (the CHECK NULL leg let it through); gist EXCLUDE constraints plus advisory locks close the dated-window overlap race. story-11-5 20/20 (6 new arms including a D1 regression arm), schema-drift 170/170, full suite 2068/2068 with 0 failures; tsc, eslint and prettier clean; migrate idempotent twice. Status moved to done. UNCOMMITTED. |
| 2026-09-09 | Code review CHUNK 2 closed (doors and wiring: the routes, both event doors, the edge and sync twins, config and env). 3 decisions ruled at a round-table and 25 patches applied; 8 more deferred as 11.5R-8 to 11.5R-15, 3 dismissed. THREE findings landed on chunk-1 work. (a) Chunk-1 patch P7 had added the GENERIC `INVALID_STATE` to both permanent sets on a false premise - it is thrown at thirteen sites including a `transfer_request.received` arriving before its ship, so an offline device draining receive-before-ship would have dead-lettered instead of self-healing; reverted, and the 11.5 late-document refusal given its own `GST_DOCUMENT_STATE_INVALID`. (b) The D1 defect had a second copy on the read path: `gstBlockFor` re-derived the supply class on TODAY's date, so the GET and the ship gate disagreed; it now reads the stamp and calls the same gate helper. (c) Ruling D3 had made two of the four Rule 28 bases unreachable, because `CREATE_ROLES` excludes `gst_officer` - RULED E1: such a transfer is created UNVALUED and the officer values it through the override route, which now INSERTS on that path; widening `CREATE_ROLES` was rejected on segregation-of-duties grounds. Also: the EDGE door gated the two new GST event types on ROLE ALONE with no module, function-scope or site predicate, so a `gst_officer` at one site could re-value or unblock another site's supply - the 2026-09-06 cross-site class on the door that was never swept, now a true twin of the events door; E2 made GSTIN registration an explicit central act bundled with a site-existence check and two new window-closing routes (without which the new gist EXCLUDE made a typo permanent); E3 removed a per-row GST fan-out that made the list route an unbounded N+1. story-11-5 27/27 (7 more arms), story-1-9 6/6, full suite 2079/2079 with 0 failures; tsc, eslint and prettier clean; migrate idempotent twice. Chunk 3 (integration tests and fixture repairs) was not separately reviewed. Status returned to done. UNCOMMITTED. |
| 2026-09-09 | Code review CHUNK 3 closed (the test layer: the story suite, the three unit suites and the four fixture repairs). 3 decisions ruled at a round-table and 37 patches applied; 4 dismissed, no new deferrals. THE HEADLINE IS A THIRD DEFECT INSIDE THE REVIEW'S OWN WORK, and the worst of the three: the D5 e-way-bill expiry check compared `ewb_valid_until` against `metadata.occurred_at`, which is caller-supplied and bounded only in the future, so any shipper could ship on a long-dead bill by backdating one field - and the suite's own D5 arm PERFORMED that bypass and asserted it as correct. RULED F1: compare against SERVER TIME; a statutory control keys on a server-observable fact, never a claim in the payload, and a refused offline ship parks in the edge queue's needs_attention, which is the compliance exception such a movement should raise. Beyond that the review found the suite's headline regression arms genuine (D1, D2, D3, E1, E2, E3, Q1 all fail against pre-patch code) but roughly half the 49 earlier patches pinned by prose and nothing else: the document-replay divergence check, the override replay short-circuit, the toScaled half-up string path, the magnitude bound, the gist EXCLUDE constraints and advisory locks, TRANSFER_SITE_MISMATCH, and Q6/Q11/Q12/Q13/Q19 were all fully revertible with a green suite. Also fixed: a D3 arm that was a zero-assertion pass (its loop body never executed), a schema-drift assertion true since Story 1.3, a threshold never tested within 31,000 of its boundary, three fixture identities shaped so their gates could not fail, and `branch_transfer_classification` missing from all four repaired TRUNCATE lists. RULED F2: do NOT convert a legacy suite to a two-GSTIN fixture - of the paths claimed lost, receive and reject never touch the GST seam and double-ship returns on the in_transit short-circuit, so the real exposure is one guard's ordering, bought by patch T20 at a fraction of the risk. RULED F3: mutation-verify the six guards the review added - all six KILLED, recorded in Table 3a - with a written caveat that mutation proves a test can detect a change, not that it asserts the right thing, F1 being the counter-example on a guard that was mutation-clean throughout. story-11-5 27 arms to 44/44; branch-transfer-valuation 10/10; edge-permanent-error-parity 4/4; schema-drift 171/171; the four fixture suites unchanged at 19/24/31/19; FULL SUITE 2099/2099, 0 failures; tsc, eslint and prettier clean; migrate idempotent twice. Status returned to done. UNCOMMITTED. |
