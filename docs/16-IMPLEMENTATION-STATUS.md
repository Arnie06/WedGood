# Implementation status and shared handoff ledger

This ledger is for Claude Code, Codex and human maintainers. Keep it factual; do not mark an item done on intent alone.

## Current state

| Field | Value |
|---|---|
| Active milestone | R0 (foundation) |
| Next ticket | R0-03 (local DB/auth), blocked on choosing a local-only database path (ADR-015) |
| Repository baseline | Next.js 16 App Router; design system, public landing, workspace shell and labelled `/preview`; `main` pushed to `github.com/Arnie06/WedGood` (public repo) |
| Stack versions | Locked; see ADR-013 and `pnpm-lock.yaml` (R0-02 added lucide-react 1.70.0, @playwright/test 1.65.1, @axe-core/playwright 4.14.0) |
| Migrations applied | None (no database yet; local-only per ADR-015) |
| Last verified commands | 2026-11-19: format:check, lint, typecheck, test:unit (125/125), test:e2e (62/62), build, all passing locally |
| External credentials | None supplied or required |
| Release status | Not deployable (no persistence, auth or product features) |

## Ticket log

| Ticket | Status (not started / in progress / blocked / done) | Branch/commit | Evidence / notes |
|---|---|---|---|
| R0-01 | done | `main` | See 2026-11-19 R0-01 entry |
| R0-02 | done locally; GitHub CI result pending its first run | `main` | See 2026-11-19 R0-02 entry |
| R0-03 | blocked | — | Needs a local-only database choice (ADR-015); Docker not installed |

## Session log

### 2026-11-19 · Claude Code · R0-02 · branch `main`

- **Scope:** ADR-014 resolved by the owner (blush primary with charcoal text, deep rose for emphasis and selected nav, eucalyptus for organizational controls, gold decorative). R0-02 design tokens, components, public landing and workspace shell. ADR-015 recorded: local-only, no hosted storage yet.
- **Docs:** `AGENTS.md` UI bullet (removed the sage-primary reference), `docs/03-DESIGN.md` (colour roles, semantic alias table, button/focus/input/progress rules), `docs/15-DECISIONS.md` (ADR-014 accepted, ADR-015), `docs/13-DEVOPS.md` (e2e commands). `prompts/08-UX-PROTOTYPE.md` still says "warm ivory/sage" as a general palette description. It doesn't name a primary button colour, so I left it unchanged.
- **Design system:** `src/styles/tokens.css` keeps all 47 Stitch colour tokens verbatim (`--stitch-*`), brand refs (`--vb-*`), and the semantic aliases declared once in `@theme static`. Tailwind's default palette is disabled. `src/styles/tokens.test.ts` checks the CSS against the YAML in `03-DESIGN.md` and checks 37 text, focus and boundary pairs against WCAG 2.2 AA. Components in `src/components/ui/` (Button/ButtonLink with five variants, Badge, Card, ProgressBar, TextField, Ornament). Global 2px eucalyptus `:focus-visible` outline that never animates. Fonts are EB Garamond and Manrope via `next/font`, self-hosted at build.
- **Shell and pages:** `src/components/shell/` (nav groups from 04-UX-FLOWS, desktop sidebar ≥1024px, mobile/tablet bottom nav with `aria-current`, masthead, compact hallmark, section overview). Routes: `/` landing; `/preview` home plus `/preview/{discover,plan,guests,more}`; `/design-system` (noindex internal reference); styled 404. The skip link is first in tab order.
- **Synthetic data:** `src/features/preview/sample-workspace.ts` follows the documented demo scenario (Alex & Morgan, 6 "Example" guests). Every figure is computed via pure domain functions in `src/domain/` (date-only countdown, exact minor-unit money formatting, commitment balances incl. T04, event RSVP and meal counts). The preview shows a persistent "fictional sample data" note and badge and is noindex. Tools that don't exist yet are labelled "Not available yet" and are not links.
- **Commands (via `npx pnpm@12.21.0`), all exit 0:** `format:check`, `lint`, `typecheck`, `test:unit` (125 passed), `test:e2e` (62 passed: axe with WCAG 2.0/2.1/2.2 A/AA tags on 7 routes at 320 and 1280px with zero violations; no horizontal overflow on 7 routes × 5 widths; nav pattern and 44×44px targets per breakpoint; skip link; keyboard tab order and focus-ring colour; `aria-current`; charcoal-on-blush CTA; sample-data labelling; 404), `build`.
- **Manual visual review:** screenshots at 320/390/768/1280/1440 inspected. Fixed overlapping budget figures in the narrow three-column card, wordmark and button wrapping in the 320px header (a class-order conflict: `hidden` was overridden by `inline-flex`), and the arch illustration's fill. Also fixed circular `@theme inline` variables and a transition that faded the focus ring in.
- **Not verified:** screen-reader pass (VoiceOver/NVDA), 200% zoom and reduced-motion behaviour by hand, WebKit/Firefox (Chromium only), and the GitHub Actions run. No WCAG conformance claim is made.
- **Known limitations:** `cn()` doesn't resolve conflicting Tailwind classes, so wrap an element instead of overriding a component's display class. Preview figures are computed from the fixture but the budget forecast is intentionally not shown (R1-06).
- **Next:** pick a local database path for R0-03 (ADR-015), e.g. install Docker for the local Supabase stack, or a local Postgres.

