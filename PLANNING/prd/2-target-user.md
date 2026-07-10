# 2. Target User

## 2.1 Jobs To Be Done

- **Operational (frontline):** Log a vehicle, weigh a truck, put stock in a bin, raise an indent, issue a tool, close a work order, sell material at the hub counter, all in seconds, gloved, one-handed, offline if needed, without corrupting downstream data.
- **Operational (supervisory):** Release production orders against real availability, approve indents with budget visibility, disposition QC lots, decide scrap, chase overdue returns, without leaving the floor or waiting for month-end.
- **Managerial:** See accurate stock, spend, forecast, and asset health across all locations in one place; run procurement, tenders, fulfillment, and logistics on measured cycle times.
- **Financial and statutory:** Close periods with subledger-to-GL reconciliation, produce audit evidence (edit logs, physical verification packs, custody statements, Form 3CL feeds, CARO extracts) as by-products of operations rather than projects.
- **External:** Suppliers bid and acknowledge through a portal; auction buyers view lots and bid without touching internal data; statutory auditors read what they need without asking for extracts.

## 2.2 Non-Users (v1)

- Maker-hub members do not get self-service system access beyond machine booking touchpoints operated at the counter; membership plans and subscription billing stay in the membership system.
- End customers do not get an order-tracking portal in v1 (existing e-commerce platform covers this).
- The system does not serve shop-floor machine operators for scheduling or operator tracking (MES scope, excluded).

## 2.3 Key User Journeys

The four fully-worked frontline stories from the source document (§9.2) are carried here as the PRD's user journeys, keeping their source IDs. Personas are role-holders; roles are hats, not badges (one person may hold several).

- **UJ-GATE-01. A gate officer logs an inbound vehicle at 2am with the network down.**
  A truck arrives with a challan referencing a known PO. The gate security officer scans or keys the PO, confirms vehicle and challan details, and photographs the challan (mandatory when offline). The system creates a queued gate event stamped with time, gate ID, and officer ID and shows "captured, pending sync." Within 5 minutes of connectivity restoring, the event auto-reconciles to the matching ASN or PO; mismatches are flagged to the store assistant, never silently dropped. A vehicle with no matching PO is still captured as "unmatched" and routed to a named owner. Value moment: goods enter on a traceable record from the first second, even offline. Validates SM-13.

- **UJ-WEIGH-01. A weighbridge operator captures trusted weights.**
  With the truck bound to its PO or ASN, the operator records tare, then gross; net auto-calculates and is validated against tolerance. In-tolerance weights post to the goods-receipt event with accept status. Out-of-tolerance loads are flagged, blocked from silent receipt, and routed to a named owner (QC or receiving supervisor). Offline, readings queue locally with timestamp and device provenance and reconcile on reconnect with no re-entry. Validates SM-14.

- **UJ-PUT-01. A store assistant bends the slotting map to reality.**
  Directed putaway tells the assistant the bin; a scan of item and bin confirms hands-light (glove-friendly, one-handed). When stock physically goes to a different bin, the assistant scans the actual location and the system records a locator-override correction event with a reason code. The physical override becomes the authoritative location fact with provenance and confidence stamp; the expected value from the ASN is preserved, the conflict surfaced. Last-writer-wins is banned for location. Overrides feed the ABC re-slotting engine, so the assistant's knowledge improves everyone's directed bins. Validates SM-15 and the adoption loop NFR-ADOPT-01.

- **UJ-IND-01. A floor supervisor raises an indent and actually knows what happens to it.**
  With ninety seconds between tasks, the supervisor raises an indent from a phone. A duplicate within the open window triggers a warning before submission. The indent confirms with an ID in under 90 seconds; live status (raised, approved, rejected, ordered, expected delivery) is always visible in-app; the department head's decision arrives as a push notification with the reason. No chasing, no guessing, no raising it twice. Validates SM-16.

Twenty-nine further story stubs (DH-APPROVE-01 through QC-WITNESS-01) are catalogued in source §9.3 with a scored promotion rule; they are backlog inputs to UX and epics, not PRD journeys. `[ASSUMPTION: these four journeys are the complete PRD-blocking set; no stub is journey-critical.]`
