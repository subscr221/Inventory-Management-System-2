# 3.22 Approvals and Delegation of Authority

Approval authority is one table, not a matrix per module. Every workflow that asks "who may approve this" resolves the answer here.

- **FR-DOA-01 - Enterprise Delegation-of-Authority Registry:** A single DOA registry defines approval authority by role, transaction type, and value band, with time-bound vacation delegation and a full change audit trail. All approval workflows (indents, POs, disposals, write-offs, capex, gate passes) resolve approvers from this registry. Workflow configuration (NFR-E-02) consumes, never overrides, the registry.
