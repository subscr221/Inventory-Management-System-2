# Opening Stock Import Template v1

This document is the contract the migration lead hands to a site before its opening stock is
loaded into the staging environment (Story 13.1, FR-DM-01, SM-48). It covers the file header, one
worked example per stock class, the rejection codes with their `details` keys, and the four-stage
model with the story that owns each transition.

## 1. Header Contract

The file is UTF-8 CSV (RFC 4180: quoted fields, doubled quotes inside quotes, CRLF or LF, an
optional byte-order mark). The first line is the header and must match the following text exactly
after trimming, in this order:

```text
site_code,location_code,sku,lot_number,serial_number,quantity,uom,stock_class,unit_cost,expiry_date,counted_on,pv_ref_ext,pv_line_ref_ext
```

A file whose header differs in any way is refused whole with `TEMPLATE_VERSION_UNSUPPORTED` and the
response carries `details.expected_header` and `details.received_header`. Column order is the
version: a looser match is how a cost column ends up read as a quantity. A future template is a
new version constant, never a relaxation of this one.

Table 1 defines each column.

Table 1: Template v1 columns

| Column | Required | Rule |
|---|---|---|
| `site_code` | yes | Must equal the `location_code` of the site named by the request `site_id` |
| `location_code` | yes | An active bin of that site |
| `sku` | yes | An active item in the item master |
| `lot_number` | conditional | Non-empty if and only if the item is lot-controlled |
| `serial_number` | conditional | Non-empty if and only if the item is serial-controlled; such a row carries quantity `1` |
| `quantity` | yes | Positive decimal, up to 12 integer and 6 fraction digits, no sign, no thousands separators |
| `uom` | yes | Must equal the item master unit of measure |
| `stock_class` | yes | One of the platform stock classes: `owned`, `consignment`, `vmi`, `job_work`, `prototype`, `offcut` |
| `unit_cost` | conditional | Mandatory non-negative decimal for `owned`; for any other class it is recorded as a declared cost and never valued |
| `expiry_date` | optional | `YYYY-MM-DD`; written to the lot register when the item is lot-controlled |
| `counted_on` | yes | `YYYY-MM-DD`, the physical-count date, not after the import date |
| `pv_ref_ext` | yes | The physical-verification sheet or legacy count reference (external text) |
| `pv_line_ref_ext` | optional | The line on that sheet |

The request body around the file is JSON: `site_id`, `file_name`, `template_version` (`v1`),
`mode` (`initial` or `correction`), `csv` (the file as a string) and a mandatory
`idempotency_key`. A file is capped at 10,000 data rows and the request at 10 MB; either limit is
refused with `PAYLOAD_TOO_LARGE` and both caps appear in `details`.

## 2. Worked Examples

Table 2 shows one valid row per stock class. Dates are illustrative; use the real count date.

Table 2: One row per stock class

| Class | Row |
|---|---|
| owned, lot-controlled | `PLANT-A,BIN-A01,RM-COIL-2MM,LOT-2409-017,,1250.000000,KG,owned,84.5000,2027-03-31,2026-09-08,PV-SHEET-12,7` |
| owned, serial-controlled | `PLANT-A,BIN-A07,MTR-7.5KW,,SN-88231,1,EA,owned,18500.0000,,2026-09-08,PV-SHEET-14,2` |
| owned, plain | `PLANT-A,BIN-A02,PKG-CARTON-L,,,400.000000,EA,owned,12.2500,,2026-09-08,PV-SHEET-12,19` |
| consignment | `PLANT-A,BIN-C01,FAST-M8-BOLT,LOT-SUP-441,,5000.000000,EA,consignment,,2028-01-31,2026-09-08,PV-SHEET-15,1` |
| vmi | `PLANT-A,BIN-C02,WELD-WIRE-1.2,LOT-VMI-09,,180.000000,KG,vmi,,,2026-09-08,PV-SHEET-15,4` |
| job_work | `PLANT-A,BIN-J01,CUST-SHEET-3MM,LOT-CUST-2201,,320.000000,KG,job_work,61.0000,,2026-09-08,PV-SHEET-16,1` |
| offcut | `PLANT-A,BIN-J02,CUST-SHEET-3MM,LOT-CUST-2201-OFF,,14.500000,KG,offcut,,,2026-09-08,PV-SHEET-16,2` |
| prototype | `PLANT-A,BIN-R01,PROTO-BRKT-V3,,,6.000000,EA,prototype,,,2026-09-08,PV-SHEET-17,1` |

For every class other than `owned` the `unit_cost` cell, when present, is stored as
`declared_unit_cost` and the row is posted at zero value: customer-owned (`job_work`, `offcut`) and
supplier-owned (`consignment`, `vmi`) material is not the company's inventory under Ind AS 2, and
the valuation ledger already ignores it. `prototype` rows are posted quantity-only as well.

## 3. Row Outcomes and Rejection Codes

Every data row ends in exactly one of three outcomes: accepted (a staging row is written),
suppressed (an identical row was already loaded, reported as `DUPLICATE_EVENT` and counted, never a
rejection), or rejected. Rejections are returned in the import response and stored on the
rejected-row report (`GET /api/v1/migration/opening-stock/imports/{load_id}`) with the source line
number and the raw line. Checks run in the order of Table 3 and the first failure decides the code.

Table 3: Rejection codes and their details keys

