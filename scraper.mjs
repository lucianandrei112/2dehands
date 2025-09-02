import { chromium } from 'playwright';

const NAV_TIMEOUT = 10000;
const SHORT_TIMEOUT = 600;
const SCROLL_BUDGET_MS = Number(process.env.SCROLL_BUDGET_MS || 7000);
const SCROLL_STEP_PX   = Number(process.env.SCROLL_STEP_PX || 2000);

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36';

const AD_TEXT_RE = /\b(topadvertentie|topzoekertje|gesponsord|gesponsorde|sponsored|publicit[eé]|annonce sponsoris[ée]e?|annonce publicitaire|mise en avant|mise en évidence)\b/i;
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

let browser;

/* ------------ Browser lifecycle ------------ */
async function launchBrowser() {
  const launchArgs = (process.env.PLAYWRIGHT_CHROMIUM_ARGS || '')
    .split(' ')
    .filter(Boolean);
  browser = await chromium.launch({
    headless: true,
    args: launchArgs.length
      ? launchArgs
      : ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--disable-gpu'],
  });
  return browser;
}
export async function ensureBrowser() {
  if (!browser || (typeof browser.isConnected === 'function' && !browser.isConnected())) {
    try { if (browser) await browser.close(); } catch {}
    await launchBrowser();
  }
  return browser;
}
export async function closeBrowser() {
  try { if (browser) await browser.close(); } catch {}
  browser = null;
}

/* ------------ Main scrape (met 1 automatische retry) ------------ */
export async function getFirstOrganicListing(listUrl, logger) {
  try {
    return await doScrape(listUrl, logger);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Target .* (closed|crash)|has been closed|browser has been closed/i.test(msg)) {
      await closeBrowser();
      await ensureBrowser();
      return await doScrape(listUrl, logger);
    }
    throw err;
  }
}

async function doScrape(listUrl, logger) {
  const b = await ensureBrowser();

  // verse context + no-cache headers
  const context = await b.newContext({
    locale: 'nl-BE',
    userAgent: UA,
    extraHTTPHeaders: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });

  // client state weg
  await context.addInitScript(() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
    try { caches?.keys?.().then(keys => keys.forEach(k => caches.delete(k))); } catch {}
  });

  // zware assets blokkeren
  await context.route('**/*', (route) => {
    const rt = route.request().resourceType();
    if (rt === 'image' || rt === 'font' || rt === 'media') return route.abort();
    return route.continue();
  });

  const page = await context.newPage();

  try {
    const urlWithTs = addCacheBuster(listUrl);
    logger?.debug?.({ urlWithTs }, 'goto');
    await page.goto(urlWithTs, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

    await dismissCookies(page);

    await page.waitForSelector('li.hz-Listing', { timeout: NAV_TIMEOUT });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
    await page.evaluate(() => window.scrollBy(0, 300));
    await page.waitForTimeout(120);

    // de allereerste NIET-ad kaart met datum
    const baseSel = 'li.hz-Listing:has(.hz-Listing-listingDate)';
    const nonAdSel = [
      baseSel,
      ':not(:has(.hz-Listing-priority))',
      ':not(:has-text("Topadvertentie"))',
      ':not(:has-text("Topzoekertje"))',
      ':not(:has-text("Gesponsord"))',
      ':not(:has-text("Sponsored"))',
      ':not(:has-text("Publicité"))',
      ':not(:has-text("Annonce sponsorisée"))',
    ].join('');

    let card = page.locator(nonAdSel).first();

    const t0 = Date.now();
    while ((await card.count()) === 0 && Date.now() - t0 < SCROLL_BUDGET_MS) {
      await page.evaluate((y) => window.scrollBy(0, y), SCROLL_STEP_PX);
      await page.waitForTimeout(180);
      card = page.locator(nonAdSel).first();
    }
    if ((await card.count()) === 0) throw new Error('Geen normale (niet-gesponsorde) kaart gevonden.');
    await card.waitFor({ state: 'attached', timeout: NAV_TIMEOUT });

    // ---- url + titel met robuuste fallback
    const { url, title } = await resolveUrlAndTitle(card, page);
    if (!url || !title) throw new Error('Kaart onvolledig (geen url/titel).');

    // ---- optioneel
    const priceRaw = await safeText(card, '[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]');
    const priceEUR = parsePriceEUR(priceRaw);
    const date = await safeText(card, '.hz-Listing-listingDate');

    const attrTexts = await safeTexts(card, '.hz-Attribute.hz-Attribute--default');
    const { year, mileageKm, fuel, transmission, body } = classifyAttributes(attrTexts);

    const optionsText = await safeText(card, '.hz-Listing-attribute-options');
    const options = optionsText ? optionsText.split(',').map((t) => clean(t)).filter(Boolean) : null;

    const sellerName = await safeText(card, '.hz-Listing-seller-name');
    const sellerCity = await safeText(card, '.hz-Listing-sellerLocation');

    // adId uit URL
    let adId = null;
    if (url) {
      const m = url.match(/m(\d+)-/); if (m) adId = m[1];
      const m2 = url.match(/\/(\d{9,})/); if (!adId && m2) adId = m2[1];
    }

    return {
      url,
      title: clean(title),
      priceRaw: clean(priceRaw),
      priceEUR,
      date: clean(date),
      adId,
      year,
      mileageKm,
      fuel,
      transmission,
      body,
      options,
      sellerName: clean(sellerName),
      sellerCity: clean(sellerCity),
      scrapedAt: new Date().toISOString(),
      listUrlUsed: listUrl,
    };
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
  }
}

