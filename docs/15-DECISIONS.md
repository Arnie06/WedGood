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
Consequences: No mock persistence will be presented as real.
Resolution (2026-11-19): owner chose Docker with the local Supabase CLI stack. OrbStack supplies Docker on the dev machine; Supabase CLI 2.120.0; Postgres 17 image. Hosted storage remains unapproved.
Follow-up: Revisit when the owner approves a hosted provider; production auth and data never fall back to demo fixtures.

ADR-016 — Membership administration model (R0-04)
Date / status: 2026-11-19 / accepted by Claude Code as a small reversible implementation decision; owner may amend.
Context: R0-04 needs partner invites, role changes, removal and last-owner protection (docs/10-SECURITY.md role matrix).
Decision:
- Roles are `owner`, `partner`, `editor`, `viewer`. Multiple owners are allowed; promoting to owner is owner-only. A wedding can never lose its last active owner (serialized by locking the wedding row; concurrent mutual removal is tested).
- Partners are trusted by default but have no member administration. An owner may grant a partner `manage_members`, which lets that partner invite and administer only editors and viewers. Grants are stored in `memberships.permissions`, whitelisted, and cleared when the role leaves partner or the member is removed.
- Invitations are email-matched, one-time, expire (default 7 days, max 30) and revocable. The app generates a 256-bit token and sends only its SHA-256 digest to the database; the raw token appears once in the owner's UI as a copyable link. No email is sent (copy-link fallback, per docs/04-UX-FLOWS.md). Every redemption failure returns one generic message. Redemption is a POST action (never a GET), requires a confirmed email on the account, and the invite page sets noindex and `no-referrer`.
- Non-members and unknown workspace ids get the same 404, in both the route guard and the RPC error codes, so existence is not leaked.
- All writes are SECURITY DEFINER RPCs that re-check the actor; clients hold SELECT only. `token_hash` is not selectable by any client role.
Consequences: Owner transfer "with recent confirmation" (security spec) is not built; multi-owner promotion has no re-authentication step yet. No rate limiting on redemption yet (no infrastructure). Removed members who are re-invited reactivate the same membership row.
Files/tests: `supabase/migrations/20261120120000_membership_admin.sql`, `tests/integration/membership.test.ts`, `src/domain/permissions`, `src/server/{auth,members,supabase}`, `tests/e2e/membership.spec.ts`.
Follow-up: add recent-auth confirmation for owner promotion/removal, redemption rate limiting, and optional email delivery behind the R1-17 provider adapter.

ADR-017 — Checklist scheduling and date-change review (R1-02)
Date / status: 2026-11-19, accepted (made under the R1-02 ticket; owner may revisit)
Context: Domain rules require date changes to preview relative tasks, never silently move fixed deadlines, and make template regeneration non-duplicating and non-destructive.
Decision:
- Tasks are `fixed` or `relative`. Relative tasks (suggested template, stable `template_key`, signed `offset_days` from the wedding date) store a derived `due_date`. Manual tasks are fixed. Editing the date of a relative task makes it fixed (a customization that never moves again). Completed tasks never move.
- The suggested checklist lives in `src/domain/tasks/templates.ts` and is passed to `generate_checklist`, which validates it and inserts with `on conflict (wedding_id, template_key) do nothing`. Archiving is a soft delete that keeps the key, so regeneration never resurrects a removed task. Generation is an explicit user action, not automatic on workspace creation.
- Saving a new wedding date does not touch tasks. Drift (open relative tasks whose stored date differs from date + offset) is derived, shown as a banner on Home and Plan, and resolved on `/plan/review-dates`. `reschedule_relative_tasks` applies only the reviewed `{id, version}` pairs, recomputes each date from the stored offset in SQL (client dates are never trusted), and aborts the whole batch if any task changed since the preview.
- `plan.edit` (owner, partner) is enforced in the database; editors and viewers read only. Editor plan editing "by explicit grant" (security spec) has no grant mechanism yet.
Consequences: After a date change, relative tasks keep their old dates until someone reviews them; the old date is not recorded in the audit (only changed field names). Task writes do not bump `weddings.revision` yet (needed once packages exist, R1-16). Assignees are validated as active members at write time; a later removal leaves a stale `assignee_user_id` that the UI shows as unassigned.
Files/tests: `supabase/migrations/20261122090000_tasks.sql`, `src/domain/tasks`, `src/server/plan`, `src/features/plan`, `src/app/app/[w]/plan`, `tests/integration/tasks.test.ts`, `tests/e2e/checklist.spec.ts`.
Follow-up: calendar/agenda view, dependencies and reminders are later tickets; revisit apply-before-commit if the owner wants a true "what if" preview of a date before saving it.

