CREATE TABLE pads (
  id text PRIMARY KEY,
  current_language text NOT NULL CHECK (current_language in ('python', 'ruby', 'javascript', 'typescript', 'sql', 'html')) DEFAULT 'python',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE pad_contents (
  id serial PRIMARY KEY,
  pad_id text NOT NULL REFERENCES pads(id) ON DELETE CASCADE,
  content text,
  language text NOT NULL CHECK (language in ('python', 'ruby', 'javascript', 'typescript', 'sql', 'html')),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (pad_id, language)
);