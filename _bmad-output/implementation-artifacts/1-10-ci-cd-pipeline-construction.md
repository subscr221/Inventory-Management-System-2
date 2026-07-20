# Story 1.10: CI/CD Pipeline Construction

Status: ready-for-dev

## Story

As a platform engineer,
I want an automated CI/CD pipeline with build, test, deploy, branch protection, and version-controlled pipeline bootstrap IaC,
so that the deployment path Stories 1.1 and 1.9 presuppose exists as repeatable automation and no change reaches any environment except through the pipeline.

## Acceptance Criteria

1. **Given** a commit pushed to any branch, **when** the CI pipeline runs, **then** it builds the application, runs unit tests, integration tests, edge tests, edge accessibility checks, and the Spine Acceptance Contract suite, and publishes the results as required status checks.
2. **Given** a pull request into the protected default branch with any required status check failing, **when** a merge is attempted, **then** branch protection blocks the merge with no administrator bypass until the check passes.
3. **Given** a merge into the protected default branch, **when** the CD stage runs, **then** the build deploys to staging through the IaC under `deploy/` with zero manual steps, and production promotion requires an explicit approval recorded with the approver's identity.
4. **Given** a clean target host, either native server or cloud VPS, and the pipeline bootstrap IaC, **when** the bootstrap is executed, **then** the pipeline itself, including CI runners, artifact store, and deployment credentials, is provisioned entirely from version-controlled IaC and is reproducible rather than hand-built.

## Requirements

- Use `deploy/` for all runtime and pipeline IaC. Do not create `deploy/aws/` or depend on AWS-specific assumptions from superseded planning drafts.
- Preserve the architecture rule that deployment remains vendor-neutral: native server or cloud VPS, Docker Compose, self-managed PostgreSQL 18.4, self-hosted PowerSync, Node.js 24, Next.js 16 standalone, and nginx or Caddy.
- Satisfy NFR-E-04 by making upgrades repeatable and under 30 minutes through immutable build artifacts, automated staging deployment, and production promotion of the same artifact.
- Keep the Story 1.9 required status check name exactly `spine-acceptance-contract`.
- Wire the Story 1.8 edge accessibility command as a required CI status check.
- Target the repository's actual protected default branch. Current repository evidence shows `master`, while the planning text says `main`. The implementation must detect or parameterize the default branch and must not protect a non-active branch.

## Tasks / Subtasks

- [ ] Task 1: Add CI workflow with stable required checks (AC: 1, 2)
  - [ ] 1.1 Create `.github/workflows/ci.yml` or an equivalent checked-in CI entry point triggered by every branch push and pull request.
  - [ ] 1.2 Use Node.js 24 and `npm ci`; do not replace existing Node test, TypeScript, ESLint, or Playwright tooling.
  - [ ] 1.3 Add a required check named `backend-quality` that runs `npx tsc --noEmit`, `npm run lint`, `npm run build`, and `git diff --check`.
  - [ ] 1.4 Add a required check named `backend-tests` that provisions PostgreSQL 18.4 with the project roles, applies migrations, and runs `npm test` serially.
  - [ ] 1.5 Add a required check named exactly `spine-acceptance-contract` that calls `npm run spine-acceptance-contract` without reimplementing its reporter flags.
  - [ ] 1.6 Upload `spine-acceptance-contract-results.xml` as a workflow artifact when present. Artifact upload must use `if: always()` so failed test runs still preserve available evidence.
  - [ ] 1.7 Add required edge checks for `npm run edge:typecheck`, `npm run edge:lint`, `npm run edge:test`, `npm run edge:build`, and `npm run edge:accessibility`.
  - [ ] 1.8 Install Playwright Chromium and required browser dependencies in CI before browser and accessibility checks.
  - [ ] 1.9 Keep required check names stable. Do not use a matrix that appends runtime suffixes to required status names.
  - [ ] 1.10 Do not use path filters on required jobs unless there is an always-reporting gate job that fails when any conditional required check fails.

