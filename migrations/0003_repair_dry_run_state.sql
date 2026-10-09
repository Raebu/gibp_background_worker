PRAGMA foreign_keys = ON;

-- Earlier dry-run builds stored simulations as outbound messages. Reclassify only
-- records carrying the explicit dry_run provider marker.
UPDATE messages
SET direction='simulation',
    classification='dry_run_' || classification
WHERE direction='outbound'
  AND provider_id LIKE 'dry_run:%';

-- Rebuild conversation counters from actual inbound/outbound transport events.
UPDATE conversations
SET outbound_count = (
      SELECT COUNT(*) FROM messages m
      WHERE m.conversation_id=conversations.id AND m.direction='outbound'
    ),
    inbound_count = (
      SELECT COUNT(*) FROM messages m
      WHERE m.conversation_id=conversations.id AND m.direction='inbound'
    ),
    message_count = (
      SELECT COUNT(*) FROM messages m
      WHERE m.conversation_id=conversations.id AND m.direction IN ('outbound','inbound')
    ),
    updated_at = datetime('now');

-- A conversation that only reached nurture because of simulation should return
-- to discovery and be eligible for a genuine first contact later.
UPDATE conversations
SET state='discovery',
    next_action_at=datetime('now'),
    updated_at=datetime('now')
WHERE state='nurture'
  AND outbound_count=0
  AND inbound_count=0
  AND human_handoff_at IS NULL;

-- last_contact_at must represent an actual sent email, never a simulation.
UPDATE contacts
SET last_contact_at = (
  SELECT MAX(m.created_at)
  FROM conversations c
  JOIN messages m ON m.conversation_id=c.id
  WHERE c.contact_id=contacts.id
    AND m.direction='outbound'
),
updated_at=datetime('now');
