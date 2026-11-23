# UX_SECURITY_ACCESSIBILITY.md

## 1. Public and guest links

| Surface | Credential | Protections observed | Residual risk | Evidence |
|---|---|---|---|---|
| `/rsvp/[token]` | 256-bit random token; DB stores SHA-256 only | Format check before DB; unknown/revoked/expired collapsed into one message; failed guesses throttled (20 per 10 min per hashed client key); `noindex`, `no-referrer`, `force-dynamic`; projection excludes workspace id, contacts and other households; RPCs callable only by `service_role` | **Throttle key** uses the first `X-Forwarded-For` value (`public.ts:51-56`), which a client can set unless the hosting proxy overwrites it. Status **Unknown** until the deployment proxy is known. Tokens live in the URL path, so host/CDN access logs will contain them: keep log retention short and scrub paths | `src/server/members/invite-token.ts`; `src/server/rsvp/public.ts`; `src/app/rsvp/[token]/page.tsx:8-13`; `rsvp.test.ts:196-246,442-508` |
| `/w/[slug]/invite/[token]` | Same token + site slug | Same headers; token must belong to the site's wedding | Same as above | `20261204090000_guest_website.sql:355-384` |
| `/w/[slug]` | Public | Only explicitly published site content | — | `docs/15-DECISIONS.md` (guest website ADR) |
| Seating/guest exports | Signed-in owner/partner | `no-store`; 404 for others | — | `docs/15-DECISIONS.md:305` |

**Link lifecycle.** Expiry (`expires_at`), revoke, reissue (old link dies immediately) all verified (`rsvp.test.ts:442,473`). After the reply date, the link still shows answers read-only; only the couple can change them, with a reason (`rsvp.test.ts:368`).

**Recommendation for the party-link redesign (P0-2).** Keep one token per party, hashed, same throttle and collapse rules. A party token must never reveal events the party is not invited to, and must not be able to address another party's `invitation_members` (reuse the existing forged-id check).

## 2. Roles and reply data

| Role | Reply rows / names | Totals | Private dietary/accessibility | Evidence |
|---|---|---|---|---|
| Owner | yes | yes | yes | `permissions/index.ts:139-160` |
| Partner | yes | yes | yes (`guests.sensitive.read`) | same |
| Editor (planner) | only with owner grant for guests | only if owner shares totals | only with grant | ADR-031 D2/D7; `event-demand.test.ts:323` |
| Viewer | no | only if shared | no | same |
| Guest (token) | own party only | none | none (not collected) | `public.ts:35-42` |

**Design implication:** W1/W2/W3 counts must call the existing `event_demand` gate, not re-derive totals from rows a role can't read. The W4 consequences block must hide names and per-guest rows from roles without `guests.manage`.

## 3. Guest-submitted sensitive data (future)

Dietary, allergy and accessibility answers are health-adjacent. If P1 adds them to the guest form: store them in `guest_private_details` (already RLS-gated), never in `audit_events` or `rsvp_changes.reason`, label them "Only the couple sees this" on the form, exclude them from vendor packages unless the recipient projection allows it, and do not prefill them on a shared party link for other party members (each person's sensitive answer is visible to whoever holds the party link: **product decision needed**, see summary Q2).

## 4. Input states

| State | Guest form today | Target |
|---|---|---|
| Required choice missing | "Choose yes or no for at least one person." (form-level) | Per-person error linked to the fieldset |
| Invalid meal / forged id | Generic error | Same (do not explain forgery) |
| Stale version | Generic conflict copy + fresh answers | Specific "someone in your party updated this" copy |
| Deadline passed | Disabled controls + explanation | Same, plus couple's contact if published |
| Throttled / unavailable | Distinct messages | Same |
| Plus-one quota used | RS422 message | Hide plus-one step when none remain (already hidden) |

## 5. Accessibility (WCAG 2.2 AA-oriented)

| Check | Result | How established |
|---|---|---|
| Axe (Chromium) on RSVP and invitations pages | **Pass** | `tests/e2e/rsvp.spec.ts:164`, run this session |
| Reflow at 320px, no horizontal scroll | **Pass** on RSVP; invitations page reflows | Same test + screenshots inspected |
| Fieldset/legend per person, labelled controls | Pass | `rsvp-form.tsx:22-26,35-46` |
| Status announced | `aria-live="polite"` container; errors `role="alert"` | `rsvp-form.tsx:92-101` |
| Target size ≥ 44px | Radio rows `min-h-11` (44px); radio input itself 20px inside a 44px label | `rsvp-form.tsx:35-42` |
| Conditional meal field | **Issue (minor):** meal select remains enabled for a person marked "Not attending"; confusing for screen-reader users who hear a meal question they need not answer | code + 320 screenshot |
| Deadline date | Rendered in UTC; for weddings west of UTC the reply date can show one day later than the couple meant at the margin, and the link closes at 23:59 UTC, not local end of day | `server/events/actions.ts:204-211`; `rsvp-form.tsx:115-120` |
| Focus after submit | Not moved; message is announced but focus stays on the button | code |
| Contrast | Token tests guard contrast (`tokens.test.ts`); primary button charcoal on blush | design tokens |
| Keyboard-only, screen reader (VoiceOver/NVDA), 200% zoom, reduced motion | **Not verified** (no manual AT run this session or earlier, per ledger carry-over gaps) | `docs/16-IMPLEMENTATION-STATUS.md` |
| Planner invitations page at 320px | Full-page capture shows the sticky header and bottom bar over content mid-page; probably a capture artifact. **Unverified** | `test-results/screenshots/320/invitations.png` |

## 6. Visual reuse

Guest form and planner pages use the shared primitives and semantic tokens (Card, Button, SelectField, TextField, Badge, Tray). All proposed components in SCREEN_MOCKUPS extend these; the one new pattern is the stepper, which should live in `src/components/ui/` so the form builder preview renders the same component guests see.
