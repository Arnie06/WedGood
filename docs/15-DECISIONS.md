# Architecture / product decision records

All entries below are proposals from the blueprint unless marked accepted by the project owner or confirmed in implementation. Record decisions before divergence; do not silently treat hypothetical vendors, pricing, stack or compliance as finalized.

| ADR | Proposed choice | Rationale / alternative |
|---|---|---|
| 001 | Next.js + TS + PostgreSQL/Supabase, modular monolith | Relational integrity, responsive web, low operational overhead; alternatives dedicated backend/ORM if repo warrants |
| 002 | PWA first, native later | One codebase, browser guest RSVP, mobile parity; native only after validated need |
| 003 | Manual discovery and licensed adapter before marketplace | Useful without supply network; avoids scraping and fabricated catalog |
| 004 | Deterministic domain core; AI proposals R2 | Correct budget/RSVP/seat behavior independent of provider |
| 005 | Tenant composite FKs, RLS + capability checks | Defense in depth, least privilege; no UI-only security |
| 006 | One currency R1, integer minor units | Prevent rounding errors and misleading mixed-currency aggregates |
| 007 | Fixed exports with recipient allowlists | Repeatable handoff, privacy; live view and ZIP bundles later |
| 008 | Mobile bottom navigation / calm editorial design | Reduce complexity and maintain accessibility |
| 009 | Local-first development with synthetic fixtures, real DB tests | Repeatability, avoids touching production; no mock persistence for release |
| 010 | Explicit external-action approvals | Prevent accidental spending, booking or messaging |
| 011 | Optimistic version concurrency + transaction locks | Prevent lost edits and overfilled tables |
| 012 | R1 PDF/CSV, basic seating; full canvas R3 | Limit MVP risk while retaining core connected experience |

## Implementation decisions

ADR-013 — R0-01 toolchain and locked versions
Date / status: 2026-11-19 · accepted in implementation (R0-01); owner may revise.
Context: Empty docs-only repository (not a git repo). Local Node v26.0.0; pnpm not installed; no Docker. Versions checked against npm registry metadata and peer ranges on 2026-11-19.
Decision (exact pins in `package.json`, resolved tree in `pnpm-lock.yaml`):
- Runtime: Node 26 (Active LTS "Lithium"); `.nvmrc` = 26, `engines.node` = `>=26.0.0 <27`. pnpm 12.21.0 via `packageManager`; run with `npx pnpm@12.21.0` until pnpm is installed (no global install made).
- App: Next.js 16.4.6 (App Router, Turbopack), React/React DOM 19.3.1, Zod 4.6.7.
- Styling: Tailwind CSS 4.3.5 via `@tailwindcss/postcss` (CSS-first config; tokens land in R0-02).
- TypeScript **6.0.3, not 7.0.2**: `typescript-eslint` 8.73 (required by `eslint-config-next`) declares `typescript <6.1`. Strict mode plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- Lint: ESLint **9.39.5** flat config with `eslint-config-next` 16.4.6 (core-web-vitals + typescript, jsx-a11y). ESLint 9 is marked end of support, but ESLint 10 is outside the declared peer ranges of `eslint-plugin-react` 7.37.5, `eslint-plugin-import` 2.32.0 and `eslint-plugin-jsx-a11y` 6.10.2. A scratch probe with ESLint 10 ran the sampled rules but left unmet peers. Dev-only tooling, no runtime exposure.
- Format: Prettier 3.10.1 (`printWidth` 100; hand-written Markdown specs excluded). Unit tests: Vitest 5.1.1 (node environment).
- CI: GitHub Actions (`actions/checkout@v7`, `pnpm/action-setup@v6`, `actions/setup-node@v7`): frozen install, format check, lint, typecheck, unit tests, build. Not yet run on GitHub (no remote).
- Env: `src/lib/env.ts` validates public config with Zod; `NEXT_PUBLIC_APP_URL` defaults to localhost outside production and is required (https, or localhost) for production builds, fail-fast.
- Baseline headers in `next.config.ts` (nosniff, referrer policy, frame deny, permissions policy, no `X-Powered-By`). Full CSP deferred until auth/shell exist.
Consequences and tradeoffs: ESLint is on an unsupported line until the React/import plugins declare ESLint 10 support; TS 7 deferred likewise.
Follow-up and reversal plan: Re-check peers when bumping `eslint-config-next`; move to ESLint 10 / TS 7 once peer ranges allow, then rerun lint/typecheck. Add CSP with auth work (R0-03/R0-04).

