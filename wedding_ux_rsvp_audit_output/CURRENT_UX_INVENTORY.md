# CURRENT_UX_INVENTORY.md

What the app actually exposes today (working tree on `main`, 2026-11-22). Read-only; cited by file:line. "Seen" means a screenshot was captured and inspected this session; everything else is from code.

## 1. Stack and boundaries

| Concern | Actual | Evidence |
|---|---|---|
| Framework / router | Next.js 16.4.6 App Router, React 19.3.1, server components by default, server actions for mutations | `package.json`; `src/server/rsvp/actions.ts:1` |
| Styling / design system | Tailwind 4.3.5 with semantic tokens (raw palette disabled, ADR-014); primitives in `src/components/ui/*` (Button, Card, Badge, TextField, SelectField, Tray, ImpactPreview, Toast, FormErrorFocus) | `src/styles/tokens.css`; `src/components/ui/` |
| Auth | Supabase Auth; workspace access via `requireWorkspace` / `hasCapability` | `src/server/auth/workspace-guard.ts` |
| Database | Supabase Postgres, RLS select-only for clients, every write an RPC with advisory lock + version check + audit | `supabase/migrations/*` (39 migrations) |
| Form engine | Native forms + `useActionState`; Zod at the server boundary; no form-builder / schema-driven forms | `src/features/events/rsvp-form.tsx:13` |
| Background jobs / queues | **None.** All downstream effects run synchronously inside the same DB transaction or are computed on read | `20261222090000_needs_attention.sql:3-6` |
| Realtime / cache | No realtime (excluded from `db:start`); `revalidatePath` after writes | `package.json` `db:start`; `src/server/rsvp/actions.ts:94` |
| Feature flags | **None found** (code search) | EVIDENCE_LOG E-13 |
| Email / SMS | Adapter exists, unconfigured; app never sends | `src/server/mail/provider.ts`; `invitations/page.tsx:98-102` |
| Roles | owner, partner, editor (planner) with owner-granted area grants (ADR-031 D7), viewer. Reply data limited to owner/partner unless owner shares totals | `src/domain/permissions/index.ts:15-30,139-160` |
| Tests | Vitest unit (domain), Vitest integration on real local Supabase (RLS, races), Playwright E2E + axe | `tests/integration/*`, `tests/e2e/*` |

## 2. Navigation

Five groups, bottom bar on mobile and sidebar on desktop: **Home · Discover · Plan · Guests · More** (`src/components/shell/nav-groups.ts:17-96`). Header shows wedding name, quick **+ Add** and role badge (seen at 320px).

Target navigation (brief p.3) is Overview · Events · Guests & Invitations · Budget · Vendors & Venues · Planning · Design & Details · Files & Messages. Differences: Events and Budget are not top-level (Events lives under Plan and is linked from Guests); there is no Messages area.

## 3. Screen inventory (actual → target)

