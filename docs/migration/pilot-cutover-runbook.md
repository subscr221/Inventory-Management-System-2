# Pilot Cutover Runbook

Status: REVIEWED 2026-09-20. Drafted 2026-09-12; review by the program director, the migration
lead, the department head and the finance controller reported complete by the program director on
2026-09-20. The mock rehearsal passed on staging the same day (46 of 46 planted defects found,
restore from the labelled base backup proven on the live stack). Tables 3, 3a and 5 are still to
be filled from the rehearsal with the site's real extract.

Pilot window: ONE WEEK from the physical freeze (site answer, 2026-09-13).

Scope: one pilot site, the Phase 1 wave (Epics 1 to 13, the 66 stories tagged PILOT in
`sprint-status.yaml`). The wave's data scope is the five migration domains that Story 13.3's
go-live gate covers: `opening_stock`, `active_boms`, `open_pos`, `jobwork_challans`,
`custody_registers`.

Sources: `deploy/pipeline/deploy.sh`, `deploy/provision/provision.sh`, `deploy/backup/backup.sh`,
`src/events/migrate.ts`, `src/cli/verify-segregated-roles.ts`, the Story 13.1 to 13.3 story
files, and `docs/migration/opening-stock-template-v1.md` and
`docs/migration/document-manifest-templates-v1.md` for the file formats.

## 1. Roles and people

The cutover needs the people in Table 1 provisioned through SCIM before any migration file is
loaded. The system enforces every separation in the table; a violation is refused at request
time and again inside the event transaction, so a missing or doubled-up holder stops the
cutover, it does not merely warn.

Table 1: Cutover roles

| Role | Module and scope | Who must NOT also hold it | Enforced by |
| --- | --- | --- | --- |
| `migration_lead` | `migration`, write, pilot site | `department_head`, `finance_controller` for the site | SOD-07, Story 13.2 and 13.3 sign-off legs |
| `department_head` | `migration`, write, pilot site | `migration_lead`; anyone who loaded, promoted or ran a verification for the site; the `finance_final` signer | Story 13.3 `assertGoLiveSignoffAllowed` |
| `finance_controller` | `migration`, write, pilot site or `*` | `migration_lead`; any loader, promoter or verification runner; the `department_head_final` signer; the `cfo` | Story 13.3 sign-off legs; Story 9.7 ruling |
| `cfo` | per Story 9.7 and 9.9 | `finance_controller` | Story 9.7 ruling (two real people) |
| Variance approver (DOA) | resolved by `doa_registry_entries` for `migration.variance_explanation` | the explainer (`EXPLAINER_CANNOT_APPROVE`) | Story 13.1 approval route |
| Domain sign-off authority | per-domain module, write (Story 13.2) | the run's loader and runner | Story 13.2 `assertDomainSignoffAllowed` |

Minimum head count: four distinct real people (lead, department head, finance controller,
CFO), plus a DOA approver who is not the person explaining variances.

### 1.1 Accounts: people sign in as themselves, the role is what moves

Decided 2026-09-13 with the site. Staff come and go, so the roles are provisioned from a file,
not by hand, and changing a holder is one line in that file plus one run. Two rules that are not
negotiable:

- Every account is a real person's own identity. There are no shared "role mailbox" logins. A
  role mailbox may exist as a place notifications go, but nobody signs in as it: the segregation
  checks compare people, and the audit log must name a person.
- One person may never hold both sides of a forbidden pair. The provisioning script refuses the
  whole file if they do, so the refusal happens at the operator's desk and not at the gate.

