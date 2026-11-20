# Product requirements

## Mission and positioning

A premium-feeling, mobile-first wedding operating system: an elegant personal wedding journal with the reliability of a planning application. Reduce duplicate entry, unclear decisions, missed deadlines and messy handoffs. Do not require a vendor to join the platform for the couple to plan with them.

**Six jobs:** discover venues and vendors; compare actual options; plan the event; track commitments and attendance; share selectively; package a decision or complete wedding into usable outputs.

## Users and jobs to be done

| Persona | Need | Success |
|---|---|---|
| Newly engaged couple | Know where to start | Onboarding produces an actionable plan even with date/budget unknown |
| Couple actively planning | Select vendors and control costs | Compare normalized proposals and see committed/paid/projected balances |
| Partner or family contributor | Collaborate without losing control | Scoped access, comments, votes, approval and visible change history |
| Planner/coordinator | Coordinate and receive a reliable handoff | Versioned wedding book, contact sheets, run of show and meal reports |
| Vendor | Get only the details relevant to delivery | Secure scoped packet; later an acknowledgment portal |
| Guest | RSVP, see relevant details quickly | Accessible mobile web, no guest account required |

Inclusive language: partners, wedding party, hosts, guests. Do not presume gender, culture, religion, household structure or a particular ceremony.

## Goals and non-goals

R1 must solve planning and decision-making with connected data, regardless of whether a live marketplace or AI provider exists. An account holder can use it from a phone or desktop. Guests can respond from an invite link. R1 is not a payment processor, comprehensive booking marketplace, legal advisor, licensed venue CAD tool, or autonomous agent. Do not build native mobile apps first. Do not market a fixture directory as live. No AI dependency for ordinary CRUD, math, statuses or exports.

## Functional requirements

| ID | Module | R1 minimum (unless stated) | Subsequent enhancement |
|---|---|---|---|
| P01 | Accounts/onboarding | Sign in, workspace, optional date/location/budget, style/priorities, partner invite, editable preferences, resume draft | Import existing full plans, cultural questionnaires |
| P02 | Dashboard | Planning progress, budget summary, RSVP counts, bookings, upcoming tasks, pending decisions, quick add | Configurable widgets, weekly recap, milestones, contextual insights |
| P03 | Discovery | Saved/manual venue and vendor records, source URL, images user may use, search/filter existing records, optional licensed catalog adapter, search/export shortlists | Map search, verified profiles, availability, reviews, tours, recommendations |
| P04 | Vendor management | Vendor categories, contact details, notes, proposal/contract links, statuses, tasks, committed costs | Inquiry pipeline, messages, vendor-specific portal and acknowledgments |
| P05 | Compare | 2–4 candidates, standardized fee rows, inclusions/exclusions, capacity, constraints, user weights, notes, decision history | AI normalization, comments/votes, alternative packages, negotiation drafts |
| P06 | Budget | Target/category allocations, estimated line items, commitments, recorded payments/refunds, due dates, contributions, contingency and forecasts | Saved scenarios, invoice/receipt extraction, currencies with explicit conversions |
| P07 | Guests/RSVP | Households, person-level guests, event invites, plus-one permission, statuses, meal choice, allergies/accessibility with privacy, CSV import/export, scoped RSVP link and reminders | Delivery analytics, multilingual forms, accommodation/transport assignments |
| P08 | Seating | Event-specific table capacity, list-based and basic visual assignment, accepted/unknown guest handling, meal totals, print/export | Scaled canvas and venue plans, intelligent constraint solver, multiple layouts, ceremony elements, place/escort cards |
| P09 | Tasks/calendar | Date-relative template, manual tasks, assignees, due dates, checklist and agenda, event timeline, reminders | Dependencies beyond templates, calendar sync, Kanban, advanced timeline |
| P10 | Design | Simple collections, uploads, palette, notes, favorite images, link to vendors | Inspiration clipping with rights, AI mood boards, décor inventory, 3D/AR concepts |
| P11 | Guest website | Template, slug, explicit publish, date/location/story/FAQ/travel/registry links, per-invitation event visibility | Custom domains, multiple languages, stationery, guest photo hub |
| P12 | Documents | Private uploads/downloads, categories, link to vendors/quotes/commitments, manual key terms | OCR, extraction with page evidence, legal issue flags, e-signature provider |
| P13 | Communication | Internal notes, drafts, basic transactional invitations/reminders, manual recording of contact | Email connection, threaded correspondence, SMS/WhatsApp via approved providers |
| P14 | Wedding day | Editable timeline, responsible parties, contact list, printable packet | Live check-ins/issues, weather contingency, offline scoped cache, vendor-specific schedules |
| P15 | Share/package | Preset and custom PDF/CSV outputs, preview, redaction, snapshot, restricted shared views | Expiring live views, ZIP bundles, branded professional packets, place cards |
| P16 | Collaboration | Owner/partner/editor/viewer roles with scoped access, invitations, comments where supported, change log | Fine-grained voting, field permissions, professional workspaces |
| P17 | AI | Not required for R1; deterministic rule-based reminders | Context-aware assistant, proposals/receipts/contracts, smart comparisons, seating and design |
| P18 | Post-wedding | Data export and account/wedding archival controls | Gift/thank-you tracking, guestbook/photos, refunds, final reconciliation, resale |

Vendor categories: venue, photography, video, floral, catering, cake, music, planner, hair/makeup, attire, rentals/decor, stationery, transport, bar, officiant, lodging, lighting, photo booth, gifts, custom.

## Experience requirements

- Give every module a clear next action and simple default view. Reveal advanced controls progressively.
- First-run dashboard should use real empty states, never fake financial figures. Demo data is available only in a clearly marked demo workspace.
- A manual path exists for every core task; no account wall for invited guests, no vendor listing account required, no dependence on AI.
- Users can plan multiple events (ceremony, reception, rehearsal, other) with distinct dates/time zones, invitations, meal choices and seating.
- Use one shared record for each guest, contract, payment and vendor; do not make users re-enter details in unrelated modules.
- Every significant computed value should be traceable to inputs; estimates, unknowns and contract terms must be distinguished.

## Success and quality metrics (proposed)

Activation = created wedding + completed a useful action (add vendor, guest, budget item or task). Track time to first useful action; partner invite acceptance; comparison completions; RSVP completion per invited person; finalized seating; package generation success; user-reported time saved; mobile completion rate. Do not log guest names, sensitive notes, contracts or message bodies in analytics. No inferred market-share or demand claims.

## R1 acceptance narrative

Create a workspace on mobile, invite a partner, add two venue options and compare all-in known costs, record a selected venue and contractual deposit, import a household guest list, collect an accountless RSVP, assign a confirmed guest to a table, see meal counts and budget forecast update, create a timeline and generate a scoped caterer PDF without exposing unrelated financial or personal information. Repeat from a second authorized device; cross-wedding access must fail.
