-- FR-SPD-005: a market reaches SETTLED once every selection in it has a confirmed result.
ALTER TABLE selections ADD COLUMN resulted_at timestamptz;
