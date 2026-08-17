import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { validatePadId, validateLanguage, requireAuth } from './decorators.js';
import { 
  getPadLanguage, 
  isExistingPad, 
  updatePadLanguage, 
  getPadContent, 
  updatePadContent, 
  createPad, 
  padLanguageComboExists 
} from './database.js';
import { customAlphabet } from 'nanoid';

const app = new Hono();

// CORS
app.use('*', async (c, next) => {
  const corsMiddlewareHandler = cors({
    origin: c.env.FRONTEND_URL,
  });
  return corsMiddlewareHandler(c, next);
});

// Set DB before each request
app.use('*', async (c, next) => {
  c.set('db', c.env.collab_pads);
  await next();
});

// Gets pad info, which is just the current language of the pad
app.get('/api/pads/:padId', validatePadId, async (c) => {
  const db = c.get('db');
  const padId = c.req.param('padId');
  const language = await getPadLanguage(db, padId);

  // The following shouldn't really happen, but it is there in case
  if (!language) {
    return c.json({ error: 'Pad does not have a language' }, 404);
  }

  return c.json({ language: language}, 200);
});

// Updates pad language
app.patch('/api/pads/:padId', validatePadId, async (c) => {
  const db = c.get('db');
  const padId = c.req.param('padId');
  const { language } = await c.req.json();
  if (!language) {
    return c.json({ error: 'Missing language' }, 400);
  }
  await updatePadLanguage(db, padId, language);
  return new Response(null, { status: 204 });
});

// Creates a new pad and inserts into the database
app.post('/api/pads', requireAuth, async (c) => {
  const db = c.get('db');

  let padId;
  const nanoid = customAlphabet(
    '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', // matches Python shortuuid
    8
  );
  while (true) {
    padId = nanoid();
    const exists = await isExistingPad(db, padId);
    if (!exists) {
      break;
    }
  }
  
  await createPad(db, padId);
  return c.json({ pad_id: padId }, 201);
});

// Get pad content for the given pad ID and language
app.get('/api/pads/:padId/content/:language', validatePadId, validateLanguage, async (c) => {
  const db = c.get('db');
  const padId = c.req.param('padId');
  const language = c.req.param('language');

  const content = await getPadContent(db, padId, language);
  return c.json({ content: content }, 200);
});

// Update content for a given pad ID and language combo
app.patch('/api/pads/:padId/content/:language', validatePadId, validateLanguage, async (c) => {
  const db = c.get('db');
  const padId = c.req.param('padId');
  const language = c.req.param('language');

  const { content } = await c.req.json();
  if (content === undefined) {
    return c.json({ error: 'Missing content' }, 400);
  }
  const exists = await padLanguageComboExists(db, padId, language);
  if (!exists) {
    return c.json({ error: 'Pad language combo does not exist' }, 400);
  }
  await updatePadContent(db, padId, language, content);
  return new Response(null, { status: 204 });
});

export default app;