The file is `deploy/provision/roles.json` (template: `deploy/provision/roles.example.json`; the
real file is git-ignored and lives only on the operator's machine). One entry per hat: role,
module, read or write, location (`site`, `*`, or a UUID) and the holder's email. Optional
`people` entries carry a display name and, when the identity provider's subject is not the
email, the `external_id` the provider will present.

```bash
npm run provision:roles -- deploy/provision/roles.json          # dry run, prints the plan
npm run provision:roles -- deploy/provision/roles.json --apply  # provisions through the SCIM seam
npm run verify:roles                                             # re-checks the pairs in the database
```

The dry run prints every person and every assignment, and `REFUSE` lines for any of the forbidden
pairs in Table 1a. `--apply` creates new people, replaces the role set of known people, and
reactivates a deprovisioned person first; it never deprovisions anyone. `verify:roles` afterwards
lists every registered segregated pair and the holders on each side; a pair with the same person
on both sides fails the run.

Table 1a: Forbidden pairs the script refuses

| Role A | Role B | Why |
| --- | --- | --- |
| `migration_lead` | `department_head` | SOD-07, Story 13.2 domain sign-off |
| `migration_lead` | `finance_controller` | SOD-07, Story 13.1 variance explanation |
| `department_head` | `finance_controller` | Story 13.3 decision 1, two final sign-offs, two people |
| `finance_controller` | `cfo` | Story 9.7 ruling, offcut acquisition |

## 2. Environment readiness

Decided with the site on 2026-09-13 and confirmed by a read-only survey of the box the same day
(Table 2a): staging runs on the company VPS `vps.inarl.in` at `103.160.106.127`, a Webuzo-managed
host that also carries company mail; the domain `ancorlabs.org` is on Cloudflare DNS; the company
has no external identity provider, so Keycloak runs on the same box. Ports 80 and 443 belong to
the panel's own nginx (a config tree the panel regenerates, so nothing is added to it by hand), so
the stack runs its own nginx under the `standalone` profile on port 8443, Cloudflare's proxy sends
public 443 traffic there through an Origin Rule, and certificates come from certbot in standalone
mode on the free port 80. Every other service publishes on a loopback port only.

Table 2a: VPS survey (read-only, 2026-09-13)

| Fact | Value | Consequence |
| --- | --- | --- |
| OS, kernel | Ubuntu 24.04.5 LTS, 6.8 | supported |
| CPU, memory, swap | 4 cores, 16 GB, 255 MB swap; 2.2 GB in use after the owner removed Elasticsearch on 2026-09-13 (`kilo`, 1 GB, is required and stays) | comfortable; Keycloak heap still capped at 512 MB, standby still not started on the shared box |
| Disk | 197 GB, 63 GB free | fine |
| Docker, Compose | 29.8, v5.5.1 | supported (deploy.sh needs 2.24 or newer) |
| SSH | port 2222, root login and password login enabled | key-based automation key installed; harden after an operator account exists |
| Ports 80 and 443 | 443: the Webuzo panel's own nginx (`/usr/local/emps`, panel-managed config); 80: free. The Ubuntu `nginx.service` carrying Nextcloud and Collabora vhosts is disabled and has never started on this boot | the stack's own nginx runs on 8443 behind a Cloudflare Origin Rule; certbot standalone on 80 |
| Port 3000 | Gitea container | our app publishes on 3100 instead |
| Port 5432 | Gitea's Postgres 15, bound to 10.0.0.1 | our Postgres 18 publishes on 127.0.0.1:5442 |
| Ports 3100 to 3103, 5442, 5443, 8081, 8443 | free | used by the stack (8443 is the only one published beyond loopback; `ufw allow 8443/tcp`) |
| Firewall | ufw active with `DEFAULT_FORWARD_POLICY=DROP` (bridge containers have no egress, so images build on the host network); 80 and 443 allowed; 8000 and 8888 allowed for old ERPNext and InvenTree installs that are not running | one new rule, 8443/tcp; the stale allows are the mail owner's to remove |
| DNS from the box | `ancorlabs.org` apex points elsewhere (169.148.148.139); `ims-staging` and `auth` do not exist yet; nameservers are Cloudflare | records must be created before certificates can be issued |

Complete Table 2 in order. Each row is a hard stop until green.

Table 2: Environment checklist

| Step | Action | Evidence |
| --- | --- | --- |
| 2.1 | Cloudflare DNS: A records `ims-staging` and `auth` on `ancorlabs.org` pointing at `103.160.106.127`, proxy OFF (grey cloud) while certificates are issued. With the proxy on, Let's Encrypt reaches Cloudflare instead of the box and the zone's redirect rule bounces the challenge to `www` (seen 2026-09-13) | `dig +short` from a public resolver returns the VPS address |
| 2.2 | Get the code onto the box: `tar` over SSH (excluding `node_modules`, `.git`, `dist`, every `.env`) to `/opt/ims`; shell scripts must arrive with LF endings (`.gitattributes` pins them; on the box `sed -i 's/\r$//'` is the repair) | `/opt/ims/deploy/compose/docker-compose.yml` present, `file *.sh` shows no CRLF |
| 2.3 | Create `/opt/ims/deploy/compose/.env` on the box: `PUBLIC_DOMAIN=ancorlabs.org`; host ports `APP_HOST_PORT=3100`, `EDGE_HOST_PORT=3101`, `POWERSYNC_HOST_PORT=3102`, `KEYCLOAK_HOST_PORT=3103`, `POSTGRES_HOST_PORT=5442`, `NGINX_HTTP_HOST_PORT=8081`, `NGINX_HTTPS_HOST_PORT=8443`; long random values (`openssl rand -hex 32`, generated on the box) for `POSTGRES_ADMIN_PASSWORD`, `DB_PASSWORD`, `READONLY_PASSWORD`, `REPLICATION_PASSWORD`, `POWERSYNC_SOURCE_PASSWORD`, `POWERSYNC_TOKEN_SECRET`, `SCIM_BEARER_TOKEN`, `KEYCLOAK_DB_PASSWORD`, `KC_BOOTSTRAP_ADMIN_PASSWORD` (the first boot sets the four runtime role passwords from these through `init-role-passwords.sh`; the SQL placeholders never survive); the auth values `AUTH_JWKS_URI=https://auth.ancorlabs.org/realms/ims/protocol/openid-connect/certs`, `AUTH_ISSUER=https://auth.ancorlabs.org/realms/ims`, `AUTH_AUDIENCE=ims-app`, `AUTH_SUBJECT_CLAIM=email`; the browser sign-in values for the edge container (Story 1.12) `EDGE_OIDC_AUTHORITY=https://auth.ancorlabs.org/realms/ims` (same value as `AUTH_ISSUER`) and `EDGE_OIDC_CLIENT_ID=ims-app` (compose refuses to start the edge without them); `TLS_CERT_PATH` and `TLS_KEY_PATH` pointing at `/etc/letsencrypt/live/ims-staging.ancorlabs.org/`. The Keycloak admin password is written to `/root/ims-keycloak-admin.txt` for the operator | `.env` present, mode 600, no empty values |
| 2.4 | Start the stack: `docker compose up -d --build` in `/opt/ims/deploy/compose` (default profile: Postgres, PowerSync, app, edge, Keycloak; images build on the host network). Wait for `PostgreSQL init process complete` in the postgres log and confirm the init line `init-role-passwords: the four runtime role passwords were set from the environment` and `Realm 'ims' imported` in the keycloak log. If first boot fails, the volume is tainted: `docker compose down -v`, fix, boot again | health on `127.0.0.1:3100` returns 200; five containers healthy |
| 2.5 | Front door: `ufw allow 8443/tcp`, then `deploy/provision/staging-front-door.sh` (certbot standalone for both names on port 80, renewal hook that reloads the container, the four `.env` lines, `docker compose --profile standalone up -d nginx`, verification on 8443 with the certificate shown). Then in Cloudflare: proxy ON for both records; Origin Rule (hostname in the two names, destination port rewrite to 8443); SSL/TLS Full (strict); Always Use HTTPS; and EXCLUDE the two names from any zone-wide redirect-to-www rule | `https://auth.ancorlabs.org` shows the Keycloak page; `https://ims-staging.ancorlabs.org/api/v1/health` returns 200 from outside |
| 2.6 | Confirm the pins inside the Postgres container: `SHOW timezone` returns `Asia/Kolkata`, `SHOW lc_collate` returns `C.UTF-8` (first-boot pins; a restored volume keeps its own) | psql output |
| 2.7 | Run the migration inside the app container: `docker compose exec -T -e DB_ADMIN_PASSWORD="$POSTGRES_ADMIN_PASSWORD" app node dist/src/events/migrate.js` (the production image has no `tsx`, so `npm run db:migrate` fails with `ERR_MODULE_NOT_FOUND`, and the container's own `DB_PASSWORD` is the app role, not the migration role; take the admin password from `deploy/compose/.env`); confirm it is re-runnable (second run, no error) | migrate log, two clean runs |
| 2.8 | Provisioning-window client: the account and DOA scripts in 2.9 and 2.9a take their operator token through `ims-cli` (direct access grant). The realm import never contains it, so a fresh production realm has no password grant: `deploy/provision/keycloak-add-cli-client.sh` adds it through kcadm for this window only, and 2.10b removes it again once browser sign-in is verified (Story 1.12). Rotate the bootstrap admin password in the Keycloak console | client visible in the realm |
| 2.9 | Accounts and site: `deploy/provision/staging-bootstrap-accounts.sh <site-code> <lead> <head> <finance> <cfo> <site-head>` creates the Keycloak accounts (username = email, first and last name required by Keycloak's profile check, passwords generated into `/root/ims-first-passwords.txt` for the operator to hand out; everyone changes theirs at `https://auth.ancorlabs.org/realms/ims/account`), provisions the lead's bootstrap hats, creates the site through `POST /api/v1/locations`, then provisions every hat for the site through the SCIM seam. Rerunnable; the script refuses any forbidden pair (Table 1a) before writing | four accounts, site id printed, `N people, M assignments, 0 segregation violations` |
| 2.9a | DOA bands: `deploy/provision/staging-doa-bands.sh <finance-controller-email>` (with `FIN_PW=<their password>` in the environment once the first-passwords file is gone; the script skips a type+role band that is already active, and `staging-doa-deactivate.sh` retires an entry by id through the PATCH route) registers the four approval bands (`migration.domain_signoff` for `department_head`, `migration.variance_explanation` for `finance_controller`, `jobwork.offcut_acquisition` for `cfo`, and `edge.refused_capture_resolution` for `department_head`, without which every refused-capture resolve in 2.10c answers 409 `APPROVAL_UNRESOLVED`) as the finance controller, then `verify:roles` | `All segregated role pairs are provisioned on separate users.` |
| 2.10 | Browser sign-in (Story 1.12): open `https://ims-staging.ancorlabs.org/maintenance` in a fresh browser; it must land on the Keycloak login for realm `ims`, and after signing in as the migration lead (an account that has already changed its temporary password; a fresh account fails with `Account is not fully set up`) return to `/maintenance` with the person's name in the header. In DevTools confirm `/api/v1/edge/bootstrap` returned 200 with an `Authorization: Bearer` request header. Leave the tab open 16 minutes and confirm no redirect (silent refresh) | login page, header name, bearer header, no redirect after 16 min |
| 2.10a | End to end, in the same signed-in tab: in the DevTools console run `fetch('/api/v1/migration/golive/reconciliation?site_id=<site id from 2.9>', { headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('oidc.user:')))).access_token } }).then((r) => r.json()).then(console.log)`; an empty report with `gate.blocking: APPROVAL_REQUIRED` proves auth, roles, database and proxy. Then press Sign out: Keycloak must end the session without a confirmation page, and the next load must ask for a login again | report JSON, login page after sign-out |
| 2.10c | Sync end to end (Story 1.13, AD-18), in a tab signed in as an account that holds an edge capture role for the site (a concrete site assignment, not `*`, or bootstrap answers 403 `EDGE_NO_CONCRETE_SITE`; the site needs at least one registered asset, `POST /api/v1/assets` with `asset_tag`, `asset_name`, `criticality_class`, or every fault report is refused `ASSET_NOT_FOUND`): (1) capture one event the server accepts; the Pending count returns to 0 and the event appears in `domain_events` for the site. (2) Capture one event the server refuses (for example as a role without that module); after the next PowerSync checkpoint it must still show under "Needs attention" on the device with its error code, and the refused-captures API (Story 1.13) must list it for the site. (3) Reload the tab: the refusal is still on the device. (4) On the box, PowerSync logs show "Sync stream started" and no `PSYNC_S2101`, and `pg_replication_slots` has an active `powersync` slot | accepted event row, refusal visible on device after checkpoint and reload, refused-captures API entry, active replication slot |
| 2.10d | Supervisor screen (Story 1.14), after the code is shipped and the app and edge images rebuilt (2.7 for the migration; it adds one index, `IF NOT EXISTS`). In a tab signed in as an account with a read grant at CMF-ALIGARH (`accounts@` holds `inventory` read and `maintenance` write there since 2.10c) the header navigation shows `Refused captures`; open `https://ims-staging.ancorlabs.org/supervisor/refused-captures` and see the two open refusals 2.10c recorded (MODULE_ACCESS_DENIED, ASSET_NOT_FOUND) as cards, newest first, each with time, person (user id and role), device, capture type and the error code with its operator message. In a tab signed in as the DOA approver for `edge.refused_capture_resolution` (`department_head`, `subscr@`, who must have changed the temporary password and hold `write` on the refusal's module at the site) press Resolve on one, enter a note, Confirm resolve: the card moves under Resolved with who, when and the note, and `GET /api/v1/edge/refused-captures?status=resolved&location_id=<site id from 2.9>` from the DevTools console (bearer as in 2.10a) lists it. Signed in as an account with no assignment at the site, the page shows the no-access copy and the list answers 403. Put the tablet in airplane mode and reload the page: only the needs-connection card renders, no rows. On the device, under "Sync failed - needs attention", press Dismiss then Confirm dismiss on one refusal: it leaves the device list, and the central row is still listed by the API | nav entry, two open cards, one resolution under Resolved and in the API, no-access copy for no grant, needs-connection card offline, dismissed row gone on the device and unchanged centrally |
| 2.10b | Only after 2.10c passes. Remove the provisioning-window client: `deploy/provision/keycloak-remove-cli-client.sh` (re-add it with `keycloak-add-cli-client.sh` only for a later re-run of 2.9 or 2.9a, and remove it again). The script exits non-zero on any Keycloak error | `ims-cli client removed` (or `already absent`), and `ims-app` listed with `directAccessGrantsEnabled: false` |
| 2.11 | SSH on staging, ruled 2026-09-20: password login and root login STAY on, because the company IT department maintains the shared box that way; project work uses the automation key only, never a password. Production keeps the original rule: a named operator account with a key, then `PermitRootLogin prohibit-password` and `PasswordAuthentication no`, not before the operator account has logged in once | staging: ruling recorded here; production: `sshd -T` output |
| 2.12 | Backups. Staging, ruled 2026-09-20 (pgBackRest is not installed on the box): `deploy/backup/staging-basebackup.sh` runs nightly from root's crontab at 02:30, keeps seven base backups in `/root/ims-backups` and cuts the WAL archive at the oldest one kept; run it by hand with a label before every rehearsal and before the freeze. Restore drill passed 2026-09-20 (backup restored into a throwaway container, row counts equal to live). Production: pgBackRest (`deploy/backup/backup.sh`) with one full backup, one WAL archive segment and an off-box copy; `deploy/backup/pgbackrest.conf` must be corrected first (section names, data directory, cipher passphrase) | staging: `/root/ims-backups` listing and `/var/log/ims-basebackup.log`; production: pgBackRest `info` |
| 2.13 | Confirm `EVENT_OCCURRED_AT_MAX_AGE_DAYS` (default 30) covers the longest offline period a technician device can have, and record the ERP sync schedule and `ERP_SYNC_FRESHNESS_MS` | `.env` review, schedule document |
| 2.14 | Record the opening-stock promotion timing on staging during the rehearsal (the site's file carries hundreds of lines; the 20,000-row figure of deferred-work item 800 is a Phase 2 platform item, not a pilot gate) | figure written into Table 3 |

Security posture of the box after 2.5: one new listener, the stack's nginx on 8443 (and 8081 for
the health redirect block), reachable only for the two names; the application, edge, PowerSync,
Keycloak and Postgres bind to `127.0.0.1` only. The certificate lasts to 2026-12-12; renewal
through the Cloudflare proxy is awkward for the HTTP challenge, so before then switch renewal to
the DNS challenge with a Cloudflare token scoped to this zone (`certbot-dns-cloudflare`), or drop
the proxy to DNS-only for the renewal run. Memory is no longer the watch item: the owner removed Elasticsearch on 2026-09-13 and the box
has about 11 GB free; the standby stays off and Keycloak's heap stays capped because the box is
shared, not because it is short.

The only promotion timing on record is a 10,000-row local run (62.7 s import); the pilot file
is in the hundreds, so step 2.14 is a measurement, not a stop.

## 3. Rehearsal on staging

Run sections 4 to 7 end to end on staging with a full copy of the pilot site's extract at least
once. Record the wall-clock time of each step in Table 3 during the rehearsal; the production
window in section 8 is planned from those figures.

Table 3: Rehearsal timing

| Step | Rehearsal start | Rehearsal end | Notes |
| --- | --- | --- | --- |
| Opening-stock load | | | |
| Variance explanation and approval | | | |
| Promotion | | | |
| Document loads and verification runs (four domains) | | | |
| Domain sign-offs | | | |
| Final ERP extract and sync | | | |
| Final sign-offs and unblock | | | |

The site's own volume estimates (2026-09-13) are in Table 3a. Fill the "actual at load" column
during the rehearsal; a domain that comes in an order of magnitude above its estimate is a stop,
because the verification cap (10,000 findings per run) was accepted on these numbers.

Table 3a: Expected versus actual volumes

| Domain | Site estimate | Expected mismatch share | Actual at load | Findings on first run |
| --- | --- | --- | --- | --- |
| Job-work challans | hundreds | under one in ten | | |
| Custody ledger entries | hundreds | under one in ten | | |
| Open purchase orders | a few | under one in ten | | |
| Active BOMs | not estimated | under one in ten | | |
| Opening-stock lines | hundreds | not applicable | | |

## 4. Opening stock (Story 13.1)

1. Freeze physical movements at the site. The counted quantities in the file must describe a
   stock position that does not change until promotion.
2. Load the counted stock file through `POST /api/v1/migration/opening-stock/imports` as the
   `migration_lead`. Format per `docs/migration/opening-stock-template-v1.md`. Rejections are
   returned per row; fix the source and reload (a later load supersedes the earlier rows).
3. Pull the ERP balance snapshot for the site (the Story 2.9 sync). Note the `snapshot_at` it
   carries; it matters in section 7.
4. Read `GET /api/v1/migration/opening-stock/variances`. Every variance must end in status
   `explained`: the lead posts an explanation through
   `POST /api/v1/migration/opening-stock/variances/explanations`, the DOA-resolved approver
   approves it through the `/approve` route. `pending_approval`, `stale` and `open` all block.
5. Promote through `POST /api/v1/migration/opening-stock/promote`. The stage moves to `dry_run`
   and the rows post to the live ledger. Promotion refuses on any unexplained variance.
6. From the physical freeze onward, nobody retypes a platform GRN into the ERP and nobody
   receives against a migrated PO in the ERP. The platform froze each PO line's legacy-received
   quantity the first time it synced the line and counts it toward the over-receipt band; a later
   ERP `open_qty` that claims more was received is surfaced on the receipt as
   `erp_receipt_overlap_qty` and logged. Treat every such warning as an ERP-side reconciliation
   item, not as permission to receive again. The migration lead reads the overlap warnings daily
   until the ERP team confirms in writing that the retyping has stopped.

## 5. Active documents (Story 13.2)

For each of `active_boms`, `open_pos`, `jobwork_challans`, `custody_registers`:

1. Load the manifest through `POST /api/v1/migration/documents/imports` (format per
   `docs/migration/document-manifest-templates-v1.md`).
2. Run verification. Findings of kind `missing_in_platform`, `missing_in_source`,
   `field_mismatch`, `state_mismatch` and `unknown_reference` appear on the run.
3. Resolve every open finding: fix the source and rerun, or waive with a narrative. A
   platform-only orphan that cannot be waived is registered through
   `POST /api/v1/migration/domains/:domain/platform-exclusions`.
4. The domain's sign-off authority signs off the latest run of the latest load through
   `POST /api/v1/migration/domains/:domain/sign-off`. `GET /api/v1/migration/domains` shows
   `verified` only when the signed-off run is the latest run of the latest load; a later load or
   run makes the domain `unverified` again and step 4 repeats.

Order of loads matters for section 7: every document load is a `migration_import` row, and the
final sign-offs must postdate all of them.

Dead purchase-order lines (site answer, 2026-09-13: two or three open POs carry lines the ERP has
dropped but the extract still shows open). The platform keeps such lines open (no line status
column until the Phase 2 fix, deferred-work row 138), so for each named PO, in this order of
preference:

1. The ERP team closes the dead lines in the ERP before the final extract, so the sync carries
   them closed.
2. Failing that, the migration lead drops the dead lines from the `open_pos` manifest, registers
   each platform-side line through `POST /api/v1/migration/domains/open_pos/platform-exclusions`
   so verification does not report it as `missing_in_source`, and issues a written do-not-receive
   list for those PO and line numbers to the receiving dock.

Table 3b lists them; fill it before the rehearsal.

Table 3b: Dead purchase-order lines

| PO number | Line numbers | Closed in ERP before extract (yes or no) | Platform exclusion registered | Do-not-receive sheet issued |
| --- | --- | --- | --- | --- |
| | | | | |
| | | | | |
| | | | | |

## 6. Reconciliation report (Story 13.3 AC 1)

`GET /api/v1/migration/golive/reconciliation?site_id=` is the one page the sign-off authorities
read. Before asking for a signature, confirm on it:

- `domains[opening_stock].unexplained_count` is 0 and `stage` is `dry_run`.
- Every document domain shows `status: verified`.
- `remaining_discrepancies` contains no entry with `blocks_golive: true`. Entries with
  `blocks_golive: false` (`quarantined_documents`, `open_findings` on a superseded run) are
  informational and must be acknowledged in the sign-off minutes.
- `gate.blocking` is `APPROVAL_REQUIRED` naming both sign-offs and nothing else. Any other code
  means a section 4 or 5 step is incomplete.

## 7. Final sign-offs and unblock (Story 13.3 AC 2 to AC 4)

The order below is mandatory because of the stale-attestation rule: a sign-off that predates the
site's latest migration load or the latest ERP `snapshot_at` is refused as `SIGNOFF_STALE` at
unblock time and must be given again.

1. Run the final ERP extract and sync. Confirm on the reconciliation report that
   `data_activity.latest_snapshot_at` shows the new snapshot and `unexplained_count` is still 0.
2. Stop the ERP sync schedule for the site until the unblock is recorded. A nightly sync that
   advances `snapshot_at` after the signatures invalidates them.
3. Confirm no further migration load will be made. If one is needed, make it now and return to
   step 1.
4. The department head records `department_head_final` through
   `POST /api/v1/migration/golive/sign-offs` (`signoff_type: department_head_final`).
5. The finance controller records `finance_final` through the same route. A different person
   from step 4; the same person is refused `SIGNOFF_ACTOR_CONFLICT`.
6. Read the report once more: `gate.satisfied` must be `true`, both `signoffs[*].stale` false.
7. The migration lead records the unblock through `POST /api/v1/migration/golive/unblock`. The
   response carries the `migration.golive.unblocked` event id; the `migration_golive_status`
   row is the durable record for the auditors.
8. Re-enable the ERP sync schedule.

Refusal codes at step 7 and their remedies are in Table 4.

Table 4: Unblock refusals

| Code | Meaning | Remedy |
| --- | --- | --- |
| `APPROVAL_REQUIRED` | One or both final sign-offs missing | Steps 4 and 5 |
| `SIGNOFF_STALE` | A sign-off predates the latest load or snapshot | Steps 1 to 5 again; the stale sign-off is re-attested, the earlier row stays on record |
| `VARIANCE_UNRESOLVED` | An opening-stock variance is not `explained` | Section 4 step 4, then steps 1 to 5 again |
| `PROMOTION_REQUIRED` | Opening stock not promoted | Section 4 step 5 |
| `DOMAIN_UNVERIFIED` | A document domain is not `verified` | Section 5 step 4 for the named domains |
| `INVALID_STATE` (`already_unblocked`) | The site is already live | Nothing; the existing event is returned on the route |

## 7a. Not in the window

Two things stay out of the pilot week because the platform has no undo for them yet
(Stories 7.9 and 7.10 are post-pilot backlog):

- Nobody records a calibration certificate during the week. A wrong validity date triggers the
  non-overridable `CALIBRATION_LOCKOUT` and the only remedy is a database restore.
- Nobody re-levels a critical spare's min-max during the week. The catalogue row cannot be
  amended; a wrong level means a wrong or missing breach alert until the amendment story ships.

Both were confirmed as "not needed in the window" by the site on 2026-09-13; this section is
what keeps that answer true under week-one enthusiasm.

One operating note for the same reason. Lot selection does not split a pick across lots: a pick
larger than any single lot of that SKU at that location is refused `NO_AVAILABLE_LOT` even when
the combined stock suffices. The site confirmed on 2026-09-13 that fast movers sit in one lot per
location and picks never exceed a lot. If a SKU is ever split across lots (a QC return as its own
lot, for example), split the pick by lot: several lines, one per lot.

## 8. Production window plan

Fill Table 5 from the rehearsal figures in Table 3. The window opens at the physical stock
freeze and closes at the unblock; transactional use of the site starts only after the unblock.

Table 5: Production window

| Milestone | Planned time | Owner | Done |
| --- | --- | --- | --- |
| Physical movement freeze | | site head | |
| Opening-stock load and variance closure | | migration lead, DOA approver | |
| Promotion | | migration lead | |
| Document loads, verification, domain sign-offs | | migration lead, domain authorities | |
| Final ERP extract; sync paused | | ERP owner | |
| Final sign-offs | | department head, finance controller | |
| Unblock; sync resumed | | migration lead | |
| First live transaction | | site head | |

## 9. Rollback

There is no delete path on any migration record: sign-offs, unblocks and promoted rows are
append-only by design (app_user holds no UPDATE or DELETE). Rollback is therefore a database
restore, not a data correction:

1. Before the physical freeze, take a named pgBackRest backup and record its label.
2. If the cutover is abandoned after promotion, restore the database to that label with
   `deploy/backup/backup.sh` and redeploy the same `IMAGE_TAG`.
3. If the cutover is abandoned before promotion, no restore is needed: staged rows and
   explanations are inert until promotion, and a fresh load supersedes them.
4. After an unblock, rollback is a management decision recorded in the audit log; the
   `migration_golive_status` row is not removed.

## 10. Open items before the first rehearsal

- Deferred-work item 800: re-ruled 2026-09-13 as Phase 2 (opening stock in the hundreds); Table 2 step 2.8 records the rehearsal's actual timing instead of gating on 20,000 rows.
- The pilot-blocking triage of `deferred-work.md` is done (`pilot-blocking-triage-2026-09-12.md`,
  rulings 2026-09-12 and 2026-09-13); nothing ruled blocking remains outside this runbook.
- The ERP feed, ruled 2026-09-20: it is pushed through the service account `erp1@ancorlabs.org`
  (`svc_erp_adapter`, inventory write), whose owner is the site head, `cmf_supervisor@ancorlabs.org`,
  the person who runs the ERP. Still open: the mechanism to pause the feed for section 7 step 2.
- Names against Table 1, settled 2026-09-20: migration lead Gagan Kumar (`info@ancorlabs.org`),
  department head `subscr@ancorlabs.org`, finance controller and variance approver
  `accounts@ancorlabs.org`, CFO `anupam@ancorlabs.org`, site head `cmf_supervisor@ancorlabs.org`,
  BOM engineer Devender (`dev1@ancorlabs.org`). Still open: the owners and times in Table 5.
- Pilot passwords, ruled 2026-09-20: every staging pilot account uses one shared simple password
  for the pilot. Each person sets their own before production data is loaded.
- The pilot's data, ruled 2026-09-20: the pilot runs on MOCK data, not on a site extract. The pack
  is `docs/migration/pilot-mock-extract/` (generated by `deploy/rehearsal/mock/generate.mjs`,
  seed 2026, 303 opening-stock rows, 27 planted defects, answer sheet `expected-outcomes.json`).
  Everything loaded for the pilot is deleted afterwards. The production deployment loads the
  site's correct data, requested with `docs/migration/site-data-request-cmf-aligarh.md`.