- [ ] Task 2: Make CI database provisioning deterministic (AC: 1)
  - [ ] 2.1 Ensure CI creates or starts a PostgreSQL 18.4 database compatible with `.env.test`.
  - [ ] 2.2 Ensure `admin_user`, `app_user`, `readonly_user`, `replication_user`, and `svc_powersync` exist where required by the selected CI path.
  - [ ] 2.3 Apply repository migrations with the existing `npm run db:migrate` path or the existing Compose init SQL, without introducing a new migration framework.
  - [ ] 2.4 Preserve integration test serial execution with `--test-concurrency=1`.
  - [ ] 2.5 Ensure backend regression and spine-contract jobs do not mutate the same database in parallel unless each job receives an isolated database or isolated service container.
  - [ ] 2.6 Preserve the audit-trigger cleanup pattern used by existing integration tests. CI database privileges must allow the harness to disable triggers for cleanup and re-enable them in `finally` blocks.

- [ ] Task 3: Add branch protection and environment bootstrap IaC (AC: 2, 4)
  - [ ] 3.1 Add a version-controlled bootstrap area under `deploy/`, preferably `deploy/pipeline/`, for repository protection, environments, runner setup, artifact store configuration, and deployment credentials.
  - [ ] 3.2 Add branch-protection IaC that configures required status checks for the protected default branch, with `enforce_admins` set to true.
  - [ ] 3.3 Configure branch protection with no bypass users, teams, apps, or administrator bypass allowances unless the repo platform requires an empty structure to express none.
  - [ ] 3.4 Make the bootstrap script detect the actual default branch through the platform API or accept it as an explicit variable. Current default is `master`; do not hard-code `main` blindly.
  - [ ] 3.5 Add environment bootstrap for `staging` and `production`. `production` must require a reviewer and must disallow administrator bypass of environment protection where the platform supports it.
  - [ ] 3.6 Add a dry-run or verification mode that reads back branch protection and environment settings and fails if required checks, admin enforcement, or production approvals are missing.
  - [ ] 3.7 Do not commit real deployment secrets. Bootstrap should reference secret names and instructions, or provision encrypted secrets through the platform API.

- [ ] Task 4: Add CD workflow and immutable artifact promotion (AC: 3, 4)
  - [ ] 4.1 Create `.github/workflows/cd.yml` or an equivalent checked-in CD entry point triggered only after successful CI on the protected default branch.
  - [ ] 4.2 Build backend and edge container images once per commit and tag them with the commit SHA or content digest.
  - [ ] 4.3 Push immutable images to a configurable OCI registry or artifact store. Do not rebuild separately in staging and production.
  - [ ] 4.4 Extend `deploy/compose/` with an environment-specific override or image-variable path so staging and production can consume the same immutable images instead of local `build:` entries.
  - [ ] 4.5 Add a noninteractive staging deploy path under `deploy/` that starts or updates the Compose stack, applies existing migrations through the existing migration command or migration artifact, and verifies `/api/v1/health`.
  - [ ] 4.6 Ensure staging deployment runs automatically after merge with zero manual steps and uses only staging-scoped secrets.
  - [ ] 4.7 Add a production promotion job that uses the same image digests as staging and references the protected `production` environment so GitHub records the approving identity before secrets are released.
  - [ ] 4.8 Add deployment concurrency control so multiple merges cannot interleave staging or production deployment.
  - [ ] 4.9 Add upgrade timing evidence to the deployment log so NFR-E-04 can be checked against the 30-minute upgrade target.
  - [ ] 4.10 Do not run CD on `pull_request`, `pull_request_target`, arbitrary branch pushes, or untrusted fork contexts.

