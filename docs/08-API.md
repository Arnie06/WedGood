# API contracts

Proposed versioned HTTP interface for mutations and external clients. Server components may call same authorized application services directly. Validate inputs at boundary, generate or maintain typed contracts, return DTOs not raw database rows. R0/R1 implement only routes required by tickets. Every workspace route verifies active membership and permission server-side; IDs in body are untrusted. Tenant derived from validated path and actor.

## Conventions

- Base `/api/v1`; authenticated cookie session with origin/CSRF protection for unsafe methods. Guest/shared capability token endpoints separate. HTTPS production. JSON UTF-8; multipart or presigned file upload flows. No secret tokens echoed in general API or logs.
- Success: `{"data": { ... }, "meta": {"revision": 7}}`; lists `data` array + `meta.nextCursor`. Immutable cursor using sort key + id; default limit 25, max 100. Use UTC ISO 8601 timestamps, `YYYY-MM-DD` date-only.
- Error: `{"error":{"code":"CAPACITY_EXCEEDED","message":"This table is full.","fieldErrors":{},"requestId":"..."}}`. 400 malformed, 401 no auth, 403 insufficient in visible workspace, 404 unknown/foreign object, 409 conflict/version/idempotency, 422 validation/invariant, 429 rate limit, 503 provider unavailable. No stack traces or sensitive data.
- `Idempotency-Key` for creates, imports, response submissions, booking/payment, export generation and job requests. Actor scope + operation + key + request hash; same returns existing result, differing hash 409. Expire per retention policy; critical external refs additionally unique. `expectedVersion` for update/delete (or standard If-Match, choose once); conflict returns current safe version. Use optimistic UI only reversible.

## Route inventory

Prefix `W = /api/v1/weddings/{weddingId}`. CRUD = GET list/detail, POST create, PATCH update, DELETE archive where supported. No arbitrary mass assignment. All command routes POST and validate transition.

| Route | Method / purpose | Permission |
|---|---|---|
| `/api/v1/weddings` | GET memberships, POST create | authenticated |
| `W` | GET, PATCH settings | scoped read / owner edit |
| `W/members`, `W/invites` | list, invite, revoke/change role | manage members; owner protected |
| `W/events` | CRUD | planning write |
| `W/dashboard` | GET derived rollups | scoped projection |
| `W/candidates`, `W/vendors`, `W/proposals` | CRUD, filters | vendor read/write |
| `W/discovery/search` | GET personal or configured catalog | discovery read |
| `W/comparisons` | CRUD | compare read/write |
| `W/comparisons/{id}/evaluate` | POST normalize + score, no mutation | compare read |
| `W/comparisons/{id}/decide` | POST decision snapshot | compare write |
| `W/vendors/{id}/book` | POST reviewed commitment creation | vendor + budget write |
| `W/budget/summary` | GET forecast/known subtotal/incomplete | budget read |
| `W/budget/categories`, `W/budget/items` | CRUD | budget read/write |
| `W/commitments`, `W/installments`, `W/payments`, `W/contributions` | list/create/update via explicit commands; refund/amend | budget read/write |
| `W/guests`, `W/households`, `W/meal-options` | CRUD | guest read/write; sensitive fields scoped |
| `W/guests/import/preview`, `/commit` | POST staged import | guest write |
| `W/invitations` | create/list/revoke, POST reminder draft/send | guest write + send permission |
| `W/invitations/{id}/responses` | POST owner response override | guest write |
| `/api/v1/rsvp/redeem`, `/api/v1/rsvp/respond` | POST token redemption and scoped response | capability only; rate limited |
| `W/layouts`, `W/layouts/{id}/tables` | CRUD | seating read/write |
| `W/layouts/{id}/assign`, `/unassign`, `/finalize` | POST transactional operations | seating write |
| `W/tasks`, `W/timeline` | CRUD | plan read/write |
| `W/date-change/preview`, `/apply` | POST preview / reviewed changes | plan/settings write |
| `W/documents/upload-intent`, `/complete`, `/{id}/download` | POST presign/complete; GET signed download | scoped document access |
| `W/boards` | CRUD + items | design read/write |
| `W/website` | GET draft, PATCH draft | site edit |
| `W/website/publish`, `/unpublish` | POST explicit publication | publish permission |
| `W/packages/preview`, `W/packages` | POST redacted projection / create snapshot | package create + section read |
| `W/packages/{id}` | GET status; GET `/download`; POST `/share`, `/revoke` if enabled | artifact/recipient scope |
| `W/audit` | GET redacted history | authorized admin |

R2: `W/assistant/messages`, `W/ai-proposals/{id}/approve`, `/reject`, extraction jobs and integration connections. R3: vendor grants, transport, live day-of and layout elements. Do not ship placeholders that return success for unimplemented functionality.

## Representative payloads

```json
{"vendorId":"uuid","proposalId":"uuid","currency":"USD","amountMinor":1000000,"allocations":[{"budgetItemId":"uuid","amountMinor":1000000}],"installments":[{"amountMinor":250000,"dueDate":"2027-01-15"},{"amountMinor":750000,"dueDate":"2027-05-08"}],"expectedVersion":3,"confirmation":true}
```
Booking command returns vendor, commitment ID, revision and task references; recheck authorization, selected proposal belongs to vendor, allocations sum, current versions and event. No external action.

```json
{"responses":[{"memberId":"uuid","status":"accepted","mealOptionId":"uuid"}],"plusOne":{"name":"Taylor Example"},"expectedVersion":2}
```
RSVP request after redeeming token into short-lived scoped session; plusOne optional, quota validation, eligible member checks; no editable event/wedding/household IDs. CSRF/origin protection on session. Return own invitation projection only. Raw token never retained in analytics or referrer paths.

```json
{"guestId":"uuid","tableId":"uuid","tentative":false,"expectedVersion":4}
```
Assign command locks layout/table; response includes count and layout version. Full table yields `CAPACITY_EXCEEDED`; wrong event yields validation error; concurrent layout version yields `VERSION_CONFLICT`.

```json
{"type":"caterer","recipientRole":"vendor","sections":["event_overview","meal_summary","seating_chart","service_timeline"],"sourceRevision":18,"format":"pdf"}
```
Package preview returns exact allowed fields, warnings, revision and digest; create takes approved digest/expected revision and revalidates. Async 202 `status: queued` only if job processing configured; otherwise generate synchronously under size/time limit or return actionable error. Snapshot must be immutable. File URLs scoped and short-lived.

## Validation and delivery

Use server schemas for limits (names ~120 chars, notes bounded, page size and CSV rows configurable, upload cap per MIME). Reject extra fields for commands. Normalize whitespace; don't coerce blank number to zero. Webhook verify provider signatures and replay protection; event dedupe; no client trust. Rate limits per actor/workspace and public token/IP with privacy-aware logging. Test positive, foreign tenant, missing permission, malformed payload, concurrency, replay and provider failure per route.