### 2026-11-19 · Claude Code · R0-01 · branch `main` (committed together with R0-02)

- **Scope:** Bootstrap only: Next.js/TS/pnpm baseline, lint/format/typecheck/unit-test/build scripts, env schema and example, gitignore, CI skeleton. No design system, DB, auth or product features.
- **Repo observed:** Docs/prompts/agent instructions only; not a git repo; Node 26.0.0, npm 11.12.1, Supabase CLI present; pnpm and Docker absent. Ran `git init -b main` (no commit).
- **Files added:** `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `vitest.config.ts`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `.env.example`, `.nvmrc`, `.github/workflows/ci.yml`, `src/app/{layout.tsx,page.tsx,globals.css}`, `src/lib/{env.ts,env.test.ts}`. Docs updated: `README.md` (local dev section), `docs/13-DEVOPS.md` (verified commands), `docs/15-DECISIONS.md` (ADR-013, ADR-014), this ledger.
- **Migrations:** none.
- **Commands (via `npx pnpm@12.21.0 …`), all exit 0:** `install`; `run format:check`; `run lint` (`--max-warnings=0`); `run typecheck` (`next typegen && tsc --noEmit`); `run test:unit` (1 file, 6 tests passed); `run build` (static `/`, `/_not-found`, no warnings); `run start -p 3100` returned HTTP 200 with the baseline security headers and no `X-Powered-By`; `run dev -p 3101` returned HTTP 200. A stdin lint probe confirmed `react/jsx-key`, `jsx-a11y/alt-text`, `no-explicit-any` and `no-img-element` fire.
- **Failures fixed along the way:** Prettier reformatted two new files; first build failed because `NEXT_PUBLIC_APP_URL` was unset in production mode (intended fail-fast; CI now sets it, and locally you copy `.env.example` to `.env.local`); a Turbopack root warning caused by a stray lockfile in a parent directory was fixed with `turbopack.root`.
- **Not run / unverified:** GitHub Actions workflow (no remote). Browser screenshots and responsive checks were not done; the only page is a static placeholder, and visual verification belongs to R0-02. `test:integration` and `test:e2e` scripts deliberately don't exist yet (R0-03/R0-05).
- **Integrations / flags:** none configured. No secrets in repo; `.env.local` is gitignored and holds only the public localhost URL.
- **Risks:** ESLint 9 is end of support and TS 7 is deferred because of peer ranges (ADR-013). `/` is an honest "foundation build" placeholder with no actions.
- **Next:** R0-02, after the owner picks an ADR-014 option. R0-03 needs Docker (or another documented isolated Postgres) for local Supabase; Docker is not installed on this machine.
- **Worktree:** committed and pushed with R0-02 at the owner's request.

## Session handoff template (append one per completed session)

- Date / agent / ticket / branch / commit if any:
- User-requested scope and decisions:
- Files changed and relevant symbols:
- Migrations (ordered, local/remote status):
- Commands run and exact pass/fail/not-run summary:
- Screenshots/artifacts and manual verification:
- Integrations/feature flags (configured, mocked, unconfigured):
- Security/performance/accessibility risks and blockers:
- Remaining tasks, assumptions, and next bounded ticket:
- Uncommitted changes or worktree warnings:

## Reporting rules

Do not include tokens, passwords, guest details, actual wedding contracts or proprietary source copied from unrelated repositories. Link to paths/commit hashes rather than duplicate code. Record unresolved issues and reproducible steps. A failed or skipped test is not a pass. Do not update this ledger for work outside the requested scope unless documenting an observed blocker.
