# Data model (logical schema)

Not a migration. Translate into SQL migrations, generated types and integration tests. UUID IDs, `created_at`, `updated_at`, `version` for mutable records; all tenant-owned rows carry non-null `wedding_id`. Use `(wedding_id,id)` unique keys on parents and composite FK for child relations; no cross-tenant FK even if IDs guessed. Users reference authenticated identity. `workspace_revision` increments on relevant transactions. Soft archive chosen for records with historical references; explicit deletion workflow for privacy. Store normalized values plus provenance and immutable snapshots where applicable.

## Core tables

| Table | Fields (in addition to common columns) | Constraints / notes |
|---|---|---|
| profiles | user_id PK, display_name, locale, timezone | no public profile by default |
| weddings | id, name, date nullable, timezone, base_currency, target_budget_minor nullable, target_guest_count nullable, location nullable, preferences JSON, revision | no wedding_id on root; timezone IANA, currency ISO; nonnegative targets |
| memberships | user_id, role, status, permissions JSON | unique wedding/user; role enum, grants server validated |
| collaborator_invites | email, role, token_hash, expires_at, redeemed_at, revoked_at | one-time, email match; rate limits |
| events | name, kind, local_date nullable, starts_at/ends_at nullable, timezone, venue_id nullable, target_attendance nullable, capacity nullable | end >= start; separate planned targets from RSVP |
| candidates | kind venue/vendor, category, name, source_type, source_url, source_verified_at, location, pricing_display, notes, archived_at | licensed catalog ID optional, no fake verification |
| venues | candidate_id, seated_capacity, ceremony_capacity, attributes JSON, policies JSON | unique candidate; only venue candidates |
| vendors | candidate_id, booking_stage, primary_contact, contact_channels JSON, selected_proposal_id nullable | unique candidate per wedding; booked requires reviewed commitment or explicit no-cost reason |
| proposals | vendor_id, event_id nullable, title, currency, pricing_basis, valid_until, source_document_id nullable, status | versioned estimates; comparison alternatives not summed |
| proposal_lines | proposal_id, category_id nullable, description, cost_mode, amount_minor nullable, quantity nullable, per_guest_minor nullable, minimum_qty nullable, max_qty nullable, tax_basis nullable, required, included_in_line_id nullable, evidence JSON | unknown distinct; validate mode and inclusions; no inclusion cycles |
| comparisons | title, event_id nullable, scenario_guest_count, currency, criteria JSON, weights JSON, chosen_proposal_id nullable | candidate rows linked by comparison_options; decision snapshot |
| comparison_options | comparison_id, proposal_id, rating_inputs JSON | unique comparison/proposal |
| decisions | comparison_id nullable, subject, status, decided_by, chosen_option_id nullable, snapshot JSON, decided_at | preserve selection revisions |
| budget_categories | name, allocation_minor nullable, sort_order | allocation sum warning, not hard gate |
| budget_items | category_id, vendor_id nullable, event_id nullable, proposal_line_id nullable, name, cost_mode, estimate_minor nullable, unit_minor nullable, quantity_basis, min_qty nullable, status | one active forecast item per covered expense; estimates not obligations |
| commitments | vendor_id nullable, proposal_id nullable, document_id nullable, amount_minor, currency, status, signed_at nullable, supersedes_id nullable | active contractual amount; status active/superseded/cancelled, changes explicit |
| commitment_allocations | commitment_id, budget_item_id, amount_minor | sum = commitment amount; prevent double coverage of active budget item |
| payment_installments | commitment_id, amount_minor, due_date nullable, status | due schedule not actual money; sum normally equal commitment or flag incomplete |
| payments | commitment_id nullable, budget_item_id nullable, installment_id nullable, kind charge/refund, amount_minor positive, paid_at, method_label, receipt_document_id nullable, external_ref nullable | exactly one parent target; installment must match commitment; idempotent external_ref when present |
| contributions | contributor_label, pledged_minor, received_minor, received_at nullable, note | not negative expense; private |
| households | name, contact fields, mailing address nullable, notes | private |
| guests | household_id nullable, name, contact fields, tags, adult_child nullable, sensitive fields separate, archived_at | no unique name assumption |
| guest_private_details | guest_id, dietary/allergy text, accessibility text, relationship/conflict notes | field-level projection; minimum necessary |
| invitations | household_id nullable, event_id, token_hash, plus_one_quota, deadline nullable, status, expires_at, revoked_at | token scoped to event/household, invitation member join handles nonhousehold |
| invitation_members | invitation_id, guest_id, eligible, is_plus_one, rsvp_status, meal_option_id nullable, responded_at | unique invitation/guest; enforce only one active member per event/guest via event_id + partial unique or transactional constraint |
| meal_options | event_id, name, active | event must match response |
| layouts | event_id, name, draft/final/archived status, scale nullable, background_document_id nullable, finalized_revision nullable | one current active layout per event; alternatives explicit |
| tables | layout_id, label, capacity, shape, geometry JSON nullable | positive capacity, unique label/layout |
| seat_assignments | layout_id, table_id, guest_id, seat_number nullable, tentative, assigned_at | unique layout/guest, unique numbered seat/table, same layout/event; capacity transaction lock |
| tasks | event_id nullable, vendor_id nullable, title, status, assignee_user_id nullable, due_date nullable, date_kind, template_key nullable, offset_days nullable, source_commitment_id nullable | date_kind fixed/relative; unique template instance key; assignee active member |
| task_dependencies | task_id, prerequisite_task_id | no self/cycles; R2 |
| timeline_items | event_id, title, starts_at, ends_at nullable, owner_member_id nullable, vendor_id nullable, notes, sort_order, status | IANA event timezone; overlap warnings, not universal bans |
| documents | kind, storage_key, mime, bytes, checksum, original_name, scan_status, visibility, uploaded_by, archived_at | private storage, quarantine until safe; links via document_links |
| document_links | document_id, entity_type, entity_id | prefer concrete FK join tables in SQL; if generic, enforce tenant ownership/existence transactionally |
| boards / board_items | title, description / board_id, asset_id or url, palette, note, position | asset rights and private storage |
| website_versions | draft/published, slug, template, public_blocks JSON, published_at, revision | globally unique active slug via site record; explicit public allowlist; no secret nested fields |
| packages | type, recipient_role, sections, redaction_policy, source_revision, status, snapshot_hash, requested_by | immutable snapshot; mutable generation status separate |
| package_artifacts | package_id, private storage_key, format, checksum, size, generated_at | safe download |
| share_grants | package_id, token_hash, expires_at, revoked_at, audience, redeemed_at nullable | opaque random token; no raw token logs |
| audit_events | actor_id nullable, entity_type, entity_id, action, safe_changes JSON, revision, request_id, occurred_at | append only, redact PII and credentials |
| outbox_events | event_type, payload minimal IDs, revision, attempts, available_at, processed_at, last_error_code | idempotent processing; no secret payload |
| idempotency_keys | actor_scope, operation, key, request_hash, response_ref, expires_at | unique scope/op/key, mismatch conflict |

