import express from 'express';
import pino from 'pino';
import { getFirstOrganicListing } from './scraper.mjs';

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const DEFAULT_URL =
  'https://www.2dehands.be/l/auto-s/#f:10898|Language:all-languages|offeredSince:Vandaag|PriceCentsFrom:0|PriceCentsTo:1500000|sortBy:DATE|sortOrder:DECREASING';

// Max tijd dat /latest mag duren (proxy timeouts voorkomen)
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 20000);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms)),
  ]);
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/latest', async (req, res) => {
  const listUrl = (req.query.url && String(req.query.url)) || DEFAULT_URL;
  // Geef Node zelf iets langer dan onze race-timeout
  res.setTimeout(SCRAPE_TIMEOUT_MS + 2000);

  try {
    const data = await withTimeout(getFirstOrganicListing(listUrl, logger), SCRAPE_TIMEOUT_MS);
    res.json(data);
  } catch (err) {
    logger.error({ err }, 'Scrape error');
    const msg = String(err?.message || err);
    const code = msg.includes('Timeout') ? 504 : 500;
    res.status(code).json({ error: msg });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => logger.info(`Listening on :${port}`));
