
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "attention_dismissals": {
                  Row: {
                    "dismissed_at": string,"dismissed_by": string | null,"fingerprint": string,"guest_data": boolean | null,"id": string,"kind": string,"subject_id": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "dismissed_at"?: string,"dismissed_by"?: string | null,"fingerprint": string,"guest_data"?: never,"id"?: string,"kind": string,"subject_id": string,"wedding_id": string
                  }
                  Update: {
                    "dismissed_at"?: string,"dismissed_by"?: string | null,"fingerprint"?: string,"guest_data"?: never,"id"?: string,"kind"?: string,"subject_id"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "attention_dismissals_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"attention_items": {
                  Row: {
                    "created_at": string,"event_id": string,"id": string,"kind": string,"occurrences": number,"resolved_at": string | null,"resolved_by": string | null,"status": string,"updated_at": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"event_id": string,"id"?: string,"kind": string,"occurrences"?: number,"resolved_at"?: string | null,"resolved_by"?: string | null,"status"?: string,"updated_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"event_id"?: string,"id"?: string,"kind"?: string,"occurrences"?: number,"resolved_at"?: string | null,"resolved_by"?: string | null,"status"?: string,"updated_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "attention_items_wedding_id_event_id_fkey"
      columns: ["wedding_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "attention_items_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_events": {
                  Row: {
                    "action": string,"actor_id": string | null,"entity_id": string,"entity_type": string,"id": string,"occurred_at": string,"request_id": string | null,"revision": number,"safe_changes": NonNullable<Json>,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"entity_id": string,"entity_type": string,"id"?: string,"occurred_at"?: string,"request_id"?: string | null,"revision": number,"safe_changes"?: NonNullable<Json>,"wedding_id": string
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"entity_id"?: string,"entity_type"?: string,"id"?: string,"occurred_at"?: string,"request_id"?: string | null,"revision"?: number,"safe_changes"?: NonNullable<Json>,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_events_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"budget_categories": {
                  Row: {
                    "allocation_minor": number | null,"archived_at": string | null,"created_at": string,"created_by": string | null,"id": string,"name": string,"sort_order": number,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "allocation_minor"?: number | null,"archived_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"name": string,"sort_order"?: number,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "allocation_minor"?: number | null,"archived_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"name"?: string,"sort_order"?: number,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "budget_categories_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"budget_items": {
                  Row: {
                    "amount_minor": number | null,"archived_at": string | null,"category_id": string,"cost_mode": string,"count_event_id": string | null,"count_source": string,"count_typed": number | null,"created_at": string,"created_by": string | null,"id": string,"min_qty": number | null,"name": string,"notes": string | null,"quantity": number | null,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor"?: number | null,"archived_at"?: string | null,"category_id": string,"cost_mode"?: string,"count_event_id"?: string | null,"count_source"?: string,"count_typed"?: number | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"min_qty"?: number | null,"name": string,"notes"?: string | null,"quantity"?: number | null,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "amount_minor"?: number | null,"archived_at"?: string | null,"category_id"?: string,"cost_mode"?: string,"count_event_id"?: string | null,"count_source"?: string,"count_typed"?: number | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"min_qty"?: number | null,"name"?: string,"notes"?: string | null,"quantity"?: number | null,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "budget_items_count_event_fk"
      columns: ["wedding_id","count_event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "budget_items_wedding_id_category_id_fkey"
      columns: ["wedding_id","category_id"]
isOneToOne: false
      referencedRelation: "budget_categories"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"budget_settings": {
                  Row: {
                    "reserve_bp": number | null,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "reserve_bp"?: number | null,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "reserve_bp"?: number | null,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "budget_settings_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: true
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"candidates": {
                  Row: {
                    "archived_at": string | null,"category": string,"created_at": string,"created_by": string | null,"id": string,"is_favorite": boolean,"kind": string,"location": string | null,"name": string,"notes": string | null,"price_basis": string | null,"price_currency": string | null,"price_minor": number | null,"pricing_display": string | null,"source_checked_on": string | null,"source_type": string,"source_url": string | null,"stage": string,"stage_changed_at": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"category": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"is_favorite"?: boolean,"kind": string,"location"?: string | null,"name": string,"notes"?: string | null,"price_basis"?: string | null,"price_currency"?: string | null,"price_minor"?: number | null,"pricing_display"?: string | null,"source_checked_on"?: string | null,"source_type"?: string,"source_url"?: string | null,"stage"?: string,"stage_changed_at"?: string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"category"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"is_favorite"?: boolean,"kind"?: string,"location"?: string | null,"name"?: string,"notes"?: string | null,"price_basis"?: string | null,"price_currency"?: string | null,"price_minor"?: number | null,"pricing_display"?: string | null,"source_checked_on"?: string | null,"source_type"?: string,"source_url"?: string | null,"stage"?: string,"stage_changed_at"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "candidates_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"catering_guarantees": {
                  Row: {
                    "candidate_id": string | null,"due_on": string | null,"event_id": string,"guaranteed_count": number,"id": string,"kind": string,"locked_at": string,"locked_by": string | null,"meals": NonNullable<Json>,"reason": string | null,"status": string,"superseded_at": string | null,"supersedes_id": string | null,"wedding_id": string,"without_meal_at_lock": number,"yes_at_lock": number
                  }
                  ComputedFields: never
                  Insert: {
                    "candidate_id"?: string | null,"due_on"?: string | null,"event_id": string,"guaranteed_count": number,"id"?: string,"kind"?: string,"locked_at"?: string,"locked_by"?: string | null,"meals": NonNullable<Json>,"reason"?: string | null,"status"?: string,"superseded_at"?: string | null,"supersedes_id"?: string | null,"wedding_id": string,"without_meal_at_lock": number,"yes_at_lock": number
                  }
                  Update: {
                    "candidate_id"?: string | null,"due_on"?: string | null,"event_id"?: string,"guaranteed_count"?: number,"id"?: string,"kind"?: string,"locked_at"?: string,"locked_by"?: string | null,"meals"?: NonNullable<Json>,"reason"?: string | null,"status"?: string,"superseded_at"?: string | null,"supersedes_id"?: string | null,"wedding_id"?: string,"without_meal_at_lock"?: number,"yes_at_lock"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "catering_guarantees_wedding_id_candidate_id_kind_fkey"
      columns: ["wedding_id","candidate_id","kind"]
isOneToOne: false
      referencedRelation: "candidates"
      referencedColumns: ["wedding_id","id","kind"]
    },{
      foreignKeyName: "catering_guarantees_wedding_id_event_id_fkey"
      columns: ["wedding_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "catering_guarantees_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "catering_guarantees_wedding_id_supersedes_id_fkey"
      columns: ["wedding_id","supersedes_id"]
isOneToOne: false
      referencedRelation: "catering_guarantees"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"collaborator_invites": {
                  Row: {
                    "created_at": string,"email": string,"expires_at": string,"id": string,"invited_by": string | null,"redeemed_at": string | null,"redeemed_by": string | null,"revoked_at": string | null,"role": Database["public"]['Enums']["membership_role"],"token_hash": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"email": string,"expires_at": string,"id"?: string,"invited_by"?: string | null,"redeemed_at"?: string | null,"redeemed_by"?: string | null,"revoked_at"?: string | null,"role": Database["public"]['Enums']["membership_role"],"token_hash": string,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"email"?: string,"expires_at"?: string,"id"?: string,"invited_by"?: string | null,"redeemed_at"?: string | null,"redeemed_by"?: string | null,"revoked_at"?: string | null,"role"?: Database["public"]['Enums']["membership_role"],"token_hash"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "collaborator_invites_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"comments": {
                  Row: {
                    "author_id": string | null,"body": string,"created_at": string,"edited_at": string | null,"id": string,"subject_id": string,"subject_kind": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "author_id"?: string | null,"body": string,"created_at"?: string,"edited_at"?: string | null,"id"?: string,"subject_id": string,"subject_kind": string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "author_id"?: string | null,"body"?: string,"created_at"?: string,"edited_at"?: string | null,"id"?: string,"subject_id"?: string,"subject_kind"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "comments_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"commitment_allocations": {
                  Row: {
                    "active": boolean,"amount_minor": number,"budget_item_id": string,"commitment_id": string,"created_at": string,"id": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"amount_minor": number,"budget_item_id": string,"commitment_id": string,"created_at"?: string,"id"?: string,"wedding_id": string
                  }
                  Update: {
                    "active"?: boolean,"amount_minor"?: number,"budget_item_id"?: string,"commitment_id"?: string,"created_at"?: string,"id"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "commitment_allocations_wedding_id_budget_item_id_fkey"
      columns: ["wedding_id","budget_item_id"]
isOneToOne: false
      referencedRelation: "budget_items"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "commitment_allocations_wedding_id_commitment_id_fkey"
      columns: ["wedding_id","commitment_id"]
isOneToOne: false
      referencedRelation: "commitments"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"commitments": {
                  Row: {
                    "amount_minor": number,"candidate_id": string | null,"created_at": string,"created_by": string | null,"currency": string,"id": string,"proposal_id": string | null,"signed_on": string | null,"status": string,"supersedes_id": string | null,"title": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor": number,"candidate_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency": string,"id"?: string,"proposal_id"?: string | null,"signed_on"?: string | null,"status"?: string,"supersedes_id"?: string | null,"title": string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "amount_minor"?: number,"candidate_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"id"?: string,"proposal_id"?: string | null,"signed_on"?: string | null,"status"?: string,"supersedes_id"?: string | null,"title"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "commitments_wedding_id_candidate_id_fkey"
      columns: ["wedding_id","candidate_id"]
isOneToOne: false
      referencedRelation: "candidates"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "commitments_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "commitments_wedding_id_proposal_id_fkey"
      columns: ["wedding_id","proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "commitments_wedding_id_supersedes_id_fkey"
      columns: ["wedding_id","supersedes_id"]
isOneToOne: false
      referencedRelation: "commitments"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"comparison_options": {
                  Row: {
                    "comparison_id": string,"created_at": string,"id": string,"position": number,"proposal_id": string,"ratings": NonNullable<Json>,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "comparison_id": string,"created_at"?: string,"id"?: string,"position": number,"proposal_id": string,"ratings"?: NonNullable<Json>,"wedding_id": string
                  }
                  Update: {
                    "comparison_id"?: string,"created_at"?: string,"id"?: string,"position"?: number,"proposal_id"?: string,"ratings"?: NonNullable<Json>,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "comparison_options_wedding_id_comparison_id_fkey"
      columns: ["wedding_id","comparison_id"]
isOneToOne: false
      referencedRelation: "comparisons"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "comparison_options_wedding_id_proposal_id_fkey"
      columns: ["wedding_id","proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"comparisons": {
                  Row: {
                    "accepts_unknowns": boolean,"archived_at": string | null,"count_event_id": string | null,"created_at": string,"created_by": string | null,"criteria": NonNullable<Json>,"currency": string,"id": string,"scenario_guest_count": number,"title": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepts_unknowns"?: boolean,"archived_at"?: string | null,"count_event_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"criteria"?: NonNullable<Json>,"currency": string,"id"?: string,"scenario_guest_count": number,"title": string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "accepts_unknowns"?: boolean,"archived_at"?: string | null,"count_event_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"criteria"?: NonNullable<Json>,"currency"?: string,"id"?: string,"scenario_guest_count"?: number,"title"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "comparisons_count_event_fk"
      columns: ["wedding_id","count_event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "comparisons_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"decisions": {
                  Row: {
                    "chosen_proposal_id": string,"comparison_id": string,"decided_at": string,"decided_by": string | null,"id": string,"note": string | null,"snapshot": NonNullable<Json>,"source_state": NonNullable<Json>,"superseded_at": string | null,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "chosen_proposal_id": string,"comparison_id": string,"decided_at"?: string,"decided_by"?: string | null,"id"?: string,"note"?: string | null,"snapshot": NonNullable<Json>,"source_state": NonNullable<Json>,"superseded_at"?: string | null,"wedding_id": string
                  }
                  Update: {
                    "chosen_proposal_id"?: string,"comparison_id"?: string,"decided_at"?: string,"decided_by"?: string | null,"id"?: string,"note"?: string | null,"snapshot"?: NonNullable<Json>,"source_state"?: NonNullable<Json>,"superseded_at"?: string | null,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "decisions_wedding_id_chosen_proposal_id_fkey"
      columns: ["wedding_id","chosen_proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "decisions_wedding_id_comparison_id_fkey"
      columns: ["wedding_id","comparison_id"]
isOneToOne: false
      referencedRelation: "comparisons"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"design_boards": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"created_by": string | null,"description": string | null,"id": string,"palette": (string)[],"title": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"id"?: string,"palette"?: (string)[],"title": string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"id"?: string,"palette"?: (string)[],"title"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "design_boards_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"design_items": {
                  Row: {
                    "board_id": string,"bytes": number | null,"candidate_id": string | null,"checksum": string | null,"created_at": string,"created_by": string | null,"favorite": boolean,"id": string,"kind": string,"mime": string | null,"note": string | null,"original_name": string | null,"position": number,"reject_reason": string | null,"rights": string | null,"status": string,"storage_key": string | null,"title": string,"updated_at": string,"url": string | null,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "board_id": string,"bytes"?: number | null,"candidate_id"?: string | null,"checksum"?: string | null,"created_at"?: string,"created_by"?: string | null,"favorite"?: boolean,"id"?: string,"kind": string,"mime"?: string | null,"note"?: string | null,"original_name"?: string | null,"position": number,"reject_reason"?: string | null,"rights"?: string | null,"status"?: string,"storage_key"?: string | null,"title": string,"updated_at"?: string,"url"?: string | null,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "board_id"?: string,"bytes"?: number | null,"candidate_id"?: string | null,"checksum"?: string | null,"created_at"?: string,"created_by"?: string | null,"favorite"?: boolean,"id"?: string,"kind"?: string,"mime"?: string | null,"note"?: string | null,"original_name"?: string | null,"position"?: number,"reject_reason"?: string | null,"rights"?: string | null,"status"?: string,"storage_key"?: string | null,"title"?: string,"updated_at"?: string,"url"?: string | null,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "design_items_wedding_id_board_id_fkey"
      columns: ["wedding_id","board_id"]
isOneToOne: false
      referencedRelation: "design_boards"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "design_items_wedding_id_candidate_id_fkey"
      columns: ["wedding_id","candidate_id"]
isOneToOne: false
      referencedRelation: "candidates"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"document_links": {
                  Row: {
                    "candidate_id": string | null,"commitment_id": string | null,"created_at": string,"created_by": string | null,"document_id": string,"id": string,"payment_id": string | null,"proposal_id": string | null,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "candidate_id"?: string | null,"commitment_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"document_id": string,"id"?: string,"payment_id"?: string | null,"proposal_id"?: string | null,"wedding_id": string
                  }
                  Update: {
                    "candidate_id"?: string | null,"commitment_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"document_id"?: string,"id"?: string,"payment_id"?: string | null,"proposal_id"?: string | null,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "document_links_wedding_id_candidate_id_fkey"
      columns: ["wedding_id","candidate_id"]
isOneToOne: false
      referencedRelation: "candidates"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "document_links_wedding_id_commitment_id_fkey"
      columns: ["wedding_id","commitment_id"]
isOneToOne: false
      referencedRelation: "commitments"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "document_links_wedding_id_document_id_fkey"
      columns: ["wedding_id","document_id"]
isOneToOne: false
      referencedRelation: "documents"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "document_links_wedding_id_payment_id_fkey"
      columns: ["wedding_id","payment_id"]
isOneToOne: false
      referencedRelation: "payments"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "document_links_wedding_id_proposal_id_fkey"
      columns: ["wedding_id","proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"documents": {
                  Row: {
                    "archived_at": string | null,"bytes": number,"checksum": string | null,"created_at": string,"id": string,"kind": string,"mime": string,"original_name": string | null,"reject_reason": string | null,"scan_status": string,"storage_key": string,"title": string,"updated_at": string,"uploaded_by": string | null,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"bytes": number,"checksum"?: string | null,"created_at"?: string,"id"?: string,"kind": string,"mime": string,"original_name"?: string | null,"reject_reason"?: string | null,"scan_status"?: string,"storage_key": string,"title": string,"updated_at"?: string,"uploaded_by"?: string | null,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"bytes"?: number,"checksum"?: string | null,"created_at"?: string,"id"?: string,"kind"?: string,"mime"?: string,"original_name"?: string | null,"reject_reason"?: string | null,"scan_status"?: string,"storage_key"?: string,"title"?: string,"updated_at"?: string,"uploaded_by"?: string | null,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "documents_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"event_locations": {
                  Row: {
                    "candidate_id": string,"created_at": string,"event_id": string,"kind": string,"set_by": string | null,"space_id": string | null,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "candidate_id": string,"created_at"?: string,"event_id": string,"kind"?: string,"set_by"?: string | null,"space_id"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "candidate_id"?: string,"created_at"?: string,"event_id"?: string,"kind"?: string,"set_by"?: string | null,"space_id"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_locations_wedding_id_candidate_id_kind_fkey"
      columns: ["wedding_id","candidate_id","kind"]
isOneToOne: false
      referencedRelation: "candidates"
      referencedColumns: ["wedding_id","id","kind"]
    },{
      foreignKeyName: "event_locations_wedding_id_candidate_id_space_id_fkey"
      columns: ["wedding_id","candidate_id","space_id"]
isOneToOne: false
      referencedRelation: "venue_spaces"
      referencedColumns: ["wedding_id","candidate_id","id"]
    },{
      foreignKeyName: "event_locations_wedding_id_event_id_fkey"
      columns: ["wedding_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"event_vendors": {
                  Row: {
                    "candidate_id": string,"created_at": string,"created_by": string | null,"event_id": string,"kind": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "candidate_id": string,"created_at"?: string,"created_by"?: string | null,"event_id": string,"kind"?: string,"wedding_id": string
                  }
                  Update: {
                    "candidate_id"?: string,"created_at"?: string,"created_by"?: string | null,"event_id"?: string,"kind"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_vendors_wedding_id_candidate_id_kind_fkey"
      columns: ["wedding_id","candidate_id","kind"]
isOneToOne: false
      referencedRelation: "candidates"
      referencedColumns: ["wedding_id","id","kind"]
    },{
      foreignKeyName: "event_vendors_wedding_id_event_id_fkey"
      columns: ["wedding_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"events": {
                  Row: {
                    "capacity": number | null,"created_at": string,"id": string,"invitations_final": boolean,"kind": string,"local_date": string | null,"location_seq": number,"name": string,"plan_open_plus_ones": boolean,"planning_basis": string,"target_attendance": number | null,"time_zone": string | null,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "capacity"?: number | null,"created_at"?: string,"id"?: string,"invitations_final"?: boolean,"kind"?: string,"local_date"?: string | null,"location_seq"?: number,"name": string,"plan_open_plus_ones"?: boolean,"planning_basis"?: string,"target_attendance"?: number | null,"time_zone"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "capacity"?: number | null,"created_at"?: string,"id"?: string,"invitations_final"?: boolean,"kind"?: string,"local_date"?: string | null,"location_seq"?: number,"name"?: string,"plan_open_plus_ones"?: boolean,"planning_basis"?: string,"target_attendance"?: number | null,"time_zone"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "events_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"guest_imports": {
                  Row: {
                    "created_at": string,"created_by": string | null,"guest_count": number,"id": string,"new_household_count": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"guest_count": number,"id"?: string,"new_household_count": number,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"guest_count"?: number,"id"?: string,"new_household_count"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "guest_imports_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"guest_messages": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"attempts": number,"body": string,"cancelled_at": string | null,"created_at": string,"created_by": string | null,"dedupe_key": string,"event_id": string,"guest_id": string,"id": string,"invitation_id": string,"kind": string,"last_error": string | null,"provider": string | null,"provider_receipt": string | null,"recipient_email": string,"sending_since": string | null,"sent_at": string | null,"state_hash": string,"status": string,"subject": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"attempts"?: number,"body": string,"cancelled_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"dedupe_key": string,"event_id": string,"guest_id": string,"id"?: string,"invitation_id": string,"kind": string,"last_error"?: string | null,"provider"?: string | null,"provider_receipt"?: string | null,"recipient_email": string,"sending_since"?: string | null,"sent_at"?: string | null,"state_hash": string,"status"?: string,"subject": string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"attempts"?: number,"body"?: string,"cancelled_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"dedupe_key"?: string,"event_id"?: string,"guest_id"?: string,"id"?: string,"invitation_id"?: string,"kind"?: string,"last_error"?: string | null,"provider"?: string | null,"provider_receipt"?: string | null,"recipient_email"?: string,"sending_since"?: string | null,"sent_at"?: string | null,"state_hash"?: string,"status"?: string,"subject"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "guest_messages_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "guest_messages_wedding_id_guest_id_fkey"
      columns: ["wedding_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "guest_messages_wedding_id_invitation_id_event_id_fkey"
      columns: ["wedding_id","invitation_id","event_id"]
isOneToOne: false
      referencedRelation: "invitations"
      referencedColumns: ["wedding_id","id","event_id"]
    }
                  ]
                },"guest_private_details": {
                  Row: {
                    "accessibility": string | null,"dietary": string | null,"guest_accessibility": string | null,"guest_answered_at": string | null,"guest_dietary": string | null,"guest_id": string,"notes": string | null,"updated_at": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accessibility"?: string | null,"dietary"?: string | null,"guest_accessibility"?: string | null,"guest_answered_at"?: string | null,"guest_dietary"?: string | null,"guest_id": string,"notes"?: string | null,"updated_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "accessibility"?: string | null,"dietary"?: string | null,"guest_accessibility"?: string | null,"guest_answered_at"?: string | null,"guest_dietary"?: string | null,"guest_id"?: string,"notes"?: string | null,"updated_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "guest_private_details_wedding_id_guest_id_fkey"
      columns: ["wedding_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"guests": {
                  Row: {
                    "age_group": string | null,"archived_at": string | null,"created_at": string,"email": string | null,"full_name": string,"household_id": string | null,"id": string,"import_id": string | null,"phone": string | null,"tags": (string)[],"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "age_group"?: string | null,"archived_at"?: string | null,"created_at"?: string,"email"?: string | null,"full_name": string,"household_id"?: string | null,"id"?: string,"import_id"?: string | null,"phone"?: string | null,"tags"?: (string)[],"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "age_group"?: string | null,"archived_at"?: string | null,"created_at"?: string,"email"?: string | null,"full_name"?: string,"household_id"?: string | null,"id"?: string,"import_id"?: string | null,"phone"?: string | null,"tags"?: (string)[],"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "guests_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "guests_wedding_id_household_id_fkey"
      columns: ["wedding_id","household_id"]
isOneToOne: false
      referencedRelation: "households"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "guests_wedding_id_import_id_fkey"
      columns: ["wedding_id","import_id"]
isOneToOne: false
      referencedRelation: "guest_imports"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"households": {
                  Row: {
                    "address": string | null,"archived_at": string | null,"created_at": string,"id": string,"name": string,"notes": string | null,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"archived_at"?: string | null,"created_at"?: string,"id"?: string,"name": string,"notes"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "address"?: string | null,"archived_at"?: string | null,"created_at"?: string,"id"?: string,"name"?: string,"notes"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "households_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"idempotency_keys": {
                  Row: {
                    "actor_scope": string,"created_at": string,"expires_at": string,"key": string,"operation": string,"request_hash": string,"response_ref": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_scope": string,"created_at"?: string,"expires_at"?: string,"key": string,"operation": string,"request_hash": string,"response_ref"?: string | null
                  }
                  Update: {
                    "actor_scope"?: string,"created_at"?: string,"expires_at"?: string,"key"?: string,"operation"?: string,"request_hash"?: string,"response_ref"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"invitation_members": {
                  Row: {
                    "active": boolean,"created_at": string,"event_id": string,"guest_id": string,"id": string,"invitation_id": string,"is_plus_one": boolean,"meal_option_id": string | null,"responded_at": string | null,"rsvp_status": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"event_id": string,"guest_id": string,"id"?: string,"invitation_id": string,"is_plus_one"?: boolean,"meal_option_id"?: string | null,"responded_at"?: string | null,"rsvp_status"?: string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"event_id"?: string,"guest_id"?: string,"id"?: string,"invitation_id"?: string,"is_plus_one"?: boolean,"meal_option_id"?: string | null,"responded_at"?: string | null,"rsvp_status"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invitation_members_wedding_id_event_id_meal_option_id_fkey"
      columns: ["wedding_id","event_id","meal_option_id"]
isOneToOne: false
      referencedRelation: "meal_options"
      referencedColumns: ["wedding_id","event_id","id"]
    },{
      foreignKeyName: "invitation_members_wedding_id_guest_id_fkey"
      columns: ["wedding_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "invitation_members_wedding_id_invitation_id_event_id_fkey"
      columns: ["wedding_id","invitation_id","event_id"]
isOneToOne: false
      referencedRelation: "invitations"
      referencedColumns: ["wedding_id","id","event_id"]
    }
                  ]
                },"invitation_parties": {
                  Row: {
                    "created_at": string,"created_by": string | null,"expires_at": string,"household_id": string | null,"id": string,"label": string,"revoked_at": string | null,"token_hash": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"expires_at": string,"household_id"?: string | null,"id"?: string,"label": string,"revoked_at"?: string | null,"token_hash": string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"expires_at"?: string,"household_id"?: string | null,"id"?: string,"label"?: string,"revoked_at"?: string | null,"token_hash"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invitation_parties_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invitation_parties_wedding_id_household_id_fkey"
      columns: ["wedding_id","household_id"]
isOneToOne: false
      referencedRelation: "households"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"invitations": {
                  Row: {
                    "batch_id": string,"created_at": string,"created_by": string | null,"deadline": string | null,"delivery_marked_at": string | null,"delivery_status": string,"event_id": string,"expires_at": string,"household_id": string | null,"id": string,"label": string,"last_responded_at": string | null,"party_id": string | null,"plus_one_quota": number,"plus_ones_used": number,"revoked_at": string | null,"token_hash": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id": string,"created_at"?: string,"created_by"?: string | null,"deadline"?: string | null,"delivery_marked_at"?: string | null,"delivery_status"?: string,"event_id": string,"expires_at": string,"household_id"?: string | null,"id"?: string,"label": string,"last_responded_at"?: string | null,"party_id"?: string | null,"plus_one_quota"?: number,"plus_ones_used"?: number,"revoked_at"?: string | null,"token_hash": string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "batch_id"?: string,"created_at"?: string,"created_by"?: string | null,"deadline"?: string | null,"delivery_marked_at"?: string | null,"delivery_status"?: string,"event_id"?: string,"expires_at"?: string,"household_id"?: string | null,"id"?: string,"label"?: string,"last_responded_at"?: string | null,"party_id"?: string | null,"plus_one_quota"?: number,"plus_ones_used"?: number,"revoked_at"?: string | null,"token_hash"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invitations_party_fk"
      columns: ["wedding_id","party_id"]
isOneToOne: false
      referencedRelation: "invitation_parties"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "invitations_wedding_id_event_id_fkey"
      columns: ["wedding_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "invitations_wedding_id_household_id_fkey"
      columns: ["wedding_id","household_id"]
isOneToOne: false
      referencedRelation: "households"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"invoices": {
                  Row: {
                    "amount_minor": number,"commitment_id": string,"created_at": string,"created_by": string | null,"due_on": string | null,"id": string,"issued_on": string | null,"note": string | null,"number": string | null,"void_reason": string | null,"voided_at": string | null,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor": number,"commitment_id": string,"created_at"?: string,"created_by"?: string | null,"due_on"?: string | null,"id"?: string,"issued_on"?: string | null,"note"?: string | null,"number"?: string | null,"void_reason"?: string | null,"voided_at"?: string | null,"wedding_id": string
                  }
                  Update: {
                    "amount_minor"?: number,"commitment_id"?: string,"created_at"?: string,"created_by"?: string | null,"due_on"?: string | null,"id"?: string,"issued_on"?: string | null,"note"?: string | null,"number"?: string | null,"void_reason"?: string | null,"voided_at"?: string | null,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invoices_wedding_id_commitment_id_fkey"
      columns: ["wedding_id","commitment_id"]
isOneToOne: false
      referencedRelation: "commitments"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"lodging_blocks": {
                  Row: {
                    "attrition_allowed_bp": number | null,"attrition_charge_minor": number | null,"booking_code": string | null,"booking_url": string | null,"budget_category_id": string | null,"check_in": string,"check_out": string,"created_at": string,"created_by": string | null,"cutoff_date": string | null,"hotel_id": string,"id": string,"label": string | null,"nightly_rate_minor": number | null,"picked_up_as_of": string | null,"picked_up_room_nights": number | null,"rooms_per_night": number,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attrition_allowed_bp"?: number | null,"attrition_charge_minor"?: number | null,"booking_code"?: string | null,"booking_url"?: string | null,"budget_category_id"?: string | null,"check_in": string,"check_out": string,"created_at"?: string,"created_by"?: string | null,"cutoff_date"?: string | null,"hotel_id": string,"id"?: string,"label"?: string | null,"nightly_rate_minor"?: number | null,"picked_up_as_of"?: string | null,"picked_up_room_nights"?: number | null,"rooms_per_night": number,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "attrition_allowed_bp"?: number | null,"attrition_charge_minor"?: number | null,"booking_code"?: string | null,"booking_url"?: string | null,"budget_category_id"?: string | null,"check_in"?: string,"check_out"?: string,"created_at"?: string,"created_by"?: string | null,"cutoff_date"?: string | null,"hotel_id"?: string,"id"?: string,"label"?: string | null,"nightly_rate_minor"?: number | null,"picked_up_as_of"?: string | null,"picked_up_room_nights"?: number | null,"rooms_per_night"?: number,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "lodging_blocks_wedding_id_budget_category_id_fkey"
      columns: ["wedding_id","budget_category_id"]
isOneToOne: false
      referencedRelation: "budget_categories"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "lodging_blocks_wedding_id_hotel_id_fkey"
      columns: ["wedding_id","hotel_id"]
isOneToOne: false
      referencedRelation: "lodging_hotels"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"lodging_hotels": {
                  Row: {
                    "address": string | null,"archived_at": string | null,"candidate_id": string | null,"created_at": string,"created_by": string | null,"guest_note": string | null,"id": string,"name": string,"phone": string | null,"show_rate": boolean,"show_to_guests": boolean,"updated_at": string,"version": number,"website_url": string | null,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"archived_at"?: string | null,"candidate_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"guest_note"?: string | null,"id"?: string,"name": string,"phone"?: string | null,"show_rate"?: boolean,"show_to_guests"?: boolean,"updated_at"?: string,"version"?: number,"website_url"?: string | null,"wedding_id": string
                  }
                  Update: {
                    "address"?: string | null,"archived_at"?: string | null,"candidate_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"guest_note"?: string | null,"id"?: string,"name"?: string,"phone"?: string | null,"show_rate"?: boolean,"show_to_guests"?: boolean,"updated_at"?: string,"version"?: number,"website_url"?: string | null,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "lodging_hotels_wedding_id_candidate_id_fkey"
      columns: ["wedding_id","candidate_id"]
isOneToOne: false
      referencedRelation: "candidates"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "lodging_hotels_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"lodging_stays": {
                  Row: {
                    "guest_answered_at": string | null,"guest_hotel_id": string | null,"guest_id": string,"guest_kind": string | null,"id": string,"planner_hotel_id": string | null,"planner_kind": string | null,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "guest_answered_at"?: string | null,"guest_hotel_id"?: string | null,"guest_id": string,"guest_kind"?: string | null,"id"?: string,"planner_hotel_id"?: string | null,"planner_kind"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "guest_answered_at"?: string | null,"guest_hotel_id"?: string | null,"guest_id"?: string,"guest_kind"?: string | null,"id"?: string,"planner_hotel_id"?: string | null,"planner_kind"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "lodging_stays_wedding_id_guest_hotel_id_fkey"
      columns: ["wedding_id","guest_hotel_id"]
isOneToOne: false
      referencedRelation: "lodging_hotels"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "lodging_stays_wedding_id_guest_id_fkey"
      columns: ["wedding_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "lodging_stays_wedding_id_planner_hotel_id_fkey"
      columns: ["wedding_id","planner_hotel_id"]
isOneToOne: false
      referencedRelation: "lodging_hotels"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"meal_options": {
                  Row: {
                    "active": boolean,"created_at": string,"event_id": string,"id": string,"name": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"event_id": string,"id"?: string,"name": string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"event_id"?: string,"id"?: string,"name"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "meal_options_wedding_id_event_id_fkey"
      columns: ["wedding_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"memberships": {
                  Row: {
                    "created_at": string,"id": string,"permissions": NonNullable<Json>,"role": Database["public"]['Enums']["membership_role"],"status": Database["public"]['Enums']["membership_status"],"updated_at": string,"user_id": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"permissions"?: NonNullable<Json>,"role": Database["public"]['Enums']["membership_role"],"status"?: Database["public"]['Enums']["membership_status"],"updated_at"?: string,"user_id": string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"permissions"?: NonNullable<Json>,"role"?: Database["public"]['Enums']["membership_role"],"status"?: Database["public"]['Enums']["membership_status"],"updated_at"?: string,"user_id"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "memberships_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"package_artifacts": {
                  Row: {
                    "bytes": number,"checksum_sha256": string,"created_at": string,"format": string,"id": string,"package_id": string,"storage_key": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "bytes": number,"checksum_sha256": string,"created_at"?: string,"format": string,"id"?: string,"package_id": string,"storage_key": string,"wedding_id": string
                  }
                  Update: {
                    "bytes"?: number,"checksum_sha256"?: string,"created_at"?: string,"format"?: string,"id"?: string,"package_id"?: string,"storage_key"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "package_artifacts_wedding_id_package_id_fkey"
      columns: ["wedding_id","package_id"]
isOneToOne: false
      referencedRelation: "packages"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"packages": {
                  Row: {
                    "created_at": string,"created_by": string | null,"formats": (string)[],"generated_at": string,"id": string,"options": NonNullable<Json>,"orientation": string,"paper": string,"preset": string,"recipient": string,"sections": (string)[],"snapshot": NonNullable<Json>,"snapshot_digest": string,"source_revision": number,"template_version": number,"title": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"formats": (string)[],"generated_at": string,"id": string,"options": NonNullable<Json>,"orientation": string,"paper": string,"preset": string,"recipient": string,"sections": (string)[],"snapshot": NonNullable<Json>,"snapshot_digest": string,"source_revision": number,"template_version": number,"title": string,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"formats"?: (string)[],"generated_at"?: string,"id"?: string,"options"?: NonNullable<Json>,"orientation"?: string,"paper"?: string,"preset"?: string,"recipient"?: string,"sections"?: (string)[],"snapshot"?: NonNullable<Json>,"snapshot_digest"?: string,"source_revision"?: number,"template_version"?: number,"title"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "packages_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"payment_installments": {
                  Row: {
                    "amount_minor": number,"commitment_id": string,"created_at": string,"due_on": string,"id": string,"label": string | null,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor": number,"commitment_id": string,"created_at"?: string,"due_on": string,"id"?: string,"label"?: string | null,"wedding_id": string
                  }
                  Update: {
                    "amount_minor"?: number,"commitment_id"?: string,"created_at"?: string,"due_on"?: string,"id"?: string,"label"?: string | null,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_installments_wedding_id_commitment_id_fkey"
      columns: ["wedding_id","commitment_id"]
isOneToOne: false
      referencedRelation: "commitments"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"payments": {
                  Row: {
                    "amount_minor": number,"budget_item_id": string | null,"commitment_id": string | null,"created_at": string,"created_by": string | null,"external_ref": string | null,"id": string,"invoice_id": string | null,"kind": string,"method_label": string | null,"note": string | null,"paid_on": string,"void_reason": string | null,"voided_at": string | null,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor": number,"budget_item_id"?: string | null,"commitment_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"external_ref"?: string | null,"id"?: string,"invoice_id"?: string | null,"kind": string,"method_label"?: string | null,"note"?: string | null,"paid_on": string,"void_reason"?: string | null,"voided_at"?: string | null,"wedding_id": string
                  }
                  Update: {
                    "amount_minor"?: number,"budget_item_id"?: string | null,"commitment_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"external_ref"?: string | null,"id"?: string,"invoice_id"?: string | null,"kind"?: string,"method_label"?: string | null,"note"?: string | null,"paid_on"?: string,"void_reason"?: string | null,"voided_at"?: string | null,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payments_invoice_fk"
      columns: ["invoice_id","commitment_id"]
isOneToOne: false
      referencedRelation: "invoices"
      referencedColumns: ["id","commitment_id"]
    },{
      foreignKeyName: "payments_wedding_id_budget_item_id_fkey"
      columns: ["wedding_id","budget_item_id"]
isOneToOne: false
      referencedRelation: "budget_items"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "payments_wedding_id_commitment_id_fkey"
      columns: ["wedding_id","commitment_id"]
isOneToOne: false
      referencedRelation: "commitments"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"display_name": string | null,"locale": string,"timezone": string | null,"updated_at": string,"user_id": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"display_name"?: string | null,"locale"?: string,"timezone"?: string | null,"updated_at"?: string,"user_id": string,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string | null,"locale"?: string,"timezone"?: string | null,"updated_at"?: string,"user_id"?: string,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"proposal_lines": {
                  Row: {
                    "amount_minor": number | null,"certainty": string,"cost_mode": string,"created_at": string,"description": string,"evidence": string | null,"id": string,"included_in_line_id": string | null,"max_qty": number | null,"min_qty": number | null,"percent_base": boolean,"position": number,"proposal_id": string,"quantity": number | null,"rate_bp": number | null,"required": boolean,"updated_at": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor"?: number | null,"certainty"?: string,"cost_mode": string,"created_at"?: string,"description": string,"evidence"?: string | null,"id"?: string,"included_in_line_id"?: string | null,"max_qty"?: number | null,"min_qty"?: number | null,"percent_base"?: boolean,"position": number,"proposal_id": string,"quantity"?: number | null,"rate_bp"?: number | null,"required"?: boolean,"updated_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "amount_minor"?: number | null,"certainty"?: string,"cost_mode"?: string,"created_at"?: string,"description"?: string,"evidence"?: string | null,"id"?: string,"included_in_line_id"?: string | null,"max_qty"?: number | null,"min_qty"?: number | null,"percent_base"?: boolean,"position"?: number,"proposal_id"?: string,"quantity"?: number | null,"rate_bp"?: number | null,"required"?: boolean,"updated_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposal_lines_proposal_id_included_in_line_id_fkey"
      columns: ["proposal_id","included_in_line_id"]
isOneToOne: false
      referencedRelation: "proposal_lines"
      referencedColumns: ["proposal_id","id"]
    },{
      foreignKeyName: "proposal_lines_wedding_id_proposal_id_fkey"
      columns: ["wedding_id","proposal_id"]
isOneToOne: false
      referencedRelation: "proposals"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"proposals": {
                  Row: {
                    "archived_at": string | null,"candidate_id": string,"created_at": string,"created_by": string | null,"currency": string,"id": string,"notes": string | null,"received_on": string | null,"source_url": string | null,"status": string,"title": string,"updated_at": string,"valid_until": string | null,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"candidate_id": string,"created_at"?: string,"created_by"?: string | null,"currency": string,"id"?: string,"notes"?: string | null,"received_on"?: string | null,"source_url"?: string | null,"status"?: string,"title": string,"updated_at"?: string,"valid_until"?: string | null,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"candidate_id"?: string,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"id"?: string,"notes"?: string | null,"received_on"?: string | null,"source_url"?: string | null,"status"?: string,"title"?: string,"updated_at"?: string,"valid_until"?: string | null,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "proposals_wedding_id_candidate_id_fkey"
      columns: ["wedding_id","candidate_id"]
isOneToOne: false
      referencedRelation: "candidates"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"rsvp_answers": {
                  Row: {
                    "answered_at": string,"event_id": string,"form_version_id": string,"guest_id": string,"id": string,"invitation_id": string,"member_id": string,"question_key": string,"updated_at": string,"value": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "answered_at"?: string,"event_id": string,"form_version_id": string,"guest_id": string,"id"?: string,"invitation_id": string,"member_id": string,"question_key": string,"updated_at"?: string,"value": string,"wedding_id": string
                  }
                  Update: {
                    "answered_at"?: string,"event_id"?: string,"form_version_id"?: string,"guest_id"?: string,"id"?: string,"invitation_id"?: string,"member_id"?: string,"question_key"?: string,"updated_at"?: string,"value"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rsvp_answers_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "rsvp_answers_wedding_id_form_version_id_event_id_fkey"
      columns: ["wedding_id","form_version_id","event_id"]
isOneToOne: false
      referencedRelation: "rsvp_form_versions"
      referencedColumns: ["wedding_id","id","event_id"]
    },{
      foreignKeyName: "rsvp_answers_wedding_id_guest_id_fkey"
      columns: ["wedding_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "rsvp_answers_wedding_id_invitation_id_event_id_fkey"
      columns: ["wedding_id","invitation_id","event_id"]
isOneToOne: false
      referencedRelation: "invitations"
      referencedColumns: ["wedding_id","id","event_id"]
    },{
      foreignKeyName: "rsvp_answers_wedding_id_member_id_fkey"
      columns: ["wedding_id","member_id"]
isOneToOne: false
      referencedRelation: "invitation_members"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"rsvp_changes": {
                  Row: {
                    "actor_id": string | null,"event_id": string,"from_meal_option_id": string | null,"from_status": string,"guest_id": string,"id": string,"occurred_at": string,"reason": string | null,"source": string,"to_meal_option_id": string | null,"to_status": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"event_id": string,"from_meal_option_id"?: string | null,"from_status": string,"guest_id": string,"id"?: string,"occurred_at"?: string,"reason"?: string | null,"source": string,"to_meal_option_id"?: string | null,"to_status": string,"wedding_id": string
                  }
                  Update: {
                    "actor_id"?: string | null,"event_id"?: string,"from_meal_option_id"?: string | null,"from_status"?: string,"guest_id"?: string,"id"?: string,"occurred_at"?: string,"reason"?: string | null,"source"?: string,"to_meal_option_id"?: string | null,"to_status"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rsvp_changes_wedding_id_event_id_fkey"
      columns: ["wedding_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "rsvp_changes_wedding_id_event_id_from_meal_option_id_fkey"
      columns: ["wedding_id","event_id","from_meal_option_id"]
isOneToOne: false
      referencedRelation: "meal_options"
      referencedColumns: ["wedding_id","event_id","id"]
    },{
      foreignKeyName: "rsvp_changes_wedding_id_event_id_to_meal_option_id_fkey"
      columns: ["wedding_id","event_id","to_meal_option_id"]
isOneToOne: false
      referencedRelation: "meal_options"
      referencedColumns: ["wedding_id","event_id","id"]
    },{
      foreignKeyName: "rsvp_changes_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "rsvp_changes_wedding_id_guest_id_fkey"
      columns: ["wedding_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"rsvp_failures": {
                  Row: {
                    "client_hash": string,"id": number,"occurred_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "client_hash": string,"id"?: never,"occurred_at"?: string
                  }
                  Update: {
                    "client_hash"?: string,"id"?: never,"occurred_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"rsvp_form_versions": {
                  Row: {
                    "definition": NonNullable<Json>,"event_id": string,"form_id": string,"id": string,"published_at": string,"published_by": string | null,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "definition": NonNullable<Json>,"event_id": string,"form_id": string,"id"?: string,"published_at"?: string,"published_by"?: string | null,"version": number,"wedding_id": string
                  }
                  Update: {
                    "definition"?: NonNullable<Json>,"event_id"?: string,"form_id"?: string,"id"?: string,"published_at"?: string,"published_by"?: string | null,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rsvp_form_versions_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "rsvp_form_versions_wedding_id_form_id_fkey"
      columns: ["wedding_id","form_id"]
isOneToOne: false
      referencedRelation: "rsvp_forms"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"rsvp_forms": {
                  Row: {
                    "created_at": string,"draft": NonNullable<Json>,"event_id": string,"id": string,"published_version_id": string | null,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"draft"?: NonNullable<Json>,"event_id": string,"id"?: string,"published_version_id"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"draft"?: NonNullable<Json>,"event_id"?: string,"id"?: string,"published_version_id"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rsvp_forms_wedding_id_event_id_fkey"
      columns: ["wedding_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "rsvp_forms_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "rsvp_forms_wedding_id_published_version_id_fkey"
      columns: ["wedding_id","published_version_id"]
isOneToOne: false
      referencedRelation: "rsvp_form_versions"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"rsvp_submissions": {
                  Row: {
                    "accepted_count": number,"accepted_revision": number,"answers_count": number,"declined_count": number,"details_count": number,"event_id": string,"form_version": number,"form_version_id": string | null,"id": string,"invitation_id": string,"invitation_version": number,"party_id": string | null,"payload_hash": string,"plus_one_added": boolean,"plus_ones_removed": number,"send_id": string,"submitted_at": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_count"?: number,"accepted_revision": number,"answers_count"?: number,"declined_count"?: number,"details_count"?: number,"event_id": string,"form_version"?: number,"form_version_id"?: string | null,"id"?: string,"invitation_id": string,"invitation_version": number,"party_id"?: string | null,"payload_hash": string,"plus_one_added"?: boolean,"plus_ones_removed"?: number,"send_id": string,"submitted_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "accepted_count"?: number,"accepted_revision"?: number,"answers_count"?: number,"declined_count"?: number,"details_count"?: number,"event_id"?: string,"form_version"?: number,"form_version_id"?: string | null,"id"?: string,"invitation_id"?: string,"invitation_version"?: number,"party_id"?: string | null,"payload_hash"?: string,"plus_one_added"?: boolean,"plus_ones_removed"?: number,"send_id"?: string,"submitted_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rsvp_submissions_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "rsvp_submissions_wedding_id_form_version_id_fkey"
      columns: ["wedding_id","form_version_id"]
isOneToOne: false
      referencedRelation: "rsvp_form_versions"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "rsvp_submissions_wedding_id_invitation_id_event_id_fkey"
      columns: ["wedding_id","invitation_id","event_id"]
isOneToOne: false
      referencedRelation: "invitations"
      referencedColumns: ["wedding_id","id","event_id"]
    },{
      foreignKeyName: "rsvp_submissions_wedding_id_party_id_fkey"
      columns: ["wedding_id","party_id"]
isOneToOne: false
      referencedRelation: "invitation_parties"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"seat_assignments": {
                  Row: {
                    "assigned_at": string,"guest_id": string,"id": string,"is_captain": boolean,"layout_id": string,"seat_number": number | null,"table_id": string,"tentative": boolean,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_at"?: string,"guest_id": string,"id"?: string,"is_captain"?: boolean,"layout_id": string,"seat_number"?: number | null,"table_id": string,"tentative"?: boolean,"wedding_id": string
                  }
                  Update: {
                    "assigned_at"?: string,"guest_id"?: string,"id"?: string,"is_captain"?: boolean,"layout_id"?: string,"seat_number"?: number | null,"table_id"?: string,"tentative"?: boolean,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "seat_assignments_wedding_id_guest_id_fkey"
      columns: ["wedding_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "seat_assignments_wedding_id_layout_id_table_id_fkey"
      columns: ["wedding_id","layout_id","table_id"]
isOneToOne: false
      referencedRelation: "seating_tables"
      referencedColumns: ["wedding_id","layout_id","id"]
    }
                  ]
                },"seating_elements": {
                  Row: {
                    "created_at": string,"h": number,"id": string,"kind": string,"label": string,"layout_id": string,"updated_at": string,"version": number,"w": number,"wedding_id": string,"x": number,"y": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"h": number,"id"?: string,"kind": string,"label": string,"layout_id": string,"updated_at"?: string,"version"?: number,"w": number,"wedding_id": string,"x": number,"y": number
                  }
                  Update: {
                    "created_at"?: string,"h"?: number,"id"?: string,"kind"?: string,"label"?: string,"layout_id"?: string,"updated_at"?: string,"version"?: number,"w"?: number,"wedding_id"?: string,"x"?: number,"y"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "seating_elements_wedding_id_layout_id_fkey"
      columns: ["wedding_id","layout_id"]
isOneToOne: false
      referencedRelation: "seating_layouts"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"seating_layouts": {
                  Row: {
                    "allow_tentative": boolean,"created_at": string,"event_id": string,"finalized_at": string | null,"finalized_by": string | null,"finalized_revision": number | null,"id": string,"revision": number,"snapshot": Json | null,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "allow_tentative"?: boolean,"created_at"?: string,"event_id": string,"finalized_at"?: string | null,"finalized_by"?: string | null,"finalized_revision"?: number | null,"id"?: string,"revision"?: number,"snapshot"?: Json | null,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "allow_tentative"?: boolean,"created_at"?: string,"event_id"?: string,"finalized_at"?: string | null,"finalized_by"?: string | null,"finalized_revision"?: number | null,"id"?: string,"revision"?: number,"snapshot"?: Json | null,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "seating_layouts_wedding_id_event_id_fkey"
      columns: ["wedding_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"seating_snapshots": {
                  Row: {
                    "event_id": string,"finalized_at": string,"finalized_by": string | null,"id": string,"layout_id": string,"revision": number,"snapshot": NonNullable<Json>,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "event_id": string,"finalized_at"?: string,"finalized_by"?: string | null,"id"?: string,"layout_id": string,"revision": number,"snapshot": NonNullable<Json>,"wedding_id": string
                  }
                  Update: {
                    "event_id"?: string,"finalized_at"?: string,"finalized_by"?: string | null,"id"?: string,"layout_id"?: string,"revision"?: number,"snapshot"?: NonNullable<Json>,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "seating_snapshots_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "seating_snapshots_wedding_id_layout_id_event_id_fkey"
      columns: ["wedding_id","layout_id","event_id"]
isOneToOne: false
      referencedRelation: "seating_layouts"
      referencedColumns: ["wedding_id","id","event_id"]
    }
                  ]
                },"seating_tables": {
                  Row: {
                    "capacity": number,"created_at": string,"id": string,"label": string,"layout_id": string,"notes": string | null,"pos_x": number | null,"pos_y": number | null,"shape": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "capacity": number,"created_at"?: string,"id"?: string,"label": string,"layout_id": string,"notes"?: string | null,"pos_x"?: number | null,"pos_y"?: number | null,"shape"?: string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "capacity"?: number,"created_at"?: string,"id"?: string,"label"?: string,"layout_id"?: string,"notes"?: string | null,"pos_x"?: number | null,"pos_y"?: number | null,"shape"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "seating_tables_wedding_id_layout_id_fkey"
      columns: ["wedding_id","layout_id"]
isOneToOne: false
      referencedRelation: "seating_layouts"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"shuttle_assignments": {
                  Row: {
                    "assigned_at": string,"direction": string,"event_id": string,"guest_id": string,"id": string,"run_id": string,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_at"?: string,"direction": string,"event_id": string,"guest_id": string,"id"?: string,"run_id": string,"wedding_id": string
                  }
                  Update: {
                    "assigned_at"?: string,"direction"?: string,"event_id"?: string,"guest_id"?: string,"id"?: string,"run_id"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "shuttle_assignments_wedding_id_event_id_run_id_direction_fkey"
      columns: ["wedding_id","event_id","run_id","direction"]
isOneToOne: false
      referencedRelation: "shuttle_runs"
      referencedColumns: ["wedding_id","event_id","id","direction"]
    },{
      foreignKeyName: "shuttle_assignments_wedding_id_guest_id_fkey"
      columns: ["wedding_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"shuttle_runs": {
                  Row: {
                    "capacity": number,"created_at": string,"departs_at": string,"direction": string,"dropoff": string | null,"event_id": string,"id": string,"label": string,"notes": string | null,"pickup": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "capacity": number,"created_at"?: string,"departs_at": string,"direction": string,"dropoff"?: string | null,"event_id": string,"id"?: string,"label": string,"notes"?: string | null,"pickup": string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "capacity"?: number,"created_at"?: string,"departs_at"?: string,"direction"?: string,"dropoff"?: string | null,"event_id"?: string,"id"?: string,"label"?: string,"notes"?: string | null,"pickup"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "shuttle_runs_wedding_id_event_id_fkey"
      columns: ["wedding_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"tasks": {
                  Row: {
                    "archived_at": string | null,"assignee_user_id": string | null,"completed_at": string | null,"completed_by": string | null,"created_at": string,"created_by": string | null,"date_kind": string,"due_date": string | null,"id": string,"notes": string | null,"offset_days": number | null,"phase": string | null,"sort_order": number,"status": string,"template_key": string | null,"title": string,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"assignee_user_id"?: string | null,"completed_at"?: string | null,"completed_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"date_kind"?: string,"due_date"?: string | null,"id"?: string,"notes"?: string | null,"offset_days"?: number | null,"phase"?: string | null,"sort_order"?: number,"status"?: string,"template_key"?: string | null,"title": string,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"assignee_user_id"?: string | null,"completed_at"?: string | null,"completed_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"date_kind"?: string,"due_date"?: string | null,"id"?: string,"notes"?: string | null,"offset_days"?: number | null,"phase"?: string | null,"sort_order"?: number,"status"?: string,"template_key"?: string | null,"title"?: string,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tasks_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"timeline_items": {
                  Row: {
                    "assignee_user_id": string | null,"contact": string | null,"created_at": string,"created_by": string | null,"ends_at": string | null,"event_id": string,"id": string,"location": string | null,"notes": string | null,"responsible_label": string | null,"starts_at": string,"status": string,"timezone": string,"title": string,"updated_at": string,"vendor_id": string | null,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assignee_user_id"?: string | null,"contact"?: string | null,"created_at"?: string,"created_by"?: string | null,"ends_at"?: string | null,"event_id": string,"id"?: string,"location"?: string | null,"notes"?: string | null,"responsible_label"?: string | null,"starts_at": string,"status"?: string,"timezone": string,"title": string,"updated_at"?: string,"vendor_id"?: string | null,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "assignee_user_id"?: string | null,"contact"?: string | null,"created_at"?: string,"created_by"?: string | null,"ends_at"?: string | null,"event_id"?: string,"id"?: string,"location"?: string | null,"notes"?: string | null,"responsible_label"?: string | null,"starts_at"?: string,"status"?: string,"timezone"?: string,"title"?: string,"updated_at"?: string,"vendor_id"?: string | null,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "timeline_items_wedding_id_event_id_fkey"
      columns: ["wedding_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["wedding_id","id"]
    },{
      foreignKeyName: "timeline_items_wedding_id_vendor_id_fkey"
      columns: ["wedding_id","vendor_id"]
isOneToOne: false
      referencedRelation: "candidates"
      referencedColumns: ["wedding_id","id"]
    }
                  ]
                },"venue_spaces": {
                  Row: {
                    "archived_at": string | null,"candidate_id": string,"created_at": string,"id": string,"kind": string,"name": string,"notes": string | null,"seated_capacity": number | null,"standing_capacity": number | null,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"candidate_id": string,"created_at"?: string,"id"?: string,"kind"?: string,"name": string,"notes"?: string | null,"seated_capacity"?: number | null,"standing_capacity"?: number | null,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"candidate_id"?: string,"created_at"?: string,"id"?: string,"kind"?: string,"name"?: string,"notes"?: string | null,"seated_capacity"?: number | null,"standing_capacity"?: number | null,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "venue_spaces_wedding_id_candidate_id_kind_fkey"
      columns: ["wedding_id","candidate_id","kind"]
isOneToOne: false
      referencedRelation: "candidates"
      referencedColumns: ["wedding_id","id","kind"]
    }
                  ]
                },"venues": {
                  Row: {
                    "candidate_id": string,"ceremony_capacity": number | null,"created_at": string,"kind": string,"seated_capacity": number | null,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "candidate_id": string,"ceremony_capacity"?: number | null,"created_at"?: string,"kind"?: string,"seated_capacity"?: number | null,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "candidate_id"?: string,"ceremony_capacity"?: number | null,"created_at"?: string,"kind"?: string,"seated_capacity"?: number | null,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "venues_wedding_id_candidate_id_kind_fkey"
      columns: ["wedding_id","candidate_id","kind"]
isOneToOne: false
      referencedRelation: "candidates"
      referencedColumns: ["wedding_id","id","kind"]
    }
                  ]
                },"wedding_sites": {
                  Row: {
                    "created_at": string,"created_by": string | null,"draft": NonNullable<Json>,"draft_rev": number,"id": string,"published": Json | null,"published_at": string | null,"published_draft_rev": number | null,"slug": string | null,"updated_at": string,"version": number,"wedding_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"draft": NonNullable<Json>,"draft_rev"?: number,"id"?: string,"published"?: Json | null,"published_at"?: string | null,"published_draft_rev"?: number | null,"slug"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"draft"?: NonNullable<Json>,"draft_rev"?: number,"id"?: string,"published"?: Json | null,"published_at"?: string | null,"published_draft_rev"?: number | null,"slug"?: string | null,"updated_at"?: string,"version"?: number,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wedding_sites_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: true
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"weddings": {
                  Row: {
                    "base_currency": string,"created_at": string,"created_by": string,"date": string | null,"id": string,"location": string | null,"name": string,"preferences": NonNullable<Json>,"revision": number,"share_guest_totals": boolean,"target_budget_minor": number | null,"target_guest_count": number | null,"timezone": string,"updated_at": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "base_currency": string,"created_at"?: string,"created_by": string,"date"?: string | null,"id"?: string,"location"?: string | null,"name": string,"preferences"?: NonNullable<Json>,"revision"?: number,"share_guest_totals"?: boolean,"target_budget_minor"?: number | null,"target_guest_count"?: number | null,"timezone": string,"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "base_currency"?: string,"created_at"?: string,"created_by"?: string,"date"?: string | null,"id"?: string,"location"?: string | null,"name"?: string,"preferences"?: NonNullable<Json>,"revision"?: number,"share_guest_totals"?: boolean,"target_budget_minor"?: number | null,"target_guest_count"?: number | null,"timezone"?: string,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "add_comment":
{ Args: { "p_body": string,"p_idempotency_key"?: string,"p_kind": string,"p_subject": string,"p_wedding": string }; Returns: string
                           },
"add_design_item":
{ Args: { "p_board": string,"p_candidate"?: string,"p_idempotency_key"?: string,"p_kind": string,"p_note"?: string,"p_title": string,"p_url"?: string,"p_wedding": string }; Returns: string
                           },
"add_lodging_block":
{ Args: { "p_block": Json,"p_hotel_id": string,"p_wedding": string }; Returns: string
                           },
"add_lodging_hotel":
{ Args: { "p_hotel": Json,"p_wedding": string }; Returns: string
                           },
"add_meal_option":
{ Args: { "p_event_id": string,"p_name": string,"p_wedding": string }; Returns: string
                           },
"add_proposal_line":
{ Args: { "p_amount_minor"?: number,"p_certainty"?: string,"p_cost_mode": string,"p_description": string,"p_evidence"?: string,"p_expected_version": number,"p_idempotency_key"?: string,"p_included_in_line_id"?: string,"p_max_qty"?: number,"p_min_qty"?: number,"p_percent_base"?: boolean,"p_proposal": string,"p_quantity"?: number,"p_rate_bp"?: number,"p_required"?: boolean,"p_wedding": string }; Returns: string
                           },
"add_seating_element":
{ Args: { "p_h": number,"p_kind": string,"p_label": string,"p_layout": string,"p_w": number,"p_wedding": string,"p_x": number,"p_y": number }; Returns: string
                           },
"add_seating_table":
{ Args: { "p_capacity": number,"p_label": string,"p_layout": string,"p_shape"?: string,"p_wedding": string }; Returns: string
                           },
"add_shuttle_run":
{ Args: { "p_capacity": number,"p_departs_at": string,"p_direction": string,"p_dropoff": string,"p_event": string,"p_label": string,"p_notes"?: string,"p_pickup": string,"p_wedding": string }; Returns: string
                           },
"add_suggested_budget_categories":
{ Args: { "p_names": Json,"p_wedding": string }; Returns: number
                           },
"amend_commitment":
{ Args: { "p_allocations": Json,"p_amount_minor": number,"p_commitment": string,"p_confirmed": boolean,"p_expected_version": number,"p_idempotency_key"?: string,"p_installments": Json,"p_signed_on"?: string,"p_title": string,"p_wedding": string }; Returns: string
                           },
"apply_seating_suggestion":
{ Args: { "p_expected_revision": number,"p_layout": string,"p_placements": Json,"p_wedding": string }; Returns: number
                           },
"archive_budget_category":
{ Args: { "p_category": string,"p_expected_version": number,"p_wedding": string }; Returns: number
                           },
"archive_budget_item":
{ Args: { "p_expected_version": number,"p_item": string,"p_wedding": string }; Returns: number
                           },
"archive_candidate":
{ Args: { "p_candidate": string,"p_expected_version": number,"p_wedding": string }; Returns: undefined
                           },
"archive_comparison":
{ Args: { "p_comparison": string,"p_expected_version": number,"p_wedding": string }; Returns: undefined
                           },
"archive_design_board":
{ Args: { "p_board": string,"p_expected_version": number,"p_wedding": string }; Returns: undefined
                           },
"archive_document":
{ Args: { "p_document": string,"p_expected_version": number,"p_wedding": string }; Returns: undefined
                           },
"archive_proposal":
{ Args: { "p_expected_version": number,"p_proposal": string,"p_wedding": string }; Returns: undefined
                           },
"archive_task":
{ Args: { "p_expected_version": number,"p_task": string,"p_wedding": string }; Returns: undefined
                           },
"archive_venue_space":
{ Args: { "p_expected_version": number,"p_space": string,"p_wedding": string }; Returns: number
                           },
"assign_guest_seat":
{ Args: { "p_guest": string,"p_layout": string,"p_seat"?: number,"p_table": string,"p_wedding": string }; Returns: undefined
                           },
"assign_household_seats":
{ Args: { "p_guests": (string)[],"p_layout": string,"p_table": string,"p_wedding": string }; Returns: number
                           },
"assign_shuttle_guests":
{ Args: { "p_guests": (string)[],"p_run": string,"p_wedding": string }; Returns: number
                           },
"begin_guest_message_send":
{ Args: { "p_expected_version": number,"p_message": string,"p_wedding": string }; Returns: Json
                           },
"book_commitment":
{ Args: { "p_allocations": Json,"p_amount_minor": number,"p_candidate": string,"p_confirmed": boolean,"p_expected_candidate_version": number,"p_idempotency_key"?: string,"p_installments": Json,"p_proposal"?: string,"p_signed_on"?: string,"p_title": string,"p_wedding": string }; Returns: string
                           },
"budget_item_counts":
{ Args: { "p_wedding": string }; Returns: {
              "actual_count": number,"event_id": string,"invitations_final": boolean,"item_count": number,"item_id": string,"plan_count": number
            }[]
                           },
"change_member_role":
{ Args: { "p_expected_version": number,"p_membership": string,"p_role": Database["public"]['Enums']["membership_role"] }; Returns: undefined
                           },
"commit_guest_import":
{ Args: { "p_idempotency_key": string,"p_rows": Json,"p_wedding": string }; Returns: string
                           },
"comparison_source_state":
{ Args: { "p_comparison": string,"p_wedding": string }; Returns: Json
                           },
"complete_design_image":
{ Args: { "p_bytes": number,"p_checksum": string,"p_item": string }; Returns: undefined
                           },
"complete_document":
{ Args: { "p_bytes": number,"p_checksum": string,"p_document": string }; Returns: undefined
                           },
"create_budget_category":
{ Args: { "p_allocation_minor"?: number,"p_idempotency_key"?: string,"p_name": string,"p_wedding": string }; Returns: string
                           },
"create_budget_item":
{ Args: { "p_amount_minor"?: number,"p_category": string,"p_cost_mode"?: string,"p_count_event"?: string,"p_count_source"?: string,"p_count_typed"?: number,"p_idempotency_key"?: string,"p_min_qty"?: number,"p_name": string,"p_notes"?: string,"p_quantity"?: number,"p_wedding": string }; Returns: string
                           },
"create_candidate":
{ Args: { "p_category": string,"p_ceremony_capacity"?: number,"p_idempotency_key"?: string,"p_kind": string,"p_location"?: string,"p_name": string,"p_notes"?: string,"p_price_basis"?: string,"p_price_minor"?: number,"p_pricing_display"?: string,"p_seated_capacity"?: number,"p_source_checked_on"?: string,"p_source_url"?: string,"p_wedding": string }; Returns: string
                           },
"create_collaborator_invite":
{ Args: { "p_email": string,"p_role": Database["public"]['Enums']["membership_role"],"p_token_hash": string,"p_valid_for"?: string,"p_wedding": string }; Returns: string
                           },
"create_comparison":
{ Args: { "p_count_event"?: string,"p_criteria": Json,"p_guest_count": number,"p_idempotency_key"?: string,"p_proposals": (string)[],"p_title": string,"p_wedding": string }; Returns: string
                           },
"create_design_board":
{ Args: { "p_description"?: string,"p_idempotency_key"?: string,"p_palette"?: (string)[],"p_title": string,"p_wedding": string }; Returns: string
                           },
"create_design_image_intent":
{ Args: { "p_board": string,"p_bytes": number,"p_candidate"?: string,"p_idempotency_key"?: string,"p_mime": string,"p_note"?: string,"p_original_name"?: string,"p_rights": string,"p_title": string,"p_wedding": string }; Returns: string
                           },
"create_document_intent":
{ Args: { "p_bytes": number,"p_idempotency_key"?: string,"p_kind": string,"p_mime": string,"p_original_name"?: string,"p_title": string,"p_wedding": string }; Returns: string
                           },
"create_event":
{ Args: { "p_event": Json,"p_idempotency_key"?: string,"p_wedding": string }; Returns: string
                           },
"create_guest":
{ Args: { "p_guest": Json,"p_household"?: string,"p_idempotency_key"?: string,"p_wedding": string }; Returns: string
                           },
"create_invitations":
{ Args: { "p_deadline"?: string,"p_event_id": string,"p_expires_at": string,"p_groups": Json,"p_idempotency_key": string,"p_plus_one_quota": number,"p_token_hashes": (string)[],"p_wedding": string }; Returns: {
              "o_invitation_id": string,"o_label": string,"o_replayed": boolean
            }[]
                           },
"create_invoice":
{ Args: { "p_amount_minor": number,"p_commitment": string,"p_due_on"?: string,"p_idempotency_key"?: string,"p_issued_on"?: string,"p_note"?: string,"p_number"?: string,"p_wedding": string }; Returns: string
                           },
"create_package":
{ Args: { "p_artifacts": Json,"p_digest": string,"p_expected_revision": number,"p_formats": (string)[],"p_generated_at": string,"p_id": string,"p_options": Json,"p_orientation": string,"p_paper": string,"p_preset": string,"p_recipient": string,"p_sections": (string)[],"p_snapshot": Json,"p_template_version": number,"p_title": string,"p_wedding": string }; Returns: string
                           },
"create_party_link":
{ Args: { "p_expires_at": string,"p_idempotency_key": string,"p_invitation_ids": (string)[],"p_token_hash": string,"p_wedding": string }; Returns: {
              "o_label": string,"o_party_id": string,"o_replayed": boolean
            }[]
                           },
"create_proposal":
{ Args: { "p_candidate": string,"p_idempotency_key"?: string,"p_notes"?: string,"p_received_on"?: string,"p_source_url"?: string,"p_title": string,"p_valid_until"?: string,"p_wedding": string }; Returns: string
                           },
"create_task":
{ Args: { "p_assignee"?: string,"p_due_date"?: string,"p_idempotency_key"?: string,"p_notes"?: string,"p_title": string,"p_wedding": string }; Returns: string
                           },
"create_timeline_item":
{ Args: { "p_assignee"?: string,"p_contact"?: string,"p_ends_at"?: string,"p_event": string,"p_expected_zone"?: string,"p_idempotency_key"?: string,"p_location"?: string,"p_notes"?: string,"p_responsible_label"?: string,"p_starts_at": string,"p_status"?: string,"p_title": string,"p_vendor"?: string,"p_wedding": string }; Returns: string
                           },
"create_venue_space":
{ Args: { "p_candidate": string,"p_idempotency_key"?: string,"p_name": string,"p_notes"?: string,"p_seated_capacity"?: number,"p_standing_capacity"?: number,"p_wedding": string }; Returns: string
                           },
"create_wedding":
{ Args: { "p_base_currency": string,"p_date"?: string,"p_idempotency_key"?: string,"p_location"?: string,"p_name": string,"p_target_budget_minor"?: number,"p_target_guest_count"?: number,"p_timezone": string }; Returns: string
                           },
"decide_comparison":
{ Args: { "p_acknowledged": boolean,"p_comparison": string,"p_expected_version": number,"p_figures": Json,"p_idempotency_key"?: string,"p_note"?: string,"p_proposal": string,"p_wedding": string }; Returns: string
                           },
"delete_comment":
{ Args: { "p_comment": string,"p_wedding": string }; Returns: undefined
                           },
"delete_timeline_item":
{ Args: { "p_expected_version": number,"p_item": string,"p_wedding": string }; Returns: undefined
                           },
"discard_guest_message":
{ Args: { "p_expected_version": number,"p_message": string,"p_wedding": string }; Returns: number
                           },
"dismiss_attention":
{ Args: { "p_fingerprint": string,"p_kind": string,"p_subject": string,"p_wedding": string }; Returns: undefined
                           },
"edit_comment":
{ Args: { "p_body": string,"p_comment": string,"p_expected_version": number,"p_wedding": string }; Returns: number
                           },
"ensure_seating_layout":
{ Args: { "p_event_id": string,"p_wedding": string }; Returns: string
                           },
"event_demand":
{ Args: { "p_wedding": string }; Returns: {
              "event_id": string,"invited": number,"meals": Json,"no": number,"open_plus_ones": number,"plan_open_plus_ones": boolean,"planning_basis": string,"seated_confirmed": number,"seated_tentative": number,"waiting_closed": number,"waiting_open": number,"yes": number,"yes_without_meal": number
            }[]
                           },
"finalize_seating_layout":
{ Args: { "p_expected_revision": number,"p_layout": string,"p_wedding": string }; Returns: undefined
                           },
"finish_guest_message_send":
{ Args: { "p_error"?: string,"p_message": string,"p_outcome": string,"p_provider"?: string,"p_receipt"?: string,"p_version": number,"p_wedding": string }; Returns: number
                           },
"generate_checklist":
{ Args: { "p_items": Json,"p_wedding": string }; Returns: number
                           },
"handle_attention_item":
{ Args: { "p_item": string,"p_wedding": string }; Returns: undefined
                           },
"link_document":
{ Args: { "p_document": string,"p_target": string,"p_target_type": string,"p_wedding": string }; Returns: undefined
                           },
"list_comments":
{ Args: { "p_kind": string,"p_subject": string,"p_wedding": string }; Returns: {
              "author_name": string,"body": string,"created_at": string,"edited_at": string,"id": string,"is_mine": boolean,"version": number
            }[]
                           },
"list_event_labels":
{ Args: { "p_wedding": string }; Returns: {
              "effective_time_zone": string,"id": string,"kind": string,"local_date": string,"name": string,"time_zone": string
            }[]
                           },
"list_members":
{ Args: { "p_wedding": string }; Returns: {
              "display_name": string,"email": string,"joined_at": string,"membership_id": string,"permissions": Json,"role": Database["public"]['Enums']["membership_role"],"user_id": string,"version": number
            }[]
                           },
"lock_guarantee":
{ Args: { "p_candidate"?: string,"p_count": number,"p_due"?: string,"p_event": string,"p_idempotency_key"?: string,"p_seen": Json,"p_wedding": string }; Returns: string
                           },
"lodging_possible_costs":
{ Args: { "p_wedding": string }; Returns: {
              "attrition_allowed_bp": number,"attrition_charge_minor": number,"block_id": string,"budget_category_id": string,"check_in": string,"check_out": string,"cutoff_date": string,"hotel_archived": boolean,"hotel_name": string,"label": string,"nightly_rate_minor": number,"picked_up_as_of": string,"picked_up_room_nights": number,"rooms_per_night": number
            }[]
                           },
"move_design_item":
{ Args: { "p_direction": string,"p_item": string,"p_wedding": string }; Returns: undefined
                           },
"move_seating_element":
{ Args: { "p_element": string,"p_wedding": string,"p_x": number,"p_y": number }; Returns: undefined
                           },
"move_seating_table":
{ Args: { "p_table": string,"p_wedding": string,"p_x": number,"p_y": number }; Returns: undefined
                           },
"number_table_seats":
{ Args: { "p_table": string,"p_wedding": string }; Returns: number
                           },
"override_rsvp_response":
{ Args: { "p_meal_option_id"?: string,"p_member_id": string,"p_reason": string,"p_status": string,"p_wedding": string }; Returns: undefined
                           },
"prepare_guest_messages":
{ Args: { "p_items": Json,"p_wedding": string }; Returns: Json
                           },
"public_site_invite_view":
{ Args: { "p_client": string,"p_slug": string,"p_token_hash": string }; Returns: Json
                           },
"public_site_view":
{ Args: { "p_slug": string }; Returns: Json
                           },
"publish_rsvp_form":
{ Args: { "p_event_id": string,"p_expected_version": number,"p_wedding": string }; Returns: number
                           },
"publish_site":
{ Args: { "p_expected_version": number,"p_slug": string,"p_wedding": string }; Returns: number
                           },
"recent_comments":
{ Args: { "p_limit"?: number,"p_wedding": string }; Returns: {
              "author_name": string,"body": string,"created_at": string,"id": string,"subject_id": string,"subject_kind": string,"subject_title": string
            }[]
                           },
"record_lodging_pickup":
{ Args: { "p_as_of"?: string,"p_block_id": string,"p_expected_version": number,"p_room_nights"?: number,"p_wedding": string }; Returns: number
                           },
"record_payment":
{ Args: { "p_amount_minor": number,"p_commitment"?: string,"p_external_ref"?: string,"p_idempotency_key"?: string,"p_invoice"?: string,"p_item"?: string,"p_kind": string,"p_method"?: string,"p_note"?: string,"p_paid_on": string,"p_wedding": string }; Returns: string
                           },
"redeem_collaborator_invite":
{ Args: { "p_token_hash": string }; Returns: string
                           },
"reissue_invitation":
{ Args: { "p_expected_version": number,"p_invitation_id": string,"p_token_hash": string,"p_wedding": string }; Returns: undefined
                           },
"reissue_party_link":
{ Args: { "p_expected_version": number,"p_party_id": string,"p_token_hash": string,"p_wedding": string }; Returns: undefined
                           },
"reject_design_image":
{ Args: { "p_item": string,"p_reason": string }; Returns: undefined
                           },
"reject_document":
{ Args: { "p_document": string,"p_reason": string }; Returns: undefined
                           },
"remove_design_item":
{ Args: { "p_expected_version": number,"p_item": string,"p_wedding": string }; Returns: string
                           },
"remove_lodging_block":
{ Args: { "p_block_id": string,"p_expected_version": number,"p_wedding": string }; Returns: undefined
                           },
"remove_member":
{ Args: { "p_expected_version": number,"p_membership": string }; Returns: undefined
                           },
"remove_proposal_line":
{ Args: { "p_expected_version": number,"p_line": string,"p_wedding": string }; Returns: number
                           },
"remove_seating_element":
{ Args: { "p_element": string,"p_expected_version": number,"p_wedding": string }; Returns: undefined
                           },
"remove_seating_table":
{ Args: { "p_expected_version": number,"p_table": string,"p_wedding": string }; Returns: number
                           },
"remove_shuttle_run":
{ Args: { "p_expected_version": number,"p_run": string,"p_wedding": string }; Returns: number
                           },
"reprice_comparison":
{ Args: { "p_comparison": string,"p_guest_count": number,"p_idempotency_key": string,"p_wedding": string }; Returns: string
                           },
"reschedule_relative_tasks":
{ Args: { "p_approved": Json,"p_wedding": string }; Returns: number
                           },
"restore_attention":
{ Args: { "p_kind": string,"p_subject": string,"p_wedding": string }; Returns: undefined
                           },
"revise_guarantee":
{ Args: { "p_candidate"?: string,"p_count": number,"p_due"?: string,"p_guarantee": string,"p_idempotency_key"?: string,"p_reason": string,"p_seen": Json,"p_wedding": string }; Returns: string
                           },
"revoke_collaborator_invite":
{ Args: { "p_invite": string }; Returns: undefined
                           },
"revoke_invitation":
{ Args: { "p_expected_version": number,"p_invitation_id": string,"p_wedding": string }; Returns: undefined
                           },
"revoke_party_link":
{ Args: { "p_expected_version": number,"p_party_id": string,"p_wedding": string }; Returns: undefined
                           },
"rsvp_party_submit":
{ Args: { "p_client": string,"p_replies": Json,"p_token_hash": string }; Returns: Json
                           },
"rsvp_party_view":
{ Args: { "p_client": string,"p_token_hash": string }; Returns: Json
                           },
"rsvp_submit":
{ Args: { "p_client": string,"p_expected_version": number,"p_form_version"?: string,"p_plus_one"?: Json,"p_responses": Json,"p_token_hash": string }; Returns: Json
                           },
"rsvp_view":
{ Args: { "p_client": string,"p_token_hash": string }; Returns: Json
                           },
"save_rsvp_form_draft":
{ Args: { "p_draft": Json,"p_event_id": string,"p_expected_version": number,"p_wedding": string }; Returns: number
                           },
"save_site_draft":
{ Args: { "p_draft": Json,"p_expected_version": number,"p_wedding": string }; Returns: number
                           },
"set_budget_reserve":
{ Args: { "p_expected_version": number,"p_reserve_bp"?: number,"p_wedding": string }; Returns: number
                           },
"set_candidate_favorite":
{ Args: { "p_candidate": string,"p_favorite": boolean,"p_wedding": string }; Returns: number
                           },
"set_candidate_stage":
{ Args: { "p_candidate": string,"p_expected_version": number,"p_stage": string,"p_wedding": string }; Returns: number
                           },
"set_comparison_ratings":
{ Args: { "p_comparison": string,"p_expected_version": number,"p_ratings": Json,"p_wedding": string }; Returns: number
                           },
"set_design_favorite":
{ Args: { "p_expected_version": number,"p_favorite": boolean,"p_item": string,"p_wedding": string }; Returns: number
                           },
"set_editor_grants":
{ Args: { "p_areas": (string)[],"p_expected_version": number,"p_membership": string }; Returns: undefined
                           },
"set_event_location":
{ Args: { "p_candidate"?: string,"p_event": string,"p_expected_version": number,"p_space"?: string,"p_update_agenda"?: boolean,"p_wedding": string }; Returns: Json
                           },
"set_event_vendors":
{ Args: { "p_add"?: (string)[],"p_event": string,"p_remove"?: (string)[],"p_wedding": string }; Returns: Json
                           },
"set_guest_archived":
{ Args: { "p_archived": boolean,"p_expected_version": number,"p_guest_id": string,"p_wedding": string }; Returns: undefined
                           },
"set_invitation_delivery":
{ Args: { "p_expected_version": number,"p_invitation_id": string,"p_shared": boolean,"p_wedding": string }; Returns: undefined
                           },
"set_lodging_hotel_archived":
{ Args: { "p_archived": boolean,"p_expected_version": number,"p_hotel_id": string,"p_wedding": string }; Returns: number
                           },
"set_lodging_stays":
{ Args: { "p_guests": (string)[],"p_hotel_id"?: string,"p_kind"?: string,"p_wedding": string }; Returns: number
                           },
"set_meal_option_active":
{ Args: { "p_active": boolean,"p_expected_version": number,"p_option_id": string,"p_wedding": string }; Returns: undefined
                           },
"set_partner_permissions":
{ Args: { "p_expected_version": number,"p_manage_members": boolean,"p_membership": string }; Returns: undefined
                           },
"set_proposal_status":
{ Args: { "p_expected_version": number,"p_proposal": string,"p_status": string,"p_wedding": string }; Returns: number
                           },
"set_seating_tentative":
{ Args: { "p_allow": boolean,"p_expected_version": number,"p_layout": string,"p_wedding": string }; Returns: undefined
                           },
"set_share_guest_totals":
{ Args: { "p_enabled": boolean,"p_wedding": string }; Returns: boolean
                           },
"set_table_captain":
{ Args: { "p_guest"?: string,"p_table": string,"p_wedding": string }; Returns: undefined
                           },
"set_task_status":
{ Args: { "p_done": boolean,"p_expected_version": number,"p_task": string,"p_wedding": string }; Returns: number
                           },
"set_vendor_events":
{ Args: { "p_add"?: (string)[],"p_candidate": string,"p_remove"?: (string)[],"p_wedding": string }; Returns: Json
                           },
"swap_guest_seats":
{ Args: { "p_guest_a": string,"p_guest_b": string,"p_layout": string,"p_wedding": string }; Returns: undefined
                           },
"unassign_guest_seat":
{ Args: { "p_guest": string,"p_layout": string,"p_wedding": string }; Returns: undefined
                           },
"unassign_shuttle_guest":
{ Args: { "p_guest": string,"p_run": string,"p_wedding": string }; Returns: undefined
                           },
"unlink_document":
{ Args: { "p_document": string,"p_target": string,"p_target_type": string,"p_wedding": string }; Returns: undefined
                           },
"unpublish_site":
{ Args: { "p_expected_version": number,"p_wedding": string }; Returns: number
                           },
"update_budget_category":
{ Args: { "p_allocation_minor"?: number,"p_category": string,"p_expected_version": number,"p_name": string,"p_wedding": string }; Returns: number
                           },
"update_budget_item":
{ Args: { "p_amount_minor"?: number,"p_category": string,"p_cost_mode": string,"p_count_event"?: string,"p_count_source"?: string,"p_count_typed"?: number,"p_expected_version": number,"p_item": string,"p_min_qty"?: number,"p_name": string,"p_notes"?: string,"p_quantity"?: number,"p_wedding": string }; Returns: number
                           },
"update_candidate":
{ Args: { "p_candidate": string,"p_category": string,"p_ceremony_capacity"?: number,"p_expected_version": number,"p_location"?: string,"p_name": string,"p_notes"?: string,"p_price_basis"?: string,"p_price_minor"?: number,"p_pricing_display"?: string,"p_seated_capacity"?: number,"p_source_checked_on"?: string,"p_source_url"?: string,"p_wedding": string }; Returns: number
                           },
"update_comparison":
{ Args: { "p_accepts_unknowns": boolean,"p_comparison": string,"p_criteria": Json,"p_expected_version": number,"p_guest_count": number,"p_title": string,"p_wedding": string }; Returns: number
                           },
"update_design_board":
{ Args: { "p_board": string,"p_description"?: string,"p_expected_version": number,"p_palette"?: (string)[],"p_title": string,"p_wedding": string }; Returns: number
                           },
"update_design_item":
{ Args: { "p_candidate"?: string,"p_expected_version": number,"p_item": string,"p_note"?: string,"p_rights"?: string,"p_title": string,"p_url"?: string,"p_wedding": string }; Returns: number
                           },
"update_document":
{ Args: { "p_document": string,"p_expected_version": number,"p_kind": string,"p_title": string,"p_wedding": string }; Returns: undefined
                           },
"update_event":
{ Args: { "p_event": Json,"p_event_id": string,"p_expected_version": number,"p_wedding": string }; Returns: undefined
                           },
"update_guest":
{ Args: { "p_expected_version": number,"p_guest": Json,"p_guest_id": string,"p_household"?: string,"p_wedding": string }; Returns: undefined
                           },
"update_household":
{ Args: { "p_address": string,"p_expected_version": number,"p_household_id": string,"p_name": string,"p_notes": string,"p_wedding": string }; Returns: undefined
                           },
"update_invitation":
{ Args: { "p_deadline"?: string,"p_expected_version": number,"p_expires_at": string,"p_invitation_id": string,"p_plus_one_quota": number,"p_wedding": string }; Returns: undefined
                           },
"update_lodging_block":
{ Args: { "p_block": Json,"p_block_id": string,"p_expected_version": number,"p_wedding": string }; Returns: number
                           },
"update_lodging_hotel":
{ Args: { "p_expected_version": number,"p_hotel": Json,"p_hotel_id": string,"p_wedding": string }; Returns: number
                           },
"update_proposal":
{ Args: { "p_expected_version": number,"p_notes"?: string,"p_proposal": string,"p_received_on"?: string,"p_source_url"?: string,"p_title": string,"p_valid_until"?: string,"p_wedding": string }; Returns: number
                           },
"update_proposal_line":
{ Args: { "p_amount_minor"?: number,"p_certainty"?: string,"p_cost_mode": string,"p_description": string,"p_evidence"?: string,"p_expected_version": number,"p_included_in_line_id"?: string,"p_line": string,"p_max_qty"?: number,"p_min_qty"?: number,"p_percent_base"?: boolean,"p_quantity"?: number,"p_rate_bp"?: number,"p_required"?: boolean,"p_wedding": string }; Returns: number
                           },
"update_seating_element":
{ Args: { "p_element": string,"p_expected_version": number,"p_h": number,"p_label": string,"p_w": number,"p_wedding": string,"p_x": number,"p_y": number }; Returns: undefined
                           },
"update_seating_table":
{ Args: { "p_capacity": number,"p_expected_version": number,"p_label": string,"p_notes"?: string,"p_shape"?: string,"p_table": string,"p_wedding": string }; Returns: undefined
                           },
"update_shuttle_run":
{ Args: { "p_capacity": number,"p_departs_at": string,"p_dropoff": string,"p_expected_version": number,"p_label": string,"p_notes"?: string,"p_pickup": string,"p_run": string,"p_wedding": string }; Returns: number
                           },
"update_task":
{ Args: { "p_assignee"?: string,"p_due_date"?: string,"p_expected_version": number,"p_notes"?: string,"p_task": string,"p_title": string,"p_wedding": string }; Returns: number
                           },
"update_timeline_item":
{ Args: { "p_assignee"?: string,"p_contact"?: string,"p_ends_at"?: string,"p_expected_version": number,"p_item": string,"p_location"?: string,"p_notes"?: string,"p_responsible_label"?: string,"p_starts_at": string,"p_status"?: string,"p_title": string,"p_vendor"?: string,"p_wedding": string }; Returns: number
                           },
"update_venue_space":
{ Args: { "p_expected_version": number,"p_name": string,"p_notes"?: string,"p_seated_capacity"?: number,"p_space": string,"p_standing_capacity"?: number,"p_wedding": string }; Returns: number
                           },
"update_wedding_settings":
{ Args: { "p_base_currency": string,"p_date"?: string,"p_expected_version": number,"p_location"?: string,"p_name": string,"p_target_budget_minor"?: number,"p_target_guest_count"?: number,"p_timezone": string,"p_wedding": string }; Returns: number
                           },
"void_invoice":
{ Args: { "p_invoice": string,"p_reason": string,"p_wedding": string }; Returns: undefined
                           },
"void_payment":
{ Args: { "p_payment": string,"p_reason": string,"p_wedding": string }; Returns: undefined
                           }
          }
          Enums: {
            "membership_role": "owner"|"partner"|"editor"|"viewer","membership_status": "active"|"removed"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "membership_role": ["owner", "partner", "editor", "viewer"],"membership_status": ["active", "removed"]
          }
        }
} as const
