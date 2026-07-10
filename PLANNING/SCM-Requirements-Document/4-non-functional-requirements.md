# 4. Non-Functional Requirements

## 4.1 Scalability

- **NFR-S-01:** The system must support a minimum of **50 locations** (warehouses, retail sites, manufacturing facilities) with the ability to scale to **200+ locations** without architectural changes.
- **NFR-S-02:** The system must handle **500,000+ active SKUs** across all locations, with per-location SKU counts of up to **100,000**.
- **NFR-S-03:** The system must support **1,000+ concurrent users** across all locations during peak operational hours, with headroom to scale to **5,000 concurrent users**.
- **NFR-S-04:** The system must process **10,000+ order lines per hour** during peak periods without degradation in response times.
- **NFR-S-05:** Database partitioning and indexing strategies must accommodate historical data retention of not less than 8 financial years for every record that feeds the books of account (Companies Act 2013 s.128(5), read with FR-AC-13), of which a minimum of 3 years online and the remainder archived yet restorable to queryable form within 48 hours for statutory audit, GST assessment, and forecasting; retention must be extensible per record class where the Central Government directs a longer period under the s.128(5) proviso following a Chapter XIV investigation.

## 4.2 Performance

- **NFR-P-01:** Page load and screen transitions for operational workflows (order entry, receiving, picking) must complete in **under 2 seconds**.
- **NFR-P-02:** Inventory queries (stock check across locations) must return results in **under 1 second** for single-SKU queries and **under 3 seconds** for multi-SKU/location queries.
- **NFR-P-03:** Report generation for standard reports must complete in **under 10 seconds**. Complex ad-hoc reports spanning multiple years of data must complete in **under 60 seconds**.
- **NFR-P-04:** The system must be available **99.5% of operational hours** (measured as uptime during business hours across all time zones where locations operate). Target: 99.9%.
- **NFR-P-05:** API response times for integration endpoints must be **under 500ms** for 95th percentile and **under 2 seconds** for 99th percentile.

## 4.3 Security

- **NFR-SEC-01:** All user access must be authenticated. Support Single Sign-On (SSO) via SAML 2.0 or OpenID Connect integration with the organization's identity provider (Azure AD, Okta, or equivalent).
- **NFR-SEC-02:** Role-Based Access Control (RBAC) at the module, function, location, and data level. A user's access to inventory, procurement, and reporting data must be scopeable to specific locations, departments, or categories.
- **NFR-SEC-03:** All data in transit must be encrypted using TLS 1.2 or higher. All data at rest must be encrypted using AES-256 or equivalent.
- **NFR-SEC-04:** The system must maintain a complete, immutable audit log of all user actions affecting inventory quantities, financial data, procurement decisions, and system configuration changes. Audit logs must be non-deletable and exportable. FR-AC-13 extends this log to the statutory edit-log obligations for records feeding the books of account.
- **NFR-SEC-05:** The system must enforce segregation of duties - for example, the user who creates a purchase order must not be the same user who approves it, and the user who records a goods receipt must not be the same user who approves the invoice.
- **NFR-SEC-06:** The system must comply with the Digital Personal Data Protection Act 2023 and the DPDP Rules 2025 (notified 14 November 2025, substantive obligations phased to May 2027) for personal data of maker-hub members, customers, supplier contacts, and users, including consent records, breach notification, and data-principal rights. Apply GDPR or other foreign regimes only where processing falls within their scope.

## 4.4 Data Integrity and Reliability

- **NFR-DI-01:** Inventory transactions must be ACID-compliant. A stock transfer, shipment, or receipt must never result in partial or inconsistent inventory states.
- **NFR-DI-02:** The system must prevent double-allocation of inventory - an item allocated to one order cannot simultaneously be allocated to another.
- **NFR-DI-03:** Data synchronization between locations must be eventually consistent with a maximum lag of **5 seconds** under normal network conditions. The system must handle network partitions gracefully, queuing transactions for replay when connectivity is restored.
- **NFR-DI-04:** The system must support automated backups at minimum **daily** with point-in-time recovery capability. Recovery Time Objective (RTO): **4 hours**. Recovery Point Objective (RPO): **1 hour**.
- **NFR-DI-05:** All financial-impacting transactions (receipts, shipments, adjustments, returns) must be idempotent - duplicate processing of the same event must not create duplicate inventory or financial postings.

## 4.5 Usability and Accessibility

- **NFR-U-01:** The user interface must be responsive and accessible on desktop browsers (Chrome, Edge, Firefox - latest two versions) and tablet devices used on warehouse floors.
- **NFR-U-02:** The system must meet WCAG 2.1 Level AA accessibility standards.
- **NFR-U-03:** The system must support internationalization (i18n) - multi-language UI, multi-currency transactions, and locale-specific date/number formatting.
- **NFR-U-04:** The system must provide contextual help, tooltips, and a searchable knowledge base accessible from within the application.
- **NFR-U-05 - Offline-First Frontline Capture:** Gate, weighbridge, and shopfloor mobile workflows must be fully operable with no network connectivity treated as a normal path, not an exception. Captured events (gate-in, weight, putaway, pick, indent) must persist locally on the device and auto-reconcile to the server on reconnection without operator re-entry, consistent with the store-and-forward behavior in NFR-DI-03.
- **NFR-U-06 - Moment-of-Use Ergonomics:** High-frequency frontline tasks must be scan-first with large touch targets, completable one-handed and with gloves, and must minimize the number of taps and fields required to complete a transaction. Screens must degrade gracefully under poor lighting and on rugged devices, so that a clumsy or slow interface does not push staff back to paper or informal workarounds.

## 4.6 Extensibility and Maintainability

- **NFR-E-01:** The system must expose a well-documented RESTful API (and/or GraphQL) for all core functions, enabling integration with external systems and custom extensions.
- **NFR-E-02:** The system must support configurable workflows (approval chains, routing rules, alert thresholds) without requiring code changes.
- **NFR-E-03:** The system must support a plugin or extension framework for custom business logic, custom reports, and integration adapters.
- **NFR-E-04:** System upgrades must be possible with minimal downtime (target: **under 30 minutes** for routine updates) and without data migration errors.

## 4.7 Frontline Adoption

- **NFR-ADOPT-01 - Locator Feedback Loop:** Where the system captures frontline tribal knowledge (for example, a store assistant's bin-location overrides, or accumulated location-confidence gains), it must surface visible value back to those same staff, such as more accurate directed bins and fewer wrong-bin walks. Sustained frontline confirmation rate must remain at or above **95%**. A drop below this threshold is treated as a system defect to be investigated, not as user error, because capturing knowledge without returning value removes the incentive to keep confirming and the data quality then degrades.

## 4.8 Documents and Retention

- **NFR-D-01:** All modules use a single attachment store for certificates, test reports, manifests, photos, videos, bills of entry, and signed documents, with per-attachment metadata (document type, linked record, uploader, timestamp), virus scanning on upload, and configurable size/format limits.
- **NFR-D-02:** Each document type carries a retention class (statutory minimums preloaded for GST, Customs, and Companies Act records) and supports legal hold; deletion before retention expiry or while on hold is blocked and audit-logged.
