# 3.21 Budget Control (ERP-Synced)

Budget masters stay in the ERP (A-02); this section defines the check, not the book. It supplies the number DH-APPROVE-01 promised approvers.

- **FR-BC-01 - ERP-Synced Budget Data:** The system consumes budget heads and period-wise available amounts from the ERP (department opex, capex by approved proposal, maintenance by asset class) on a configurable sync schedule. It maintains no budget masters of its own (A-02).
- **FR-BC-02 - Commitment Check at Approval:** On approval of indents, capex requests, and maintenance work orders, the system displays budget remaining inline (per DH-APPROVE-01) and applies a configurable warn-or-block rule (NFR-E-02) when the request exceeds available budget. Committed-not-yet-consumed amounts reduce available budget until ERP actuals are synced.
