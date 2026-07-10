# 3.4 Order Management and Fulfillment

- **FR-O-01 - Order Capture:** Accept orders from multiple channels - manual entry, EDI, e-commerce platform integration, internal requisitions, and inter-branch orders.
- **FR-O-02 - Order Validation:** Validate orders for completeness (customer, items, quantities, pricing), credit limits, and inventory availability at the time of entry.
- **FR-O-03 - Order Routing and Fulfillment Location Assignment:** Intelligently route orders to the optimal fulfillment location based on configurable rules: inventory availability, proximity to customer, workload balancing, shipping cost, and item sourcing constraints.
- **FR-O-04 - Split Shipments:** Support splitting a single order across multiple fulfillment locations when one location cannot fulfill the entire order, with partial shipment tracking and customer communication.
- **FR-O-05 - Backorder Management:** Track backordered items, automatically allocate incoming stock to backorders (configurable FIFO or priority-based), and generate backorder fulfillment orders.
- **FR-O-06 - Order Status Tracking:** Real-time order status visibility (received, confirmed, allocated, picked, packed, shipped, delivered, returned) with timestamps and user attribution for each status transition.
- **FR-O-07 - Returns Management:** Process return authorizations (RMA), track returned goods receipt, inspect returned items, route for restock, repair, or disposal, and process refunds or replacements.
- **FR-O-08 - Drop Shipping:** Support drop-ship orders where the supplier ships directly to the customer. Track drop-ship POs linked to sales orders.
