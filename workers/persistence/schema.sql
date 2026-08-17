CREATE TABLE pads (
  id text PRIMARY KEY,
  current_language text NOT NULL CHECK (current_language in ('python', 'ruby', 'javascript', 'typescript', 'sql', 'html')) DEFAULT 'python',
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pad_contents (
  id integer PRIMARY KEY,
  pad_id text NOT NULL REFERENCES pads(id) ON DELETE CASCADE,
  content text,
  language text NOT NULL CHECK (language in ('python', 'ruby', 'javascript', 'typescript', 'sql', 'html')),
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (pad_id, language)
);