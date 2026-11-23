# Wireframes (annotated)

Numbers in `[n]` are annotations listed under each frame. All names are fictional.

---

## W1 · Wedding Overview (mobile 390)

```
┌──────────────────────────────────────┐
│ (W) Example Wedding    [+ Add] OWNER │  [1]
├──────────────────────────────────────┤
│ Good afternoon                        │
│ 142 days to go · Sat 12 Jun 2027      │
│                                      │
│ ┌ Replies ─────────────────────────┐ │  [2]
│ │ Reception  ██████████░░  86/120   │ │
│ │   34 waiting · reply by 1 May     │ │
│ │ Ceremony   ████████████  98/104   │ │
│ │ [ See who's waiting → ]           │ │
│ └──────────────────────────────────┘ │
│ ┌ Needs attention (3) ─────────────┐ │  [3]
│ │ ● Reception: 2 seats released     │ │
│ │   after you finalized   [Review →]│ │
│ │ ● Caterer count 4 above attending │ │
│ │ ● 6 attending without a meal      │ │
│ └──────────────────────────────────┘ │
│ ┌ Next steps ──────────────────────┐ │
│ │ ...existing tasks card...         │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ Home  Discover  Plan  Guests  More   │
└──────────────────────────────────────┘
```
1. Existing header. 2. **New** deadline strip per event, from `event_demand` (no new data). Owner/partner only; collaborators see it only when totals are shared. 3. Existing `AttentionList`.

---

## W2 · Event Hub (desktop 1280)

```
Plan › Events › Reception                         [Switch event ▾]
Reception · Sat 12 Jun 2027 · Harbour Hall, Main Room (cap 130)
┌ Needs attention ─────────────┐ ┌ Who's coming ─────────────────┐
│ 2 seats released  [Review]   │ │ Invited 132 · Yes 86 · Wait 34│
└──────────────────────────────┘ │ No 12 · Plus-ones not named 3 │
┌ Meals ───────────────────────┐ │ [Open guest table: Reception] │ [1]
│ Fish 40 · Chicken 38 · Veg 8 │ └───────────────────────────────┘
│ 6 attending without a meal   │ ┌ Caterer count  (see W8) ──────┐
└──────────────────────────────┘ └───────────────────────────────┘
┌ Seating ─────────────────────┐ ┌ Budget for this event ────────┐ [2]
│ v3 finalized 2 May · OUT OF  │ │ Catering  £9,460 forecast     │
│ DATE (2 changes) [Open plan] │ │  = 86 attending × £110        │
└──────────────────────────────┘ │ Committed £8,800 · Paid £2,000│
┌ Vendors ┐ ┌ Agenda ┐          └───────────────────────────────┘
```
1. Deep link into W3 pre-filtered to this event. 2. **New** section reading existing budget items whose count source is this event; shows the driver formula (existing "How the forecast is built" logic).

---

## W3 · Guest & Invitation table

Desktop 1280:
```
Guests                                 [Invite] [Import] [Export]
Event: [Reception ▾]  Answer: [Any ▾]  [ ] Attending, no meal
Search [__________]   Group: [Household ▾]  [ ] Attending, not seated
┌──────────────────┬──────────┬─────────┬──────────┬────────┬───┐
│ Name             │ Answer   │ Meal    │ Seat     │ Notes  │   │
├──────────────────┼──────────┼─────────┼──────────┼────────┼───┤
│ ▸ Example house  │ 2 of 2   │         │          │        │   │
│   Ada Example    │ ✓ Yes    │ Fish    │ T6 · 4   │ diet ● │ › │ [1]
│   Bo Example     │ ✗ No     │ —       │ released │        │ › │ [2]
│   Cy (plus-one)  │ ✓ Yes    │ —  ⚠    │ —   ⚠    │        │ › │
└──────────────────┴──────────┴─────────┴──────────┴────────┴───┘
```
Mobile 390: same filters in a "Filters (2)" tray; rows become cards: name, answer badge, meal, seat on one line; `›` opens W4 full-screen.

1. "diet ●" indicates a private note exists; content only for `guests.sensitive.read`. 2. "released" shown until the plan is re-finalized.
Data: one server query joining `guests`, active `invitation_members` for the selected event, `seat_assignments`; no new tables.

---

## W4 · Guest profile + impact (side panel)

```
┌ Bo Example ─────────────────────── ✕ ┐
│ Example household · Adult             │
│ Reception   ✗ Not attending  (guest,  │
│             changed 3 May from Yes)   │
│ Ceremony    ✓ Attending               │
│ ┌ Consequences of the 3 May change ─┐ │
│ │ Updated automatically              │ │ [1]
│ │  · Reception attending 87 → 86     │ │
│ │  · Fish 41 → 40, forecast −£110    │ │
│ │ Needs your review                  │ │
│ │  · Seat T6·5 released; plan v3 is  │ │
│ │    out of date   [Open seating]    │ │
│ │ Not changed                        │ │
│ │  · Caterer count 90 (locked 1 May) │ │
│ │  · Contracts, invoices, payments   │ │
│ └────────────────────────────────────┘ │
│ [Change an answer]  [Reply history]   │
└───────────────────────────────────────┘
```
1. Built from `rsvp_changes` (latest row), `event_demand`, `catering_guarantees`, seating revision. The "before" numbers come from the history row plus current totals; no new storage.