ADR-018 — Budget model, reserve and currency guard (R1-06)
Date / status: 2026-11-20, accepted (made under the R1-06 ticket; owner may revisit)
Context: docs/07 defines target, allocated, committed, paid, forecast and reserve, and test T01 fixes the reserve as a percentage of the known subtotal. Commitments and payments are R1-07, so the budget must work and stay honest before they exist.
Decision:
- Budget categories carry an optional target; items carry a cost mode (fixed, per guest with optional minimum, price x quantity). A null amount is unknown and never zero; a null or explicit zero target are different. `summarizeBudget` (`src/domain/budget/summary.ts`) is pure and already accepts commitments, allocations and payments, so R1-07 plugs in without changing it. The page passes none yet and says "nothing booked or paid is recorded yet".
- Reserve is `budget_settings.reserve_bp` (basis points of committed plus uncommitted known costs, half-up via BigInt). It is a plan, never a payment.
- An item covered by an active commitment counts once, as the commitment; an uncommitted item counts at least what was paid for it. Per-guest items use the wedding's guest target; there is no what-if guest scenario input yet (the domain function takes any guest count).
- Amounts have no stored currency, so a trigger refuses a base-currency change (`55006`) while any category target or item amount exists, rather than silently reinterpreting them. This resolves the R1-01 and R1-04 carry-over for budget figures only; quotes keep their own stored currency.
- Capability is `budget.manage` (owner and partner); writes are RPCs, versioned, audited by field name only, creates idempotent. Percent and tiered item pricing are not modelled (quotes in R1-04 do).
Consequences: Allocation overage is a warning, not a gate. The currency guard also counts archived rows. Cap of 300 costs and 40 categories keeps sums exact in JS numbers.
Files/tests: `supabase/migrations/20261126090000_budget.sql`, `src/domain/budget`, `src/server/budget`, `src/features/budget`, `src/app/app/[w]/plan/budget`, `tests/integration/budget.test.ts`, `tests/e2e/budget.spec.ts`.
Follow-up: R1-07 adds commitments, allocations, installments and payments and feeds them to `summarizeBudget`; per-category paid amounts and a guest what-if are not built.

## Open decisions (do not invent answers)

- Product name, logo, domain, trademark, brand approval.
- Target launch region, currency, locales; initial privacy policy and accessibility obligations.
- Team/budget, hosting, exact versions, analytics and auth flow. Confirm existing repo conventions first.
- Whether to prioritize licensed marketplace search earlier; provider terms, pricing data, reviews/availability rights.
- Email sender and consent policy, scanning provider, production upload enablement, AI provider/data retention and quotas.
- Whether partner access defaults should be narrowed; retention, export and account deletion rules with legal guidance.
- Final pricing, plans, guest limits and support; no billing enabled without approval.
- User validation of complex seating editor, cultural/destination needs and marketplace strategy.

## ADR-019: Booking and payment ledger (R1-07)

Status: accepted (implementation decisions made within the R1-07 ticket; no product owner decision needed).

Context: docs/07 and docs/06 define commitments, allocations, installments and payments; tests T03/T04 fix the figures. R1-06's `summarizeBudget` already accepts them.

Decision:
- Booking (`book_commitment`) is one atomic RPC: commitment, allocations, installment schedule and the vendor stage `booked`. It requires explicit confirmation, one active commitment per venue or vendor (more cost is an amendment), and a candidate version check. Selecting a quote never books.
- An active allocation covers a budget item once (partial unique index plus a row lock), so a booked cost is counted once as the commitment. A cost with its own payments cannot be booked, and a booked or paid cost cannot be archived (`archive_budget_item` replaced).
- Amendment (`amend_commitment`) keeps the old row as `superseded`, creates a new row that supersedes it, and moves recorded payments to it (count in the audit event). Signed rows are never edited in place.
- Payments are append-only facts: a refund cannot exceed net paid on its target (checked under a row lock), the paid date cannot be in the future in the wedding's time zone, overpayment is allowed and flagged, and a mistake is voided (kept, with a reason), never deleted. Voiding a charge that refunds depend on is refused. A payment targets exactly one of a commitment or an unbooked planned cost. A repeated receipt reference is refused (unique per wedding).
- Deviation from docs/06: `payments.installment_id` is not built. Installments are a plan; status is derived by matching net paid to installments oldest-due first. The schedule total may differ from the amount and is flagged, not blocked.
- The base currency is locked once any commitment or payment exists (extends the R1-06 guard).

Not built (follow-ups): cancellation with retained or non-refundable amounts (the stage `cancelled` stays unreachable), generated payment tasks, linking payments to specific installments, receipt documents (R1-08), contributions.

## ADR-020: Private documents (R1-08)

