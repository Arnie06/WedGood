# Information architecture and UX flows

## Route map

Paths below are proposed Next.js App Router routes; `w` is an opaque workspace ID. Public URLs are not permission credentials.

| Route | Page and primary action |
|---|---|
| `/`, `/features`, `/pricing` | Editorial public landing, explore product, start planning; no invented testimonials |
| `/sign-in`, `/sign-up`, `/invite/[token]` | Authenticate or redeem collaborator invitation |
| `/onboarding` | Create/resume wedding and select preferences |
| `/app` | Select accessible workspace or create one |
| `/app/[w]` | Home: next step, metrics, quick add |
| `/app/[w]/discover`, `/discover/[id]` under workspace | Venue/vendor search, save or add candidate; edit manual details |
| `/app/[w]/compare`, `/compare/[id]` | Shortlists, criteria and selected options; decide |
| `/app/[w]/vendors`, `/vendors/[id]` | Pipeline and detail, proposals, commitments, contacts |
| `/app/[w]/plan`, `/plan/calendar` | Task list and agenda; add task |
| `/app/[w]/budget`, `/budget/payments` | Budget categories, forecast, due payments; add expense/payment |
| `/app/[w]/guests`, `/guests/[id]` | Guests and households; import/add/invite |
| `/app/[w]/guests/invitations` | Event-specific invites, response and delivery status |
| `/app/[w]/seating/[eventId]` | Tables, capacity, assign guests; print |
| `/app/[w]/design` | Collections, palette, saved images |
| `/app/[w]/website` | Editor, preview and publish |
| `/app/[w]/documents` | Upload, categorize, attach and download |
| `/app/[w]/day-of/[eventId]` | Timeline, tasks, contacts, package |
| `/app/[w]/packages` | Preset/custom sections, preview, create snapshot |
| `/app/[w]/settings` | Wedding details, collaborators, preferences, export/delete |
| `/w/[slug]` | Published guest website; only public allowlisted fields |
| `/rsvp/[token]` | Scoped, accountless event invitation flow |
| `/shared/[token]` | Restricted package redemption (only when configured) |

All submenu paths in the shorthand table live under `/app/[w]`. Public preview uses authenticated editor or separate restricted token, never public draft state. R2+ assistant is contextual drawer rather than competing top-level navigation. R1 navigation groups: Home; Discover (venues/vendors, compare); Plan (tasks/calendar, budget, vendor pipeline, design, documents, day-of); Guests (list, invites, seating, website); More (packages, settings). Desktop may expose more subitems; mobile same functions reachable with at most one subnavigation step from group.

## Screen contracts

Every authenticated screen identifies current wedding, page title, one primary action, meaningful empty/loading/error/permission-denied states, and contextual breadcrumbs. Detail pages link to related records rather than duplicated copies. Mutations show pending, success or recoverable failure. Draft input is preserved on server validation errors. Do not use disabled nav for nonexistent features; omit or clearly label preview.

| Screen | Information hierarchy | Critical interaction |
|---|---|---|
| Home | Countdown if known, progress, committed/paid/forecast, RSVP, next three actions | Quick add, deep link to related filtered page |
| Discover | Search, category, chips, provenance, price/capacity, images | Save, manual add URL, compare selection |
| Compare | Criteria, all-in known totals, unknown rows, capacity fit, evidence | Adjust weights, read inclusions, record decision |
| Vendor detail | Stage, proposal options, contact, notes, contract, costs/tasks | Book manually with confirmation and commitment creation |
| Budget | Target, paid, outstanding obligations, forecast, reserve, category table | Create line, add payment/refund, edit target, audit math |
| Guest list | Attendance counts by event, households, filters | Import preview/commit, add guests, invite, RSVP update |
| Seating | Event picker, assigned/unassigned, capacity, tables, meal legend | Tap guest then table, accessible select, warnings before save |
| Plan | Next actions, grouped checklist, calendar/agenda | Complete, assign, reschedule flexible tasks |
| Website | Template, editable blocks, preview, publication status | Explicit publish/unpublish, guest-specific visibility |
| Documents | Type/vendor filters, scan status, access | Upload, link, safe download, archive |
| Package | Recipient/purpose, selected sections, permission and redaction | Preview exactly, generate fixed snapshot, download |
| Wedding day | Chronological agenda, owners, contacts, print/offline links | Add/edit timeline, handoff to coordinator |

## Journeys with acceptance conditions

### A. First 5 minutes
1. Register/sign in. Create workspace name; choose date/location or skip; optional target and guest count; choose style/priorities; invite partner or skip.
2. Show useful task template and dashboard with missing-data prompts. Do not invent wedding date, venue or budget. Save progress across reload. Avoid default email invitation until explicit consent.
3. Quick-add first venue or guest. Return to intended page after sign-in.

### B. Discovery to commitment
1. Search personal candidates or configured licensed catalog; save a candidate; manually enter availability and source/date. Add proposal values or upload document.
2. Compare two or more options using same guest count, currency and fee basis. Flag unknowns, mandatory fees and capacity. User changes preferences, reads details, selects option.
3. Review selection. Explicitly record booking and confirmed costs/dates, never send or sign on user's behalf. Transaction links vendor, proposal, commitment and ledger. Dashboard and tasks update.

### C. Import to RSVP
1. Upload CSV with mapping and preview. Show invalid rows, possible duplicates and consent warning; commit validated rows idempotently.
2. Select event and eligible invitees, configure plus-one rules and deadline. Send only when provider configured; otherwise create copyable invite URL with revocation.
3. Guest opens mobile link, sees eligible events and household members, responds per person, enters meals/approved plus-one, gets confirmation. No other households visible. Updates are idempotent and concurrent edits detected.
4. Owner sees counts, pending responses; accepts/declines changes update seating queue and estimated catering. Contracted guest minimum remains unchanged.

### D. Seating to caterer package
1. Choose reception; add tables and capacities; accepted guests in unassigned queue. Tentative guests clearly marked and not counted as confirmed.
2. Assign by table selector or drag where supported, prevent duplicate/overcapacity. Change RSVP to declined: unassign on default policy and retain history, alert if layout previously finalized.
3. Review final counts, meals, missing selections, access needs and stale version. Generate caterer snapshot excluding unrelated contacts/budget/private notes. Download from mobile; old snapshot marked stale when plan changes.

### E. Planning changes and package
1. User changes target guest count or wedding date. Display impacted estimates and warnings; explicit confirmation for flexible task reschedule. Do not change signed payments or invitations silently.
2. User creates planner package, chooses sections, examines redacted preview and generates fixed snapshot. Access expires/revokes if using token; previously downloaded file cannot be recalled. Document version and source revision visible.

### F. Error/recovery
Network loss: preserve draft, show retry; no fake save. Expired invite: friendly message with contact host, no sensitive details. Conflict: compare last saved version, retry/reload or manual merge. Missing provider: display configuration status and permitted manual fallback. Permission denial: avoid leaking existence of other workspace data.
