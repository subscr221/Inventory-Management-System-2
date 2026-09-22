# Mock Rehearsal and Operations Pack

This folder builds a fictitious but complete site: the legacy extract with planted migration
defects, and an operations layer so that a pilot user can work a normal day right after go-live.
Nothing here touches platform source. All data is invented.

## What the Pack Contains

`generate.mjs` writes one pack per site code. The same `--seed` always gives the same pack. The
files are listed in Table 1.

Table 1: Pack files

| File | Purpose |
| --- | --- |
| `opening_stock.csv`, `active_boms.csv`, `open_pos.csv`, `jobwork_challans.csv`, `custody_registers.csv` | The five v1 migration files, with the 27 planted defects of `defects.json` |
| `expected-outcomes.json` | Answer sheet for the planted defects |
| `erp-sync-stock-balances.json` | ERP stock snapshot, the truth the opening stock is compared with |
| `erp-sync-purchase-orders.json` | One complete purchase-order snapshot, including the operations PO with open lines for a plain, a lot and a consignment item |
| `erp-sync-sales-orders.json` | One complete sales-order snapshot: six orders of two lines, sized far below the clean opening stock |
| `roles.json` | People and role assignments in the format of `src/cli/provision-roles.ts` |
| `world.json` | Platform side: items, location tree, legacy kits, service orders, people, and the `operations` block |

The `operations` block of `world.json` names the receiving dock, the QC-hold zone, the quarantine
bin, the putaway bin and the dispatch staging bin. It also lists the DOA entries, the maintenance
SLA policies, the assets with a meter each, the inspection plans, the ownership agreements, the
suppliers, and which person acts for each logical actor of the scripts.

The location tree follows the platform rule that a site holds zones, a zone holds aisles, an
aisle holds racks and a rack holds bins. It has a receiving zone (`RECV-DOCK`), the QC-hold zone
`ZONE-QC-HOLD` with quarantine bins, two storage zones that carry the ten stock bins and one empty
putaway bin, and a dispatch staging zone. Every bin has a pick sequence.

## Order of Commands for a Fresh Site

Run the steps of Table 2 in order. Local commands assume `--env-file=.env.test`; set `DB_PORT` in
the shell to point at your own database container, because an explicit variable wins over the file.

Table 2: Load sequence

| Step | Command | Result |
| --- | --- | --- |
| 1 | `node deploy/rehearsal/mock/generate.mjs --site-code <CODE> --seed <N> [--tag <RUN>] [--site-id <uuid>]` | Pack in `out/<CODE>` (or `--out <dir>`) |
| 2 | `node deploy/rehearsal/mock/seed.mjs --site-code <CODE> --actor-email <user> [--pack <dir>] [--dry-run]` | Site, location tree, items, PO projection, job-work receipts, custody; prints the site id |
| 3 | `npm run provision:roles -- <pack>/roles.json --apply` | People and roles (the file needs the real site id: regenerate with `--site-id`) |
| 4 | `node --import tsx deploy/rehearsal/mock/rehearse.ts --remote cfg.json --pack <dir> --through-unblock` | Migration flow through the go-live unblock |
| 5 | `node --import tsx deploy/rehearsal/mock/setup-operations.ts --remote ops.json --pack <dir>` | Everything of the operations block that has an API |
| 6 | `node deploy/rehearsal/mock/seed.mjs --site-code <CODE> --sales-order-ids > so-ids.json` | Dispatch-order ids for the remote smoke test |
| 7 | `node --import tsx deploy/rehearsal/mock/operations-smoke.ts --remote ops.json --pack <dir> --sales-order-ids so-ids.json` | PASS or FAIL table of one working day |

`roles.json` is complete on purpose. The provisioning CLI replaces a person's assignments, so the
migration grants that `rehearse.ts` needs are repeated in it. Nobody in it holds two of
`migration_lead`, `department_head`, `finance_controller` and `cfo`, which are the pairs the CLI
refuses. Three people are fictitious because the duty had no holder: `qchead1` (QC head),
`dispatch1` (dispatch clerk) and `notify1` (notification administrator).

## Local and Remote Mode

