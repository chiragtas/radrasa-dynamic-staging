import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TryOnError } from './lib/errors.js';
import { normalizeShop, normalizeHandle } from './lib/shops.js';
import { createStore } from './lib/store.js';
import { classify, CATEGORIES, categoryIds, FOCUS_AREAS, genericAllowed, categoryChoices } from './lib/categories.js';
import { API_VERSION as SHOPIFY_API_VERSION, fetchProduct, fetchAllProducts, normalizeProduct, pickVariant } from './lib/products.js';
import { fetchProductImage } from './lib/images.js';
import { prepareProduct, fitAspect, assess, cleanOutput } from './lib/imageops.js';
import { buildPrompt } from './lib/prompt.js';
import { pickEngine } from './lib/engines/index.js';
import { classifyByPhoto, visionEngine } from './lib/vision.js';
import { hashPassword, makeSession, normalizeEmail, readSession, verifyPassword } from './lib/platformAuth.js';
import { verifyShopifyIdToken, exchangeShopifyIdToken } from './lib/shopifyEmbeddedAuth.js';
import {
  verifyQueryHmac, verifyWebhookHmac, makeState, checkState, stateOwner, installUrl, exchangeCode, encryptToken, decryptToken,
} from './lib/shopifyAuth.js';
import { withDefaults, creditSummary, pricingFor, toMilli, tryonCostMilli, paginate, modeFor, imageCostMilli } from './lib/billing.js';
import { textsFor, cleanTexts, customTexts, DEFAULT_TEXTS, TEXT_GROUPS, LEGACY_KEYS, LEGACY_DEFAULTS } from './lib/texts.js';
import { createBilling } from './lib/billingRoutes.js';
import { limitsFor, cleanLimits, shopperFrom, access, device, countryOf, filterEvents, summarize, shopperRows, toCsv, cleanEmail } from './lib/shoppers.js';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PRODUCT_TTL_MS = 10 * 60_000;

