# SCREEN_MOCKUPS / MANIFEST

Annotated static wireframes in `WIREFRAMES.md` (ASCII, so they review in any editor and diff cleanly). No prototype was built inside the app: the brief forbids modifying it, and a separate prototype would duplicate the existing design primitives. If you want clickable versions, the repo already has a segregated `/preview` route group (`src/app/preview/*`) intended for labelled synthetic prototypes; that would be a separate, approved ticket.

| ID | Screen | Viewport | Reuses | New components |
|---|---|---|---|---|
| W1 | Wedding Overview | mobile 390 | Card, AttentionList, CountStrip | Deadline strip |
| W2 | Event Hub | desktop 1280 | existing Event page sections | Event budget section, invitee mini-table |
| W3 | Guest & Invitation table | desktop 1280 + mobile 390 | GuestFilters, Badge | Event selector, status columns, side panel |
| W4 | Guest profile + impact panel | side panel | Card, Badge | Consequences block (live / review / protected) |
| W5 | Guest mobile RSVP stepper (5 steps + confirmation) | mobile 320/390 | TextField, SelectField, Button | Stepper, radio cards, review table |
| W6 | RSVP Form Builder (questions + preview) | desktop 1280 | Tray, form fields | Question list, mapping chip, publish bar |
| W7 | Planner override with impact preview | tray | ImpactPreview, OverrideForm | — |
| W8 | Catering source-of-truth breakdown | Event Hub card | GuaranteeCard | Breakdown rows |
| W9 | Needs-attention item drawer | tray | Tray, AttentionList | Resolution history |

Design rules applied (docs/03-DESIGN.md, AGENTS.md): blush primary with charcoal text; deep rose for high-emphasis; eucalyptus for confirmed/progress; gold decorative only; serif headings; 44–48px targets; no hover-only actions; drag-and-drop never required.
