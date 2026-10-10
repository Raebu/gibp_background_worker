# GIBP Autonomous Growth Engine

An autonomous, low-cost commercial-development worker for GIBP.

The goal is deliberately **not** "send lots of cold email". The goal is:

> continuously discover organisations and buying signals, research them, find only defensible/public contact routes, start relevant conversations, handle routine replies and nurture automatically, and hand a human only serious opportunities.

## What is implemented

The first production-oriented build contains:

- **Global direct-sales discovery** using GDELT news triggers.
- **Separate autonomous partner-acquisition pipeline** for integrators, consultancies, fintech infrastructure firms and potential distribution/referral partners.
- **Procurement/RFP discovery** using global GDELT tender signals plus official UK Contracts Finder and Find a Tender OCDS feeds.
- **Free organisation enrichment** using Wikidata and GLEIF before any paid enrichment is considered.
- **Public-contact discovery** from official company websites only; it does not guess email addresses.
- **Optional Apollo candidate discovery** using the 0-credit People Search endpoint to persist named senior prospects with verified-email availability, while keeping paid enrichment completely disabled until explicitly approved.
- **Robots.txt-aware crawling** with strict page/subrequest limits.
- **Account research/scoring** using Cloudflare Workers AI when available, with deterministic fallbacks.
- **Compliance-by-jurisdiction**. Unknown jurisdictions default to monitor-only rather than "send everywhere".
- **Autonomous outreach sequences** with a maximum of three outbound messages before nurture.
- **Adaptive sender-reputation ramp** starting at 5 new contacts/day, increasing only after enough healthy delivery/reply history and reducing automatically on bounce/complaint risk.
- **Hard total daily sending limits** designed to stay comfortably below low-cost/free provider ceilings.
- **Resend sending + inbound replies + delivery/open/click/bounce/complaint webhooks**.
- **Cryptographic Resend webhook verification** (Svix signatures).
- **Reply classification** into positive, information request, meeting request, referral, not-now, negative, unsubscribe, commercial terms, security/legal, or other.
- **Automatic safe replies** for routine enquiries using only approved GIBP facts.
- **Automatic referral capture** when a recipient introduces another contact.
- **Website-intent ingestion** so GIBP web activity can increase account/conversation scores.
- **Persistent AI account dossiers** with evidence, current initiatives, use-case hypotheses, stakeholder maps, recommended offer and next-best action.
- **Conversation qualification profiles** covering problem, architecture, objective, geography, scale, budget context, timeline, decision process, influence and missing information.
- **Recipient-local working-hour scheduling** plus signal-aware long-cycle nurture.
- **Dynamic private account briefings** served from the Worker with non-indexed account research, public evidence and institutional conversion actions.
- **Institutional lead magnets** for payment readiness, cross-border friction, rail selection and liquidity efficiency.
- **Meeting-booking adapter** with a safe booking-link fallback and serious-opportunity escalation.
- **Authority engine** that turns clusters of public market signals into sourced GIBP market briefings.
- **Closed-loop commercial learning** from replies, serious handoffs and recorded commercial outcomes.
- **Authenticated Autonomous Market Development Desk** at `/dashboard`.
- **Global suppression list and one-click unsubscribe endpoint**.
- **Serious-opportunity handoff** with a complete briefing/transcript only when the opportunity crosses the threshold or asks for a meeting/binding commercial/legal/security discussion.
- **Dry-run by default**. The repository cannot send live outreach until explicitly configured.

## Operating model

```text
GDELT / imports / website intent
            |
            v
     Account discovery
            |
            v
  Wikidata + GLEIF + site
            |
            v
 Research + fit/signal score
            |
            v
 Public contact discovery
            |
            v
 Jurisdiction/compliance gate
            |
            v
     Autonomous outreach
            |
      +-----+------+
      |            |
      v            v
 no reply       inbound reply
      |            |
 follow-up      classify + score
      |            |
 nurture       routine? -> AI reply
                   |
              serious?
                   |
                   v
           EXECUTIVE HANDOFF
```

## Cost design

The architecture is intentionally serverless and scale-to-zero:

