# 3.5 Warehouse Management

- **FR-W-01 - Warehouse Configuration:** Define warehouse structure - sites, zones, aisles, racks, bins - with configurable attributes (temperature zones, hazardous material zones, quarantine zones).
- **FR-W-02 - Receiving:** Receive inbound shipments against ASNs (Advanced Shipping Notices) or purchase orders. Capture lot/serial numbers, expiry dates, and quality inspection results at receipt. Generate putaway tasks.
- **FR-W-03 - Putaway:** System-directed putaway based on item characteristics (velocity, size, temperature requirements), zone capacity, and configurable rules. Support both directed and user-selected putaway.
- **FR-W-04 - Picking:** Generate pick tasks with optimized pick paths. Support multiple picking strategies: single-order picking, batch picking, wave picking, zone picking. Paper-based and mobile-device-directed workflows.
- **FR-W-05 - Packing:** Packing station workflow - scan items, system validates against order, capture weights and dimensions, generate shipping labels and packing slips. Support cartonization (suggesting optimal box sizes).
- **FR-W-06 - Shipping:** Generate shipping documents (BOL, commercial invoice, customs documents). Carrier rate shopping and label generation. Load planning and truck manifest creation.
- **FR-W-07 - Task Management:** Generate, assign, prioritize, and track warehouse tasks (receiving, putaway, picking, replenishment, cycle count). Monitor task completion rates and worker productivity.
- **FR-W-08 - Replenishment:** Trigger replenishment of forward-pick locations from reserve storage based on min/max levels or demand-driven signals.
- **FR-W-09 - Cross-Docking:** Support flow-through and distribution cross-docking where inbound goods are immediately staged for outbound shipment without putaway.
