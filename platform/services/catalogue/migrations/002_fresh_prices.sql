-- FR-SPD-006 / FR-SPD-013: a live feed event reopens after an outage only once it has fresh prices.
-- When the active pricing source last sent prices for the event.
ALTER TABLE events ADD COLUMN prices_at timestamptz;
UPDATE events SET prices_at = updated_at WHERE origin = 'feed';
-- When the source last came back after being silent beyond the heartbeat timeout.
ALTER TABLE source_heartbeats ADD COLUMN recovered_at timestamptz;
