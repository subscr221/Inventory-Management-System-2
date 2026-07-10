# 1. Project Overview

## 1.1 Purpose

This document defines high-level requirements for a materials management platform serving one Indian enterprise that runs four businesses on shared infrastructure: it manufactures and sells its own products, develops new products in an R&D centre through prototype and pilot builds, operates a maker-hub where members book company machines and buy materials at point of use, and fabricates for customers as job work. The platform is the system of record for stock, assets, and material movements across all locations, and it must post to the ERP financial ledger in a form that satisfies Ind AS, GST law, and the Companies Act 2013. Every requirement in this document names the user who feels the pain today and the measurable condition that counts as done.

## 1.2 Scope

The system manages inventory, assets, and material flows across these location types:

- **Production plants** - raw material, WIP, finished goods, and line-side stores
- **Warehouses and distribution centres** - bulk storage and inter-location transfers
- **R&D centre** - project stores that issue materials against project codes and hold prototype WIP
- **Maker-hub** - member-facing stores selling materials at point of use, plus consumables for bookable machines
- **Retail outlets** - finished-goods stock and sales
- **Third-party logistics (3PL) providers** - outsourced storage and fulfilment where contracted

Functional scope covers the full material and asset lifecycle: plan, source, make, develop, maintain, deliver, return, and dispose, with reporting and analytics across all stages.

## 1.3 Business Context

The company runs manufacturing, R&D, maker-hub, and job-work operations on systems built for none of them. The pain the business feels today:

- **Fragmented stock visibility** - answering "what do we hold and where" takes phone calls across locations, not a query
- **Manual inter-location transfers** - spreadsheets and email produce shrinkage, double counting, and disputes
- **Procurement disconnected from consumption** - buyers reorder blind, so stockouts coexist with excess stock
- **Untracked R&D consumption** - materials issued to projects disappear from view, prototype WIP carries no book value, and project costs are rebuilt by hand at year-end
- **No maintenance or calibration history** - equipment fails without warning, downtime is unmeasured, and repair is reactive
- **Finished-goods QC in an offline register** - no system link between test result and stock release
- **Scrap and defectives leak** - generation goes unrecorded, disposal is undervalued, and sale proceeds cannot be traced to lots
- **Depreciation in spreadsheets** - no register links an asset's book value to its physical location and condition
- **R&D spend inseparable from production spend** - at audit the company is exposed on Ind AS 38 classification and DSIR reporting

This system addresses these pain points by providing a single source of truth for all supply chain data, with role-appropriate access and workflows.