export async function createApp(opts = {}) {
  const env = opts.env || process.env;
  const f = opts.fetch || globalThis.fetch;
  const store = opts.store || (await createStore(env));
  const audit = async (action, details = {}, actor = 'system') => {
    try { await store.addAudit({ at: Date.now(), action, actor, ...details }); }
    catch (e) { console.warn('[audit] could not record event:', e.message); }
  };
  const engine = opts.engine !== undefined ? opts.engine : pickEngine(env);

  const API_KEY = env.SHOPIFY_API_KEY;
  const API_SECRET = env.SHOPIFY_API_SECRET;
  const APP_URL = (env.APP_URL || '').replace(/\/$/, '');
  const HAS_APP = Boolean(API_KEY && API_SECRET && APP_URL);
  const SUPER_EMAIL = normalizeEmail(env.SUPER_ADMIN_EMAIL);
  const SUPER_PASSWORD_HASH = env.SUPER_ADMIN_PASSWORD ? hashPassword(env.SUPER_ADMIN_PASSWORD) : null;
  const SUPER_ID = SUPER_EMAIL ? `super:${SUPER_EMAIL}` : '';
  // Who may use the service. With a Shopify app configured, only stores that installed it (or ALLOWED_SHOPS).
  // Without one, any *.myshopify.com store (set OPEN_SHOPS=0 to refuse unknown stores).
  const ALLOWED = (env.ALLOWED_SHOPS || '').split(',').map((s) => normalizeShop(s)).filter(Boolean);
  // A list in ALLOWED_SHOPS always restricts the service to those stores (unless OPEN_SHOPS=1 is set on purpose).
  const OPEN = env.OPEN_SHOPS === '1' || (!HAS_APP && env.OPEN_SHOPS !== '0' && ALLOWED.length === 0);
  const PER_IP_PER_MIN = Number(env.RATE_PER_MINUTE || 4);
  const SHOP_DAILY = Number(env.DAILY_CAP_PER_SHOP || 200);
  const RETRIES = Math.max(0, Number(env.TRYON_RETRIES ?? 1)); // extra tries when the AI returns a blank picture or hands the photo back unchanged
  const GLOBAL_DAILY = Number(env.DAILY_CAP || (engine?.id === 'cloudflare' ? 80 : 2000));
  const BILLING_OFF = env.BILLING === 'off';
  const getSettings = async () => withDefaults(await store.getSettings());

  // Credits apply to every store that installed the app. A store served only through OPEN_SHOPS / ALLOWED_SHOPS with no
  // installation (your own single store, read from its public storefront) is not billed. BILLING=off turns credits off.
  const isBilled = (record) => !BILLING_OFF && Boolean(record && (record.token || record.ownerId || record.platformManaged || record.status === 'installed' || record.credits));

  // Give a store its credit balance once (welcome credits), and convert balances from older versions to credits.
  async function ensureCredits(shop, record, settings) {
    if (!record || (record.credits && record.creditUnit === 'credit')) return record;
    const per = tryonCostMilli(settings);
    if (!record.credits) {
      const legacy = Number.isFinite(record.creditsLimit) ? Math.max(0, record.creditsLimit - (Number(record.creditsUsed) || 0)) : null;
      // Only the super admin's "Welcome credits" setting (default 0) decides free credits. The old DEFAULT_TRYON_CREDITS variable is ignored.
      const welcome = Math.max(0, Number(settings.welcomeCredits) || 0);
      await store.putShop(shop, { ...record, credits: { balance: 0, purchased: 0, spent: 0 }, creditUnit: 'credit' });
      const give = legacy !== null ? Math.round(legacy * per) : Math.round(welcome * 1000);
      if (give > 0) await store.adjustCredits(shop, give, { type: legacy !== null ? 'migration' : 'welcome', note: legacy !== null ? 'Carried over' : 'Welcome credits' });
    } else {
      // An earlier version kept the balance in money: convert it to credits at the store's value per try-on.
      const rate = toMilli(Number.isFinite(record.pricing?.pricePerTryon) ? record.pricing.pricePerTryon : 0.1); // the earlier versions' value per try-on
      const target = Math.floor(record.credits.balance / rate) * per;
      if (target !== record.credits.balance) await store.adjustCredits(shop, target - record.credits.balance, { type: 'conversion', note: 'Balance converted to credits' });
      const fresh = await store.getShop(shop);
      await store.putShop(shop, { ...fresh, creditUnit: 'credit' });
    }
    return store.getShop(shop);
  }

  // Shoppers never see which AI service, key or model is behind a preview. Anything that slips through is replaced.
  const TECH_WORDS = /gemini|google|vertex|openai|gpt|dall|anthropic|claude|cloudflare|workers ai|flux|stability|replicate|nano.?banana|imagen|api[ -]?key|token|model|quota|neurons|upstream|stack|undefined|null|\bat \w+ \(/i;
  const shopperMessage = (e) => {
    const m = e instanceof TryOnError ? String(e.message || '') : '';
    return !m || TECH_WORDS.test(m) ? 'Something went wrong. Please try again.' : m;
  };
  const errorCode = (status) => ({ 400: 'bad_request', 402: 'no_credit', 403: 'not_allowed', 404: 'not_found', 413: 'too_large', 422: 'photo', 429: 'busy', 503: 'unavailable', 504: 'timeout' }[status] || 'error');

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ---- limits (in memory; use Redis if you run several servers) ---
  const hits = new Map();
  const shopCount = new Map();
  let day = new Date().toDateString();
  let globalCount = 0;
  function gate(ip, shop) {
    const today = new Date().toDateString();
    if (today !== day) { day = today; globalCount = 0; shopCount.clear(); }
    if (globalCount >= GLOBAL_DAILY) return 'Today\'s preview limit has been reached. Please try again tomorrow.';
    if ((shopCount.get(shop) || 0) >= SHOP_DAILY) return 'This store has reached today\'s preview limit. Please try again tomorrow.';
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
    if (recent.length >= PER_IP_PER_MIN) return 'Too many previews in a minute. Please wait a moment.';
    recent.push(now);
    hits.set(ip, recent);
    globalCount += 1;
    shopCount.set(shop, (shopCount.get(shop) || 0) + 1);
    return null;
  }

  // Why a store is not served (for the error message): not_found | disconnected | account_inactive | not_linked.
  const shopBlockReason = async (shop) => {
    const record = await store.getShop(shop);
    if (!record) return 'not_found';
    if (record.status === 'disconnected') return 'disconnected';
    if (record.ownerId) return 'account_inactive';
    return 'not_linked';
  };
  const notInstalled = async (res, shop) => {
    const code = await shopBlockReason(shop);
    const hint = {
      not_found: 'No record of this store. Check the address is the .myshopify.com one, and open lookOn once in the Shopify admin.',
      disconnected: 'The store was disconnected (app uninstalled or its access stopped working). Open lookOn in the Shopify admin to reconnect.',
      account_inactive: 'The account this store belongs to is switched off in the super admin.',
      not_linked: 'Open lookOn once in the Shopify admin to finish connecting the store.',
    }[code];
    return res.status(403).json({ error: 'This store has not installed the try-on app.', code, hint });
  };
  const shopAllowed = async (shop) => {
    if (OPEN || ALLOWED.includes(shop)) return true;
    const record = await store.getShop(shop);
    if (!record) return false;
    // A valid Shopify installation token is sufficient for storefront try-on.
    // Storefront access must not depend on whether Super Admin has assigned the
    // store to a purchaser account yet.
    if (record.status === 'disconnected') return false;
    if (record.token) return true;
    if (record.ownerId) return Boolean((await store.getUser(record.ownerId))?.active);
    if (record.platformManaged) return false;
    return true; // legacy store installed before purchaser accounts were enabled
  };

  async function platformUser(req) {
    const token = /(?:^|;\s*)ptn_platform=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    let id;
    try { id = readSession(decodeURIComponent(token || ''), env); } catch { return null; }
    if (!id) return null;
    if (id === SUPER_ID && SUPER_PASSWORD_HASH) return { id, email: SUPER_EMAIL, name: 'lookOn Super Admin', role: 'superadmin', active: true };
    const user = await store.getUser(id);
    return user?.active ? { ...user, role: 'admin' } : null;
  }

  function setPlatformCookie(res, req, token) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `ptn_platform=${encodeURIComponent(token || '')}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${token ? 43200 : 0}`);
  }

  // A refreshed copy of a product keeps its saved photo-based answer while its title and main photo are unchanged (so the vision call is made once, not every refresh).
  const keepVision = (old, fresh) => {
    if (old?.vision && old.title === fresh.title && old.images?.[0] === fresh.images?.[0]) fresh.vision = old.vision;
    return fresh;
  };

  async function loadProduct(shop, handle) {
    const cached = await store.getProduct(shop, handle);
    if (cached && Date.now() - cached.fetchedAt < PRODUCT_TTL_MS) return cached;
    const rec = await store.getShop(shop);
    try {
      const p = keepVision(cached, await fetchProduct({ fetch: f, shop, handle, token: decryptToken(rec?.token, env) }));
      const detected = classify(p).id;
      if (detected) p.tryOnCategory = detected;
      await store.putProducts(shop, [p]);
      return p;
    } catch (e) {
      if (e.status === 404 && cached) await store.deleteProduct(shop, cached.id);
      else if (cached) return cached; // store unreachable: a slightly old copy is better than an error
      throw e;
    }
  }

  // The category of a product: the word lists first (free, instant); if they cannot place it and VISION_CLASSIFY=1, look at the
  // product photo once and remember the answer with the product.
  async function resolveCategory(shop, product, hint, record) {
    record = record === undefined ? await store.getShop(shop) : record;
    // 1) Shopify metafield custom.tryon_category, 2) the merchant's choice for this product, 3) the merchant's mapping for the product type.
    if (hint && CATEGORIES[hint]) return { id: hint, by: 'metafield' };
    const own = record?.productCategories?.[product.handle];
    if (own === 'none') return { id: null, by: 'merchant' };
    if (own && CATEGORIES[own]) return { id: own, by: 'merchant' };
    const typeKey = String(product.type || '').trim().toLowerCase();
    const mapped = typeKey && record?.typeMap?.[typeKey];
    if (mapped === 'none') return { id: null, by: 'merchant' };
    if (mapped && CATEGORIES[mapped]) return { id: mapped, by: 'type-map' };
    const found = await detectCategory(shop, product);
    if (found.id) return found;
    // 4) last resort, only if the merchant switched it on: a general "wear or use this product" preview.
    if (record?.widget?.tryUncategorized && genericAllowed(product)) return { id: 'generic', by: 'fallback' };
    return found;
  }

  async function detectCategory(shop, product) {
    const cat = classify(product);
    if (cat.id) return cat;
    // Persisted during catalog sync so older products do not need a Shopify
    // metafield and can still be recognised after a restart.
    if (product.tryOnCategory && CATEGORIES[product.tryOnCategory]) {
      return { id: product.tryOnCategory, by: 'catalog' };
    }
    const known = product.vision;
    if (known && known.v === 1) return known.category === 'none' ? cat : { id: known.category, by: 'photo' };
    if (!visionEngine(env) || !product.images[0]) return cat;
    try {
      const image = await fetchProductImage({ fetch: f, url: product.images[0], shop, maxSide: 512 });
      const answer = await classifyByPhoto({ env, fetch: f, image, title: product.title });
      if (answer == null) return cat;
      product.vision = { v: 1, category: answer, at: Date.now() };
      await store.putProducts(shop, [product]);
      return answer === 'none' ? cat : { id: answer, by: 'photo' };
    } catch (e) {
      console.warn('[vision] could not classify', product.handle, e.message); // not saved: it will be tried again next time
      return cat;
    }
  }

  async function syncShop(shop) {
    const rec = await store.getShop(shop);
    // Without an installation, a store allowed by OPEN_SHOPS / ALLOWED_SHOPS is read from its public storefront.
    const publicOnly = !rec?.token && rec?.status !== 'disconnected' && (OPEN || ALLOWED.includes(shop));
    if (!publicOnly && (!rec || rec.status === 'disconnected' || !rec.token)) throw new TryOnError('This Shopify store is disconnected. Reconnect it before syncing.', 409);
    const products = await fetchAllProducts({ fetch: f, shop, token: publicOnly ? undefined : decryptToken(rec?.token, env) });
    const current = await store.getShop(shop);
    if (!publicOnly && (!current || current.status === 'disconnected' || !current.token)) throw new TryOnError('This Shopify store was disconnected during sync.', 409);
    const before = new Map((await store.listProducts(shop)).map((x) => [x.handle, x]));
    await store.putProducts(shop, products.map((p) => {
      const fresh = keepVision(before.get(p.handle), p);
      const detected = classify(fresh).id;
      if (detected) fresh.tryOnCategory = detected;
      else if (before.get(p.handle)?.tryOnCategory) fresh.tryOnCategory = before.get(p.handle).tryOnCategory;
      return fresh;
    }));
    await store.putShop(shop, { ...(current || rec || {}), syncedAt: Date.now(), productCount: products.length });
    return products.length;
  }

  // Shopify normally notifies us through app/uninstalled. This lightweight check is a
  // fallback for missed/delayed webhooks (and keeps the Super Admin status truthful).
  // Network failures are intentionally ignored so a temporary outage never disconnects
  // a healthy store; only an explicit unauthorized response invalidates the connection.
  async function reconcileShopConnection(shop, record) {
    if (!record || record.status === 'disconnected' || !record.token) return record;
    const token = decryptToken(record.token, env);
    if (!token) {
      await store.disconnectShop(shop, { disconnectedReason: 'invalid_token' });
      await audit('store_disconnected', { shop, reason: 'invalid_token' });
      return { ...record, token: null, status: 'disconnected', disconnectedReason: 'invalid_token', uninstalledAt: Date.now() };
    }
    try {
      const response = await f(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`, {
        headers: { Accept: 'application/json', 'X-Shopify-Access-Token': token },
        redirect: 'manual',
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 401 || response.status === 403) {
        await store.disconnectShop(shop, { disconnectedReason: 'shopify_token_rejected' });
        await audit('store_disconnected', { shop, reason: 'shopify_token_rejected' });
        return { ...record, token: null, status: 'disconnected', disconnectedReason: 'shopify_token_rejected', uninstalledAt: Date.now() };
      }
    } catch (e) {
      console.warn('[shop-check]', shop, e?.message || e);
    }
    return record;
  }

  const billing = createBilling({ store, env, fetch: f, audit, getSettings, ensureCredits, APP_URL, API_KEY });
  billing.registerWebhooks(app); // Stripe and Razorpay webhooks need the raw body too

  // ---- Shopify webhooks need the raw body for their signature, so they are registered before the JSON parser ----
  app.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '4mb' }), async (req, res) => {
    if (!verifyWebhookHmac(req.body, req.get('x-shopify-hmac-sha256'), API_SECRET)) return res.sendStatus(401);
    const topic = req.get('x-shopify-topic') || '';
    const shop = normalizeShop(req.get('x-shopify-shop-domain'));
    let body = {};
    try { body = JSON.parse(req.body.toString('utf8') || '{}'); } catch { return res.sendStatus(400); }
    try {
      if (shop) {
        const record = await store.getShop(shop);
        if (topic === 'products/create' || topic === 'products/update') {
          if (!record || record.status === 'disconnected') return res.sendStatus(200);
          const p = normalizeProduct(body);
          if (p) await store.putProducts(shop, [keepVision(await store.getProduct(shop, p.handle), p)]);
        } else if (topic === 'products/delete') {
          if (record?.status !== 'disconnected') await store.deleteProduct(shop, body.id);
        } else if (topic === 'app/uninstalled') {
          // Keep the store and product history, but invalidate credentials and stop sync.
          await store.disconnectShop(shop, { disconnectedReason: 'app_uninstalled' });
        } else if (topic === 'app_purchases_one_time/update') {
          await billing.shopifyPurchaseUpdated(shop, body);
        } else if (topic === 'shop/redact') {
          // Shopify's shop redaction request permits removing the app's stored data.
          await store.purgeShop(shop);
        }
        // customers/data_request and customers/redact: this service stores no customer data (photos are never kept), so there is nothing to return or erase.
      }
      return res.sendStatus(200);
    } catch (e) {
      console.error('[webhook]', topic, e.message);
      return res.sendStatus(500);
    }
  });

  // Which websites may call the API from a browser (CORS).
  //  - Nothing configured (no CORS_ORIGINS, no ALLOWED_SHOPS): any site may, so it works anywhere.
  //  - ALLOWED_SHOPS set: each of those stores' own https://<shop>.myshopify.com pages are allowed automatically.
  //  - CORS_ORIGINS="https://radrasa.com,https://www.radrasa.com": extra origins, for stores that use their own domain
  //    ("*" means any). Installed stores' myshopify.com pages are allowed too.
  // CORS only controls browsers; abuse is limited by the daily caps and the store allow-list above.
  const CORS_LIST = (env.CORS_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  const CORS_OPEN = CORS_LIST.includes('*') || (CORS_LIST.length === 0 && ALLOWED.length === 0 && OPEN);
  async function originAllowed(origin) {
    if (CORS_OPEN) return true;
    if (!origin) return false;
    if (CORS_LIST.includes(origin)) return true;
    let host;
    try { const u = new URL(origin); if (u.protocol !== 'https:') return false; host = u.hostname; } catch { return false; }
    return ALLOWED.includes(host) || (Boolean(normalizeShop(host)) && (OPEN || Boolean(await store.getShop(host))));
  }
  app.use('/api', async (req, res, next) => {
    const origin = req.get('Origin');
    if (await originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', CORS_OPEN ? '*' : origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (!CORS_OPEN) res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '12mb' }));

  // ---------------- lookOn platform panels ----------------
  const panelPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public', 'panel.html');
  const embeddedPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public', 'embedded.html');

  // ---------------- Embedded Shopify purchaser app ----------------
  app.get('/app', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(embeddedPath); });
  async function embeddedIdentity(req) {
    const auth = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!auth) throw new Error('Shopify authentication is required.');
    const identity = verifyShopifyIdToken(auth[1], env);
    const shopRecord = await store.getShop(identity.shop);
    // A purchaser account belongs to the store, not to whichever Shopify staff
    // member happens to open the embedded app today.
    const id = shopRecord?.ownerId || `purchaser:${identity.shop}`;
    let user = await store.getUser(id);
    if (!user) {
      user = { id, name: identity.email || identity.shop, email: identity.email || '', shop: identity.shop, shopifyStore: identity.shop, shopifyUserId: identity.sub, active: true, createdAt: Date.now(), source: 'shopify_store' };
      await store.putUser(id, user);
    }
    if (!user.active) throw new Error('This lookOn account is suspended. Contact lookOn support.');
    return { identity, user, id, shopRecord };
  }
  app.post('/app/api/session', async (req, res) => {
    try {
      const { identity, user, id } = await embeddedIdentity(req);
      const oldShop = await store.getShop(identity.shop);
      // Prompt once for the theme embed, including stores installed before this
      // onboarding flow existed. The flag is set before redirect so reopening
      // the embedded app does not loop back to the theme editor.
      const needsThemeSetup = oldShop?.themeEmbedSetup !== true;
      const exchanged = await exchangeShopifyIdToken({ fetch: f, token: req.get('authorization').replace(/^Bearer\s+/i, ''), shop: identity.shop, env });
      await store.putShop(identity.shop, { ...(oldShop || {}), ownerId: id, platformManaged: true, status: 'installed', disconnectedAt: null, uninstalledAt: null, token: encryptToken(exchanged.token, env), scope: exchanged.scope, installedAt: oldShop?.installedAt || Date.now(), lastEmbeddedUserId: identity.sub, themeEmbedSetup: needsThemeSetup ? true : oldShop.themeEmbedSetup, disabledProductHandles: Array.isArray(oldShop?.disabledProductHandles) ? oldShop.disabledProductHandles : [] });
      // Embedded installs authenticate through Shopify's App Bridge ID-token
      // exchange instead of the legacy /auth/callback flow.  That path must
      // perform the initial catalogue sync too; otherwise the store appears
      // active while it has zero products and the storefront block stays
      // hidden because /api/product cannot resolve a product from the cache.
      // Finish the first catalogue sync before rendering the purchaser panel.
      // Otherwise a newly installed store briefly (or permanently, if the
      // request is the only invocation) reports zero products and its
      // storefront lookup has no reliable catalogue to use.
      await ensureCredits(identity.shop, await store.getShop(identity.shop), await getSettings());
      // The first open pulls the whole catalogue; later opens use the webhooks and the "Refresh catalog" button.
      let syncedProducts = null;
      if (!oldShop?.syncedAt) {
        try { syncedProducts = await syncShop(identity.shop); }
        catch (e) { console.error('[sync]', identity.shop, e.message); }
      }
      const response = { shop: identity.shop, user: { id: user.id, name: user.name, email: user.email }, role: 'admin', syncedProducts };
      if (needsThemeSetup) {
        const themeEditor = new URL(`https://${identity.shop}/admin/themes/current/editor`);
        themeEditor.searchParams.set('context', 'apps');
        themeEditor.searchParams.set('activateAppId', `${API_KEY}/product-tryon`);
        themeEditor.searchParams.set('target', 'newAppsSection/app-embed');
        response.themeEditorUrl = themeEditor.toString();
      }
      res.json(response);
    } catch (e) { res.status(401).json({ error: e.message || 'Shopify authentication failed.' }); }
  });
  app.use('/app/api', async (req, res, next) => {
    try { req.embedded = await embeddedIdentity(req); next(); }
    catch (e) { res.status(401).json({ error: e.message || 'Shopify authentication failed.' }); }
  });
  // Everything below needs the store to belong to the signed-in purchaser.
  async function ownShop(req, res) {
    const shop = req.embedded.identity.shop;
    const record = await store.getShop(shop);
    if (!record || record.status === 'disconnected' || record.ownerId !== req.embedded.id) {
      res.status(403).json({ error: 'This Shopify store is not connected to your lookOn account.' });
      return null;
    }
    return { shop, record };
  }

  // Product list with the category each product resolves to, and why.
  async function productRows(shop, record) {
    const disabled = new Set(Array.isArray(record.disabledProductHandles) ? record.disabledProductHandles : []);
    const rows = [];
    for (const p of await store.listProducts(shop)) {
      const cat = await resolveCategoryNoVision(p, record);
      rows.push({
        title: p.title, handle: p.handle, type: p.type || '', image: p.images?.[0] || null, variants: p.variants?.length || 0,
        category: cat.id, categoryBy: cat.by, override: record.productCategories?.[p.handle] || '', tryOnEnabled: !disabled.has(p.handle),
      });
    }
    return rows.sort((a, b) => a.title.localeCompare(b.title));
  }
  // Same order as resolveCategory, but never calls the vision service (listing a catalogue must not cost AI calls).
  function resolveCategoryNoVision(p, record) {
    const own = record.productCategories?.[p.handle];
    if (own === 'none') return { id: null, by: 'merchant' };
    if (own && CATEGORIES[own]) return { id: own, by: 'merchant' };
    const t = String(p.type || '').trim().toLowerCase();
    const mapped = t && record.typeMap?.[t];
    if (mapped === 'none') return { id: null, by: 'type-map' };
    if (mapped && CATEGORIES[mapped]) return { id: mapped, by: 'type-map' };
    const c = classify(p);
    if (c.id) return c;
    if (p.tryOnCategory && CATEGORIES[p.tryOnCategory]) return { id: p.tryOnCategory, by: 'catalog' };
    if (p.vision?.v === 1 && p.vision.category !== 'none') return { id: p.vision.category, by: 'photo' };
    if (record.widget?.tryUncategorized && genericAllowed(p)) return { id: 'generic', by: 'fallback' };
    return { id: null, by: 'none' };
  }

  // Products, one page at a time, with search and a filter (all / try-on on / not try-on).
  app.get('/app/api/products', async (req, res) => {
    const own = await ownShop(req, res); if (!own) return;
    let rows = await productRows(own.shop, own.record);
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) rows = rows.filter((p) => p.title.toLowerCase().includes(q) || p.type.toLowerCase().includes(q) || p.handle.includes(q));
    if (req.query.filter === 'tryable') rows = rows.filter((p) => p.category && p.tryOnEnabled);
    if (req.query.filter === 'off') rows = rows.filter((p) => !p.category || !p.tryOnEnabled);
    res.json(paginate(rows, req.query.page, req.query.pageSize || 20, 100));
  });

  app.patch('/app/api/products/:handle', async (req, res) => {
    try {
      const own = await ownShop(req, res); if (!own) return;
      const { shop, record } = own;
      const handle = normalizeHandle(req.params.handle);
      const { enabled, category } = req.body || {};
      if (!handle || (enabled !== undefined && typeof enabled !== 'boolean') || (category !== undefined && category !== '' && category !== 'none' && !CATEGORIES[category])) return res.status(400).json({ error: 'Provide a valid product handle, enabled value or category.' });
      const disabled = new Set(Array.isArray(record.disabledProductHandles) ? record.disabledProductHandles : []);
      if (enabled === true) disabled.delete(handle); else if (enabled === false) disabled.add(handle);
      const productCategories = { ...(record.productCategories || {}) };
      if (category !== undefined) { if (category) productCategories[handle] = category; else delete productCategories[handle]; }
      await store.putShop(shop, { ...record, disabledProductHandles: [...disabled], productCategories });
      await audit('purchaser_product_update', { shop, handle, enabled: !disabled.has(handle), category: productCategories[handle] || null }, req.embedded.id);
      res.json({ handle, enabled: !disabled.has(handle), override: productCategories[handle] || '' });
    } catch (e) { res.status(500).json({ error: e.message || 'Could not update the product.' }); }
  });
  // Map a whole product type (Shopify's "Product type") to a try-on category, e.g. "Jhumka" -> earrings.
  app.put('/app/api/type-map', async (req, res) => {
    const own = await ownShop(req, res); if (!own) return;
    const { shop, record } = own;
    const type = String(req.body?.type || '').trim().toLowerCase().slice(0, 120);
    const category = String(req.body?.category ?? '');
    if (!type || (category && category !== 'none' && !CATEGORIES[category])) return res.status(400).json({ error: 'Choose a product type and a valid category.' });
    const typeMap = { ...(record.typeMap || {}) };
    if (category) typeMap[type] = category; else delete typeMap[type];
    await store.putShop(shop, { ...record, typeMap });
    await audit('purchaser_type_map', { shop, type, category: category || null }, req.embedded.id);
    res.json({ typeMap });
  });
  app.put('/app/api/texts', async (req, res) => {
    try {
      const own = await ownShop(req, res); if (!own) return;
      const { shop, record } = own;
      const texts = cleanTexts(req.body?.texts);
      const { tryOnSettings: _old, ...rest } = record; // the older 7-field settings are folded into these texts
      await store.putShop(shop, { ...rest, widget: { ...(record.widget || {}), texts } });
      await audit('purchaser_texts_saved', { shop, changed: Object.keys(texts).length }, req.embedded.id);
      res.json({ texts: textsFor({ widget: { texts } }), changed: Object.keys(texts) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  // The 7-field "Try-On text" API (heading, subheading, photoHint, buttonLabel, selfieLabel, consentText, privacyText).
  // Kept so older admin screens keep working; it reads and writes the same texts as the Texts tab.
  const legacyView = (record) => {
    const custom = customTexts(record);
    return Object.fromEntries(Object.entries(LEGACY_KEYS).map(([old, key]) => [old, custom[key] || LEGACY_DEFAULTS[old]]));
  };
  app.get('/app/api/settings', async (req, res) => {
    const own = await ownShop(req, res); if (!own) return;
    res.json({ shop: own.shop, settings: legacyView(own.record) });
  });
  app.patch('/app/api/settings', async (req, res) => {
    try {
      const own = await ownShop(req, res); if (!own) return;
      const { shop, record } = own;
      const merged = customTexts(record);
      for (const [old, key] of Object.entries(LEGACY_KEYS)) {
        if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, old)) continue;
        const v = String(req.body[old] ?? '').trim();
        if (!v || v.length > 500) throw new TryOnError(`Invalid ${old} text. Use 1–500 characters.`, 400);
        if (v === LEGACY_DEFAULTS[old]) delete merged[key]; else merged[key] = v;
      }
      const texts = cleanTexts(merged);
      const { tryOnSettings: _old, ...rest } = record;
      await store.putShop(shop, { ...rest, widget: { ...(record.widget || {}), texts } });
      await audit('purchaser_tryon_settings_update', { shop }, req.embedded.id);
      res.json({ shop, settings: legacyView({ widget: { texts } }) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message || 'Could not save Try-On settings.' }); }
  });
  app.delete('/app/api/settings', async (req, res) => {
    const own = await ownShop(req, res); if (!own) return;
    const { shop, record } = own;
    const texts = { ...(record.widget?.texts || {}) };
    for (const key of Object.values(LEGACY_KEYS)) delete texts[key];
    const { tryOnSettings: _old, ...rest } = record;
    await store.putShop(shop, { ...rest, widget: { ...(record.widget || {}), texts } });
    await audit('purchaser_tryon_settings_reset', { shop }, req.embedded.id);
    res.json({ shop, settings: null });
  });

  app.patch('/app/api/widget', async (req, res) => {
    const own = await ownShop(req, res); if (!own) return;
    const { shop, record } = own;
    const widget = { ...(record.widget || {}) };
    if (req.body?.zeroCreditMode !== undefined) {
      if (!['message', 'hide'].includes(req.body.zeroCreditMode)) return res.status(400).json({ error: 'zeroCreditMode must be "message" or "hide".' });
      widget.zeroCreditMode = req.body.zeroCreditMode;
    }
    if (req.body?.tryUncategorized !== undefined) widget.tryUncategorized = Boolean(req.body.tryUncategorized);
    await store.putShop(shop, { ...record, widget });
    res.json({ zeroCreditMode: widget.zeroCreditMode || 'message', tryUncategorized: Boolean(widget.tryUncategorized) });
  });
  app.patch('/app/api/limits', async (req, res) => {
    try {
      const own = await ownShop(req, res); if (!own) return;
      const { shop, record } = own;
      const limits = cleanLimits(req.body || {}, record.widget?.limits);
      await store.putShop(shop, { ...record, widget: { ...(record.widget || {}), limits } });
      await audit('purchaser_limits_saved', { shop, ...limits }, req.embedded.id);
      res.json({ limits });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  // Every try-on attempt on this store, with filters: dates, product, result, shopper type, device and a search.
  const RANGE = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, '90d': 90 * 864e5 };
  function activityQuery(q) {
    const out = { ...q };
    if (RANGE[q.range]) out.from = Date.now() - RANGE[q.range];
    return out;
  }
  const eventRow = (e) => ({
    id: e.id, at: e.at, status: e.status, reason: e.reason || null, product: e.handle, productTitle: e.productTitle || e.handle, variant: e.variantTitle || null, category: e.category || null,
    shopper: e.customerId ? 'customer' : e.email ? 'email' : 'visitor', email: e.email || null, customerId: e.customerId || null, visitor: e.visitor ? e.visitor.slice(0, 8) : null,
    device: e.device?.type || null, browser: e.device?.browser || null, os: e.device?.os || null, country: e.country || null, credits: e.credits || 0, seconds: e.ms ? Math.round(e.ms / 100) / 10 : null,
  });
  app.get('/app/api/activity', async (req, res) => {
    const own = await ownShop(req, res); if (!own) return;
    const list = filterEvents(await store.listEvents(own.shop), activityQuery(req.query));
    const products = new Map();
    for (const e of await store.listEvents(own.shop)) if (!products.has(e.handle)) products.set(e.handle, e.productTitle || e.handle);
    const pg = paginate(list, req.query.page, req.query.pageSize || 20, 100);
    res.json({ summary: summarize(list), ...pg, items: pg.items.map(eventRow), products: [...products].map(([handle, title]) => ({ handle, title })).sort((a, b) => a.title.localeCompare(b.title)) });
  });
  app.get('/app/api/activity/shoppers', async (req, res) => {
    const own = await ownShop(req, res); if (!own) return;
    let rows = shopperRows(filterEvents(await store.listEvents(own.shop), activityQuery({ ...req.query, status: '', who: '' })), await store.listLeads(own.shop));
    if (req.query.who === 'email') rows = rows.filter((r) => r.email);
    if (req.query.who === 'customer') rows = rows.filter((r) => r.customerId);
    if (req.query.who === 'visitor') rows = rows.filter((r) => !r.email && !r.customerId);
    const pg = paginate(rows, req.query.page, req.query.pageSize || 20, 100);
    res.json({ ...pg, items: pg.items.map((r) => ({ ...r, visitor: r.visitor ? r.visitor.slice(0, 8) : null })) });
  });
  app.get('/app/api/activity/export', async (req, res) => {
    const own = await ownShop(req, res); if (!own) return;
    const when = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
    let csv, name;
    if (req.query.kind === 'shoppers') {
      const rows = shopperRows(filterEvents(await store.listEvents(own.shop), activityQuery({ ...req.query, status: '', who: '' })), await store.listLeads(own.shop));
      csv = toCsv(rows, [['email', 'Email'], ['customerId', 'Customer ID'], ['visitor', 'Visitor'], ['previews', 'Previews'], ['attempts', 'Attempts'], ['products', 'Products tried'], [(r) => (r.marketing ? 'yes' : 'no'), 'Agreed to emails'], ['country', 'Country'], ['device', 'Device'], [(r) => when(r.firstSeen), 'First seen (UTC)'], [(r) => when(r.lastSeen), 'Last seen (UTC)']]);
      name = 'lookon-shoppers.csv';
    } else {
      const rows = filterEvents(await store.listEvents(own.shop), activityQuery(req.query)).map(eventRow);
      csv = toCsv(rows, [[(r) => when(r.at), 'Time (UTC)'], ['status', 'Result'], ['reason', 'Reason'], ['productTitle', 'Product'], ['variant', 'Variant'], ['category', 'Worn on'], ['shopper', 'Shopper type'], ['email', 'Email'], ['customerId', 'Customer ID'], ['visitor', 'Visitor'], ['device', 'Device'], ['browser', 'Browser'], ['os', 'OS'], ['country', 'Country'], ['credits', 'Credits'], ['seconds', 'Seconds']]);
      name = 'lookon-try-ons.csv';
    }
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}"`).send('\ufeff' + csv);
  });

  app.post('/app/api/catalog/sync', async (req, res) => {
    try {
      const own = await ownShop(req, res); if (!own) return;
      const products = await syncShop(own.shop);
      await audit('purchaser_catalog_sync', { shop: own.shop, products }, req.embedded.id);
      res.json({ shop: own.shop, products, syncedAt: Date.now() });
    } catch (e) { res.status(e.status || 502).json({ error: e.message || 'Could not refresh the Shopify catalog.' }); }
  });
  app.get('/app/api/overview', async (req, res) => {
    const own = await ownShop(req, res); if (!own) return;
    const settings = await getSettings();
    const record = await ensureCredits(own.shop, own.record, settings);
    const products = await productRows(own.shop, record);
    const types = new Map();
    for (const p of products) { const t = p.type.trim().toLowerCase(); if (t) types.set(t, (types.get(t) || 0) + 1); }
    res.json({
      shop: own.shop,
      user: req.embedded.user.name || req.embedded.user.email,
      syncedAt: record.syncedAt || null,
      productCount: products.length, tryableCount: products.filter((p) => p.category && p.tryOnEnabled).length,
      credits: creditSummary(settings, record),
      categories: categoryChoices(),
      typeMap: record.typeMap || {},
      productTypes: [...types.keys()].sort(),
      productTypeCounts: Object.fromEntries(types),
      texts: textsFor(record), textDefaults: DEFAULT_TEXTS, textGroups: TEXT_GROUPS.map((g) => ({ id: g.id, label: g.label, keys: Object.keys(g.keys) })),
      widget: { zeroCreditMode: record.widget?.zeroCreditMode || 'message', tryUncategorized: Boolean(record.widget?.tryUncategorized), limits: limitsFor(record) },
    });
  });
  const panelLoginFailures = new Map();
  app.get('/panel', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(panelPath); });
  app.post('/panel/api/login', async (req, res) => {
    const now = Date.now(), ip = req.ip || req.socket.remoteAddress || 'unknown';
    const recent = (panelLoginFailures.get(ip) || []).filter((at) => now - at < 15 * 60_000);
    if (recent.length >= 10) return res.status(429).json({ error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
    const email = normalizeEmail(req.body?.email), password = String(req.body?.password || '');
    let user = null;
    if (SUPER_PASSWORD_HASH && email === SUPER_EMAIL && verifyPassword(password, SUPER_PASSWORD_HASH)) {
      user = { id: SUPER_ID };
    } else {
      const found = (await store.listUsers()).find((u) => normalizeEmail(u.email) === email);
      if (found?.active && verifyPassword(password, found.passwordHash)) user = found;
    }
    if (!user) { recent.push(now); panelLoginFailures.set(ip, recent); return res.status(401).json({ error: 'Email or password is incorrect, or this account is inactive.' }); }
    panelLoginFailures.delete(ip);
    try { setPlatformCookie(res, req, makeSession(user.id, env)); return res.json({ ok: true }); }
    catch { return res.status(503).json({ error: 'Platform login is not configured. Set PLATFORM_SESSION_SECRET.' }); }
  });
  app.post('/panel/api/logout', (_req, res) => { setPlatformCookie(res, _req, ''); res.json({ ok: true }); });
  app.use('/panel/api', async (req, res, next) => {
    if (req.get('Origin') && APP_URL && new URL(APP_URL).origin !== req.get('Origin')) return res.sendStatus(403);
    req.platformUser = await platformUser(req);
    if (!req.platformUser) return res.status(401).json({ error: 'Please sign in again.' });
    next();
  });
  const superAdminOnly = (req, res, next) => req.platformUser.role === 'superadmin' ? next() : res.sendStatus(403);
  app.get('/panel/api/me', (req, res) => {
    const { id, email, name, role } = req.platformUser;
    res.json({ id, email, name, role });
  });
  // Stores, one page at a time. Stats cover every store; only the shown page is checked against Shopify.
  app.get('/panel/api/overview', async (req, res) => {
    const sa = req.platformUser.role === 'superadmin';
    const users = sa ? await store.listUsers() : [];
    const names = new Map(users.map((u) => [u.id, u.name || u.email]));
    const settings = await getSettings();
    const rows = [];
    for (const shop of await store.listShops()) {
      const record = await store.getShop(shop);
      if (!sa && record?.ownerId !== req.platformUser.id) continue;
      rows.push({ shop, record, status: record?.status || (record?.token ? 'installed' : 'unknown'), credits: creditSummary(settings, record) });
    }
    const stats = {
      stores: rows.length,
      active: rows.filter((r) => r.status === 'installed').length,
      outOfCredit: rows.filter((r) => r.status === 'installed' && isBilled(r.record) && r.credits.empty).length,
      lowCredit: rows.filter((r) => r.status === 'installed' && isBilled(r.record) && r.credits.low && !r.credits.empty).length,
      creditsHeld: Math.round(rows.reduce((t, r) => t + r.credits.credits, 0)),
      testStores: rows.filter((r) => modeFor(settings, r.record) === 'test').length,
    };
    const q = String(req.query.q || '').trim().toLowerCase();
    const filter = String(req.query.filter || '');
    let list = rows.filter((r) => !q || r.shop.includes(q) || String(names.get(r.record?.ownerId) || '').toLowerCase().includes(q));
    if (filter === 'active') list = list.filter((r) => r.status === 'installed');
    if (filter === 'disconnected') list = list.filter((r) => r.status !== 'installed');
    if (filter === 'empty') list = list.filter((r) => r.status === 'installed' && isBilled(r.record) && r.credits.empty);
    if (filter === 'low') list = list.filter((r) => r.status === 'installed' && isBilled(r.record) && r.credits.low);
    if (filter === 'test') list = list.filter((r) => modeFor(settings, r.record) === 'test');
    list.sort((a, b) => (b.record?.installedAt || 0) - (a.record?.installedAt || 0) || a.shop.localeCompare(b.shop));
    const pg = paginate(list, req.query.page, req.query.pageSize || 10, 50);
    const items = [];
    for (const r of pg.items) {
      const record = await reconcileShopConnection(r.shop, r.record);
      const pricing = pricingFor(settings, record);
      items.push({
        shop: r.shop, ownerId: record?.ownerId || '', owner: names.get(record?.ownerId) || (record?.ownerId ? 'Account unavailable' : 'Unassigned'),
        status: record?.status || (record?.token ? 'installed' : 'unknown'), installedAt: record?.installedAt || null, uninstalledAt: record?.uninstalledAt || null, lastTryOnAt: record?.lastTryOnAt || null,
        products: Number.isFinite(record?.productCount) ? record.productCount : (await store.listProducts(r.shop)).length,
        billed: isBilled(record), credits: creditSummary(settings, record),
        pricing: { bonusPct: pricing.bonusPct, custom: pricing.custom },
        billingChannel: record?.billingChannel || '', billingMode: record?.billingMode || '', mode: modeFor(settings, record),
      });
    }
    res.json({ ...pg, items, stats, currency: settings.currency, mode: settings.mode, engine: sa ? engine?.id || null : undefined });
  });
  app.get('/panel/api/audit', superAdminOnly, async (req, res) => {
    const pg = paginate(await store.listAudit(2000), req.query.page, req.query.pageSize || 25);
    res.json({ ...pg, events: pg.items });
  });
  app.delete('/panel/api/shops/:shop', superAdminOnly, async (req, res) => {
    const shop = normalizeShop(req.params.shop);
    if (!shop) return res.status(400).json({ error: 'Invalid shop.' });
    const record = await store.getShop(shop);
    if (!record) return res.sendStatus(404);
    if (record.status !== 'disconnected') return res.status(409).json({ error: 'Disconnect the Shopify app before permanently removing this store.' });
    await store.purgeShop(shop);
    await audit('store_purged', { shop }, req.platformUser.id);
    res.json({ ok: true, shop });
  });
  app.post('/panel/api/shops/:shop/disconnect', superAdminOnly, async (req, res) => {
    const shop = normalizeShop(req.params.shop);
    if (!shop) return res.status(400).json({ error: 'Invalid shop.' });
    const record = await store.getShop(shop);
    if (!record) return res.sendStatus(404);
    await store.disconnectShop(shop, { disconnectedReason: 'super_admin_marked_disconnected' });
    await audit('store_disconnected', { shop }, req.platformUser.id);
    res.json({ ok: true, shop, status: 'disconnected' });
  });
  app.get('/panel/api/admins', superAdminOnly, async (_req, res) => {
    const admins = await store.listUsers();
    const rows = admins.map((u) => ({ id: u.id, name: u.name, email: u.email, active: Boolean(u.active), shops: 0 }));
    for (const shop of await store.listShops()) { const rec = await store.getShop(shop); const row = rows.find((x) => x.id === rec?.ownerId); if (row) row.shops++; }
    res.json({ admins: rows });
  });
  app.post('/panel/api/admins', superAdminOnly, async (req, res) => {
    const name = String(req.body?.name || '').trim(), email = normalizeEmail(req.body?.email), password = String(req.body?.password || '');
    if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid name and email.' });
    if (password.length < 12 || password.length > 256) return res.status(400).json({ error: 'Use a temporary password between 12 and 256 characters.' });
    if (email === SUPER_EMAIL || (await store.listUsers()).some((u) => normalizeEmail(u.email) === email)) return res.status(409).json({ error: 'An account with that email already exists.' });
    const id = crypto.randomUUID();
    const user = { id, name, email, passwordHash: hashPassword(password), active: true, createdAt: Date.now() };
    await store.putUser(id, user);
    await audit('purchaser_created', { userId: id, email }, req.platformUser.id);
    res.status(201).json({ id, email, name, active: true });
  });
  app.patch('/panel/api/admins/:id', superAdminOnly, async (req, res) => {
    const user = await store.getUser(req.params.id);
    if (!user) return res.sendStatus(404);
    if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'active must be true or false.' });
    user.active = req.body.active;
    await store.putUser(user.id, user);
    await audit(user.active ? 'purchaser_reactivated' : 'purchaser_suspended', { userId: user.id }, req.platformUser.id);
    res.json({ id: user.id, active: user.active });
  });
  app.delete('/panel/api/admins/:id', superAdminOnly, async (req, res) => {
    const user = await store.getUser(req.params.id);
    if (!user) return res.sendStatus(404);
    for (const shop of await store.listShops()) {
      const record = await store.getShop(shop);
      if (record?.ownerId === user.id) { record.ownerId = null; await store.putShop(shop, record); }
    }
    await store.deleteUser(user.id);
    await audit('purchaser_deleted', { userId: user.id }, req.platformUser.id);
    res.json({ ok: true });
  });

  billing.registerRoutes(app);

  // ---------------- public API (called by the theme block) ----------------
  app.get('/api/config', (_req, res) => {
    res.json({ ready: Boolean(engine), maxPersonSide: engine?.maxPersonSide || 0, categories: categoryIds() });
  });

  app.get('/api/product', async (req, res) => {
    const shop = normalizeShop(req.query.shop);
    const handle = normalizeHandle(req.query.handle);
    if (!shop || !handle) return res.status(400).json({ error: 'Missing or invalid shop or product.' });
    if (!(await shopAllowed(shop))) return notInstalled(res, shop);
    try {
      const record = await store.getShop(shop);
      const disabled = new Set(Array.isArray(record?.disabledProductHandles) ? record.disabledProductHandles : []);
      const product = await loadProduct(shop, handle);
      const found = await resolveCategory(shop, product, String(req.query.category || ''), record);
      const cat = disabled.has(product.handle) ? { id: null, by: 'disabled' } : found;
      const { variant, exact, by } = pickVariant(product, req.query.variant);
      const texts = textsFor(record);
      const custom = customTexts(record);
      if (!custom.photoHint) texts.photoHint = cat.id ? CATEGORIES[cat.id].photoHint : '';
      // Out of credits: either show a message on the product page or hide the block, as the merchant chose.
      let outOfCredits = false;
      if (cat.id && isBilled(record)) {
        const settings = await getSettings();
        outOfCredits = creditSummary(settings, await ensureCredits(shop, record, settings)).empty;
      }
      const hide = outOfCredits && record?.widget?.zeroCreditMode === 'hide';
      // What this shopper may still do (free previews left, email/sign-in needed, per-product and daily limits).
      const shopperAccess = cat.id ? await access(store, shop, record, shopperFrom(req.query), product.handle) : null;
      res.set('Cache-Control', 'no-store'); // credits and limits change at any time: never serve a stale answer
      res.json({
        ready: Boolean(engine),
        maxPersonSide: engine?.maxPersonSide || 0,
        tryable: Boolean(cat.id) && Boolean(engine) && !outOfCredits,
        outOfCredits,
        texts,
        textsCustom: Object.keys(custom), // lines changed in the app; others keep the theme editor value
        access: shopperAccess,
        category: cat.id && !hide ? { id: cat.id, label: CATEGORIES[cat.id].label, by: cat.by } : null,
        photoHint: cat.id ? CATEGORIES[cat.id].photoHint : null,
        keepFace: cat.id ? CATEGORIES[cat.id].keepFace : false,
        needs: cat.id ? CATEGORIES[cat.id].needs : null,
        focus: cat.id ? CATEGORIES[cat.id].focus || null : null,
        title: product.title,
        variant: variant ? { id: variant.id, title: variant.title, ownImage: exact, imageBy: by } : null,
        reason: !cat.id ? 'This product is not something that can be tried on.' : !engine ? 'The try-on service is not set up yet.' : outOfCredits ? texts.outOfCredits : undefined,
      });
    } catch (e) {
      if (!(e instanceof TryOnError)) console.error(e);
      const status = e instanceof TryOnError ? e.status : 500;
      res.status(status).json({ error: shopperMessage(e), code: errorCode(status) });
    }
  });

  // A shopper gives their email to keep trying on. Saved for the merchant (Activity > Shoppers).
  app.post('/api/shopper', async (req, res) => {
    const shop = normalizeShop(req.body?.shop);
    if (!shop) return res.status(400).json({ error: 'A valid Shopify shop is required.' });
    if (!(await shopAllowed(shop))) return notInstalled(res, shop);
    const email = cleanEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: textsFor(await store.getShop(shop)).gateEmailInvalid, code: 'email' });
    const shopper = shopperFrom({ ...req.body, email });
    await store.putLead(shop, { email, visitor: shopper.visitor || null, marketing: Boolean(req.body?.marketing), source: 'tryon' });
    const record = await store.getShop(shop);
    res.json({ email, access: await access(store, shop, record, shopper, normalizeHandle(req.body?.handle)) });
  });

  // Older blocks fetch this separately; null means "not customised in the app, keep the theme editor values".
  app.get('/api/settings', async (req, res) => {
    const shop = normalizeShop(req.query.shop);
    if (!shop) return res.status(400).json({ error: 'A valid Shopify shop is required.' });
    if (!(await shopAllowed(shop))) return notInstalled(res, shop);
    const record = await store.getShop(shop);
    const custom = customTexts(record);
    res.json({ shop, settings: Object.values(LEGACY_KEYS).some((k) => custom[k]) ? legacyView(record) : null });
  });

  app.post('/api/tryon', async (req, res) => {
    const started = Date.now();
    const shopper = shopperFrom(req.body || {});
    const ev = { visitor: shopper.visitor || null, email: shopper.email || null, customerId: shopper.customerId || null, device: device(req.get('user-agent')), country: countryOf(req) };
    let logShop = null;
    try {
      if (!engine) throw new TryOnError('The try-on service is not set up yet.', 503);
      const { shop: rawShop, handle: rawHandle, variantId, image, consent, category: hint, focus: rawFocus } = req.body || {};
      const shop = normalizeShop(rawShop);
      const handle = normalizeHandle(rawHandle);
      if (!shop || !handle) throw new TryOnError('Missing or invalid shop or product.', 400);
      if (consent !== true) throw new TryOnError('Please confirm the photo is of you and you are 18 or over.', 400);
      if (!image || typeof image.data !== 'string' || !ALLOWED_MIME.has(image.mime)) throw new TryOnError('Upload a JPEG, PNG or WebP photo.', 400);
      if (!/^[A-Za-z0-9+/=]+$/.test(image.data)) throw new TryOnError('The photo data is not valid.', 400);
      if (Buffer.byteLength(image.data, 'base64') > MAX_IMAGE_BYTES) throw new TryOnError('That photo is too large. Please use one under 8 MB.', 413);
      const w = Number(image.width);
      const h = Number(image.height);
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 64 || h < 64 || Math.max(w, h) > engine.maxPersonSide) {
        throw new TryOnError(`Send a photo no larger than ${engine.maxPersonSide} px on its longest side, with its width and height.`, 400);
      }
      if (!(await shopAllowed(shop))) throw new TryOnError('This store has not installed the try-on app.', 403);

      logShop = shop; ev.handle = handle;
      let usageRecord = await store.getShop(shop);
      const disabledHandles = new Set(Array.isArray(usageRecord?.disabledProductHandles) ? usageRecord.disabledProductHandles : []);
      if (disabledHandles.has(handle)) throw new TryOnError('Try-on is disabled for this product by the store administrator.', 403);
      const billed = isBilled(usageRecord);
      const settings = billed ? await getSettings() : null;
      let rateMilli = 0;
      if (billed) {
        usageRecord = await ensureCredits(shop, usageRecord, settings);
        rateMilli = tryonCostMilli(settings);
        // Checked before any AI call, so an empty store never costs you anything.
        if ((usageRecord.credits?.balance || 0) < rateMilli) throw new TryOnError(textsFor(usageRecord).outOfCredits, 402);
      }

      const product = await loadProduct(shop, handle);
      const cat = await resolveCategory(shop, product, String(hint || ''), usageRecord);
      if (!cat.id) throw new TryOnError('This product is not something that can be tried on.', 422);
      const { variant, image: productImageUrl } = pickVariant(product, variantId);
      Object.assign(ev, { productTitle: product.title, variantId: variant?.id ? String(variant.id) : null, variantTitle: variant?.title && variant.title !== 'Default Title' ? variant.title : null, category: cat.id });
      if (!productImageUrl) throw new TryOnError('This product has no photo to try on.', 422);

      // The merchant's shopper rules, checked before any AI call.
      const acc = await access(store, shop, usageRecord, shopper, handle);
      const t = textsFor(usageRecord);
      if (acc.blocked === 'identify') throw Object.assign(new TryOnError(acc.gate === 'login' ? t.gateLoginIntro : acc.gate === 'email' ? t.gateEmailIntro : t.gateEitherIntro, 403), { code: 'identify', gate: acc.gate });
      if (acc.blocked === 'product') throw Object.assign(new TryOnError(t.limitProduct, 429), { code: 'limit' });
      if (acc.blocked === 'day') throw Object.assign(new TryOnError(t.limitDay, 429), { code: 'limit' });

      const limited = gate(req.ip, shop);
      if (limited) throw Object.assign(new TryOnError(limited, 429), { code: 'limit' }); // per-minute / daily limits: the message says which

      const fetched = await fetchProductImage({ fetch: f, url: productImageUrl, shop, maxSide: engine.productSide });
      const productImage = await prepareProduct(fetched, engine.productSide);
      // A close-up crop is only accepted for the area this category is meant for.
      const focus = FOCUS_AREAS.includes(rawFocus) && rawFocus === CATEGORIES[cat.id].focus ? rawFocus : null;
      const prompt = buildPrompt({ categoryId: cat.id, product, variant, optionNames: product.options, compact: engine.id === 'cloudflare', focus });
      const personIn = { mime: image.mime, data: image.data, width: w, height: h };
      let out = null;
      let tries = 0;
      let verdict = { ok: false };
      while (tries <= RETRIES) {
        tries += 1;
        out = await engine.generate({ env, fetch: f, prompt, person: personIn, product: productImage, signal: AbortSignal.timeout(90_000) });
        out = await fitAspect(out, w, h);
        verdict = await assess(out, personIn, cat.id);
        if (verdict.ok) break;
        console.warn(`[quality] ${shop}/${handle}: ${verdict.reason} result, try ${tries}`);
      }
      if (!verdict.ok) throw new TryOnError(`The preview did not come out right this time. ${CATEGORIES[cat.id].photoHint} Then try again.`, 422);
      out = await cleanOutput(out); // no maker / provenance metadata in the file the shopper gets
      Object.assign(ev, { status: 'success', tries, credits: billed ? rateMilli / 1000 : 0, ms: Date.now() - started, focus: focus || null });
      const label = `${product.title}${variant && variant.title && variant.title !== 'Default Title' ? ` (${variant.title})` : ''}`;
      if (billed) {
        // Charged only for a preview the shopper actually receives. Retries are your cost, not the merchant's.
        await store.adjustCredits(shop, -rateMilli, { type: 'tryon', handle, variant: variant?.id ? String(variant.id) : null, category: cat.id, tries, aiCost: imageCostMilli(settings) * tries, aiCostCc: toMilli(settings.aiCostPerImage) * tries });
        const latest = await store.getShop(shop);
        if (latest) await store.putShop(shop, { ...latest, lastTryOnAt: Date.now() });
      }
      store.addEvent(shop, ev).catch((err) => console.error('[activity]', err.message));
      res.json({ image: out, label, category: cat.id, tries, keepFace: CATEGORIES[cat.id].keepFace, focus });
    } catch (e) {
      if (!(e instanceof TryOnError)) console.error(e);
      const status = e instanceof TryOnError ? e.status : 500;
      const code = e.code || errorCode(status);
      // Every attempt on a real product is in the merchant's activity: blocked by a rule, or failed and why.
      if (logShop && ev.handle && status !== 400) {
        const blocked = ['identify', 'limit', 'no_credit'].includes(code) || status === 402;
        store.addEvent(logShop, { ...ev, status: blocked ? 'blocked' : 'failed', reason: code === 'error' && status === 402 ? 'no_credit' : status === 402 ? 'no_credit' : code, ms: Date.now() - started })
          .catch((err) => console.error('[activity]', err.message));
      }
      res.status(status).json({ error: shopperMessage(e), code, gate: e.gate });
    }
  });

  // ---------------- Shopify install ----------------
  app.get('/', (req, res) => {
    // Shopify opens the app URL with ?shop=...&hmac=... when a merchant installs or opens the app.
    const shop = normalizeShop(req.query.shop);
    if (HAS_APP && shop && verifyQueryHmac(req.query, API_SECRET)) return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);
    res.type('text/plain').send('Universal try-on service is running.');
  });

  app.get('/auth', async (req, res) => {
    if (!HAS_APP) return res.status(503).send('Shopify app credentials are not configured on this server.');
    const shop = normalizeShop(req.query.shop);
    if (!shop) return res.status(400).send('Invalid shop.');
    const user = await platformUser(req);
    if (SUPER_PASSWORD_HASH && user?.role !== 'admin') return res.status(401).send('Sign in to your purchaser account before connecting a Shopify store. <a href="/panel">Open the lookOn admin panel</a>.');
    const ownerId = user?.role === 'admin' ? user.id : '';
    const state = makeState(shop, API_SECRET, Date.now(), ownerId);
    res.setHeader('Set-Cookie', `tryon_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`);
    res.redirect(installUrl({ shop, apiKey: API_KEY, scopes: env.SCOPES || 'read_products', appUrl: APP_URL, state }));
  });

  app.get('/auth/callback', async (req, res) => {
    if (!HAS_APP) return res.status(503).send('Shopify app credentials are not configured on this server.');
    const shop = normalizeShop(req.query.shop);
    const cookie = /(?:^|;\s*)tryon_state=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (!shop || !req.query.code || !verifyQueryHmac(req.query, API_SECRET)) return res.status(400).send('Invalid request.');
    if (!cookie || cookie !== req.query.state || !checkState(req.query.state, shop, API_SECRET)) return res.status(400).send('The install session expired. Please start the install again.');
    try {
      const ownerId = stateOwner(req.query.state);
      const oldShop = await store.getShop(shop);
      if (ownerId) {
        const owner = await store.getUser(ownerId);
        if (!owner?.active) return res.status(403).send('This purchaser account is no longer active.');
        if (oldShop?.ownerId && oldShop.ownerId !== ownerId) return res.status(409).send('This Shopify store is already linked to another purchaser account.');
      }
      const { token, scope } = await exchangeCode({ fetch: f, shop, apiKey: API_KEY, secret: API_SECRET, code: String(req.query.code) });
      await store.putShop(shop, { ...(oldShop || {}), ...(ownerId ? { ownerId, platformManaged: true } : {}), status: 'installed', disconnectedAt: null, uninstalledAt: null, token: encryptToken(token, env), scope, installedAt: oldShop?.installedAt || Date.now() });
      syncShop(shop).catch((e) => console.error('[sync]', shop, e.message)); // fill the catalogue in the background
      res.setHeader('Set-Cookie', 'tryon_state=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0');
      // Open Shopify's theme editor with the lookOn app embed selected.
      // Shopify still requires the merchant to click Save once.
      const themeEditor = new URL(`https://${shop}/admin/themes/current/editor`);
      themeEditor.searchParams.set('context', 'apps');
      themeEditor.searchParams.set('activateAppId', `${API_KEY}/product-tryon`);
      themeEditor.searchParams.set('target', 'newAppsSection/app-embed');
      res.redirect(themeEditor.toString());
    } catch (e) {
      console.error('[auth]', e.message);
      res.status(502).send('Could not finish the install. Please try again.');
    }
  });

  // ---------------- admin (your own use; needs ADMIN_SECRET) ----------------
  const admin = (req, res, next) => {
    const secret = env.ADMIN_SECRET;
    const given = /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1] || '';
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(String(secret || '')).digest();
    if (!secret || !crypto.timingSafeEqual(a, b)) return res.sendStatus(secret ? 401 : 404);
    next();
  };
  app.post('/admin/sync', admin, async (req, res) => {
    const shop = normalizeShop(req.body?.shop);
    if (!shop) return res.status(400).json({ error: 'Invalid shop.' });
    try { res.json({ shop, products: await syncShop(shop) }); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.get('/admin/catalog', admin, async (req, res) => {
    const shop = normalizeShop(req.query.shop);
    if (!shop) return res.status(400).json({ error: 'Invalid shop.' });
    const list = (await store.listProducts(shop)).map((p) => ({ handle: p.handle, title: p.title, type: p.type, category: classify(p).id || p.tryOnCategory || (p.vision && p.vision.category !== 'none' ? p.vision.category : null), variants: p.variants.length, hasImage: p.images.length > 0 }));
    res.json({ shop, total: list.length, tryable: list.filter((p) => p.category).length, products: list });
  });

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That photo is too large. Please use one under 8 MB.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
}

// Serverless (Vercel) entry: build the app once, then reuse it.
let appPromise;
export default function handler(req, res) {
  appPromise ||= createApp();
  return appPromise.then((a) => a(req, res));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile?.(); } catch { /* no .env file */ }
  const PORT = Number(process.env.PORT || 3000);
  createApp().then((a) => a.listen(PORT, () => console.log(`Universal try-on running on port ${PORT}`)));
}
