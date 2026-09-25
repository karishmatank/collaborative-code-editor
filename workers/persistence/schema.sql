CREATE TABLE IF NOT EXISTS pads (
  id text PRIMARY KEY,
  current_language text NOT NULL CHECK (current_language in ('python', 'ruby', 'javascript', 'typescript', 'sql', 'html')) DEFAULT 'python',
  generation text,
  join_count integer NOT NULL DEFAULT 0,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pad_contents (
  id integer PRIMARY KEY,
  pad_id text NOT NULL REFERENCES pads(id) ON DELETE CASCADE,
  content text,
  language text NOT NULL CHECK (language in ('python', 'ruby', 'javascript', 'typescript', 'sql', 'html')),
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (pad_id, language)
);

-- Dedups joins within a single generation so PartySocket/YProvider reconnects
-- (same `_pk` connection id) don't inflate `pads.join_count`. Rows are kept
-- for later reference.
CREATE TABLE IF NOT EXISTS pad_connections (
  pad_id text NOT NULL REFERENCES pads(id) ON DELETE CASCADE,
  generation_id text NOT NULL,
  connection_id text NOT NULL,
  first_seen_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (pad_id, generation_id, connection_id)
);