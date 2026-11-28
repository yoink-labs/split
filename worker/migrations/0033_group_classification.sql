-- Reuse groups.kind. Keep all existing classifications and fill blank legacy values.
UPDATE groups
SET kind = CASE WHEN start_date IS NOT NULL OR end_date IS NOT NULL THEN 'trip' ELSE 'home' END
WHERE kind = '';