- Cloudflare Worker for the API and lightweight scheduling.
- Cloudflare Queues for background discovery/research/outreach so Cron does not perform heavy work.
- Cloudflare D1 for the CRM/state machine.
- Cloudflare Workers AI for limited research/copy/classification. The engine enforces an independent daily AI-call cap.
- Resend for sending and receiving.
- Apollo is optional. People Search is used as the zero-credit candidate layer; standard person matching is capped independently and never reveals phone/personal email.
- QuickEmailVerification is an optional second mailbox-quality gate. It verifies up to 100 contacts/day on the configured free-tier cap and blocks role, catch-all, disposable or otherwise unsafe addresses from outreach.
- GDELT, Wikidata and GLEIF for free public discovery/enrichment.
- Optional Apollo People Search for zero-credit candidate discovery. Paid person matching exists behind an independently capped, policy-gated layer; the persistent production cap remains zero unless explicitly changed.
- No paid CRM, vector database, queue cluster or always-on VM is required.

Paid data providers can later be added behind adapters without changing the state machine.

## Safety and commercial boundaries

The autonomous agent **must not** independently agree:

- pricing or discounts;
- contracts or legal terms;
- exclusivity;
- SLAs or liability;
- regulatory status or regulatory guarantees;
- security guarantees;
- bespoke product commitments;
- implementation dates.

Replies touching these areas become a serious handoff.

The worker also refuses first-contact sending when:

- the address is suppressed;
- the email is not a defensible public/consented business address;
- the jurisdiction has no approved policy;
- the jurisdiction requires consent and none is recorded;
- sender compliance configuration is incomplete;
- a daily/jurisdiction limit has been reached.

This is intentional. Global discovery can be automatic while email policy remains country-aware.

## Default sending limits

- `SEND_MODE=dry_run`
- `APOLLO_ENRICHMENT_DAILY_CAP=0` until explicitly commissioned
- `QEV_DAILY_CAP=100` and `QEV_VERIFICATIONS_PER_RUN=5` when QuickEmailVerification is configured
- 50 total outbound messages/day
- 5 new first-contact messages/day initially
- automatic reputation ramp up to a configured ceiling of 20 new first contacts/day
- 3-message maximum autonomous cold sequence
- serious handoff threshold: 85/100
- 30 Workers AI calls/day

These are configuration values, not marketing targets. Raise them only after sender reputation and response quality are proven.

## Cloudflare setup

### 1. Create Cloudflare state resources

```bash
npx wrangler d1 create gibp-growth --location weur
npx wrangler queues create gibp-growth-jobs
```

Copy the returned D1 database ID into `wrangler.jsonc`. The Queue binding is already configured.

Alternatively, the repository contains a manual GitHub Actions workflow named **Provision and deploy Cloudflare**. Once `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist as repository secrets, it resolves/creates the D1 database, ensures the queue exists, applies migrations and deploys while preserving `SEND_MODE=dry_run`.

### 2. Apply migrations

```bash
npm install
npm run db:migrate:remote
```

### 3. Add secrets

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_WEBHOOK_SECRET
npx wrangler secret put UNSUBSCRIBE_SECRET
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SITE_EVENT_TOKEN
npx wrangler secret put BUSINESS_POSTAL_ADDRESS
npx wrangler secret put HANDOFF_TO
```

Optional:

```bash
npx wrangler secret put HANDOFF_WEBHOOK_URL
npx wrangler secret put GIBP_APPROVED_FACTS
npx wrangler secret put APOLLO_API_KEY
```

`APOLLO_API_KEY` is optional. When present, the Worker uses only Apollo People Search (`/mixed_people/api_search`) and stores candidate metadata in D1. It does not call Apollo people-enrichment endpoints or spend enrichment credits.

### 4. Deploy in dry-run mode

```bash
npm run deploy
```

Do not change `SEND_MODE` to `live` yet.

### 5. Configure Resend webhook

Point Resend events at:

```text
https://<worker-domain>/webhooks/resend
```

At minimum subscribe to:

- `email.received`
- `email.delivered`
- `email.opened`
- `email.clicked`
- `email.bounced`
- `email.complained`
- `email.suppressed`
- `suppression.added`