Status: accepted (implementation decisions within the R1-08 ticket; no product owner decision needed).

Context: docs/10 requires private buckets, upload intent, MIME and signature validation, randomized keys, checksums, quarantine until scanned, and no claim of scanning without a scanner. No scanner is configured.

Decision:
- Documents are owner and partner only (matches the budget/contract row of the role matrix). Rows, links and storage reads are denied to editors, viewers and non-members by RLS and the storage policy (`can_read_document_object`), which replaces the R0-03 any-member read policy.
- Clients never write storage or mark a file validated. `create_document_intent` (user JWT) records a `pending` row with a random key `<wedding>/<document>`; the server validates the bytes itself (signature, size, active-content heuristic for PDFs; PDF, JPEG, PNG, WebP; 10 MB), then uses the service role (`SUPABASE_SECRET_KEY`, server only, `src/server/supabase/admin.ts`) to store the object and call `complete_document` or `reject_document` (service_role only). `complete_document` checks the object exists with the declared size.
- Validated files are `unscanned`, never `clean`. Downloads of unscanned files are refused unless `DOCUMENTS_ALLOW_UNSCANNED_DOWNLOADS=true` (set only for local dev and the e2e server). Downloads are a 60-second signed URL created with the user's session so the storage policy re-checks role, archive and scan state. The UI labels every file "Not virus-scanned".
- Links use concrete nullable FKs (booking, payment, vendor, quote), exactly one per row, with composite tenant FKs (adds a `(wedding_id, id)` unique key on `payments`). Archive keeps the file and links but removes download access. Audit events carry field names only.
- Deviation from docs/06: no `visibility` column (all documents are manager-only now) and `commitments.document_id`, `payments.receipt_document_id` and `proposals.source_document_id` are not built; links replace them.

Follow-ups: a malware scanner adapter (flips `unscanned` to `clean`), cleanup of abandoned `pending` rows and orphaned objects, erasure of storage objects on wedding deletion, EXIF stripping, restore from archive, vendor-scoped document access, upload rate limiting beyond the in-flight cap.

## ADR-022: Events, invitations and accountless RSVP (R1-10)

Status: accepted (implementation decisions within the R1-10 ticket; no product owner decision needed).

