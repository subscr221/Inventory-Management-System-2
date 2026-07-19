# 89 Stories Explained in Simple Language (Grandmother Edition)

## EPIC 1: Building the Foundation (The Rulebook & Safety System)

**Story 1.1: Core Infrastructure** 
Think of this as building a strong house foundation. Before you can put furniture in, the house needs solid concrete, plumbing, and electricity. This story builds the computer system's "foundation" - the database where everything gets stored.

**Story 1.2: SSO Login**
Like a single key that opens your front door, back door, and garage. Instead of different passwords for different things, everyone gets ONE login (through Google, company system, etc.) that works everywhere.

**Story 1.3: Keeping an Official Record**
Imagine a notebook that records every single action someone takes - who did what, when, and why. AND nobody, not even the boss, can erase or change that notebook. It's for tax inspectors and auditors.

**Story 1.4: Who Can Approve What**
Like a rulebook that says: "The store manager can approve orders up to ₹50,000. The director can approve up to ₹1 crore." The system looks at this rulebook to decide who needs to say "yes" before something happens.

**Story 1.5: Tag Everything for Taxes**
Imagine sorting your receipts into folders: "Factory expenses," "Research costs," "Store sales." Every time someone records a transaction, they MUST put it in the right folder, or the system won't accept it.

**Story 1.6: Knowing Where Things Really Are**
When a warehouse worker says "I put this box in Bin A-43" but the plan said it should go to "Bin A-47," the system notices the difference and raises a flag instead of just accepting it. Like catching a mistake before it becomes a problem.

**Story 1.7: Broken Weighing Machines Get Blocked**
If the weighing machine hasn't been checked/certified in 6 months, it's blocked from use. Nobody can measure anything on an uncertified scale.

**Story 1.8: Working Without Internet**
The app works on tablets even when there's no internet. It stores everything locally and syncs later when connection comes back. Perfect for factories with bad WiFi.

**Story 1.9: Safety Tests Before Launch**
Before the system is considered "ready," 5 specific safety tests must pass: Edit log is tamper-proof, Approval rules work, Locations are tracked correctly, Broken scales are blocked, and everything is tagged.

**Story 1.10: Automatic Testing & Release**
Every time a developer writes code, automatic tests run to check if it's good. Like a quality inspector checking every batch before shipping.

**Story 1.11: Notifications & Alerts**
When something important happens ("Your approval is waiting," "Weighing machine needs calibration"), someone gets a notification. Could be email, SMS, or a pop-up.

---

## EPIC 2: Tracking Your Inventory (The Stock Counter)

**Story 2.1: Master List of All Items**
Like a catalog of everything you have - each item gets a unique code (SKU), name, and location. "Product XYZ is in Warehouse A, Shelf 3."

**Story 2.2: Real-Time Stock Balances**
At any moment, you can see exactly how many items you have in each location. Updated live, not at the end of the day.

**Story 2.3: Batch & Serial Numbers**
When you buy medicines or car parts, they have batch numbers to trace recalls. If Item #B2345 is defective, the system can tell you exactly which locations have it and how many.

**Story 2.4: Calculating the Right Cost**
When you sell something, what was its cost? If you bought 10 items at ₹100 each, then 5 more at ₹120 each, which ones did you sell? The system uses proper accounting rules (First-In-First-Out or weighted average) - no guessing.

**Story 2.5: Moving Stock Between Locations**
"Send 50 units from Warehouse A to Warehouse B." Someone creates the request, it gets approved, and the system tracks the move from here to there.

**Story 2.6: Physical Inventory Counts**
Every few months, workers count everything on shelves to check if the computer numbers match reality. The system records the physical count and flags differences.

**Story 2.7: Minimum Stock Alerts & Old Stock**
If an item is running low, order more. If an item sits on the shelf for years and nobody buys it, flag it as "old" and maybe reduce its value on the books.

