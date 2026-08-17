import { isExistingPad } from "./database.js";

const VALID_LANGUAGES = ['python', 'ruby', 'javascript', 'typescript', 'sql', 'html'];

export const validatePadId = async (c, next) => {
  const db = c.get('db');
  const padId = c.req.param('padId');
  const exists = await isExistingPad(db, padId);
  if (!exists) {
    return c.json({ error: 'Pad not found' }, 404);
  }
  await next();
};

export const validateLanguage = async (c, next) => {
  const language = c.req.param('language');
  if (!VALID_LANGUAGES.includes(language)) {
    return c.json({ error: 'Pad language is invalid' }, 404);
  }
  await next();
};

export const requireAuth = async (c, next) => {
  const token = c.req.header('Authorization');
  if (token !== `Bearer ${c.env.AUTH_TOKEN}`) {
    return c.json({ error: 'Not authorized' }, 401);
  }
  await next();
};