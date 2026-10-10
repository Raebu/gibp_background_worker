export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>
}

export interface Env {
  GROWTH_DB: D1Database
  GROWTH_QUEUE: Queue<GrowthJob>
  AI?: AiBinding
  SEND_MODE?: string
  FROM_EMAIL?: string
  OUTBOUND_FROM_EMAIL?: string
  TRANSACTIONAL_FROM_EMAIL?: string
  PUBLIC_BASE_URL?: string
  GIBP_SITE_URL?: string
  AI_MODEL?: string
  AI_DAILY_CALL_CAP?: string
  DAILY_SEND_CAP?: string
  DAILY_NEW_OUTREACH_CAP?: string
  RAMP_START_CAP?: string
  CONTACT_SCANS_PER_HOUR?: string
  APOLLO_CANDIDATE_SEARCHES_PER_HOUR?: string
  APOLLO_ENRICHMENT_DAILY_CAP?: string
  QEV_DAILY_CAP?: string
  QEV_VERIFICATIONS_PER_RUN?: string
  DOSSIERS_PER_RUN?: string
  NURTURE_MIN_DAYS?: string
  AUTHORITY_MIN_SIGNAL_COUNT?: string
  RFP_MIN_SCORE?: string
  RFP_HANDOFF_SCORE?: string
  SERIOUS_THRESHOLD?: string
  DEFAULT_JURISDICTION_MODE?: string
  RETENTION_DAYS?: string

  RESEND_API_KEY?: string
  RESEND_WEBHOOK_SECRET?: string
  UNSUBSCRIBE_SECRET?: string
  INTENT_SIGNING_SECRET?: string
  ADMIN_TOKEN?: string
  SITE_EVENT_TOKEN?: string
  BUSINESS_POSTAL_ADDRESS?: string
  HANDOFF_TO?: string
  HANDOFF_WEBHOOK_URL?: string
  GIBP_APPROVED_FACTS?: string
  DISCOVERY_QUERY?: string
  PARTNER_DISCOVERY_QUERY?: string
  PROCUREMENT_OCDS_FEEDS?: string
  APOLLO_API_KEY?: string
  QUICKEMAILVERIFICATION_API_KEY?: string
  MEETING_BOOKING_WEBHOOK_URL?: string
  MEETING_BOOKING_SECRET?: string
  BOOKING_URL?: string
}

export interface Account {
  id: string
  name: string
  legal_name: string | null
  domain: string | null
  country_code: string | null
  account_type: string
  pipeline: string
  status: string
  score: number
  fit_score: number
  signal_score: number
  engagement_score: number
  risk_score: number
  priority_adjustment: number
  source: string | null
  source_url: string | null
  research_json: string
  last_researched_at: string | null
  next_action_at: string | null
  created_at: string
  updated_at: string
}

export interface GrowthJob {
  kind: "directories" | "discovery" | "procurement" | "research" | "dossiers" | "contacts" | "apollo_candidates" | "apollo_enrich" | "apollo_enrich_commissioning" | "apollo_enrich_commissioning_v2" | "email_verify" | "email_verify_commissioning_v2" | "conversations" | "nurture" | "outreach" | "authority" | "learning" | "maintenance"
}

export interface Contact {
  id: string
  account_id: string
  name: string | null
  role: string | null
  email: string
  email_source: string
  source_url: string | null
  country_code: string | null
  timezone: string | null
  is_public: number
  verified: number
  seniority_score: number
  consent_status: string
  lawful_basis: string | null
  status: string
  last_contact_at: string | null
  created_at: string
  updated_at: string
}

export interface Conversation {
  id: string
  account_id: string
  contact_id: string
  pipeline: string
  opportunity_id: string | null
  state: string
  score: number
  summary: string | null
  message_count: number
  outbound_count: number
  inbound_count: number
  next_action_at: string | null
  human_handoff_at: string | null
  qualification_score: number
  nurture_count: number
  last_signal_at: string | null
  created_at: string
  updated_at: string
}

export interface ReplyClassification {
  intent:
    | "positive"
    | "information_request"
    | "meeting_request"
    | "referral"
    | "not_now"
    | "negative"
    | "unsubscribe"
    | "commercial_terms"
    | "security_or_legal"
    | "other"
  sentiment: "positive" | "neutral" | "negative"
  serious: boolean
  score_delta: number
  should_reply: boolean
  requires_human: boolean
  summary: string
  suggested_reply?: string
  referral_name?: string
  referral_email?: string
}
