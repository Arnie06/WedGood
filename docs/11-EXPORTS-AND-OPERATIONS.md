# Wedding packages, reporting and day-of operations

Packaging is a primary product job, not an afterthought. A user can convert current plan into visually polished, practical, recipient-specific artifacts without assembling spreadsheets manually.

## Standard templates

| Preset | Default sections |
|---|---|
| Master wedding book | Overview, events, venue, vendors, budget, schedule, guests, seating, design, documents index, contingencies |
| Venue comparison | Source, date, assumptions, normalized fees, missing amounts, capacity, criteria, notes/decision |
| Vendor selection | Proposal options, inclusions, scope, estimate, user ratings, evidence |
| Financial report | Category targets, estimates, commitments, paid/refunded, outstanding, due installments, forecast, reserve, funding if permitted |
| Caterer | Event details, confirmed headcount, pending count, meal choices/allergies only when permitted, seating and service timeline |
| Photographer | Event timeline, locations, shot list R3, relevant contacts |
| Florist | Palette/approved mood board, table count/layout, delivery/setup | 
| Coordinator | Timeline, contacts, assignments, layout, guest counts, contingency plan |
| Family/wedding party | Relevant events, times, transport, responsibilities |
| Guest itinerary | Public/invited events, travel/accommodation, contact instructions |
| Archive | Selected final documents, expense and plan summaries, export metadata |

Preset is not an authorization grant. Master book excludes sensitive notes and raw contract attachments unless separately authorized and selected. Custom sections must be constrained to actor and recipient permissions, and preview exactly what final renderer includes. Staff/vendor snapshots should contain minimum necessary contact and allergy details, not full guest contact list or unrelated finances.

## Generation flow and format

1. Select recipient/purpose, format, sections and event scope; choose optional redactions.
2. Read projection from a consistent database snapshot (single transaction/revision), compute totals using domain functions, render preview digest. User confirms.
3. Recheck revision and permissions; persist immutable authorized snapshot + source revision/hash and template version. Generate PDF/CSV via safe renderer; no raw HTML execution or unsanitized remote resources. Use job status queued/rendering/ready/failed only when real worker exists; retry idempotently. File stored privately and checksum verified.
4. Download after current authorization; optional expiring/revocable grant later. Show generated time, snapshot revision, relevant events, recipient role, estimated vs confirmed caveats, stale badge if underlying revision changed. Old snapshot stays unchanged until deletion/retention. Redacted preview, not full source snapshot, is what renderer receives.

R1 PDF + CSV; ICS calendar export may accompany plan. R3 ZIP bundle (PDF/CSV/ICS + explicitly approved file attachments), live share view revalidates scope for every request, per-recipient version/delivery status, print stationery/escort cards. Clearly distinguish fixed snapshot from live link. No public indexing or secret link analytics. User warned that downloaded files cannot be revoked.

## PDF layout requirements

A4/US Letter configurable, portrait default; landscape for wide comparisons/seat layouts; cover with wedding title and date when set; clear headings, generous margins, page number, generated timestamp/revision, confidentiality label where appropriate. Repeat table headers on page breaks, prevent clipping, display full monetary values and missing data, use accessible text rather than rasterized pages, test long names/multi-page documents. Print-friendly contrast, scale legend for layouts and "not certified layout" note. Images include captions and rights as applicable. Use palette/type from design tokens with local licensed fonts. CSV UTF-8 headers, normalized dates, currency, safe text escaping, no formulas. Spreadsheet XLSX later; do not label a CSV as Excel workbook.

## Wedding day mode

R1 master agenda, responsible person/vendor, venue, times, contacts and printable coordinator handoff. R3 operational mode: timeline status (`upcoming`, `in_progress`, `complete`, `delayed`, `cancelled`), vendor check-ins, separate setup/teardown and call sheets, issue priority/status/owner, transport pickup lists, styling appointments, shot schedule, contingency plan with triggers and manual activation. One incident affects relevant timeline proposals not all concurrent work automatically. Couple can delegate coordinator access; vendor sees own tasks only. No claim of live status unless someone or validated integration updates it.

### Offline requirements (R3)

Explicitly download a scoped emergency packet with revision/time, contacts, agenda, layouts and approved notes. PWA cache only user-selected minimum data, encrypted where feasible with threat model; no broad private response caching or guest list retained on shared device without approval. Show last synced and offline state; read-only default, queued changes only for designed operations with conflict detection. Sign-out clears local data; revoke stops online access but cannot retract offline copies. Test airplane mode, stale data, expired session, reconnect and cache clearing. Printable fallback always available.
