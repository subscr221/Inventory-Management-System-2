# Document Manifest Templates v1

This document is the migration lead's contract for the four document-domain manifests that Story
13.2 verifies before the pilot go-live gate (FR-DM-02): active BOMs, open purchase orders, job-work
challans and custody registers. It is the companion of
[Opening Stock Import Template v1](opening-stock-template-v1.md), which owns the opening-stock
domain and the stage model.

## 1. What a Manifest Is

Migration execution belongs to the module epics: a legacy kit becomes a `bom` row through the BOM
legacy-kit route, an open purchase order enters as an ERP reference projection, a challan becomes
a job-work material receipt with its statutory return clock, and a custody register is the
customer-ownership balance of the custody ledger. A manifest is the source side of that picture:
the legacy extract listing what should be in the platform. The verification run compares the
manifest with the platform and produces the report the department head signs off. A manifest is
never posted anywhere.

Each manifest travels as a UTF-8 CSV string in the JSON body of
`POST /api/v1/migration/documents/imports`, with `site_id`, `domain`, `file_name`,
`template_version` (`v1`), `csv` and a mandatory `idempotency_key`. The 10,000-row cap and the
10 MB body cap of the opening-stock import apply unchanged. The first column of every template is
`site_code`, and it is the only reference resolved at import: a row whose `site_code` is not the
request's site is rejected with `UNKNOWN_REFERENCE`. Every other reference is resolved by the
verification run so that a document the platform lacks is reported, not silently dropped.

## 2. Header Contracts

Table 1 lists the four v1 headers. Column order and names are the version; a file whose trimmed
header does not match byte-for-byte is refused whole with `TEMPLATE_VERSION_UNSUPPORTED` and
`details.expected_header`.

| Domain | Header |
|---|---|
| `active_boms` | `site_code,kit_ref,parent_sku,revision_code,component_sku,quantity_per,line_uom` |
| `open_pos` | `site_code,po_number_ext,line_no,sku,supplier_ref_ext,ordered_qty,received_qty,open_qty,over_receipt_tolerance_pct,under_receipt_tolerance_pct` |
| `jobwork_challans` | `site_code,challan_number_ext,challan_date,order_number_ext,customer_party_code,sku,challan_qty,uom,challan_class` |
| `custody_registers` | `site_code,order_number_ext,customer_party_code,sku,custody_qty,uom` |

Table 2 lists the match keys and one worked row per domain.

| Domain | Document key | Line key | Worked row |
|---|---|---|---|
| `active_boms` | `kit_ref` | `component_sku` | `PILOT,KIT-0451,FG-PUMP-12,R1,RM-SHAFT-8,3,EA` |
| `open_pos` | `po_number_ext` | `line_no` | `PILOT,PO-2026-00817,1,RM-SHAFT-8,SUP-ACME,100,40,60,5,5` |
| `jobwork_challans` | `challan_number_ext` | `order_number_ext` and `sku` | `PILOT,DC-2026-113,2026-08-12,JW-0091,ACME,RM-SHEET-2,1000,KG,input` |
| `custody_registers` | `order_number_ext` | `sku` | `PILOT,JW-0091,ACME,RM-SHEET-2,1300,KG` |

Rules per template:

1. `active_boms`: one row per kit component. `quantity_per` is a positive NUMERIC string,
   `revision_code` is optional. The platform side is the `bom` row with `origin = 'legacy_kit'`
   and the same `kit_ref`, compared on its current revision.
2. `open_pos`: one row per PO line. `line_no` is a positive integer; the three quantities are
   NUMERIC strings; both tolerance columns may be empty, and an empty cell equals a null on the
   ERP projection. `received_qty` is compared with the projection's `ordered_qty - open_qty`.
3. `jobwork_challans`: one row per challan line. `challan_date` is ISO `YYYY-MM-DD` and is the
   date the statutory return clock runs from; `challan_class` is `input` or `capital_goods`.
4. `custody_registers`: one row per order and sku. `custody_qty` is the customer-owned balance
   the platform must hold (receipts less consumption, returns, losses and offcuts).

## 3. Row Outcomes

Table 3 lists the import outcomes. Rejected rows never block accepted rows and are listed on
`GET /api/v1/migration/documents/imports/:load_id` with their line number and raw text.