Local mode needs no preparation. `operations-smoke.ts` without arguments runs `rehearse.ts` for a
fresh run-scoped site, starts the app in-process, provisions the people of `roles.json` as
throwaway users, runs the setup and then the day. `--site-code MOCK-XXXX` reuses a site that is
already live, and `--seed` and `--lines` are passed on to the rehearsal. A run prints 35 lines:
8 setup steps, 1 lot check and 26 steps of the day, two of them expected refusals (a job-work
challan received twice, a pack naming a lot that was not picked). The seeded job-work orders
carry no kit BOM, so local mode sets `JOBWORK_RECEIPT_ALLOW_NO_KIT_BOM=true` before the app boots
unless the shell already set it; staging runs with the same setting.

Remote mode drives a deployed stack as the real people and provisions nobody. The config has the
shape of `remote.example.json`; see `ops-remote.example.json`. The `actors` map is optional here:
an actor that is not listed is the person named in `world.json`, with the password taken from the
environment variable named by `default_password_env`. A bad config is refused before any network
call. `--with-setup` makes the smoke test run the setup first. Every record is permanent, so each
remote smoke run uses up one sales order and a little stock; the pack ships six orders.

When the platform froze another person as approver, local mode grants that user the module and
acts as that user. Remote mode fails with the platform's own message, which names the user to map.

## What Goes Through the API and What Does Not

Created through the API by `setup-operations.ts`: the purchase-order and sales-order snapshots,
22 DOA entries, 8 maintenance SLA policies that cover priorities p1 to p4, 4 assets with a meter
each, 3 suppliers submitted and approved, ownership agreements for the consignment and VMI items
at both docks and every storage bin, and an approved inspection plan per finished good.

Written by direct SQL in `seed.mjs`, as the Story 13.2 integration test does: the site and the
location tree, the item master, the first PO projection (the rehearsal verifies open POs before
any operations actor exists), service orders, job-work receipts, return clocks and the custody
ledger. Lots need no seeding: the opening-stock promotion writes `lot_master` with the expiry
date, and the local smoke test checks that no lot balance is missing, held or expired.

## What Is Still Impossible and Why

1. A remote client cannot learn the dispatch-order id that pick generation needs. The sales-order
   list leaves the id out (`src/api/v1/erp-projections.ts:210`). Step 6 of Table 2 is the
   workaround and needs database access.
2. There is no route that lists DOA entries (`src/server.ts:540` onward has create, update, delegations and resolve only). The setup asks the resolve
   route whether a band already answers a transaction type.
3. The pick sequence of a bin has no API field (`src/api/v1/location-register.ts:135`), so the
   tree is seeded by SQL.
4. The QC-hold zone is the literal code `ZONE-QC-HOLD` (`src/compliance/receiving.ts:63`) and
   location codes are unique across the database. Only one site per database can own it. The
   seeder warns and skips the zone for a second site.
5. A location cannot be re-parented (`src/api/v1/location-register.ts:279` accepts no parent). A
   site that was seeded with the old flat bins keeps them, and pick generation refuses those bins
   (`src/warehouse/pick-task-generator.ts:222`). Load this pack into a restored database or under
   a new site code.
6. Both ERP snapshots are global. A sync closes every open order that the batch does not carry,
   for every site (`src/adapters/erp/sync.ts:664` and `:707`). Do not sync a mock snapshot into a
   database that holds real orders.
7. An approver is the oldest active holder of the role in the whole database
   (`src/read/projections/doa_registry.ts:298`), with no site scope. Keep one holder per approving
   role until that changes.
8. The historic job-work receipts of the extract stay in `seed.mjs`: they predate the site and
   carry no GRN of their own. A new receipt goes through the API as a `JOBWORK_CHALLAN` source on
   `/api/v1/grn-lines` (no purchase order, no ticket), which the smoke test exercises against the
   seeded order JW-MK-0001. The gate and the weighbridge still need a purchase-order reference, so
   a challan receipt is ticketless.
9. Calibration certificates and critical spare min-max are left out on purpose: the runbook
   forbids them in the pilot. The pack seeds no instrument and no spare.