- [ ] Task 5: Preserve and update existing deploy scripts safely (AC: 3, 4)
  - [ ] 5.1 Reuse `deploy/compose/docker-compose.yml`, `deploy/provision/provision.sh`, `deploy/provision/teardown.sh`, `deploy/backup/backup.sh`, root `Dockerfile`, `edge/Dockerfile`, and `sync/` configuration instead of replacing the deployment architecture.
  - [ ] 5.2 Fix or wrap `deploy/provision/provision.sh` so hosts with Docker Compose v2 but no `docker-compose` binary pass validation.
  - [ ] 5.3 Do not assume the root `npm start` script works for production smoke tests; current Dockerfile starts `dist/src/server.js` while `package.json` starts `dist/server.js`.
  - [ ] 5.4 Do not assume runtime containers can run migrations unless the required migration source files are present in the image or supplied as a migration artifact.
  - [ ] 5.5 Keep production OIDC, SCIM, and PowerSync secrets fail-closed. Use environment secrets, not committed real values.
  - [ ] 5.6 Preserve PostgreSQL 18.4, PowerSync 1.23.x, Node.js 24, Next.js 16 standalone output, and self-hosted deployment topology.

- [ ] Task 6: Add implementation verification and documentation evidence (AC: 1, 2, 3, 4)
  - [ ] 6.1 Verify a push or pull request run reports all required CI checks with stable names.
  - [ ] 6.2 Verify a deliberately failing required check blocks merge to the protected default branch for administrators as well as normal contributors.
  - [ ] 6.3 Verify a merge to the protected default branch deploys to staging with no manual step.
  - [ ] 6.4 Verify production promotion requires explicit approval and that the approver identity is visible in the deployment record.
  - [ ] 6.5 Verify a clean host can bootstrap the runner, artifact store or registry references, branch protection, environments, and deployment credentials from `deploy/pipeline/` without hand-building platform state.
  - [ ] 6.6 Run the full local or CI validation set and record results in the Dev Agent Record.

## Dev Notes

### Current Repository State

- Story 1.10 is the first backlog story in `sprint-status.yaml`; Stories 1.1 through 1.9 are done.
- There is currently no `.github/` directory and no checked-in CI or CD workflow.
- Research found the GitHub repository default branch is `master`, not `main`. The planning AC text says `main`; implementation must protect the actual default branch or make the protected branch configurable.
- GitHub branch protection is currently absent on `master`; Story 1.10 must add version-controlled bootstrap to create and verify it.
- GitHub Actions is available, but no workflow runs, required checks, repository environments, or branch rulesets exist yet.

### Previous Story Intelligence

- Story 1.9 delivered `npm run spine-acceptance-contract` and deliberately did not create CI YAML or branch protection. Story 1.10 owns that wiring.
- Story 1.9 fixed the required check name as `spine-acceptance-contract`. Do not rename, duplicate, or reimplement this check.
- The Story 1.9 script runs ESLint before `test/integration/story-1-9.test.ts`, then emits JUnit XML at `spine-acceptance-contract-results.xml`.
- Story 1.9 added production router-surface assertions through `createAppRouter`, `createAppServer`, and route introspection. CI should run the existing script to preserve this exact behavior.
- Story 1.8 created the edge workspace, PowerSync wiring, Playwright tests, and the `edge:accessibility` command. Story 1.8 AC6 explicitly says Story 1.10 wires accessibility as a required CI status check.
- Story 1.1 created the deploy substrate under `deploy/` and deferred CI/CD to this story. Reuse that substrate.
- Recent regression evidence in sprint status shows backend `npm test` at 143/143, spine gate at 6/6, edge Playwright at 9/9, edge unit tests at 14/14, TypeScript clean, ESLint clean, and `git diff --check` clean.

### Architecture Compliance

- The deployment-portability rule is binding: no component may depend on a cloud-vendor-proprietary managed service. This story may use GitHub repository automation because the repo itself is on GitHub, but deployment targets and runtime architecture must remain native-server or cloud-VPS portable.
- Existing architecture structural seed places all infrastructure under `deploy/`, specifically `compose/`, `provision/`, and `backup/`. Add pipeline bootstrap under `deploy/` rather than a top-level infrastructure directory.
- The production profile is Dockerized backend, edge PWA, PowerSync, projection workers, and notification service behind nginx or Caddy, with self-managed PostgreSQL primary plus streaming-replication standby.
- Staging is a single-node Docker Compose target. CD must deploy to staging through IaC and verify health.
- Production promotion must be gated and auditable. GitHub environment approvals record approver identity and keep production secrets unavailable until the required reviewer approves.
- The same immutable images must be promoted from staging to production. Rebuilding separately per environment violates repeatability and weakens NFR-E-04.