/* ---------- url/titel super-robust + detail-fallback ---------- */
async function resolveUrlAndTitle(card, page) {
  const origin = await page.evaluate(() => location.origin);

  // 1) Probeer diverse link selectors (meest specifiek → algemeen)
  const linkSelectors = [
    'a[data-testid="listing-link"]',
    'a:has([data-testid="listing-title"])',
    'a[href*="/v/auto-s/"]',
    'a[href*="/v/"]',
    'a[href^="/v"]',
    'a[href*="/m"]',
    'a[href]' // allerlaatste redmiddel
  ];

  let link = null;
  for (const sel of linkSelectors) {
    const loc = card.locator(sel).first();
    if (await loc.count()) { link = loc; break; }
  }

  let href = null;
  if (link) {
    href = await link.getAttribute('href').catch(() => null);
  }
  const url = href ? new URL(href, origin).href : null;

  // titel: prefer data-testid, anders h3/h2, anders link title/aria-label/tekst
  let title =
    (await safeText(card, '[data-testid="listing-title"]')) ||
    (await safeText(card, 'h3, h2')) ||
    (link ? (await link.getAttribute('title').catch(() => null)) : null) ||
    (link ? (await link.getAttribute('aria-label').catch(() => null)) : null) ||
    (link ? (await link.textContent().catch(() => null)) : null);

  title = clean(title);

  // 2) Als nog steeds geen url of titel → open kort de detailpagina en lees daar
  if ((!url || !title) && link) {
    try {
      await link.scrollIntoViewIfNeeded().catch(() => {});
      const [detail] = await Promise.all([
        page.context().waitForEvent('page'),
        link.click({ button: 'middle' }) // open in nieuwe tab
      ]);
      await detail.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      const dUrl = detail.url();
      // titel op detail: h1 of data-testid varianten
      const dTitle =
        (await detail.locator('h1, [data-testid="ad-title"], [data-testid="listing-title"]').first().textContent({ timeout: 2000 }).catch(() => null)) ||
        null;
      await detail.close().catch(() => {});

      return {
        url: url || dUrl || null,
        title: clean(title || dTitle) || null,
      };
    } catch {
      // negeer; val terug op wat we hebben
    }
  }

  return { url: url || null, title: title || null };
}

/* ---------- helpers ---------- */

function addCacheBuster(u) {
  const ts = `_ts=${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const i = u.indexOf('#');
  if (i === -1) return u + (u.includes('?') ? '&' : '?') + ts;
  const base = u.slice(0, i);
  const hash = u.slice(i);
  return base + (base.includes('?') ? '&' : '?') + ts + hash;
}

async function safeText(scope, selector) {
  try {
    const loc = scope.locator(selector).first();
    if ((await loc.count()) === 0) return null;
    const t = await loc.textContent({ timeout: SHORT_TIMEOUT });
    return t ? t.replace(/\s+/g, ' ').trim() : null;
  } catch { return null; }
}
async function safeAttr(scope, selector, attr) {
  try {
    const loc = scope.locator(selector).first();
    if ((await loc.count()) === 0) return null;
    return await loc.getAttribute(attr, { timeout: SHORT_TIMEOUT });
  } catch { return null; }
}
async function safeTexts(scope, selector) {
  try {
    const loc = scope.locator(selector);
    const n = await loc.count();
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = await loc.nth(i).textContent({ timeout: SHORT_TIMEOUT }).catch(() => null);
      if (t) out.push(t.replace(/\s+/g, ' ').trim());
    }
    return out;
  } catch { return []; }
}
function parsePriceEUR(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : null;
}
function parseKm(raw) {
  if (!raw) return null;
  const m = raw.match(/([\d.\s]+)\s*km/i);
  if (!m) return null;
  const digits = m[1].replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : null;
}
function classifyAttributes(items) {
  const norm = (s) => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const fuels = ['diesel','benzine','essence','petrol','elektrisch','electrique','electric','hybride','hybrid','plug-in hybride','plugin hybride','cng','lpg'];
  const transmissions = ['automaat','automatic','automatisch','boite auto','boîte auto','boite automatique','boîte automatique','handgeschakeld','manueel','manuelle','boite manuelle','boîte manuelle','semi-automaat','semi automaat'];
  const bodies = ['berline','sedan','hatchback','break','station','stationwagen','stationwagon','suv','coupe','coupé','cabri','cabrio','cabriolet','mpv','monovolume','pick-up','pickup','bestelwagen','bestel','coupé'];

  let year=null, mileageKm=null, fuel=null, transmission=null, body=null;
  for (const raw of items) {
    const t = norm(raw);
    const y = (raw.match(/(?:19|20)\d{2}/) || [])[0];
    if (!year && y && +y >= 1950 && +y <= 2035) year = y;
    if (!mileageKm) { const km = parseKm(raw); if (km) mileageKm = km; }
    if (!fuel && fuels.some((k) => t.includes(k))) fuel = clean(raw);
    if (!transmission && transmissions.some((k) => t.includes(k))) transmission = clean(raw);
    if (!body && bodies.some((k) => t.includes(k))) body = clean(raw);
  }
  return { year: year ? String(year) : null, mileageKm: mileageKm ?? null, fuel: fuel ?? null, transmission: transmission ?? null, body: body ?? null };
}

async function dismissCookies(page) {
  try { const b = page.locator('#onetrust-accept-btn-handler'); if (await b.isVisible({ timeout: 800 })) { await b.click(); return; } } catch {}
  try { const no = page.locator('button:has-text("Doorgaan zonder te accepteren"), button:has-text("Continuer sans accepter")'); if (await no.first().isVisible({ timeout: 600 })) { await no.first().click(); return; } } catch {}
  try { const acc = page.locator('button:has-text("Accepteren"), button:has-text("Accepter")'); if (await acc.first().isVisible({ timeout: 600 })) { await acc.first().click(); return; } } catch {}
}
