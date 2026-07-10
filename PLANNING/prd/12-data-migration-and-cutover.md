# 12. Data Migration and Cutover

Go-live quality is set by opening balances; an error here repeats its damage on every transaction after cutover.

- **FR-DM-01** Physically verified opening stock by location, lot, and serial; asset register with cost, accumulated depreciation, and remaining Schedule II life; open POs, sales orders, and job-work challans with source references.
- **FR-DM-02** Active BOMs, custody and loan registers, and open gate passes migrated and department-verified before cutover.
- **FR-DM-03** Balances reconciled to ERP and legacy records; department-head and finance sign-off is a mandatory go-live gate. Validated by SM-48.