Store the webhook signing secret as `RESEND_WEBHOOK_SECRET`.

### 6. Test the engine

```bash
curl https://<worker-domain>/health

curl -X POST https://<worker-domain>/admin/run \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl https://<worker-domain>/admin/status \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 7. Import known target accounts

```json
{
  "accounts": [
    {
      "name": "Example Bank",
      "domain": "examplebank.com",
      "country_code": "GB",
      "account_type": "bank",
      "contacts": [
        {
          "name": "Example Contact",
          "role": "Head of Payments",
          "email": "person@examplebank.com",
          "email_source": "official_directory",
          "source_url": "https://examplebank.com/leadership",
          "is_public": true,
          "verified": true,
          "seniority_score": 90,
          "lawful_basis": "corporate_b2b"
        }
      ]
    }
  ]
}
```

POST that JSON to `/admin/import` with the admin bearer token.

## Website-intent endpoint

The GIBP sites can send first-party commercial intent to:

```text
POST /events/website
Authorization: Bearer <SITE_EVENT_TOKEN>
```

Example:

```json
{
  "conversation_id": "optional-conversation-id",
  "account_domain": "examplebank.com",
  "event_type": "security_view",
  "path": "/security"
}
```

Recommended event weights already exist for trust, security, regulatory, architecture, whitepaper, contact and meeting actions.

## Admin endpoints

- `GET /health` — public health check.
- `GET /admin/status` — engine/config/CRM metrics.
- `GET /admin/handoffs` — serious sales and procurement opportunities only.
- `GET /admin/opportunities` — current qualified/monitored procurement opportunities.
- `GET /admin/contact-candidates` — persisted zero-credit Apollo decision-maker candidates awaiting any separately approved enrichment step.
- `POST /admin/enqueue` — enqueue the normal autonomous background phases.
- `POST /admin/run` — manually run all phases synchronously for diagnostics.
- `POST /admin/import` — import accounts/contacts.
- `POST /admin/policy` — explicitly approve/update a jurisdiction policy.
- `POST /events/website` — signed first-party website intent.
- `POST /webhooks/resend` — signed Resend events.
- `GET /unsubscribe?token=...` — suppression endpoint.

## Going live

Before setting `SEND_MODE=live`:

1. D1 migrations are applied.
2. Resend sending and receiving domains are verified.
3. Resend webhook signature verification succeeds.
4. A legal postal address is configured.
5. Unsubscribe token secret is configured.
6. Handoff destination works.
7. Approved GIBP facts are reviewed.
8. Jurisdiction policy table is reviewed.
9. Dry-run messages have been inspected for several days.
10. Sender authentication/reputation is healthy.

Then update:

```json
"SEND_MODE": "live"
```

and deploy.

## Next layers

The architecture is intentionally ready for:

- richer official bank/payment directories;
- additional official procurement sources beyond the UK/global-signal layer;
- formal partner-program directory discovery;
- event/conference intelligence;
- explicitly approved Apollo people enrichment from the persisted candidate queue;
- direct calendar-provider credentials for fully automatic slot selection/booking via the meeting adapter;
- additional reviewed country policies beyond the currently evidenced set;
- more first-party and official global procurement/directory feeds;
- CRM export/sync;
- deeper annual-report, earnings-call and technology-estate research sources.

The core rule remains: **the machine handles the pipeline; a human appears only when a serious conversation or binding decision begins.**


## Apollo enrichment commissioning

Apollo People Search can populate named senior candidates without revealing their email address. The separate standard person-match layer is intentionally disabled in production by default.

When enabled later:

- one candidate is processed per queue invocation;
- after any paid Apollo match attempt, that account is excluded from further paid enrichment for 30 days;
- the daily cap is clamped to at most 5;
- standard work-email match only;
- no phone reveal;
- no personal-email reveal;
- no waterfall enrichment;
- the returned work email must be Apollo-verified;
- the address must match the target organisation's corporate domain;
- explicitly verified alternate corporate email domains may be accepted only when backed by a first-party source and stored against that account;
- generic role inboxes are rejected;
- matched records are stored as `research_only`, not `active`, so enrichment alone cannot trigger outreach.

This gives a second commissioning gate between paying for contact data and authorising that data for outreach.


## QuickEmailVerification mailbox gate

QuickEmailVerification can be configured as a second-stage mailbox verification layer after a contact has been discovered.

The worker uses the single-address verification API and stores the provider result separately from source/contact provenance. It never treats mailbox verification as evidence of consent or lawful basis.

Operational rules:

- maximum 100 verification requests/day in code;
- five candidates per hourly run by default, with the daily cap enforcing the free-tier ceiling;
- only named, already-source-verified contacts in approved corporate-B2B jurisdictions are selected;
- Apollo-derived research-only contacts are prioritised;
- `safe_to_send=true` plus a valid result is required;
- role, disposable and accept-all addresses are not outreach-eligible;
- unknown results remain blocked and may be retried once after 24 hours;
- results older than 30 days are eligible for re-verification;
- a definitive unsafe result moves an active contact to `verification_blocked`;
- when the QEV key is configured, outreach requires a fresh safe QEV result;
- live sending is blocked entirely if QuickEmailVerification is intended but its key is absent.

The API key is stored only as a Cloudflare Worker secret and is never exposed to the browser.


## Autonomous Revenue OS v2

The Worker now runs the following additional background phases:

```text
research
  -> dossier
  -> contact discovery / Apollo candidates
  -> QEV mailbox verification
  -> reviewed jurisdiction-policy activation
  -> conversation creation
  -> local-working-time outreach
  -> reply qualification
  -> stakeholder expansion
  -> signal-aware nurture
  -> serious handoff / meeting adapter

