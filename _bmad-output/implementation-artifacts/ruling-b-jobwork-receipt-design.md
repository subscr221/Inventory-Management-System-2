# Ruling B - Job-Work Material Receipt Without a Purchase Order

Date: 2026-09-21. Status: design for the owner ruling that customer-owned job-work material is
received against the job-work order plus the customer challan, with no purchase order and with
the weighbridge optional.

## Finding

Story 9.2 already receives customer material through the normal GRN flow: `goods.received` with
`stock_class: 'job_work'`, `service_order_id` and the inbound challan, which posts `job_work`
stock, the GRN line, the putaway task and a nested `jobwork.material_received` custody event. The
only blockers are in the GRN shell: `po_ref_ext`, a matching purchase-order line and an accepted
weighbridge token are mandatory for every `goods.received`. No parallel pipeline is needed.

## Chosen Shape

`goods.received` (stream `receiving`, route `POST /api/v1/grn-lines`) gains a third
`source_document` kind, `JOBWORK_CHALLAN`. No new event type, stream or route. On this kind the
purchase-order steps (PO lookup, SKU to PO line match, PO tolerance band, PO price default) are
skipped and the order plus challan take their place. Every step after that is the unchanged
Story 3.4 and 9.2 code. `PO` and `ASN` receipts run exactly the code they ran before.

## Payload Contract

Table 1 lists the `JOBWORK_CHALLAN` payload fields that differ from a `PO` receipt; all other
`goods.received` fields keep their meaning.

Table 1: JOBWORK_CHALLAN payload differences

| Field | Rule |
| --- | --- |
| `source_document` | `'JOBWORK_CHALLAN'` |
| `stock_class` | must be `'job_work'` |
| `service_order_id` | required UUID; the job-work order |
| `challan_number_ext`, `challan_date` | required; date is `YYYY-MM-DD` |
| `challan_qty` | required, positive (existing Story 9.2 variance base) |
| `po_ref_ext`, `line_no`, `unit_cost` | must be absent |
| `cross_dock` | must not be `true` |
| `lot_id` | optional customer lot or heat number; part of the duplicate key |
| `correlation_id` | optional weighbridge ticket; never defaulted from the envelope |
| `received_qty`, `sku`, target location | unchanged, required |

## Validations and Refusal Codes

Table 2 lists each refusal on the new kind. The last five codes are new.

Table 2: Refusals for a JOBWORK_CHALLAN receipt

| Condition | Code |
| --- | --- |
| order id or challan number, date, quantity missing | 409 `SOURCE_DOCUMENT_REQUIRED` |
| order unknown, draft, closed, or at another site | 409 `SOURCE_DOCUMENT_REQUIRED` |
| `stock_class` not `job_work`, a PO field or `unit_cost` supplied, `cross_dock` true | 400 `INVALID_PARAMS` |
| SKU is not a customer-supplied line of the order kit BOM | 409 `KIT_LINE_MISMATCH` |
| ticket supplied but unknown | 404 `RECEIVING_BINDING_TOKEN_NOT_FOUND` |
| ticket supplied but no accepted weighment | 409 `RECEIVING_WEIGHT_NOT_ACCEPTED` |
| actor's location is not at the order site | 403 `LOCATION_ACCESS_DENIED` |
| actor lacks the receiving role | 403 `FUNCTION_ACCESS_DENIED` |
| ticket at another site than the order | 409 `SOURCE_DOCUMENT_REQUIRED` |
| challan already received for this customer, SKU and lot | 409 `JOBWORK_CHALLAN_DUPLICATE` (new) |
| supplied ticket is bound to a purchase order | 409 `RECEIVING_TICKET_PO_BOUND` (new) |
| GRN id exists with another kind, PO, site or order | 409 `GRN_HEADER_MISMATCH` (new, all kinds) |
| same idempotency key, different submission | 409 `IDEMPOTENCY_KEY_CONFLICT` (new on this route) |
| linking a challan GRN to a purchase order | 409 `GRN_NOT_PO_RECEIPT` (new) |
| order has no kit BOM and `JOBWORK_RECEIPT_ALLOW_NO_KIT_BOM` is not `true` | 409 `JOBWORK_ORDER_KIT_BOM_REQUIRED` (new) |

