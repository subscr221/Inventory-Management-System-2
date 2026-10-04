# Data Request for CMF-ALIGARH

## What We Need and Why

The new inventory system starts its trial at CMF-ALIGARH soon. Before the trial, the system must
be loaded with what the site holds today, and it checks every figure against your records. For
that we need five files from your current system and registers.

Please send a first version as early as you can, even if it is not perfect. We use the first
version for a practice run. A final version, taken on the day stock movement is frozen, replaces
it later.

## How to Prepare the Files

1. One file per section below, saved as CSV (in Excel: Save As, CSV UTF-8).
2. The first row must be the column names exactly as written here, in the same order.
3. Write `CMF-ALIGARH` in the `site_code` column of every row.
4. Dates are written year first: `2026-09-20`.
5. Numbers have no commas and no unit: write `1250.5`, not `1,250.5 kg`.
6. Leave a cell empty when it does not apply. Do not write `NA` or `-`.
7. If you are unsure about a row, include it anyway and tell us. A missing row is harder to find
   than a doubtful one.

## File 1: Opening Stock

Everything physically in the store, from the latest physical count. One row for each combination
of bin, item, lot and serial number. Table 1 lists the columns.

Table 1: Opening stock columns

| Column | What to write |
| --- | --- |
| `site_code` | `CMF-ALIGARH` |
| `location_code` | The bin or rack where the stock sits |
| `sku` | The item code |
| `lot_number` | The lot or batch number, only for items tracked by lot |
| `serial_number` | The serial number, only for items tracked by serial; such a row has quantity 1 |
| `quantity` | The counted quantity |
| `uom` | The unit the item is kept in, for example `KG` or `EA` |
| `stock_class` | One of `owned`, `consignment`, `vmi`, `job_work`, `prototype`, `offcut` |
| `unit_cost` | Cost per unit; required for `owned` stock |
| `expiry_date` | Only if the lot has an expiry date |
| `counted_on` | The date of the physical count |
| `pv_ref_ext` | The count sheet number |
| `pv_line_ref_ext` | The line on that sheet, if you have it |

Example row:

```text
CMF-ALIGARH,BIN-A01,RM-COIL-2MM,LOT-2409-017,,1250.000000,KG,owned,84.5000,2027-03-31,2026-09-08,PV-SHEET-12,7
```

We also need, as a separate sheet in any layout, the stock balance your present system shows for
the same date. The new system compares the two and lists every difference for explanation.

## File 2: Active Kits and Bills of Material

Every product recipe in current use. One row per component. Table 2 lists the columns.

Table 2: Bill of material columns

| Column | What to write |
| --- | --- |
| `site_code` | `CMF-ALIGARH` |
| `kit_ref` | Your reference number for the kit or bill of material |
| `parent_sku` | The item that is made |
| `revision_code` | The revision, if you keep one |
| `component_sku` | The item that goes into it |
| `quantity_per` | How much of the component one parent needs |
| `line_uom` | The unit of that quantity |

Example row:

```text
CMF-ALIGARH,KIT-0451,FG-PUMP-12,R1,RM-SHAFT-8,3,EA
```

## File 3: Open Purchase Orders

Every purchase order line that is not fully received. Table 3 lists the columns.

Table 3: Open purchase order columns

| Column | What to write |
| --- | --- |
| `site_code` | `CMF-ALIGARH` |
| `po_number_ext` | The purchase order number |
| `line_no` | The line number on the order |
| `sku` | The item code |
| `supplier_ref_ext` | The supplier code |
| `ordered_qty` | Quantity ordered |
| `received_qty` | Quantity received so far |
| `open_qty` | Quantity still to come |
| `over_receipt_tolerance_pct` | Allowed excess in percent, if agreed |
| `under_receipt_tolerance_pct` | Allowed shortfall in percent, if agreed |

Example row:

```text
CMF-ALIGARH,PO-2026-00817,1,RM-SHAFT-8,SUP-ACME,100,40,60,5,5
```

## File 4: Job-Work Challans

Every challan under which customer material is at the site now. One row per challan and item.
Table 4 lists the columns.

Table 4: Job-work challan columns

| Column | What to write |
| --- | --- |
| `site_code` | `CMF-ALIGARH` |
| `challan_number_ext` | The challan number |
| `challan_date` | The date on the challan; the legal return period runs from this date |
| `order_number_ext` | The job-work order number |
| `customer_party_code` | The customer code |
| `sku` | The item code |
| `challan_qty` | Quantity on the challan |
| `uom` | The unit |
| `challan_class` | `input` for material to be processed, `capital_goods` for tools and dies |

Example row:

```text
CMF-ALIGARH,DC-2026-113,2026-08-12,JW-0091,ACME,RM-SHEET-2,1000,KG,input
```

## File 5: Customer Material Held

For each job-work order and item, how much customer-owned material the site holds today: what
was received, less what was used, returned, lost or turned into offcuts. Table 5 lists the
columns.

Table 5: Custody register columns

| Column | What to write |
| --- | --- |
| `site_code` | `CMF-ALIGARH` |
| `order_number_ext` | The job-work order number |
| `customer_party_code` | The customer code |
| `sku` | The item code |
| `custody_qty` | The balance held for that customer |
| `uom` | The unit |

Example row:

```text
CMF-ALIGARH,JW-0091,ACME,RM-SHEET-2,1300,KG
```

## Two Questions for the Person Who Runs the Present System

1. Who can pause the regular data feed from the present system for about two hours on the
   go-live day, and how is it paused?
2. Roughly how many rows will each of the five files have? An estimate is enough.

## Where to Send

Send the files and the two answers to the migration lead, Gagan Kumar, at
[info@ancorlabs.org](mailto:info@ancorlabs.org).
