// server.mjs
import express from 'express';
import { getFirstOrganicListing, ensureBrowser, closeBrowser } from './scraper.mjs';

const PORT = process.env.PORT || 3000;
const LIST_URL =
  process.env.LIST_URL ||
  'https://www.2dehands.be/l/auto-s/#f:10898|Language:all-languages|offeredSince:Vandaag|PriceCentsFrom:0|PriceCentsTo:1500000|sortBy:DATE|sortOrder:DECREASING';
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 20000);

// anti-overlap en lichte jitter aan serverzijde
let busy = false;
let lastRunAt = 0;

const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 45000); // min tijd tussen runs
const JITTER_MIN_MS   = Number(process.env.JITTER_MIN_MS   || 1000);
const JITTER_MAX_MS   = Number(process.env.JITTER_MAX_MS   || 5000);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randInt = (a,b) => Math.floor(Math.random()*(b-a+1))+a;

const app = express();

// Health check
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Main route
app.get('/latest', async (req, res, next) => {
  try {
    if (busy) return res.status(429).json({ error: 'Busy, try again shortly.' });

    // Spreiding + rate-limit vriendelijk
    const now = Date.now();
    const waitNeeded = lastRunAt + MIN_INTERVAL_MS - now;
    if (waitNeeded > 0) {
      return res.status(429).json({ error: `Too soon, retry in ~${Math.ceil(waitNeeded/1000)}s` });
    }

    // No-cache headers (voorkomt caching door proxies/n8n/clients)
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    // kleine jitter vóór scrape
    await sleep(randInt(JITTER_MIN_MS, JITTER_MAX_MS));

    lastRunAt = Date.now();
    busy = true;

    const listUrl = req.query.url || LIST_URL;

    await ensureBrowser();
    const result = await withTimeout(getFirstOrganicListing(listUrl), SCRAPE_TIMEOUT_MS);

    return res.json(result);
  } catch (err) {
    return next(err);
  } finally {
    busy = false;
  }
});

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error middleware
app.use((err, _req, res, _next) => {
  console.error('Request error:', err);
  if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
});

// Process-level guards
process.on('unhandledRejection', (r) => console.error('UnhandledRejection:', r));
process.on('uncaughtException', (e) => console.error('UncaughtException:', e));
process.on('SIGTERM', async () => {
  console.log('SIGTERM: closing browser');
  await closeBrowser().catch(() => {});
  process.exit(0);
});

app.listen(PORT, () => console.log(`Server listening on :${PORT}`));

// helpers
function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`Timeout ${ms}ms`)), ms); });
  return Promise.race([promise.finally(() => clearTimeout(t)), timer]);
}