| Outcome | `error_code` | `details` keys |
|---|---|---|
| Wrong cell count or a typed cell that does not parse | `MALFORMED_ROW` | `column`, `reason` (`cell_count`, `empty`, `not_numeric`, `not_positive_numeric`, `not_positive_integer`, `not_iso_date`, `unknown_class`) |
| Same document and line key seen earlier in the file | `MALFORMED_ROW` | `reason: duplicate_manifest_key`, `first_line_no` |
| `site_code` is not the request's site | `UNKNOWN_REFERENCE` | `reference: site_code`, `value`, `expected` |
| Identical file already loaded for the site and domain | replay, HTTP 200 | `replayed: true`, `existing_event_id` |

A differing file for the same site and domain is a new load and becomes the latest manifest;
earlier loads stay queryable by `load_id` and are never deleted.

## 4. Verification Run and Findings

`POST /api/v1/migration/domains/:domain/verification-runs` with `site_id` and an
`idempotency_key` compares the latest manifest with the platform and records a run with
`source_count`, `migrated_count`, `quarantined_count` and `mismatch_count`. Without a manifest the
run is refused with `MANIFEST_REQUIRED`. Table 4 lists the finding kinds.

| Kind | `error_code` | Meaning | Waivable |
|---|---|---|---|
| `unknown_reference` | `UNKNOWN_REFERENCE` | The platform document's item, location, lot, GRN line or service order does not resolve. The document is quarantined and does not count as migrated. | No |
| `missing_in_platform` | `RECONCILIATION_MISMATCH` | A manifest document with no platform counterpart. | Yes |
| `missing_in_source` | `RECONCILIATION_MISMATCH` | A platform document absent from the manifest. | Yes |
| `field_mismatch` | `RECONCILIATION_MISMATCH` | A compared field differs; `field`, `source_value` and `platform_value` name it. | Yes |
| `state_mismatch` | `RECONCILIATION_MISMATCH` | A BOM that is not released or is flagged for remediation, or a challan without its return clock at the legacy date. | Yes |

`migrated_count` counts manifest documents that matched with no finding of any kind. `bom` and
the ERP purchase-order projection carry no site, so `missing_in_source` for `active_boms` and
`open_pos` is enterprise-wide unless the run body names a `document_ref_prefix`; a pilot site with
one legacy system needs none.

The report is read from `GET /api/v1/migration/domains/:domain/verification-runs/:run_id`, paged
and filterable by `kind` and `status`.

## 5. Department-Head Sign-Off

`POST /api/v1/migration/domains/:domain/sign-off` with `site_id`, `run_id`, `waivers` and an
`idempotency_key` records the per-domain sign-off. Table 5 lists who may sign which domain: the
signer holds the `department_head` role on a write assignment for the domain's module at the site
(or `*`), plus a read assignment on module `migration` to read the report.

| Domain | Module of the signing assignment |
|---|---|
| `active_boms` | `engineering` |
| `open_pos` | `procurement` |
| `jobwork_challans` | `jobwork` |
| `custody_registers` | `jobwork` |

Sign-off rules, enforced in the route and again inside the event applier:

1. Only the latest run of the latest manifest can be signed (`VERIFICATION_STALE`).
2. A run with any quarantined document cannot be signed (`VERIFICATION_UNRESOLVED` with
   `details.quarantined`); the reference is fixed at source and the domain re-run.
3. Every other open finding must be waived in the body with a narrative of at most 2,000
   characters (`VERIFICATION_UNRESOLVED` with `details.unwaived`).
4. The signer must not be the actor who ran the verification nor the actor who loaded the
   manifest (`SIGNOFF_ACTOR_CONFLICT`, SOD-07); `migration_lead` is never a signing role, and the
   provisioning check `npm run verify:roles` refuses one person holding both hats.

## 6. Verification Status

`GET /api/v1/migration/domains?site_id=` reports each domain as `verified` or `unverified`. A
domain is `verified` if and only if a sign-off exists for the latest run of the latest manifest
load. Any later manifest load or verification run reverts it to `unverified` until signed again.
Story 13.3's go-live gate consumes this status; `opening_stock` is gated by its own variance
report and promotion, described in the opening-stock template document.