**Story 2.8: Company Goods vs. Other People's Goods**
Some stock belongs to you (your property), some belongs to customers (they're just storing it with you), and some is on consignment (you sell it but pay only what sells). The system keeps these separate.

**Story 2.9: Reading from the Old System**
Your old accounting system has open orders and open invoices. This story reads them and shows them in the new system as "reference data" (read-only, can't change here).

---

## EPIC 3: Warehouse Operations (The Loading Dock)

**Story 3.1: Warehouse Layout**
Map out the warehouse: Zones, Aisles, Racks, Bins. Add special rules like "This zone is cold storage" or "This zone is for hazardous materials."

**Story 3.2: Vehicle Arrives - Create a Ticket**
When a truck arrives at the gate, create a "gate event" linking the truck to the purchase order. Like a checkpoint ticket.

**Story 3.3: Weighing the Truck**
The weighing scale records how much the truck weighs (empty vs. full). If the purchase order says it should be 100kg but it's 95kg, the system flags it.

**Story 3.4: Unloading & Checking Quality**
Workers unload the truck and check: "Is it the right items? The right quantity? Any damage?" The system records what came in.

**Story 3.5: Putting Stock Away**
The system tells the worker: "Put this box in Bin A-43." If the worker says "No, I'm putting it in A-47 because A-43 is full," the system records that change so we know it's actually in A-47.

**Story 3.6: Making a Picking List**
When a customer order comes in, the system tells warehouse workers: "Go get 5 units from Bin A-1, 3 units from Bin B-5." Optimizes the route so they don't run around the warehouse.

**Story 3.7: Packing & Shipping**
Workers pack the items, weigh the package, generate a shipping label and receipt (packing slip). System records everything.

**Story 3.8: Task Management**
The system tracks who did what, how fast, and how many errors. Helps managers see who's productive and who needs training.

**Story 3.9: Restocking the Front Area**
The fast-selling area (forward pick zone) needs constant refilling from the back storage. System monitors when it's getting low and sends refill orders.

**Story 3.10: Cross-Docking**
When a truck arrives with items for Store B, instead of unloading and storing them, they go straight to the outgoing truck to Store B. No storage needed.

---

## EPIC 4: Buying Things (The Procurement)

**Story 4.1: Supplier Information**
Keep a list of suppliers: their address, tax ID, bank details, contact person. Like a phone book for vendors.

**Story 4.2: Are Suppliers Good?**
Track if suppliers deliver on time, if their quality is good, and if their prices are fair. At year-end, rate each supplier.

**Story 4.3: Employee Requests to Buy**
A factory floor supervisor says "We need 50 kg of raw material." Creates an indent/purchase requisition. Manager approves it based on the DOA rulebook.

**Story 4.4: Creating Purchase Orders**
After approval, send an official purchase order to the supplier: "Send 50 kg of item X by Friday."

**Story 4.5: Receiving & Matching**
When goods arrive, check if the PO (what we ordered), the goods receipt (what arrived), and the invoice (what the supplier charged) all match. If not, investigate.

**Story 4.6: Supporting Small Businesses**
If the supplier is registered as a small business (Udyam), the system tracks them specially for tax compliance - the government needs to know we're helping small businesses.

**Story 4.7: Recording the Invoice**
When the supplier sends a bill, record it in the system. Matches it against the PO and receipt.

---

## EPIC 5: Bills of Materials (The Recipe Book)

**Story 5.1: Product Recipes**
A bike is made of: frame (1 unit), wheels (2 units), handlebars (1 unit). This is the "recipe" or Bill of Materials. The system knows what goes into each product.

**Story 5.2: Locking Recipes Once Approved**
Once a recipe is official and approved, it can't be changed. Any change goes through a formal change request process. Like a regulation change at a restaurant.

**Story 5.3: Change Requests for Recipes**
"We want to use a lighter frame material." Submit a change request, check where this recipe is used (which orders, which stock), get approvals, then implement. Everything is tracked.

**Story 5.4: R&D Experiments**
Scientists are experimenting with different recipes. Their recipes can be messy and incomplete - not ready for actual production yet.

**Story 5.5: Alternatives**
"We can use Brand-A steel or Brand-B steel for the frame." Both are allowed. System tracks which is primary and which is backup.

**Story 5.6: Calculating Product Cost**
Once a recipe is locked, calculate the total material cost to make one unit. Send this to the accounting system.

---

## EPIC 6: Making Products (The Factory)

**Story 6.1: Create a Production Order**
"We need to make 100 bikes today." Create a production order, check if all materials are available, manager approves, then release to the factory floor.

**Story 6.2: Picking Materials & Tracking**
When the order is released, workers get a list: "Get 100 frames from Bin A-1, 200 wheels from Bin B-3." System tracks what was picked for each production order.

**Story 6.3: Finishing & Quality Check**
When 100 bikes are done, they go to quality control. System records that they're finished but "on hold" until QC approves them.

**Story 6.4: Keeping Track of Waste**
If the recipe said "use 10kg of material to make 5 bikes" but you actually used 11kg, record the difference. This helps improve the recipe over time.

---

## EPIC 7: Machines & Tools (The Maintenance)

**Story 7.1: Equipment Register**
List every machine, tool, and asset in the factory. Give each one an ID number and a tag with a QR code (like a barcode).

**Story 7.2: Scheduled Maintenance**
"This machine needs an oil change every 3 months." The system auto-creates maintenance tasks on schedule.

**Story 7.3: Emergency Repairs**
A worker scans the broken machine's QR code on their phone. System sends an alert to the maintenance supervisor within 5 minutes. Tracks the repair and when it's fixed.

**Story 7.4: Spare Parts Inventory**
Keep critical spare parts always in stock. If the spare bin gets low, automatically create a purchase order for more.

**Story 7.5: Weighing Machines & Calibration**
Every weighing scale needs to be certified every 6 months. Once it's overdue, NOBODY can use it for production or quality checks. Non-negotiable.

**Story 7.6: Inspections & Compliance**
Some machines need legal inspections yearly (like safety equipment). System tracks if they're overdue and blocks their use.

**Story 7.7: Insurance & Warranties**
Track if machines are still under warranty, when insurance expires, etc. System alerts before expiry.

**Story 7.8: Technician Work Offline**
Technicians work on the factory floor with a tablet. They can update maintenance records even without internet, then sync later.

---

## EPIC 8: Quality Control (The Inspector)

**Story 8.1: Inspection Instructions**
For each product type, specify what to inspect: dimensions, color, weight, etc. Like a checklist for QC workers.

**Story 8.2: Random Sampling**
Instead of checking every single unit (expensive), use statistical sampling: check every 10th unit or 5% of the batch. The system decides which items to check based on standard methods.

**Story 8.3: Pass/Fail Decision**
For each batch: "ACCEPT" (sell it), "REJECT" (scrap it), or "CONDITIONAL RELEASE" (sell it but with a note to be careful).

**Story 8.4: Certificate of Analysis**
Generate an official certificate showing what was inspected and the results. Customers might want this proof.

**Story 8.5: Block & Recall**
If a defect is found, the system blocks all stock with that batch number from being sold. If some was already sold, the system can trace who has it.

**Story 8.6: Regulatory Blocks**
Some rules are government regulations: "No product can ship without a government license." The system enforces these blocks.

**Story 8.7: Government Compliance**
Register business licenses, product licenses, food licenses (if food), etc. The system checks before release.

**Story 8.8: Witnessed Testing**
For some products, a government inspector or customer rep watches the test. System records that they witnessed it.

---

## EPIC 9: Job-Work Services (The Contract Manufacturing)

**Story 9.1: Customer Work Orders**
"Please make 100 custom parts for us. Here's the design, here's when you need it, here's the price."

**Story 9.2: Storing Customer Goods**
The customer ships their raw materials to you. You receive them and store them separately (not mixing with your own stock).

**Story 9.3: Tracking What's Used**
"You sent us 100kg of material. We used 95kg to make your products, and 5kg was wasted." System records exactly what came, what went into products, what was waste.

**Story 9.4: Finished Product & Approval**
Once the products are finished and approved by QC, you can ship them back to the customer and bill them.

**Story 9.5: Legal Return Clocks**
By law, customer materials left with you must be returned within specific timeframes (1 year or 3 years depending on the agreement). System tracks these deadlines and sends reminders.

**Story 9.6: Scrap & Waste Handling**
The 5kg of waste from above - did the customer take it back, or did you scrap it? System records the decision.

---

## EPIC 10: R&D & Maker-Hub (The Innovation Lab)

**Story 10.1: Research Projects**
Create a project: "Develop new battery design." Assign a budget, owner, and target date. Everything spent on this project gets tagged with the project code.

**Story 10.2: Research Spending Control**
"This project has a ₹5 lakh budget." As researchers request materials, the system checks: "Are we still within budget?" If yes, approve. If no, need higher approval.

**Story 10.3: Prototypes & Building**
"We're building prototype #5 of the battery." System tracks all materials used in each prototype - sometimes they succeed, sometimes they fail, but we keep the records.

**Story 10.4: Machine Time Booking**
Hub members book the CNC machine: "I need 2 hours tomorrow morning." System tracks usage and charges them accordingly.

**Story 10.5: Physical Verification**
Every month, count what's in the R&D storage to make sure the records match reality.

**Story 10.6: Quick Sales (Hub)**
Someone buys materials from the maker-hub with a credit card or UPI. System records it, decreases stock, and bills the hub member.

**Story 10.7: Member Statements**
At the end of the month, print a statement for each hub member: "You used ₹2000 worth of materials, 5 hours of machine time, and owe ₹2500."

---

## EPIC 11: Accounting & Taxes (The Finance)

**Story 11.1: Tax Credit Register**
Track every purchase that qualifies for tax credit (GST). By the end of the month, calculate how much tax the government owes you.

**Story 11.2: E-Invoice Before Shipping**
Before anything leaves the warehouse, the invoice must be registered with the government (online) and get a government QR code. No QR, no shipping.

**Story 11.3: Budget Limits**
Before approving a big expense, check the budget. "Do we have ₹10 lakhs left in the budget this month?" System checks and approves or blocks.

**Story 11.4: Month-End Closing**
At the end of each month, close the books. Check if all transactions match the accounting ledger, check if budgets are on track. Finance team signs off.

---

## EPIC 12: Reports & Dashboards (The Dashboard)

**Story 12.1: Role-Specific Views**
Warehouse manager sees: "Stock levels, pending orders, task status." Procurement manager sees: "Supplier performance, open POs, payment due dates." Everyone sees what they need.

**Story 12.2: Executive Dashboard**
CEO sees: "Total sales this month, profit margin, where inventory is stuck, which suppliers are slow."

**Story 12.3: Domain Reports**
"Stock movement report," "Supplier report," "Quality report" - detailed reports for each department.

**Story 12.4: Self-Service Reporting**
Managers can create their own reports: "Show me sales by region this quarter." Export to Excel, PDF, or email it.

**Story 12.5: Smart Alerts**
"Alert me if stock runs below 10 units," "Alert me if a PO is overdue by 5 days." System watches and alerts only when rules are triggered.

**Story 12.6: Scheduled Reports**
"Send me the daily sales report every morning at 8 AM." System auto-generates and emails it.

---

## EPIC 13: Going Live (The Migration Gate)

**Story 13.1: Opening Stock Import**
Take the physical count you did before launch and import it into the new system. "We had 5000 units in Warehouse A, 2000 in Warehouse B" etc.

**Story 13.2: Import Active Records**
Import all the active recipes (BOMs), open purchase orders, open customer orders, and supplier relationships from the old system.

**Story 13.3: Final Approval to Launch**
Department heads verify: "Yes, the numbers in the new system match our records from the old system." Finance approves. Only then can we go live.

---

## Summary in One Sentence Per Epic

1. **Epic 1:** Building the safe, rule-based foundation.
2. **Epic 2:** Tracking what you have, where, and how much it costs.
3. **Epic 3:** Managing the warehouse - receiving, storing, picking, shipping.
4. **Epic 4:** Buying from suppliers with full tracking and approval.
5. **Epic 5:** Documenting product recipes and managing changes.
6. **Epic 6:** Making products on the factory floor and tracking materials.
7. **Epic 7:** Maintaining machines and ensuring scales are certified.
8. **Epic 8:** Inspecting products for quality and preventing defects.
9. **Epic 9:** Making products for customers who supply their own materials.
10. **Epic 10:** Running R&D projects and a maker-hub with budget control.
11. **Epic 11:** Accounting, taxes, and month-end closing.
12. **Epic 12:** Dashboards and reports so managers see what they need to know.
13. **Epic 13:** Safely switching from the old system to the new one.