---

## W5 · Guest mobile RSVP stepper (320/390)

```
Step 1 of 5                 Step 2 of 5                 Step 3 of 5
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ Example Wedding       │   │ Who's coming?         │   │ Meals · Reception     │
│ Ada & Bo, you're      │   │ RECEPTION · 12 Jun    │   │ Ada                   │
│ invited to:           │   │ Ada                   │   │ ( ) Fish  (•) Chicken │
│  · Ceremony 12 Jun    │   │ [✓ Attending][ Not ]  │   │ ( ) Vegetarian        │
│  · Reception 12 Jun   │   │ Bo                    │   │                       │
│ Please reply by 1 May │   │ [ Attending][✓ Not ]  │   │ (Bo isn't attending,  │ [2]
│                       │   │ CEREMONY · 12 Jun     │   │  so no meal needed)   │
│ [ Start ]             │   │ ...                   │   │                       │
└──────────────────────┘   │ [Back]      [Next]    │   │ [Back]      [Next]    │
                           └──────────────────────┘   └──────────────────────┘
Step 4 of 5 (Details)       Step 5 of 5 (Review)        Confirmation
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ Anything the couple   │   │ Reception             │   │ ✓ Thank you, your     │
│ should know?          │   │  Ada  Yes · Chicken   │   │ reply is saved        │ [4]
│ Dietary needs (Ada)   │   │  Bo   No              │   │ (same summary)        │
│ [_________________]   │   │  + Cy Yes · —  [Edit] │   │ Change it any time    │
│ Only the couple sees  │   │ Ceremony              │   │ until 1 May using     │
│ this.            [1]  │   │  Ada  Yes  Bo  No     │   │ this link.            │
│ Bringing a guest?     │   │ [Edit answers]        │   │                       │
│ [Name________] [Meal▾]│   │ [ Send my reply ] [3] │   │                       │
└──────────────────────┘   └──────────────────────┘   └──────────────────────┘
```
1. Only questions the couple published appear; privacy note per sensitive question. 2. Conditional skip text is announced with `aria-live`. 3. One submit for all events: one transaction across the party's `invitation_members` rows. 4. Focus moves to the confirmation heading.
Accessibility: each step is a `<fieldset>` with `<legend>`; step heading receives focus on Next; errors summarized at the top and linked to fields (existing `FormErrorFocus`); no timeouts.

---

## W6 · RSVP Form Builder (desktop 1280)

```
Guests › Reply form                       Draft (v4) · Published v3
┌ Questions ───────────────────────┐ ┌ Preview (phone) ───────┐
│ ⠿ Attendance        built-in 🔒  │ │                         │
│ ⠿ Meal              built-in     │ │  (live render of W5     │
│    Show when: attending event    │ │   with sample people)   │
│    Saves to: meal choice  ✓ [1]  │ │                         │
│ ⠿ Dietary needs     text, private│ │                         │
│    Saves to: dietary note ✓      │ │                         │
│ ⠿ Need a shuttle?   yes/no       │ │                         │
│    Saves to: answer only  ⓘ [2]  │ │                         │
│ [+ Add a question]               │ │                         │
└──────────────────────────────────┘ └─────────────────────────┘
[Discard draft]          3 changes since v3      [Publish v4] [3]
```
1. Mapping chip: built-in questions map to canonical fields; validation blocks publish if a mapping target is missing. 2. Questions without a module store the answer only (no fake transport assignment). 3. Publish freezes a version; existing replies keep the version they answered.

---

## W7 · Planner override with impact preview (tray)

```
Change an answer · Example household
Answer for Bo   [Not attending ▾]
Meal            [—]
┌ What this changes ──────────────────┐   ← existing ImpactPreview
│ · Releases seat 5 at Table 6        │
│ · Seating v3 becomes out of date    │
│ · Caterer count drift becomes +4    │
│ Not changed: locked count, invoices │
└─────────────────────────────────────┘
Reason for the change [Called us on 3 May_____]
[Save change]
```

---

## W8 · Catering source-of-truth breakdown (Event Hub card)

```
Caterer count · Reception
Live attending          86   (+ 34 waiting, reply by 1 May)
Locked count            90   locked 1 May by owner        [Revise]
Contract minimum        80   from booking "Example Catering"
Invoiced                £8,800 for 80 · Paid £2,000
⚠ Locked count is 4 above attending. Nothing was sent to the caterer.
```

---

## W9 · Needs-attention item drawer

```
Reception: 2 seats released after you finalized
What happened   2 guests stopped attending (3 May, 4 May)
Touches         Seating v3 (out of date)
Suggested fix   Review the plan, then finalize again
[Open seating plan]   [Mark handled]
History         Opened 3 May · +1 on 4 May
```
