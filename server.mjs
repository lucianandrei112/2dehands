import express from 'express';
import pino from 'pino';
import { getFirstOrganicListing, ensureBrowser, closeBrowser } from './scraper.mjs';

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const DEFAULT_URL =
  'https://www.2dehands.be/l/auto-s/#f:10898|Language:all-languages|offeredSince:Vandaag|PriceCentsFrom:0|PriceCentsTo:1500000|sortBy:DATE|sortOrder:DECREASING';

// respond within this time (Railway proxy safety)
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 15000);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms)),
  ]);
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// simple concurrency guard (1 scrape at a time prevents OOM/timeouts)
let busy = false;

app.get('/latest', async (req, res) => {
  const listUrl = (req.query.url && String(req.query.url)) || DEFAULT_URL;
  res.setTimeout(SCRAPE_TIMEOUT_MS + 1000);

  if (busy) {
    return res.status(429).json({ error: 'Busy, try again in a few seconds.' });
  }

  busy = true;
  try {
    await ensureBrowser(); // warm browser
    const data = await withTimeout(getFirstOrganicListing(listUrl, logger), SCRAPE_TIMEOUT_MS);
    return res.json(data);
  } catch (err) {
    logger.error({ err: String(err) }, 'Scrape error');
    const msg = String(err?.message || err);
    const code = msg.includes('Timeout') ? 504 : 500;
    return res.status(code).json({ error: msg });
  } finally {
    busy = false;
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => logger.info(`Listening on :${port}`));

// graceful shutdown (Railway restarts etc.)
process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});
