CREATE TABLE IF NOT EXISTS monitor_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL CHECK (json_valid(body)),
  owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
-- Import the existing state.json into id=1 before enabling the Worker.
-- An empty/missing database intentionally does not reset notification history.
