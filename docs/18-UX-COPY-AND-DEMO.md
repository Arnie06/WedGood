# UX copy, sample content and synthetic demo

## Voice and tone

Warm, calm, clear, inclusive. Speak to the task rather than guilt or urgency. Use plain words like "Still owed", "Not yet confirmed", "Your next steps". Avoid congratulating users for spending more, gender assumptions, forced wedding date, manipulative notifications, or overpromising AI. Keep errors instructive and preserve inputs.

| Context | Suggested copy |
|---|---|
| Landing | Your wedding. Beautifully organized. / Discover, compare and bring every detail together. |
| CTA | Start planning / Explore your workspace |
| Onboarding date | Have a date in mind? It's okay if you're still deciding. |
| Onboarding budget | Set a target, or come back when you're ready. |
| Dashboard unknown | Add a venue or guest to start bringing your plan together. |
| Discovery empty | Save a venue or vendor you love. Add a link or enter details yourself. |
| Unknown price | Pricing not confirmed. Ask the vendor for a full proposal. |
| Comparison | Compare based on the same guest count and inclusions. |
| Budget | This is an estimate, not a confirmed commitment. |
| RSVP | We'd love to know whether you can join us. |
| Seating | 4 confirmed guests still need a table. |
| Finalized layout stale | Guest responses changed after your last seating review. Review the layout before exporting. |
| Payment | Record a payment / This records a payment; it does not send money. |
| Package | Choose who will receive this plan. Preview what they'll see. |
| AI | Review these suggested updates before applying them. |
| Unsaved | We couldn't save this change. Your draft is still here. Try again. |
| Conflict | Someone updated this plan. Review the latest version before saving. |
| Permission | You don't have access to this section. Ask the workspace owner. |
| Provider absent | Email delivery isn't configured. Copy the invitation link instead. |
| Partial export | Includes known costs. Some required charges are still unconfirmed. |

## Consistent demo data (fictional only)

Workspace: Alex & Morgan, wedding date 2027-05-22, America/Los_Angeles, USD target $40,000, target guest count 120. Fixed demo reference date 2026-11-19 gives 184 days to wedding (date-only difference). Demo mode must be labeled and segregated from real account data. Never seed fictional reviews or availability into live catalog.

Candidates (examples only): Vineyard Estate $8,500 rental, capacity 180; Coastal Terrace $12,000, 150; Garden House $6,500, 120. Compare scenarios under 120 guests; sample known totals $28,000/$33,200/$25,200 only if component rows support exact totals (include fees). Separate sample budget scenario from selected proposal; do not mix incompatible figures. Demo payment data can use $10,000 active venue commitment and $2,500 recorded payment with $7,500 owed. Budget simulator uses rules example $95 catering + $30 bar per guest, $20k fixed, 10% reserve. Demo guest roster may use 6 synthetic people (e.g. Avery Example, Jordan Example, Riley Example, Sam Example, Casey Example, Quinn Example): 4 accepted, 1 pending, 1 declined; households with distinct membership; meal counts 1 chicken, 2 vegetarian, 1 fish. Populate table assignments consistent with four accepted guests or build full separate fixture explicitly. Two events: ceremony/reception plus optional rehearsal; invitations individually scoped.

Use stable fixture IDs and deterministic dates for tests; compute all dashboard figures from seeded records. Do not hardcode disconnected counts or show dummy toast success. If demo backend not configured, label it local-only synthetic prototype and disable live send/share/payment actions. Use original geometric placeholder images with alt text in local repository; replace with authorized editorial photos when available.

## Interaction delight

Optional celebrations for booking, checklist milestones and RSVP completion; reduced-motion respected. Small progress summaries and next actions rather than endless feeds. Personalize workspace palette only within contrast-safe tokens. Allow notification settings and dismissal of recommendations. Do not use a fabricated quote, testimonial or star rating to enhance design.