- Expected materials: a service order carries no material lines or quantities. It carries a kit
  BOM, mandatory at confirmation. The expected items are the non-placeholder kit lines whose
  `supply_source` is `customer` or untagged, the same `kitLineMatchesConsumption` rule custody
  consumption uses. An order with no kit BOM at all (only possible for an order migrated in
  already confirmed, as the rehearsal mock pack seeds them) names no expected items. Owner ruling
  2026-09-22: such a receipt is refused in production and allowed on the pilot. The config knob
  `JOBWORK_RECEIPT_ALLOW_NO_KIT_BOM` (default `false`, refuse) is read on the seam both doors
  pass through; staging sets it `true`, and then the item check is skipped for such an order and
  the item need only be an active item master record.
- Over-receipt: the order has no expected quantity, so the purchase-order band cannot apply. The
  existing job-work rule stands: received versus challan quantity is recorded as a signed variance
  and flagged beyond `config.jobwork.receiptTolerancePercent`. It flags and does not refuse.
- Duplicate challan: one receipt per customer party, challan number (trimmed, case-insensitive),
  SKU and lot. A challan may list several SKUs and several lots of one SKU, one GRN line each.
  The lot is the resolved lot number: the payload `lot_id` (the customer lot or heat number the
  clerk keys) or the lot the existing helpers auto-resolve, which is what
  `jobwork_material_receipt.lot_id` stores. A non-lot item compares as no lot. Checked under an
  advisory lock on customer plus challan, against custody receipts from either receiving path and
  enforced on both, so one paper challan cannot enter once through each.
- GRN header: a header is written by its first line and never overwritten, so a later line whose
  source document, purchase order, site or (for this kind) service order differs is refused.
- Idempotent replay: the same `idempotency_key` with the same submission returns the original
  result (REST answers 200 with `replayed: true`, also for a racing retry that re-sends the same
  ids); the same key with a different submission is a conflict. Resolved before the duplicate
  check can fire. The purchase-order path's replay behaviour is unchanged.
- Resolved by owner ruling 2026-09-22: an order with no kit BOM is refused
  `JOBWORK_ORDER_KIT_BOM_REQUIRED` unless `JOBWORK_RECEIPT_ALLOW_NO_KIT_BOM=true`, which staging
  sets for the pilot's migrated orders; with it, the expected-item check is skipped for such an
  order and any active item can be received against it.

## Ownership and Valuation

Stock posts as `stock_class = 'job_work'`; the owner (`owner_party_code`, equal to the order's
customer) is verified by the existing `assertJobworkReceiptOwnership` gate and recorded on the
custody ledger's opening row (`ownership = 'customer'`). The valuation seam skips every
non-owned class and no `unit_cost` is derived, so `inventory_valuation` is untouched.
`DISPATCH_STOCK_NOT_OWNED` and the custody ledger keep working because the class is unchanged.

## Downstream

Identical to a purchase-order GRN: lot auto-create, QC-hold routing to `ZONE-QC-HOLD` for
quarantine or BIS items, a `ready` or `held` putaway task, plus the Story 9.2 custody receipt,
ledger row, Section 143 return clock and the first-receipt move to `in_process`.

## Schema

One forward migration, `read/projections/grn_jobwork_challan.sql`, appended at the tail of
`src/events/migrate.ts`: widens `chk_grn_source_document`, makes `grn.po_ref_ext`,
`grn.correlation_id`, `grn_line.po_ref_ext`, `grn_line.line_no` and
`grn_line.weighbridge_correlation_id` nullable, and adds checks so only a `JOBWORK_CHALLAN` header
or a `job_work` line may omit them. It is guarded by constraint name to run once, and mirrored at
the tail of `deploy/compose/init-db.sql` with a schema-drift test pinning the mirror.

## RBAC, Site Scope and Edge

Same as a purchase-order GRN: module `receiving`, scope `write`, role `store_assistant` on the
route. With no weighbridge token to name the site, the site is the order's site. The route checks
the write location coverage from `src/middleware/rbac.ts` and the seam calls `assertActorAtSite`,
so the events door and the edge get the same refusal. The event is not central-only, matching
the purchase-order GRN, which the edge accepts today.

## Out of Scope

Gate entry and the weighbridge still require a PO reference to issue a ticket; a job-work vehicle
simply skips them, and because every ticket issued today is bound to a purchase order, a supplied
ticket is refused: challan receipts are ticketless until the gate and weighbridge support
job-work. A ticketless receipt stores no GRN correlation id, so the gate-dwell view never joins a
caller-chosen value. No UI work. Three-way match never sees these lines, enforced twice: the
`grn.po_linked` seam refuses to bind a challan GRN to a purchase order, and the match sum excludes
challan GRNs and `job_work` lines. The supplier scorecard needs a linked GRN, so it is covered by
the same refusal. No
mock-pack smoke step was added: the pack seeds job-work orders directly in SQL but the operations
layer has no job-work actor or step to extend.