ADR-014 — Primary action colour and semantic colour roles
Date / status: 2026-11-19 · **accepted by project owner**.
Context: `AGENTS.md` specified "accessible forest/sage primary actions", while `03-DESIGN.md` made blush rose `#D88C9A` the primary button colour and allowed white text on it (2.58:1, fails AA).
Decision and owner approval: The design direction is Google Stitch Vow & Bloom, Couture Editorial Minimalism.
- Primary button: `#D88C9A` with `#1B1C1A` text (6.63:1). Never white text on light blush for normal-size text.
- High-emphasis primary: `#8B4B58` with `#FFFFFF` text (6.47:1), reserved for high-emphasis actions and selected navigation states.
- Secondary: `#3D5A50` with white text when filled (7.56:1) or eucalyptus text and border when outlined (7.2:1 on canvas). Used for organizational controls, progress indicators and confirmed statuses.
- Decorative accent: `#D4AF37`, decoration only.
- The original Stitch tokens are preserved verbatim; semantic application aliases are centralized in `src/styles/tokens.css`. Tailwind's default palette is disabled, so only semantic colours are available as utilities.
Consequences and tradeoffs: Focus indicators use eucalyptus (2px outline, 2px offset). Input boundaries use `#847375` rather than `#EAE3D9` to meet 3:1 non-text contrast. The blush button fill is 2.46:1 against ivory; WCAG 1.4.11 does not require a text button's fill to contrast with its surroundings because the charcoal label identifies the control. Hover and pressed tints were chosen to keep text ≥4.5:1.
Files/tests affected: `AGENTS.md`, `docs/03-DESIGN.md`, `src/styles/tokens.css`, `src/styles/tokens.test.ts` (computes contrast from the actual CSS), `tests/e2e/accessibility.spec.ts` (axe, WCAG 2.2 AA tags).
Follow-up and reversal plan: Any palette change must keep `tokens.test.ts` green. Manual screen-reader and 200% zoom checks remain open (see ledger).

ADR-015 — Local-only development until hosted storage is approved
Date / status: 2026-11-19 · accepted by project owner.
Context: The owner is not ready for non-local (hosted) storage. Supabase or an equivalent hosted backend is expected later. Docker is not installed, so the local Supabase stack cannot run here today.
Decision: No hosted database, storage, auth provider or deployment for now. Work continues locally. R0-02 needs no persistence; its preview uses in-repo synthetic fixtures labelled as sample data. Before R0-03, choose a local-only database path, for example installing Docker for the local Supabase CLI stack, or a local Postgres, so that RLS and integration tests are real rather than mocked.
Consequences: R0-03 onward is blocked until that local option is selected. No mock persistence will be presented as real.
Follow-up: Revisit when the owner approves a hosted provider; production auth and data never fall back to demo fixtures.

## Open decisions (do not invent answers)

- Product name, logo, domain, trademark, brand approval.
- Target launch region, currency, locales; initial privacy policy and accessibility obligations.
- Team/budget, hosting, exact versions, analytics and auth flow. Confirm existing repo conventions first.
- Whether to prioritize licensed marketplace search earlier; provider terms, pricing data, reviews/availability rights.
- Email sender and consent policy, scanning provider, production upload enablement, AI provider/data retention and quotas.
- Whether partner access defaults should be narrowed; retention, export and account deletion rules with legal guidance.
- Final pricing, plans, guest limits and support; no billing enabled without approval.
- User validation of complex seating editor, cultural/destination needs and marketplace strategy.

## Decision template

```
ADR-XXX — Title
Date / status: proposed | accepted | superseded
Context:
Options considered:
Decision and owner approval:
Consequences and tradeoffs:
Files/tests affected:
Follow-up and reversal plan:
```
