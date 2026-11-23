# BEFORE_AFTER_FLOWS.md

For each workflow: **Before** = what the app does today (cited) · **After** = proposed journey · **Why**. "After" reuses existing RPCs and tables wherever possible; new persistence is called out explicitly and is deferred until approved.

---

## F1. Create and send an invitation

**Before** (`guests/invitations/page.tsx:191-205`, `server/events/actions.ts:213-325`)
1. Guests → Invitations. The page stacks every event.
2. Under one event: Invite guests (tray) → pick households/individuals, reply-by date, link expiry, plus-ones → Create.
3. Repeat for each event. A household invited to Ceremony + Reception gets **two links**.
4. Copy each link, share it yourself, optionally "Mark as shared".

**After**
1. Guests & Invitations → **Invite** (one tray). Step 1: pick parties. Step 2: tick events per party (matrix, defaults from the party's tags). Step 3: plus-ones per party per event, reply-by date (shown in the wedding's zone). Step 4: review "3 parties · 2 events · 5 people · 1 plus-one place" → Create.
2. Each party gets **one party link** that opens every event they are invited to.
3. Delivery state unchanged ("Not shared yet" / "Shared by you"); copy-all CSV of links for the couple to mail-merge themselves.

**Why** One link per party halves the links a couple must manage and removes the most likely guest error (answering one event and missing the other). The canonical per-event rows (`invitation_members`) stay as they are.

---

## F2. Guest responds per event and person

**Before** (`rsvp/[token]/page.tsx`, `rsvp-form.tsx`; seen at 320px): one event per page, one long form, meal select shown even for "Not attending", plus-one fieldset, Send.

**After** (mobile stepper, see SCREEN_MOCKUPS W5)
1. **Welcome**: wedding, party name, events you're invited to, reply-by date.
2. **Who's coming**: per event, per person: Attending / Not attending (big radio cards).
3. **Meals**: only for people attending an event that has meal options; one question per person per event.
4. **Details** (published questions only): dietary notes (private), accessibility needs, transport interest. Each answer shows the label "Shared with the couple only".
5. **Plus-one** (if a place exists for an event someone attends): name + meal, or "Not bringing anyone".
6. **Review**: table of person × event × meal; Edit links per step → **Send**.
7. **Confirmation**: same summary, "You can change this until {date}", Add to calendar (later ticket).

**Why** Conditional steps remove irrelevant questions; the review step makes the first submission deliberate and cuts later corrections.

---

## F3. Name a plus-one

**Before**: free-text name + meal; creates a guest and accepts them (`events_rsvp.sql:739-776`). Guest can later only mark them "Not attending"; the place stays used.

**After**: same write; in Review the plus-one row has "Remove". Removal = decline + free the place (needs a small RPC change, P2). Planner sees "Plus-one added by guest" tag (already `plus-one` tag) and the name on the reply history.

---

## F4. Submit, retry, edit

**Before**: idempotent, version-checked, atomic; stale tab gets the latest answers back with a message (`server/rsvp/actions.ts:74-88`). Button disabled while sending.

**After**: unchanged backend. UI adds: "Sending…" → "Saved {time}" with summary; on conflict: "Someone in your party already updated this. Here's the latest; check and send again." (current copy is generic). Edit = reopen the link → lands on Review with current answers.

---

## F5. Planner sees the accepted response

**Before**: invitations page card lists each member's answer and meal; counts strip; Event page "Who's coming"; reply history on the guest page. The guest list itself shows no RSVP data.

**After**: Guest table with event selector and columns **Answer · Meal · Seat · Dietary flag**; filters "Waiting", "Attending without meal", "Attending, not seated", "Changed since last finalized plan". Row → side panel (Guest Profile + Impact) without leaving the table.

---

## F6. Guest declines after seating was finalized (brief's late cancellation)

**Before** (verified by tests): seat removed from the live plan in the same transaction; finalized version kept and marked out of date; one "seats released" item on Home/Needs attention; caterer drift item if a count is locked; budget forecast moves; guarantee unchanged.

**After**: same data behaviour. Presentation adds:
- Needs-attention item names the event and links to the seating plan **filtered to the released seat(s)** with "Re-finalize" as the resolving action.
- Guest side panel shows a **Consequences** block: *Updated automatically:* attending count, meal tally, forecast. *Needs your review:* seating version out of date, caterer count now 1 above attending. *Not changed:* locked caterer count, contracts, invoices, payments.

---

## F7. Caterer guarantee already locked

**Before**: locked row immutable; drift computed; revise needs a reason and a fresh preview (`catering_guarantees.sql:1-14`).

**After**: Catering card on the Event Hub shows a source-of-truth breakdown in one place: Live attending · Locked count (date, by whom) · Contracted minimum (from booking, if entered) · Invoiced · Paid. Drift row links to "Revise count" with the impact preview already used by the guarantee flow.

---

## F8. Planner changes an answer for a guest

**Before**: Change an answer → status, meal, reason → Save (`event-forms.tsx` OverrideForm). A seated guest silently loses their seat; no preview.

**After**: after choosing the new answer, an **ImpactPreview** (existing primitive) lists the effects before Save: "Releases seat 4 at Table 6 · Finalized plan becomes out of date · Caterer count drift becomes +1". Save stays one click; no modal.

---

## F9. Issue opened and resolved

**Before**: Needs attention list with links; computed items can be dismissed (come back if they change); stored "seats released" items can be marked handled or close on re-finalize.

**After**: same model plus an item detail drawer: what happened (counts, no names for collaborators without access), which records it touches, suggested fix, **who handled it and when** (read from existing audit events). Optional assignee only after the planner-role work (deferred).
