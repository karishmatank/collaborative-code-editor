export async function isExistingPad(db, padId) {
  // Check to make sure pad ID exists in the database
  const result = await db
    .prepare("SELECT * FROM pads WHERE id = ?")
    .bind(padId)
    .first();
  return result !== null;
}

export async function getPadLanguage(db, padId) {
  // Gets the current language of a pad
  const result = await db
    .prepare("SELECT current_language FROM pads WHERE id = ?")
    .bind(padId)
    .first();
  return result ? result.current_language : null;
}

export async function updatePadLanguage(db, padId, language) {
  // Updates the current language of a pad
  const updatedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  await db
    .prepare("UPDATE pads SET current_language = ?, updated_at = ? WHERE id = ?")
    .bind(language, updatedAt, padId)
    .run();
}

export async function getPadContent(db, padId, language) {
  // Gets the last seen content of a pad for a given language
  const result = await db
    .prepare("SELECT content FROM pad_contents WHERE pad_id = ? AND language = ?")
    .bind(padId, language)
    .first();

  if (result === null) {
    await createPadContent(db, padId, language);
    return '';
  }
  return result.content || '';
}

export async function updatePadContent(db, padId, language, content) {
  // Updates the last seen content of a pad for a given language
  const updatedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  await db
    .prepare("UPDATE pad_contents SET content = ?, updated_at = ? WHERE pad_id = ? AND language = ?")
    .bind(content, updatedAt, padId, language)
    .run();
}

export async function createPad(db, padId) {
  // Creates a new pad
  await db
    .prepare("INSERT INTO pads (id) VALUES (?)")
    .bind(padId)
    .run();
}

export async function createPadContent(db, padId, language) {
  // Creates a new row in pad_contents to keep track of a language's content in a pad
  await db
    .prepare("INSERT INTO pad_contents (pad_id, language) VALUES (?, ?)")
    .bind(padId, language)
    .run();
}

export async function padLanguageComboExists(db, padId, language) {
  // Check if pad ID and language combo exists
  const count = await db
    .prepare("SELECT count(id) FROM pad_contents WHERE pad_id = ? AND language = ?")
    .bind(padId, language)
    .first('count(id)');
  return count === 1;
}