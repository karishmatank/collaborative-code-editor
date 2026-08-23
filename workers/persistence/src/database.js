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

export async function getGeneration(db, padId) {
  // Get the generation ID that represents the current group session for a pad
  // We introduce generation ID instead of solely relying on pad ID so that
  // we get new Durable Objects that reset location based on the first student of the group
  // Otherwise, for a given pad, we would use the same DO no matter where students are joining from
  return db
    .prepare("SELECT generation FROM pads WHERE id = ?")
    .bind(padId)
    .first('generation');  
}

export async function setGeneration(db, padId, generationId) {
  // Set a generation ID
  // Checking for generation of NULL makes sure we don't reset a generation ID if it was just set
  // which can happen if two users join right after one another, where the second user
  // gets a NULL generation ID from getGeneration above before the first user has set it
  await db
    .prepare("UPDATE pads SET generation = ? WHERE id = ? AND generation IS NULL")
    .bind(generationId, padId)
    .run();
}

export async function clearGeneration(db, padId) {
  // Clear a previously set generation ID
  // Null presence sets an indicator that a given group session is over
  await db
    .prepare("UPDATE pads SET generation = NULL WHERE id = ?")
    .bind(padId)
    .run();
}

export async function incrementJoinCount(db, padId) {
  await db
    .prepare("UPDATE pads SET join_count = join_count + 1 WHERE id = ?")
    .bind(padId)
    .run();
}