market signals
  -> authority briefing
  -> public insight / assessment
  -> conversion request
  -> account/conversation score

commercial outcomes
  -> country/pipeline/role learnings
  -> account priority adjustment
```

### New public surfaces

- `GET /briefing?gi=<signed-intent-token>` — non-indexed private account briefing.
- `POST /briefing/request` — architecture, technical, security, due-diligence, executive or meeting request.
- `GET|POST /assessment/payment-readiness`
- `GET|POST /assessment/cross-border-friction`
- `GET|POST /assessment/rail-selection`
- `GET|POST /assessment/liquidity-efficiency`
- `GET /insights` and `GET /insights/:slug` — sourced public market briefings.
- `GET /dashboard` — authenticated Autonomous Market Development Desk.
- `POST /events/search` — signed ingestion for Search Console/search-demand signals so non-email acquisition feeds the same commercial brain.

### New administrative data

- `GET /admin/dossiers`
- `GET /admin/stakeholders`
- `GET /admin/conversions`
- `GET /admin/content`
- `GET /admin/learnings`
- `GET /admin/policies`
- `GET|POST /admin/evidence` — manage the approved fact/evidence library used by the SDR and RFP planner.
- `GET /admin/search-demand`
- `POST /admin/outcome` — record meeting/opportunity/proposal/win/loss/deferred/partner/RFP outcomes for closed-loop learning.

### Sender separation

Set `OUTBOUND_FROM_EMAIL` for acquisition mail and `TRANSACTIONAL_FROM_EMAIL` for internal/transactional mail. `FROM_EMAIL` remains a compatibility fallback. The checked-in defaults keep commercial outbound on `partnerships@gibp.global` and internal handoffs on `support@gibp.global`.

### Calendar integration

The meeting layer is fully coded but provider-neutral. Set `MEETING_BOOKING_WEBHOOK_URL` (and optionally `MEETING_BOOKING_SECRET`) to a calendar/booking adapter that returns `status`, `scheduled_at` and/or `booking_url`. `BOOKING_URL` can be used as a no-provider fallback. Meeting requests remain serious handoffs; the AI never makes contractual or commercial commitments.

### Jurisdiction policy evidence

Live sending now requires the relevant country policy to have a non-expired evidence review. GB, US, CA and AU source records are seeded in migration 0008. Unknown or stale jurisdictions remain blocked/monitor-only until reviewed rather than being guessed.