### Current Files to Preserve or Update

- Existing deploy files to preserve and extend:
  - `deploy/compose/docker-compose.yml`
  - `deploy/compose/init-db.sql`
  - `deploy/compose/init-pg-hba.sh`
  - `deploy/compose/init-wal-archive.sh`
  - `deploy/compose/nginx.conf`
  - `deploy/provision/provision.sh`
  - `deploy/provision/teardown.sh`
  - `deploy/backup/backup.sh`
  - `deploy/backup/pgbackrest.conf`
  - `Dockerfile`
  - `edge/Dockerfile`
  - `sync/powersync.yaml`
  - `sync/sync-rules.yaml`
- Likely new files:
  - `.github/workflows/ci.yml`
  - `.github/workflows/cd.yml`
  - `deploy/pipeline/branch-protection.json`
  - `deploy/pipeline/environments.json`
  - `deploy/pipeline/bootstrap.sh`
  - `deploy/pipeline/verify.sh`
  - `deploy/pipeline/runner/` files if self-hosted runner bootstrap is implemented there
  - `deploy/compose/docker-compose.staging.yml` or another Compose override for immutable image deployment
- Likely updates:
  - `package.json` for stable CI aliases if needed
  - `edge/playwright.config.ts` for CI reporter, retries, traces, screenshots, workers, and artifact paths
  - `deploy/provision/provision.sh` for Compose v2 support and noninteractive deployment inputs
  - `.gitignore` for generated CI reports, if new reports are emitted

### Required CI Commands and Tooling

- Backend commands already available:
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npm run build`
  - `npm test`
  - `npm run test:integration`
  - `npm run spine-acceptance-contract`
  - `npm run db:migrate`
- Edge commands already available:
  - `npm run edge:typecheck`
  - `npm run edge:lint`
  - `npm run edge:test`
  - `npm run edge:build`
  - `npm run edge:accessibility`
- Test harness facts:
  - Backend tests use Node's built-in `node:test` runner and `.env.test`.
  - Integration tests run serially with `--test-concurrency=1`.
  - Integration tests require real PostgreSQL, not mocks.
  - Cleanup uses audit-trigger disable and re-enable around table truncation. CI must provide sufficient privileges.
  - `npm run sync:smoke` is Windows PowerShell based and Docker dependent; do not rely on it unchanged in Ubuntu CI.

### Branch Protection Requirements

- The protected branch must be the actual default branch. In this repo that is currently `master`; planning text says `main` because it uses generic language.
- Required checks should include at least:
  - `backend-quality`
  - `backend-tests`
  - `spine-acceptance-contract`
  - `edge-quality`
  - `edge-accessibility`
- If implementation uses a final aggregate required check, individual test jobs may still publish named checks, but the aggregate must fail whenever any underlying required result fails.
- Branch protection must require status checks to pass, require the branch to be up to date if practical, and set administrator enforcement on.
- There must be no bypass allowances for the required checks or pull request requirements unless a platform limitation forces a documented exception.

### Deployment Requirements

- CD must run only after successful CI on the protected default branch.
- Staging deployment must use staging-scoped secrets and run without human action after merge.
- Production must use protected environment approval with identity capture.
- CI and CD must not expose deployment secrets to pull requests, fork contexts, or arbitrary branch pushes.
- Deployment scripts must support noninteractive execution and fail with clear messages when required environment variables or secrets are missing.
- The deployment path must preserve `/api/v1/health` as the health check and preserve nginx routing for `/api/`, `/powersync`, and `/`.

### Latest Technical Information

- GitHub Actions artifact upload supports `actions/upload-artifact@v4` with named artifacts and retention settings. Use it for JUnit XML, Playwright reports, and deployment evidence when those files exist.
- GitHub Actions environments can require reviewers, prevent self-review, restrict deployment branches, hold environment secrets until protection rules pass, and create deployment records with environment status.
- GitHub branch protection REST APIs support required status checks, `enforce_admins`, pull request review rules, force-push blocking, deletion blocking, and readback verification.
- Use current GitHub REST API headers in bootstrap scripts and avoid embedding tokens in logs.

### Anti-Patterns to Avoid

- Do not protect `main` while the active default branch remains `master`.
- Do not rename `spine-acceptance-contract` or create a second version of that gate.
- Do not use a CI matrix if it changes required check names after branch protection is configured.
- Do not run backend integration tests and the spine gate against the same database concurrently.
- Do not assume a plain PostgreSQL service is enough without project roles, grants, migrations, and trigger privileges.
- Do not skip required jobs through path filters without a stable reporting gate.
- Do not deploy by rebuilding source independently on staging and production.
- Do not use AWS CodePipeline, CodeBuild, ECS-only deployment assumptions, or `deploy/aws/`.
- Do not commit real production or staging secrets.
- Do not run deployment jobs on untrusted PR contexts.
- Do not rely on the current Windows-only `sync:smoke` command in Linux CI unless it is made platform-neutral.
- Do not confuse existing runtime IaC with pipeline bootstrap IaC; AC4 requires provisioning of pipeline state as code.

### Testing Requirements

- A complete implementation must run or provide CI evidence for:
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npm run build`
  - `npm test`
  - `npm run spine-acceptance-contract`
  - `npm run edge:typecheck`
  - `npm run edge:lint`
  - `npm run edge:test`
  - `npm run edge:build`
  - `npm run edge:accessibility`
  - `git diff --check`