| Order | Code | Cause | `details` keys |
|---|---|---|---|
| 1 | `MALFORMED_ROW` | Unbalanced quotes, wrong cell count, or a cell that does not parse | `column` (null for a whole-row fault), `reason` |
| 2 | `UNKNOWN_REFERENCE` | Site code, bin, sku or unit of measure does not resolve | `reference`, `value`, `expected` where applicable |
| 3 | `MALFORMED_ROW` | Lot or serial presence contradicts the item flags; a serial row not at quantity 1; an `owned` row with no cost | `column`, `reason` |
| 4 | `DUPLICATE_LOT_SERIAL` | The same bin, sku, lot and serial appears earlier in the file, or the same serial appears anywhere in the file for the sku | `first_line_no`, `scope` |
| 5 | `DUPLICATE_LOT_SERIAL` | A differing row is already loaded on that grain (initial mode), or the serial is already loaded elsewhere | `existing_row_id`, `existing_status`, `scope` |

Suppressed rows are listed separately with their `line_no` and the `existing_event_id` of the row
already loaded.

## 4. Import Modes and Re-submission

The row identity is the SHA-256 of its normalised cells. Re-submitting a file after a partial
failure therefore never duplicates a row: every row already loaded is suppressed and only new or
corrected rows apply. The two modes decide what a differing row on an already-loaded grain means.

- `initial`: a differing row on a live grain is a rejection (`DUPLICATE_LOT_SERIAL`). Use this for
  every first load and for re-submitting the same file.
- `correction`: a differing row supersedes the live row on the same grain. The old row keeps its
  history with status `superseded` and the new row becomes the live one. Use this only for a file
  the site has re-verified.

A row whose content exactly matches a row that was later superseded is still suppressed, because
its identity already exists; to restore an earlier value, re-submit it in correction mode with a
distinguishing `pv_line_ref_ext` or `counted_on`.

## 5. Variance Report and Explanations

`GET /api/v1/migration/opening-stock/variances?site_id=` compares the live staging rows against the
latest ERP and legacy balance snapshots pushed through the ERP sync trigger and lists every
difference with a deterministic `variance_key` of the form
`{source_system}|{location_code}|{sku}|{lot or -}|{serial or -}`. Table 4 lists the variance kinds.

Table 4: Variance kinds

| Kind | Meaning |
|---|---|
| `missing_in_import` | The source holds a balance the file did not |
| `missing_in_source` | The file holds a balance the source did not |
| `quantity_mismatch` | Both sides hold the grain at different quantities |
| `serial_missing_in_source` | A serial was counted but the source does not list it |
| `serial_missing_in_import` | The source lists a serial that was not counted |
| `unmapped_source_row` | A source row whose site, bin or sku does not exist on the platform |

`variance_value` is `quantity_delta` times the unit cost and is exactly `0` for customer-owned and
supplier-owned classes. The approval band, however, is computed on the unsigned quantity times cost
regardless of class, so a customer-owned variance still needs a signature at the appropriate
authority; a variance with no known cost is banded at the lowest band.

A variance is resolved either by a corrected import row that removes it, or by an explanation
(`POST .../variances/explanations` naming the variance keys, a cause code and a narrative) that a
finance controller approves through their own session. The approver is resolved from the DOA
registry (transaction type `migration.variance_explanation`) and frozen on the explanation; the
person who wrote the explanation can never approve it (`EXPLAINER_CANNOT_APPROVE`). An explanation
approved for one quantity delta becomes `stale` if the delta later changes, and the gate blocks
again.

## 6. Stage Model

Table 5 lists the stages the opening-stock domain of a site passes through and the story that owns
each transition.

Table 5: Stages and owning stories

| Transition | Owner | Gate |
|---|---|---|
| (none) to `staging` | Story 13.1 | First accepted import row |
| `staging` to `dry_run` | Story 13.1 | `POST /api/v1/migration/opening-stock/promote`; refused with `VARIANCE_UNRESOLVED` while any variance is not `explained`, with `NOTHING_TO_PROMOTE` when no accepted rows exist, with `STAGE_LOCKED` when already promoted |
| `dry_run` to go-live | Story 13.3 | Department-head and finance sign-off across every migrated domain |
| Other domains (`active_boms`, `open_pos`, `jobwork_challans`, `custody_registers`) | Story 13.2 | Same stage table, one row per domain |

Promotion posts every accepted row into the live ledger in one transaction: stock balances by bin,
lot and class; the lot and serial registers; cost layers for `owned` rows by the item's valuation
method; and one lot-genealogy origin row per lot pointing at the load event that created it. After
promotion the site takes no further opening-stock files in either mode.

Reverse promotion is not supported. A site promoted in error is restored by rebuilding the staging
environment, which is defined as a disposable single-node deployment, and re-importing.

## 7. Deployment Prerequisites

Before the first import at a site the following must be provisioned through SCIM and the DOA
registry.

1. A `migration_lead` with a `migration` write assignment for the site (or all sites).
2. A `finance_controller` with a `migration` read assignment for the site, who is a different
   person from every migration lead.
3. One active DOA band for `migration.variance_explanation` on role `finance_controller` with
   `value_min` set to `0` and an open `value_max`. Never seed a band with a null `value_min`.
4. The ERP and legacy balance snapshots pushed through `POST /api/v1/erp/sync` as
   `stock_balances`, each row carrying its `snapshot_at` cut-off instant.

`npm run verify:roles` checks the migration-lead and finance-controller separation at provisioning
time, before a single variance exists.