## R2/R3 extension entities

`extraction_jobs`, `extracted_fields` (page/quote/source/confidence), `ai_change_proposals` (typed patch, source rev, approval), `budget_scenarios`, `decision_votes`, `message_threads`, `message_drafts`, `integration_connections` (encrypted tokens), `delivery_attempts`, `vendor_grants`, `layout_elements`, `transport_routes`, `transport_assignments`, `lodging_blocks`, `beauty_appointments`, `shot_lists`, `contingency_plans`, `day_of_issues`, `vendor_checkins`, `guest_uploads`. Add only when ticket requires them.

## Indexes & access patterns

All tenant FKs indexed; common composites `(wedding_id,status)`, `(wedding_id,event_id)`, `(wedding_id,due_date)`, `(wedding_id,vendor_id)`, `(wedding_id,updated_at,id)` for cursor lists. Unique hashes for invite/share token lookups (privileged RPC only). GIN on searchable documented non-sensitive fields only after query plan review. RLS on every tenant table; private guest data and package artifacts explicitly restricted. Cascades only for pure child records or approved erasure; restrict deletion of financially referenced objects; archive and surface unresolved entries. Public RSVP queries should return only permitted household/event projections.

## Date/quantity assumptions

One base currency in R1; store original currency for evidence but don't sum foreign amounts. All-day dates DATE, timestamps timestamptz, event timezone explicit; unknown dates nullable. Use exact integer arithmetic/decimal rounding for costs. RSVP statuses `pending`, `accepted`, `declined`; invitation delivery separate from response. Vendor stage `saved`, `contacted`, `proposal_received`, `considering`, `booked`, `declined`, `cancelled`. Status transitions explicit, audited.
