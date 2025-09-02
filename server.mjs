// server.mjs
import express from 'express';
import { getFirstOrganicListing, ensureBrowser, closeBrowser } from './scraper.mjs';

const PORT = process.env.PORT || 3000;
const LIST_URL =
  process.env.LIST_URL ||
  'https://www.2dehands.be/l/auto-s/#f:10898|Language:all-languages|offeredSince:Vandaag|PriceCentsFrom:0|PriceCentsTo:1500000|sortBy:DATE|sortOrder:DECREASING';
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 20000);

let busy = false;

const app = express();

// Health check (kijk hiermee of je process nog leeft)
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/latest', async (req, res, next) => {
  try {
    if (busy) return res.status(429).json({ error: 'Busy, try again in a few seconds.' });
    busy = true;

    // vers resultaat afdwingen
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    const listUrl = req.query.url || LIST_URL;
    await ensureBrowser();

    const result = await withTimeout(
      getFirstOrganicListing(listUrl),
      SCRAPE_TIMEOUT_MS
    );

    return res.json(result);
  } catch (err) {
    return next(err);
  } finally {
    busy = false;
  }
});

// 404 fallback
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler (voorkomt proces-crash op throw/reject)
app.use((err, _req, res, _next) => {
  console.error('Request error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Process-level guards: loggen i.p.v. crashen
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err);
  // niet process.exit(); laat de server leven
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM: closing browser');
  await closeBrowser().catch(() => {});
  process.exit(0);
});

app.listen(PORT, () => console.log(`Server listening on :${PORT}`));

// helpers
function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timer]);
}
