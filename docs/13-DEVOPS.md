# Developer setup and operations

This is a proposed runbook; exact scripts must be implemented and verified in R0. Do not claim commands work before running them. Use official version compatibility docs; choose supported Node LTS and pnpm version, record in packageManager/engines and version manager file. Lock dependencies. Avoid global OS changes.

## Verified commands (R0-01/R0-02, 2026-11-19)

Requires Node 26 LTS (`.nvmrc`) and pnpm 12.21.0 (`packageManager`). If pnpm isn't installed, prefix the commands with `npx pnpm@12.21.0` instead of `pnpm`. Development is local-only for now (ADR-015).

```bash
cp .env.example .env.local   # public localhost URL only; production builds need NEXT_PUBLIC_APP_URL
pnpm install --frozen-lockfile
pnpm dev                     # http://localhost:3000
pnpm format:check            # pnpm format to fix
pnpm lint                    # ESLint, zero warnings allowed
pnpm typecheck               # next typegen && tsc --noEmit
pnpm test:unit               # Vitest, including token contrast checks
pnpm exec playwright install chromium   # once per machine (browser cache, not a global npm install)
pnpm test:e2e                # builds, serves on :3200, runs axe, responsive and keyboard tests
pnpm build && pnpm start
```

`test:e2e` writes screenshots for manual review to `test-results/screenshots/<viewport>/` (gitignored). `db:*` and `test:integration` below are not implemented yet (R0-03/R0-05). They are deliberately absent rather than stubbed.

## Expected workflow after bootstrap

```bash
pnpm install --frozen-lockfile
# Start local Supabase via documented CLI (Docker required) if configured
pnpm db:start
pnpm db:reset        # LOCAL only, destructive; never against production
pnpm dev
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm build
```
Scripts are contract names, not existing files. If no Docker, provide documented setup for isolated dev database or offline UI prototype explicitly labeled, never use fake auth for production. Set up migration generation/review and `db:types`. Add test setup for local auth users and two tenant fixtures. Local mail sink or copy link flow. Never reset or run destructive migrations remotely without explicit approval.

## Environment variables (proposed names)

| Variable | Scope | Required |
|---|---|---|
| NEXT_PUBLIC_APP_URL | public base URL | yes |
| NEXT_PUBLIC_SUPABASE_URL | public endpoint | yes |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | public publishable/anon key as appropriate | yes |
| SUPABASE_SERVICE_ROLE_KEY | server only, narrow jobs | only if necessary |
| DATABASE_URL | server migration/worker only | if required by tooling |
| EMAIL_PROVIDER_API_KEY / EMAIL_FROM | server | optional delivery |
| AI_PROVIDER_API_KEY / AI_MODEL | server | R2 optional |
| MAPS_PROVIDER_KEY | server or restricted browser key | optional catalog/maps |
| CRON_SECRET / WEBHOOK_SECRET | server | if jobs/webhooks configured |
| FILE_SCAN_PROVIDER_KEY | server | if production uploads enabled |
| INTEGRATION_ENCRYPTION_KEY | server | R3 OAuth |
| STORAGE_MAX_BYTES / AI_BUDGET_LIMIT | validated config | relevant feature |

Create `.env.example` with placeholders, no real credentials. Validate at startup per environment; optional adapters report unconfigured. Never expose service secrets through NEXT_PUBLIC. Production and staging separate projects/buckets/keys; use synthetic data in preview. Configure auth redirects/CORS, CSP, TLS, rate limiting, email domain and verified sender before enabling delivery.

## CI/CD

PR pipeline: install locked deps, typecheck, lint, unit, integration with isolated DB/migrations, build, E2E smoke and accessibility checks; secret/dependency scans; artifact screenshots/logs sanitized. Branch protection and human review for auth/RLS, migrations, money and guest data. Staging deploy after approved merge; smoke tests, migration dry run where possible, backup verification. Explicit owner approval before production release or external side effects. Use forward-compatible migrations (expand/backfill/contract), avoid destructive operations without rollback/restore plan. Pin provider configuration per environment.

## Monitoring and operations

Structured logs with request/correlation ID, actor pseudonymous ID, operation, status, latency; strip PII, tokens, contract content, raw query strings on capability routes. Error monitoring configured with scrubbing. Metrics: failed jobs, auth denials, conflict rates, export failures, email delivery, queue age, DB errors, slow pages, AI spend. Alerts for sustained failures, abuse and storage/cost limits. Set service quotas, timeout and file caps. Define recovery targets with owner before production (no unsupported SLA). Practice backup restore in isolated environment; audit and test erasure workflow. Incident steps: contain/revoke, preserve minimal evidence, assess scope, fix/verify, follow required notification procedures with legal guidance.

## Multi-agent workflow

One branch/worktree per ticket. Inspect `git status`, commits and ledger. No overwrite of uncommitted user work. Commit only if asked or repository convention permits; no push/deploy/install global software without approval. Merge serially and rerun tests after conflict resolution. Use handoff prompt to record files, migration ordering, test commands/results, open questions and next bounded ticket. No secrets or user data in logs/commits.
