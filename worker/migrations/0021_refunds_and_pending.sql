-- Refunds and pending expenses live in the entry payload (kind "refund", refundOf, pending).
-- This index lets the Worker find an expense's refunds when it checks that they never exceed it.
CREATE INDEX IF NOT EXISTS entries_refund_of ON entries(group_id, json_extract(payload, '$.refundOf'));