Decision:
- Capability flow: the app generates a 256-bit token per invitation and passes only its SHA-256 digest to the database. The guest page `/rsvp/[token]` and its action call service-role-only RPCs (`rsvp_view`, `rsvp_submit`) on every request; there is no guest session. The token stays in the path (the spec prefers removing it where practical; a session redirect was not built). Mitigations: `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `Cache-Control: no-store`, no third-party scripts.
- Revoked, expired and unknown tokens return the same null and the same page text. Failed lookups are throttled in the database per hashed client key (20 failures per 10 minutes, then RS429).
- Scope: an invitation belongs to one event and optionally a household; members are existing guests. Partial unique index allows one active membership per guest per event; revoking frees the guest. A guest sees only their invitation's members, never contact or private details or the workspace id.
- Plus-ones: created only from the guest's own response, under the invitation row lock and the guest-write advisory lock, consuming quota; a repeat with the same name reuses the existing plus-one. Replays after success hit the version check.
- Optimistic concurrency: invitation `version`; the deadline check precedes the version check so a late guest hears the real reason. After the deadline only the owner can change answers, with a mandatory audited reason.
- Declining clears meal choice (check constraint). Raw links are shown once; "New link" rotates the token. Delivery is not modelled (R1-17); nothing is sent.
- Owner and partner only, same gate as guests.

Consequences: seating queue and stale-snapshot effects of a decline arrive with R1-11 (no seating exists yet). No event archive or delete. Editors have no invitation access.
Files/tests: `20261130090000_events_rsvp.sql`, `src/domain/events`, `src/server/{events,rsvp}`, `src/features/events`, `tests/integration/rsvp.test.ts`, `tests/e2e/rsvp.spec.ts`.

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

## ADR-021: Guests, households and CSV import (R1-09)

Status: accepted (implementation decisions within the R1-09 ticket; no product owner decision needed).

Decision:
- Guests are owner and partner only (RLS and RPC checks), matching the docs/10 matrix until a grant mechanism exists. Dietary, accessibility and private notes live in `guest_private_details` so a later grant can expose names without them. Exports and the guest list never include private fields or mailing addresses.
- Identity is the id. Name or email matches are shown as "possible duplicate" in the import preview and left out by default; the user may include them. Nothing is merged silently.
- Import is stateless and server-authoritative: the client sends raw CSV text and column choices; the server re-parses, re-validates and dedupes for both preview and commit, then calls one atomic RPC with a mandatory idempotency key. Invalid rows are never stored; the RPC also rejects the whole batch if any row is invalid. A consent acknowledgement is required; importing sends nothing to anyone.
- CSV injection: values are stored verbatim (a name may legitimately begin with `+` or `-`), rendered as escaped text, and neutralized with a leading apostrophe on export. Limits: 256 KB, 500 rows, 40 columns per import; 2,000 active guests per wedding.
- Households are found or created by name (case-insensitive, unique among active households); guests carry the name through the form or import.

## ADR-023: Seating layouts, snapshots and the guests lock order (R1-11)

Status: accepted (implementation decisions within the R1-11 ticket; no product owner decision needed).

Decision:
- One layout per event; owner and partner only. All writes are RPCs under the per-wedding guests advisory lock, the same lock RSVP submissions use, so capacity and eligibility checks serialize with answer changes (T10). Capacity counts tentative and confirmed seats; they are reported separately.
- A confirmed seat needs an active accepted answer for that event and a non-archived guest. A tentative seat needs a waiting answer and the layout's `allow_tentative` switch (off by default). RSVP changes act on seating inside their own transaction: decline, archive and invitation revocation remove the seat; accepting confirms a tentative seat in place; resetting to waiting keeps it as tentative when allowed, else removes it. Nothing is ever placed automatically.
- Finalizing freezes a jsonb snapshot (tables, guest names, meals, counts) at `layouts.revision`. Every plan-affecting change bumps `revision`, so stale means `revision <> finalized_revision`; there is no flag to drift. Finalize requires the revision the person reviewed. Old snapshots are never rewritten.
- `lock_wedding_for_guests` now authorizes first, then takes the advisory lock, then `FOR SHARE` on the wedding row. The old order deadlocked (40P01) when two writers both held the share lock and one updated `weddings.revision`; found by the concurrent T10 test. This also fixes the latent same race in `revoke_invitation` and other guest RPCs.
- Reports and CSV include names, tables, status and meals only; dietary and access notes are excluded until the package/redaction work (R1-13).

## ADR-024: Design boards (R1-13)

Status: accepted (implementation decisions within the R1-13 ticket; no product owner decision needed).

Decision:
- Every member can view boards and images (`design.view`); owner and partner write (`plan.edit`). All writes are RPCs with version checks and field-name-only audit events.
- Saved links are validated (http/https, host, no credentials or spaces, 2048 characters) and stored as text. No server code requests them, so there is no SSRF surface and no link previews. They render as outbound links with `noopener noreferrer nofollow`.
- Images reuse the ADR-020 pipeline in a separate private bucket `wedding-design` (JPEG, PNG, WebP, 5 MB): intent as the user, byte validation and storage with the service role, completion only by the service role. Each image records a rights statement (own, permission, inspiration only). Images are never described as scanned; the image route and previews follow the same `DOCUMENTS_ALLOW_UNSCANNED_DOWNLOADS` gate as documents.
- Images are served through an authorized route that reads with the member's own session so the storage policy re-checks access, with `nosniff`, a sandboxing CSP and private caching.
- Reordering uses move earlier/later buttons (the accessible alternative); drag-and-drop is not built.

Follow-ups: storage cleanup job, EXIF stripping, scanner adapter, publication and rights approval for guest-website images (R1-14), revision bump for packages (R1-16).


## ADR-025: Guest website (R1-14)

Status: accepted (implementation decisions within the R1-14 ticket; no product owner decision needed).

Decision:
- One site per wedding. Owner and partner (`plan.edit`) edit and publish; other members cannot read the row. Clients have SELECT only (the published snapshot column is not selectable); all writes are RPCs with version checks and field-name-only audit events.
- The draft is a JSON document of allowlisted keys, validated in the database as well as the app (`app_private.site_draft_ok`): text only, no HTML, https links only, event ids must belong to the wedding. React renders it as escaped text.
- Publishing copies the draft into an immutable snapshot built from explicit keys plus the chosen events' current name, kind and date. Later draft or event edits do not reach the public page until republished (the editor shows "published, with unpublished changes"). Unpublishing deletes the snapshot; the slug stays reserved to its wedding.
- Event visibility is `public` or `invited`. Public reads are service-role RPCs: the slug page returns only public events; the invitation route (`/w/[slug]/invite/[token]`) adds the one event the invitation is for, reuses the RSVP token hashing and failure throttle, collapses every failure to one message, is noindex/no-referrer, and links to the RSVP page.
- Preview is the saved draft behind a signed-in owner/partner session; no shareable draft token. Public pages are `force-dynamic` so unpublish is immediate.
- Images are out of scope. Publishing images needs the separate rights and approval step from ADR-020/024 and is deferred.

Follow-ups: images with a publication/rights step, private (password/token) sites, custom domains, CSP (ADR-013), per-IP throttle on the anonymous slug page.

## ADR-026: Sharing and comments (R1-15)

Status: accepted (implementation decisions within the R1-15 ticket; no product owner decision needed).

Decision:
- "Sharing" in R1 is membership-based. Collaborators (partner, editor, viewer) see exactly what their role's RLS already allows; no new link, token or anonymous access is added. The `/app/[w]/shared` page is a role-aware summary and a recent-comments feed, not a new permission surface. Restricted packages and share links stay with R1-16.
- Comments attach to three subjects every member can already read: vendor candidates, comparisons and design boards. Any active member, including a viewer, can read and post. A comment never exposes more than its author typed, and the subject must belong to the same wedding and be unarchived.
- Authors edit and delete their own comments; owner and partner may also delete others' (moderation). Nobody edits another person's words. Deleting is a hard delete; the audit event stays.
- Clients have SELECT only; writes and reads with author names are RPCs (`add_comment` idempotent, `edit_comment` version-checked, `delete_comment`, `list_comments`, `recent_comments`). Audit events carry the subject kind and a moderated flag, never the text. Limits: 2000 characters, 20 comments per user per minute, 500 per subject.
- Text is stored and rendered as plain text (React escaping, `whitespace-pre-wrap`).

Follow-ups: notifications and mentions, threaded replies, resolve/vote on decisions, comments on tasks and guests (sensitive: needs a scope rule), per-field collaborator grants for editors, an owner-facing activity view over audit events.



## ADR-027: Package builder (R1-16)

Status: accepted (implementation decisions, no owner question outstanding).

- **Snapshot and staleness.** A package stores the redacted document model (the only thing renderers receive), its SHA-256 digest, the plan revision and template version. Most modules do not bump `weddings.revision`, so staleness is decided by re-deriving the document from the live plan and comparing digests, not by revision. The revision is stored as evidence and checked at creation. Digests from another template version show "Not checked".
- **Consistency.** The projection is several RLS-scoped reads, not one database snapshot. Creation therefore re-derives the document and requires it to equal the approved preview digest and revision; a mismatch is refused with a reload message. The database stores what the server supplies and does not re-derive it; only owner/partner can call it, so this affects only their own export.
- **Synchronous generation.** No worker exists, so no queued/rendering status: files are rendered in the request, stored privately, then package and file rows are inserted in one RPC. The package id is the idempotency key and the preview fixes `generatedAt`, so retries render identical bytes.
- **Storage.** Dedicated private bucket `wedding-packages` with no `storage.objects` policy; only the service role reads it, after the app authorizes the user. Downloads verify size and SHA-256. Keys are derived in SQL.
- **PDF.** `pdf-lib` 1.17.1 (MIT, no dependencies, unmaintained since 2022 but stable) with built-in Times and Helvetica (Windows-1252). Unsupported characters are simplified and counted in the preview; the CSV keeps them. Custom fonts, tagged PDF and document-level accessibility tags are not done.
- **Scope of data.** Never included: guest names, contacts, dietary details, prices, links, files, relationship notes. Contacts and notes on agenda/design items are opt-in. Presets are suggestions; each section needs a capability and owner/partner only may create or read packages.
- **CSV** is one flat long-format file (Section, Table, Row, Column, Value) with a BOM and formula neutralization; it is not a workbook.
- **Deferred:** photographer, florist, family and guest-itinerary presets (need shot lists, travel data), archive preset, ZIP, expiring share grants (`share_grants`), package deletion/retention, download rate limiting, dietary details for caterers.

## ADR-028: Invitation delivery ledger and calendar export (R1-17)

Status: accepted (implementation decisions, no owner question outstanding).

- **Truthful status.** `invitations.delivery_status` is `not_sent` or `shared_manually` only, plus `delivery_marked_at`. "Shared" records what the owner says they did; the app never claims delivered, opened or read. Set through `set_invitation_delivery` (owner/partner, versioned, audited, revoked refused). A trigger resets the status when the link is replaced (`reissue_invitation`), because the shared link no longer works.
- **Mail adapter, no provider.** `src/server/mail/provider.ts` defines `MailProvider` with the typed outcomes from docs/09 and one implementation, `unconfigured`. Nothing calls `send` yet. A send button is deliberately absent: raw tokens are shown once and not stored, so a send needs a reviewed, per-recipient approval flow plus a provider decision. The page says honestly that email is not set up.
- **ICS.** `src/domain/calendar/ics.ts` (pure): RFC 5545 CRLF, 75-octet folding, TEXT escaping with control characters dropped (no property injection), UTC instants for timed items, date-only events as all-day with exclusive end. Download at `/app/[w]/plan/calendar.ics` for `exports.create` (owner/partner), `no-store`. Includes event dates and scheduled (not cancelled) agenda items with title, location and "in charge" label only; contacts, notes and guests are never included. It is a snapshot, not a subscription; UIDs are stable and `SEQUENCE` follows the item version so a re-import updates entries in most apps.
- **Deferred:** actual email send and provider choice, per-recipient send approval and reminders, calendar subscription feeds, guest-facing "add to calendar" on the RSVP page, timeline time zone beyond UTC instants.

## ADR-029: Optional page lookup for saved links (UX-04c)

Owner decision, 2026-11-20: a member may ask the app to read a pasted venue or vendor link and prefill the form. This supersedes ADR-003's "no scraping" and the R1 line in `docs/10-SECURITY.md` ("store URL only, don't fetch arbitrary links") **only** for the narrow, user-initiated lookup below. ADR-003's other rules stand: no fake availability, reviews, prices or catalogs; the personal list stays the product.

- **User-initiated only.** One page, fetched when the member presses "Look up this page". Never on save, in the background or in bulk. Requires `vendors.manage` for the workspace.
- **Proposal, not a record.** The lookup returns text for the form. Nothing is saved until the member reviews and saves. Only empty fields are filled, each filled field is named, and the note says the details came from the page and need checking. The page's description goes into Notes labelled as such. The lookup never fills a price, capacity, availability or rating; unknown stays unknown.
- **Extraction is parsing, not AI.** Title, `og:` tags and JSON-LD `LocalBusiness`-style name/address/phone only, truncated and stripped to plain text. Page content is untrusted data and is never followed as instructions or rendered as HTML.
- **SSRF controls** (`src/server/links`): http/https on ports 80/443 only; no credentials, IP-literal, single-label, `.local`/`.internal` or `localhost` hosts; DNS answers are validated and the connection is pinned to the validated address (no rebinding gap); loopback, private, link-local, CGNAT, multicast, reserved, documentation, NAT64/6to4/IPv4-mapped ranges refused; at most 3 redirects, each re-validated; 8 s total timeout; 512 KB cap on the decompressed body; HTML only; no cookies or credentials sent; generic failure messages so the endpoint cannot be used to probe the network.
- **Per-site rules.** `src/server/links/site-rules.ts` is the one place for host-specific policy (block a host, or later allow extra handling). It ships with an empty block list and a default of allow. A blocked site gets an honest "can't read this site; enter the details by hand" message. Owner will specify rules per site later; changes go through this file and a note here.
- **Identity.** The request uses a generic product User-Agent and no personal data from the member or the workspace.
- **Rate limit.** 10 lookups per member per minute, in memory per server instance. This is a known limitation: it does not hold across instances or restarts. A database-backed limit is deferred.
- **Not decided here:** robots.txt handling and terms-of-service review per site. The lookup reads a single page the member could open in a browser. Revisit before any bulk, scheduled or marketplace use, which remain out of scope.


## ADR-030: Seating overhaul: details, captains, floor plan, suggestions (SEAT-1 to SEAT-5)

Owner decision, 2026-11-21: seating should let a couple design the room, see who has answered at each table, plus-ones and dietary needs, assign table captains, and tap a table or a guest for details. The owner chose a full floor-plan canvas now, plus seating a household together, numbered seats, an escort-card/table-list PDF and suggested seating. This pulls R3-01 (canvas) and part of R2-05 (suggestions) forward and supersedes the "full canvas is R3" half of decision 012. Built as five ordered slices; each is verified before the next.

- **Captain on the assignment.** `seat_assignments.is_captain` with a partial unique index per table, not a column on the table. A captain is therefore always seated at that table: unseating, a decline, archiving, moving to another table and removing the table clear it with no extra code. Moving within a table (seat number change) keeps it. `set_table_captain` (idempotent, null clears) and the finalized snapshot records it.
- **Seat a household together.** `assign_household_seats` seats up to 20 guests at one table in one transaction, all or nothing (SE409 no room, SE422 someone ineligible), counting only guests not already there. "Together" means the same invitation (a household, or a guest and their plus-one), because that is the unit the couple already defined. The queue groups unseated guests by invitation.
- **Private notes stay private.** Dietary and access text is read by `loadSeating` only for the interactive page (`details: true`), shown to owner/partner, and is never in CSV or PDF downloads (the export route passes `details: false`). Seating was already limited to `guests.manage`.
- **Tentative seating is surfaced, not defaulted.** Designing before RSVPs need tentative seats; the page now says how many guests haven't answered and points to the switch. It remains the couple's explicit choice (docs/07).
- **Canvas is schematic.** Abstract grid units; no scale calibration, clearance or fire-code claims (docs/07 R3 note). A visible "not to scale" note ships with the canvas (SEAT-2).
- **Suggestions are proposals.** SEAT-5 is deterministic, never applies itself, is checked against the layout revision on apply, and reports what it could not place. Hard must-link/must-separate rules and cultural/relationship constraints remain R2-05.
- **Migrations.** `20261208090000_seating_details.sql` (SEAT-1). `add_seating_table` and `update_seating_table` gained optional shape/notes parameters (old calls keep working).

### ADR-030 addendum: floor-plan canvas (SEAT-2)

- **Abstract grid, schematic only.** The room is 120 x 80 units, enforced by the database. A table's position is its centre, an element's is its top-left corner; table size is derived from shape and seat count and is not stored. The page says the plan is not to scale and is not a safety, aisle-width or clearance check. No real-world units or calibration (R3).
- **Overlap is advice, not a rule.** The database enforces bounds only. Table-on-table and table-on-item overlap is listed under the plan as a note; item-on-item is allowed (a head table on a stage). Unplaced tables get a deterministic tidy layout that is shown but not saved until someone moves them.
- **Positions are not part of the finalized copy.** The frozen snapshot holds names, tables and meals, so moving things neither bumps the layout revision nor makes a finalized plan out of date. If a later slice puts positions into the snapshot (the PDF in SEAT-4 may), revisit this.
- **Moves are last-write-wins.** `move_seating_table` and `move_seating_element` take no expected version, so a drag never fails on a stale one; they are idempotent. The row's own `version` still advances (the shared `updated_at` trigger), so an edit form left open while the other partner moves the item is refused with the usual reload message. Adding, editing and removing room items are versioned and audited without labels in the audit payload; moves are not audited (too noisy, no sensitive effect).
- **Drag has non-drag alternatives.** Arrow keys on a focused item (Shift for 5 units, saved after a pause, announced politely), typed Column and Row fields in the table tray, and a List view that carries every table as a card. Below 720px the plan scrolls inside its own frame instead of shrinking so tables stay at least 44px; zoom 100 to 300%.
- **View choice is a URL parameter** (`?view=list`), server-rendered, no stored preference.
- **Limits.** 40 room items and 100 tables per event. Room item kinds are a fixed list (dance floor, stage, head table, bar, buffet, entrance, DJ or band, cake, photo area, other).
- **Migration.** `20261209090000_seating_floor_plan.sql`.

### ADR-030 addendum: numbered seats (SEAT-3)

- **Seat numbers were already stored.** `seat_assignments.seat_number` is unique per table, inside the table's capacity, and already in the finalized snapshot. SEAT-3 adds the way to use it, not a new model. A guest may be at a table with no number; that is allowed and shown ("No seat number yet").
- **Swap is atomic and general.** `swap_guest_seats` exchanges two seated guests' table and seat number in one transaction (the per-table unique index forces freeing both numbers first). It works within a table and across tables (table sizes are unchanged, so capacity cannot be exceeded). A guest's tentative flag stays with the guest. A captain who changes table stops being captain, as for any move; a captain who only changes seat at the same table stays captain. A guest who is not seated returns `SE404`.
- **Numbering is deterministic.** `number_table_seats` gives unnumbered guests at a table the lowest free numbers in name order and returns how many it numbered; 0 changes nothing and does not touch the revision. Nothing numbers seats automatically.
- **Both change the plan.** Seat numbers are in the frozen copy, so a swap or numbering advances the layout revision (a finalized plan becomes out of date) and writes an audit event with no guest names.
- **Chips are a sketch, not chair positions.** Chips are spread evenly round a round table's rim (seat 1 at the top, clockwise) or along the long sides of a rectangle (top left to right, then bottom right to left). Their size shrinks on big tables. On the canvas they are decorative and hidden from assistive tech (initials only, shown from 150% zoom); the table tray carries the same facts as 44px buttons with full names. Guests without a number fill the lowest empty chips on the canvas so the filled count always matches who is at the table.
- **Tray, not drag.** Choosing a chip opens a panel: put someone in an empty seat, swap with another guest at the table, move to an empty seat, or clear the number. Dragging a guest card onto a seat is not part of this slice.
- **Cross-table swap is database-only for now.** The RPC supports it and is tested; the tray offers swap within the table because a cross-table picker would put every seated guest into every table's panel payload. Revisit with a lazily loaded picker.
- **Migration.** `20261210090000_seating_seats.sql`.

### ADR-030 addendum: table list and escort cards PDF (SEAT-4)

- **No migration.** Generated on demand from the live plan by `GET /app/[w]/seating/[eventId]/export/pdf?doc=table-list|cards&paper=a4|letter&meals=0|1` (default table list, A4, no meals; anything else is a 400). Same gate as the CSV: `guests.manage`, owner/partner only, 404 otherwise, `cache-control: no-store`. Nothing is stored; it is a snapshot of the plan at download time and says so (plan revision and UTC time in the footer), so it does not touch the finalized snapshot or the stale rules.
- **What may be printed.** Names, table labels, seat numbers (only where a guest has one) and meal choices (only when "Include meal choices" is ticked). `buildPrintModel` (pure, `src/domain/seating/print.ts`) is the only input to the renderer and has no field for dietary or access text, contact details, table notes or positions; the route also loads with `details: false`. Tested at three levels: the model's JSON, the rendered text, and an e2e that inflates the downloaded PDF and searches for a private note (with a positive control).
- **Seat numbers yes, floor-plan positions no.** Positions stay out of the PDF: the plan is schematic and not to scale (SEAT-2), and printing it would imply a venue drawing. This also keeps the SEAT-2 rule that positions are not part of the snapshot. Revisit only with a calibrated plan (R3).
- **Cards are for confirmed guests only.** A guest seated tentatively (not answered yet) appears in the table list, marked "(tentative)", with a footer saying it may change, but gets no card; accepted guests with no seat get no card and are listed under "Not seated yet" in the table list. Cards are ordered by surname (last word, ignoring "(child)" style notes and Jr/Sr/II/III/IV); this is a sorting convenience, not a claim about anyone's surname. A name is printed as stored, including any "(child)" note.
- **Layout.** Escort cards are 3.5 x 2 in, two columns by five rows (10 per sheet) on A4 or Letter, with light cut lines; a name shrinks to 12pt then wraps to two lines, a meal wraps to two lines, longer text is cut with "...". The table list flows over pages in portrait, repeats the column header per page and keeps a table heading with its first row. Built-in PDF fonts only: accents are kept where WinAnsi has them, otherwise simplified, other characters become "?"; the PDF says so when that happened (the CSV keeps names unchanged).
- **Not built.** Folded tent cards, place cards at the seat, table number signs, custom wording or fonts, a stored/shareable copy (these go through the package builder, R1-16, if wanted), and printing from the guest-facing site.

### ADR-030 addendum: suggested seating (SEAT-5)

- **A proposal, never a write.** `suggestSeating` (pure, `src/domain/seating/suggest.ts`) reads the plan and returns a proposal; it is computed on every page render, stored nowhere, and shown in a tray ("Suggest seating") for review. Nothing changes until the couple presses "Seat N guests this way".
- **Additive only.** Only guests who can be seated now are placed (attending, plus waiting guests when tentative seating is on, the same sets as the queue). Anyone already seated stays where they are; the suggestion never moves, swaps or removes a seat, and sets no seat numbers or captains.
- **A group is an invitation, and is never split.** Same unit as "seat together" (ADR-030 above). An invitation goes to one table or is reported as not placed with the reason: every table is full, or it needs N seats together and no table has more than M open. If other people on the same invitation are already seated, the rest go to that table when it has room.
- **Deterministic and explainable.** Biggest groups first (then label, then id); each goes to the table where it fits most tightly (fewest seats left over, then plan order), so partly filled tables fill up before an empty one is used. The same plan always gives the same proposal, whatever order the data arrives in. Tested for order independence.
- **Deliberately not built (R2-05 owns these).** Must-sit-with, must-not-sit-with, relationship or cultural constraints, preferences, balancing tables evenly (the rule above fills tables rather than spreading people), splitting a large group across tables, and any scoring. The panel says it does not know who gets along.
- **Apply is atomic and revision-checked.** `apply_seating_suggestion(wedding, layout, expected_revision, placements)` locks the wedding and layout, refuses with 55000 if the layout revision differs from the one the proposal was made against, then validates every placement inside the same transaction (tables belong to the layout, every guest is eligible now and not already seated, no table exceeds its capacity) and inserts all of it or none (SE422 and SE409 otherwise, 22023 for malformed input). The server action posts the exact placements that were reviewed plus the revision; the database trusts none of it, which is why a stale or tampered form can at worst be refused. One revision bump (a finalized plan becomes out of date, its frozen copy is not rewritten) and one audit event with counts only, no names. Seats are created without a number and tentative exactly as `assign_guest_seat` would.
- **Why the revision is the guard.** Every seating change, RSVP answer or meal change, archive and revoke bumps the layout revision, so "the plan changed since you looked" is one integer comparison, not a diff. It is conservative: any seating change refuses the apply and the couple reviews a fresh proposal.
- **Migration.** `20261211090000_seating_suggestion.sql` (one function, no table or column change).