| Actual screen / route | Main job today | Maps to target screen | Fit | Evidence |
|---|---|---|---|---|
| Home `/app/[w]` | Next steps, counts, **Needs attention** card (top items + see all) | Wedding Overview | Partial: has deep-linked problems; no single "decisions" list or deadline strip by event | `src/app/app/[w]/page.tsx:32-111` |
| Needs attention `/app/[w]/plan/attention` | Computed and stored issues with links, dismiss / restore / mark handled | Issue Center | Partial: no owner, priority, suggested fix text per item beyond a link, or resolution history list | `src/app/app/[w]/plan/attention/page.tsx:13-85`; `src/domain/attention/attention.ts:20-41` |
| Event page `/app/[w]/plan/events/[eventId]` | Needs attention, Where (venue/space/capacity), Who's coming, Meals, caterer count, Seating, Vendors, Agenda | Event Hub | Strong: missing event-scoped budget section and invitee table | `src/app/app/[w]/plan/events/[eventId]/page.tsx:167-555` |
| Events list `/app/[w]/plan/events` | Event switcher / list | Event Hub index | Verified exists | route file |
| Guest list `/app/[w]/guests` | Households and people; search, adult/child, tag filters; links to Events, Invitations, Seating, Website | Guest / Invitation Table | **Weak**: no per-event response, meal, seat or "missing meal / unseated" columns or filters | `src/app/app/[w]/guests/page.tsx:85-110`; `src/features/guests/guest-filters.tsx:77-95` |
| Invitations `/app/[w]/guests/invitations` | Per event: counts strip with "How we count", meal tallies, invite, meal options, invitation cards with per-member answer, change-an-answer (reason), new link, mark shared, revoke | Guest / Invitation Table + part of Form Builder | Partial: card stack, not a filterable table; long page with many events | `src/app/app/[w]/guests/invitations/page.tsx:88-329` (seen 320px) |
| Guest detail `/app/[w]/guests/[guestId]` | Details, private dietary/accessibility (gated), household, **reply history per event**, archive | Guest Profile + Impact | Partial: history yes; no current per-event status panel with live vs protected consequences | `src/app/app/[w]/guests/[guestId]/page.tsx:40-218` |
| Import `/app/[w]/guests/import` | CSV wizard | (support) | n/a | route |
| Seating `/app/[w]/seating/[eventId]` + versions + PDF/CSV | Floor plan, tables, numbered seats, suggestions, finalize, immutable versions, stale state | Seating workspace | Strong | `seating/[eventId]/page.tsx`; `versions/[snapshotId]/page.tsx` |
| Budget `/app/[w]/plan/budget` (+ bookings, amend) | Targets, estimates, commitments, payments; per-guest items count from replies; "How the forecast is built" | Catering / Budget, Budget driver explanation | Partial: driver explained in budget; no catering-vs-guarantee-vs-invoice single view | `src/app/app/[w]/plan/budget/page.tsx:92-266` |
| Caterer count card (on Event page) | Lock / revise guarantee with preview of breakdown; drift | Catering-versus-guarantee | Partial: guarantee vs live demand yes; contracted/invoiced/paid not on the same card | `src/features/events/guarantee-card.tsx`; event page `:434` |
| Guest RSVP `/rsvp/[token]` | One event, members, attend/decline, meal, one plus-one name + meal, deadline, update later | Guest Mobile RSVP | Partial (see §4) | `src/app/rsvp/[token]/page.tsx`; `src/features/events/rsvp-form.tsx` (seen 320 / 1280) |
| Invited site `/w/[slug]/invite/[token]` | Published site + link to RSVP | Guest portal entry | Verified for one event | `src/app/w/[slug]/invite/[token]/page.tsx:14-41` |
| — | — | RSVP Form Builder | **Missing** | E-12 |
| — | — | Submission Inspector | **Partial** via guest reply history; no per-submission view, no processing state (not needed: synchronous) | guest detail `:192` |
| — | — | RSVP Impact Preview (planner override) | **Missing** for answer overrides; `ImpactPreview` primitive exists and is used only for event location changes | `src/components/ui/impact-preview.tsx`; `src/features/events/location-form.tsx` |

## 4. Guest RSVP screen in detail (seen at 320px)

- Header: wedding name, event name (serif), event kind, date if set, "Invitation for {label}".
- One bordered fieldset per member: Attending / Not attending radios (44px rows), "Meal choice (if attending)" select.
- "Bringing a guest?" fieldset when places remain: full name + meal.
- Status line (`aria-live`), primary button "Send my response" / "Update my response", reply-by date.
- Closed state: controls disabled, "contact the couple". Invalid / throttled / unavailable: one generic card each.
- **Not present:** multi-event steps, review step, confirmation summary, dietary/allergy, accessibility, transport, children ages, custom questions, add-to-calendar, "remove my plus-one", email confirmation.
- Meal select is not hidden or disabled when "Not attending" is selected (server discards it).

## 5. States recorded

| State | Where | Evidence |
|---|---|---|
| Loading | No `loading.tsx` boundaries in `src/app` (code search); pending button text "Sending…" on RSVP | `rsvp-form.tsx:108-110` |
| Empty | Invitations ("No events yet…", "No invitations…"), Event vendors, Agenda | `invitations/page.tsx:122-129,237-239` |
| Error | Generic link error, throttled, unavailable; inline field errors with focus | `rsvp/[token]/page.tsx:27-42`; `form-error-focus.tsx` |
| Locked | RSVP closed after deadline; caterer count locked; finalized seating versions | `rsvp-form.tsx:102-106`; guarantee card |
| Permission denied | Invitations page explanatory card; guest detail `notFound()` | `invitations/page.tsx:59-73`; `guests/[guestId]/page.tsx:40` |
| Stale projection | Finalized seating "out of date"; caterer drift item | `20261201090000_seating.sql:16-18`; attention kinds |

## 6. Not inspected visually

Desktop planner pages beyond the RSVP spec's 1280px shots, 390/768/1440 widths, 200% zoom, screen reader output. The 320px full-page capture of the invitations page shows the sticky header and bottom bar overlaying content mid-page; this is most likely a full-page screenshot artifact and is **unverified** as a real defect.
