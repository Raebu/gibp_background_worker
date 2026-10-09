# GIBP Autonomous Growth Engine

An autonomous, low-cost commercial-development worker for GIBP.

The goal is deliberately **not** "send lots of cold email". The goal is:

> continuously discover organisations and buying signals, research them, find only defensible/public contact routes, start relevant conversations, handle routine replies and nurture automatically, and hand a human only serious opportunities.

## What is implemented

The first production-oriented build contains:

- **Global discovery** using GDELT news triggers.
- **Free organisation enrichment** using Wikidata and GLEIF before any paid enrichment is considered.
- **Public-contact discovery** from official company websites only; it does not guess email addresses.
- **Robots.txt-aware crawling** with strict page/subrequest limits.
- **Account research/scoring** using Cloudflare Workers AI when available, with deterministic fallbacks.
- **Compliance-by-jurisdiction**. Unknown jurisdictions default to monitor-only rather than "send everywhere".
- **Autonomous outreach sequences** with a maximum of three outbound messages before nurture.
- **Hard daily sending limits** designed to stay comfortably below low-cost/free provider ceilings.
- **Resend sending + inbound replies + delivery/open/click/bounce/complaint webhooks**.
- **Cryptographic Resend webhook verification** (Svix signatures).
- **Reply classification** into positive, information request, meeting request, referral, not-now, negative, unsubscribe, commercial terms, security/legal, or other.
- **Automatic safe replies** for routine enquiries using only approved GIBP facts.
- **Automatic referral capture** when a recipient introduces another contact.
- **Website-intent ingestion** so GIBP web activity can increase account/conversation scores.
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

- Cloudflare Worker for orchestration/API/cron.
- Cloudflare D1 for the CRM/state machine.
- Cloudflare Workers AI for limited research/copy/classification. The engine enforces an independent daily AI-call cap.
- Resend for sending and receiving.
- GDELT, Wikidata and GLEIF for free public discovery/enrichment.
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
- 50 total outbound messages/day
- 20 new first-contact messages/day
- 3-message maximum autonomous cold sequence
- serious handoff threshold: 85/100
- 30 Workers AI calls/day

These are configuration values, not marketing targets. Raise them only after sender reputation and response quality are proven.

## Cloudflare setup

### 1. Create D1

```bash
npx wrangler d1 create gibp-growth
```

Copy the returned database ID into `wrangler.jsonc`.

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
```

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
- `contact.unsubscribed`

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
- `GET /admin/handoffs` — serious opportunities only.
- `POST /admin/run` — manually trigger a full worker tick.
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
- public RFP/procurement discovery;
- partner-program discovery;
- event/conference intelligence;
- optional Apollo or other enrichment provider;
- meeting-calendar booking after qualification;
- private per-account briefing pages;
- GIBP website campaign tokens;
- CRM export/sync;
- a lightweight internal serious-opportunity dashboard.

The core rule remains: **the machine handles the pipeline; a human appears only when a serious conversation or binding decision begins.**