- Branch protection evidence must include readback of required checks and `enforce_admins: true`.
- Deployment evidence must include staging health verification and production approval identity capture.
- If a command cannot run locally because Docker or GitHub admin credentials are unavailable, the dev agent must record the blocker honestly and provide the exact CI or bootstrap command that verifies the requirement.

### Project Context Reference

- BMad Phase 4 implementation is active. Pilot slice includes Epics 1, 2, 3, 5, 7, 8, 9, Story 11.2, and Epic 13.
- Markdown files must follow `FORMATTING_RULES.md`: one H1 first line, clean heading hierarchy, hyphens instead of em dashes in prose, no arrow sequences in prose, wrapped links only, and referenced tables if any are added.
- Multi-file migration work must keep each migration self-sufficient with guarded grants.
- Tagging enforcement must remain scoped to inventory stream types and must not affect DOA, SCIM, audit, or generated system writes.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` Story 1.10 lines 851 to 877]
- [Source: `_bmad-output/planning-artifacts/epics.md` Additional Requirements lines 257 to 276]
- [Source: `_bmad-output/planning-artifacts/epics.md` Epic 1 goal and architecture lines 335 to 347]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` Stack lines 184 to 199]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` Structural Seed lines 201 to 240]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` Deployment Topology lines 293 to 308]
- [Source: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md` NFR-E lines 455 to 466]
- [Source: `_bmad-output/implementation-artifacts/1-1-core-infrastructure-deployment-and-event-store-schema.md` deployment and CI deferral lines 273 to 317]
- [Source: `_bmad-output/implementation-artifacts/1-8-offline-edge-pwa-shell-and-powersync-sync-layer.md` AC6 lines 37 to 39]
- [Source: `_bmad-output/implementation-artifacts/1-9-spine-acceptance-contract-ci-gate.md` CI handoff lines 38 to 42 and completion notes lines 146 to 151]
- [Source: `package.json` scripts lines 9 to 25]
- [Source: `deploy/compose/docker-compose.yml` services and PostgreSQL 18.4 config lines 1 to 188]
- [Source: `deploy/provision/provision.sh` current provisioning behavior lines 1 to 65]
- [Source: `edge/package.json` scripts lines 6 to 16]
- [Source: `edge/playwright.config.ts` current Playwright config lines 1 to 16]
- [Source: GitHub Docs, workflow artifacts]
- [Source: GitHub Docs, environments for deployment]
- [Source: GitHub Docs, protected branches REST API]

## Dev Agent Record

### Agent Model Used

fugu-ultra-20260615

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.

### File List

## Change Log

- 2026-07-20: Created Story 1.10 as ready-for-dev with CI, CD, branch protection, pipeline bootstrap, deployment, testing, and regression guardrails.
