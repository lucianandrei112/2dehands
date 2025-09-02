import express from 'express';
import pino from 'pino';
import { getFirstOrganicListing } from './scraper.mjs';

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const DEFAULT_URL =
  'https://www.2dehands.be/l/auto-s/#f:10898|Language:all-languages|offeredSince:Vandaag|PriceCentsFrom:0|PriceCentsTo:1500000|sortBy:DATE|sortOrder:DECREASING';

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Voor nu: enkel /latest (pakt de eerste NIET-gesponsorde kaart)
app.get('/latest', async (req, res) => {
  const listUrl = (req.query.url && String(req.query.url)) || DEFAULT_URL;
  try {
    const data = await getFirstOrganicListing(listUrl, logger);
    res.json(data);
  } catch (err) {
    logger.error({ err }, 'Scrape error');
    res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => logger.info(`Listening on :${port}`));
