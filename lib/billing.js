// Credits and payments.
//
// Unit: a store's balance is counted in CREDITS (kept as whole milli-credits, 1000 = 1 credit, so sums never drift).
// One successful image (try-on) uses `creditsPerTryon` credits (default 10). Merchants only ever see credits and images:
// "pay $100 -> 5,000 credits = 500 images". The super admin chooses how payments buy credits:
//   - packs:  fixed packs, e.g. $10 -> 500, $20 -> 1,000, $50 -> 2,500, $100 -> 5,000 credits (default)
//   - amount: any amount at a rate, e.g. 50 credits per $1
// Costs are tracked in a cost currency (e.g. INR) with an exchange rate, so profit reads like
// "customer pays ₹9,400 - image cost ₹5,000 = ₹4,400 (46.8%)".
// Money is kept in milli-units of the currency (1000 = 1.00).
import crypto from 'node:crypto';
import { encryptToken, decryptToken } from './shopifyAuth.js';
import { API_VERSION } from './products.js';

export const toMilli = (x) => Math.round(Number(x) * 1000);
export const fromMilli = (m) => Math.round(Number(m || 0)) / 1000;

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF']);
export const toMinor = (milli, currency) => (ZERO_DECIMAL.has(currency) ? Math.round(milli / 1000) : Math.round(milli / 10));

const keys = () => ({ test: {}, live: {} });
export const DEFAULT_PACKS = Object.freeze([
  { id: 'p10', price: 10, credits: 500 },
  { id: 'p20', price: 20, credits: 1000 },
  { id: 'p50', price: 50, credits: 2500, popular: true },
  { id: 'p100', price: 100, credits: 5000 },
]);
export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'test',                 // 'test': sandbox keys, test charges, instant test payments; 'live': real money
  currency: 'USD',              // what stores pay in
  creditModel: 'packs',         // 'packs' or 'amount'
  packs: DEFAULT_PACKS,
  creditsPerUnit: 50,           // amount model: credits for 1.00 of the currency
  creditsPerTryon: 10,          // credits used by one successful image
  minPurchaseCredits: 500,      // smallest purchase, in credits
  minTopup: 10,                 // amount model: smallest and largest payment
  maxTopup: 5000,
  quickAmounts: [10, 20, 50, 100],
  costCurrency: 'INR',          // currency your AI cost is paid in
  fxRate: 94,                   // 1 unit of `currency` = fxRate units of `costCurrency`
  aiCostPerImage: 10,           // in costCurrency, per AI call
  welcomeCredits: 0,            // free credits a newly installed store receives
  lowBalanceTryons: 20,         // warn the merchant below this many images
  allowInstantTest: true,       // test mode: offer "Test payment" that adds credits without any gateway
  appStoreMode: false,          // listed on the Shopify App Store: only Shopify Billing may be offered
  gateways: {
    shopify: { enabled: false },
    stripe: { enabled: false, ...keys() },
    razorpay: { enabled: false, ...keys() },
  },
});

const SECRET_FIELDS = { stripe: ['secretKey', 'webhookSecret'], razorpay: ['keySecret', 'webhookSecret'] };
const PLAIN_FIELDS = { stripe: [], razorpay: ['keyId'] };
const MODES = ['test', 'live'];

/** Stored settings merged over the defaults (secrets still encrypted). Older layouts are converted. */
export function withDefaults(stored = {}) {
  const g = stored.gateways || {};
  const gw = (name) => {
    const cur = g[name] || {};
    const out = { enabled: Boolean(cur.enabled), test: { ...(cur.test || {}) }, live: { ...(cur.live || {}) } };
    for (const f of [...SECRET_FIELDS[name], ...PLAIN_FIELDS[name]]) if (cur[f] && !out.live[f]) out.live[f] = cur[f];
    return out;
  };
  const legacyMode = g.shopify && g.shopify.test === false ? 'live' : undefined;
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(legacyMode ? { mode: legacyMode } : {}),
    ...stored,
    packs: Array.isArray(stored.packs) ? stored.packs : DEFAULT_PACKS.map((p) => ({ ...p })),
    gateways: { shopify: { enabled: Boolean(g.shopify?.enabled) }, stripe: gw('stripe'), razorpay: gw('razorpay') },
  };
  // Earlier "share of payment" settings become the equivalent rate: credits per 1.00.
  if (merged.creditModel === 'share') {
    const pct = Number(stored.merchantCreditPct ?? 50), value = Number(stored.pricePerTryon ?? 0.1);
    merged.creditModel = 'amount';
    merged.creditsPerUnit = value > 0 ? (pct / 100 / value) * merged.creditsPerTryon : merged.creditsPerUnit;
  }
  // Earlier "AI cost per call" in the payment currency.
  if (stored.aiCostPerImage === undefined && Number.isFinite(stored.aiCostPerCall)) { merged.costCurrency = merged.currency; merged.fxRate = 1; merged.aiCostPerImage = stored.aiCostPerCall; }
  if (merged.costCurrency === merged.currency) merged.fxRate = 1;
  for (const k of ['merchantCreditPct', 'pricePerTryon', 'aiCostPerCall']) delete merged[k];
  return merged;
}

/** Settings safe to show in the super admin panel: secrets replaced by "...Set" flags. */
export function publicSettings(s) {
  const out = JSON.parse(JSON.stringify(s));
  for (const [gw, fields] of Object.entries(SECRET_FIELDS)) for (const m of MODES) for (const f of fields) {
    out.gateways[gw][m][f + 'Set'] = Boolean(s.gateways[gw][m]?.[f]);
    delete out.gateways[gw][m][f];
  }
  return out;
}

const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };

/** Validate a settings update from the super admin. Secrets are only replaced when a new value is sent. Throws on bad input. */
export function applySettingsUpdate(current, body, env) {
  const next = withDefaults(JSON.parse(JSON.stringify(current)));
  const err = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (body.mode !== undefined) { if (!MODES.includes(body.mode)) err('Mode must be "test" or "live".'); next.mode = body.mode; }
  for (const k of ['currency', 'costCurrency']) if (body[k] !== undefined) { const c = String(body[k]).toUpperCase(); if (!/^[A-Z]{3}$/.test(c)) err('Use a 3-letter currency code such as USD or INR.'); next[k] = c; }
  if (body.creditModel !== undefined) { if (!['packs', 'amount'].includes(body.creditModel)) err('Choose credit packs or any amount.'); next.creditModel = body.creditModel; }
  const labels = { creditsPerUnit: 'Credits per 1.00', creditsPerTryon: 'Credits per image', minPurchaseCredits: 'Minimum purchase', aiCostPerImage: 'Cost per image', fxRate: 'Exchange rate', minTopup: 'Smallest payment', maxTopup: 'Largest payment', lowBalanceTryons: 'Low-balance warning', welcomeCredits: 'Welcome credits' };
  const fields = { creditsPerUnit: [0.001, 1e6], creditsPerTryon: [0.01, 1e6], minPurchaseCredits: [0, 1e9], aiCostPerImage: [0, 1e6], fxRate: [0.000001, 1e6], minTopup: [0.5, 1e6], maxTopup: [1, 1e7], lowBalanceTryons: [0, 1e6], welcomeCredits: [0, 1e9] };
  for (const [k, [min, max]] of Object.entries(fields)) if (body[k] !== undefined) { const v = num(body[k], min, max); if (v === null) err(`${labels[k]} must be between ${min} and ${max}.`); next[k] = v; }
  if (next.costCurrency === next.currency) next.fxRate = 1;
  if (next.minTopup > next.maxTopup) err('The smallest payment cannot be above the largest.');
  if (body.quickAmounts !== undefined) {
    const list = (Array.isArray(body.quickAmounts) ? body.quickAmounts : String(body.quickAmounts).split(',')).map((x) => Number(String(x).trim())).filter((x) => Number.isFinite(x) && x > 0);
    if (list.length > 8) err('Use at most 8 suggested amounts.');
    next.quickAmounts = list;
  }
  if (body.packs !== undefined) {
    if (!Array.isArray(body.packs) || body.packs.length > 8) err('Use between 1 and 8 credit packs.');
    const seen = new Set();
    next.packs = body.packs.map((p, i) => {
      const price = num(p.price, 0.5, 1e6), credits = num(p.credits, 1, 1e9);
      if (price === null || credits === null) err(`Pack ${i + 1}: enter a price and a number of credits.`);
      let id = String(p.id || p.name || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 30) || `pack${i + 1}`;
      while (seen.has(id)) id += 'x';
      seen.add(id);
      return { id, price, credits: Math.floor(credits), name: String(p.name || '').trim().slice(0, 40) || undefined, popular: Boolean(p.popular) };
    });
  }
  if (next.creditModel === 'packs' && !next.packs.some((p) => p.credits >= next.minPurchaseCredits)) err('At least one pack must meet the minimum purchase.');
  for (const k of ['appStoreMode', 'allowInstantTest']) if (body[k] !== undefined) next[k] = Boolean(body[k]);
  const g = body.gateways || {};
  if (g.shopify?.enabled !== undefined) next.gateways.shopify.enabled = Boolean(g.shopify.enabled);
  for (const name of ['stripe', 'razorpay']) {
    if (!g[name]) continue;
    if (g[name].enabled !== undefined) next.gateways[name].enabled = Boolean(g[name].enabled);
    for (const m of MODES) {
      const src = g[name][m]; if (!src) continue;
      for (const f of PLAIN_FIELDS[name]) if (typeof src[f] === 'string') next.gateways[name][m][f] = src[f].trim();
      for (const f of SECRET_FIELDS[name]) if (typeof src[f] === 'string' && src[f].trim()) next.gateways[name][m][f] = encryptToken(src[f].trim(), env);
    }
  }
  const m = next.mode;
  if (next.gateways.stripe.enabled && !next.gateways.stripe[m].secretKey) err(`Add the Stripe ${m} secret key before enabling Stripe in ${m} mode.`);
  if (next.gateways.razorpay.enabled && (!next.gateways.razorpay[m].keyId || !next.gateways.razorpay[m].keySecret)) err(`Add the Razorpay ${m} key ID and key secret before enabling Razorpay in ${m} mode.`);
  return next;
}

/** Test or live, for one store: the platform mode unless the super admin set one for this store. */
export const modeFor = (settings, shopRecord) => (MODES.includes(shopRecord?.billingMode) ? shopRecord.billingMode : settings.mode);
export const secret = (settings, gw, field, env, mode) => decryptToken(settings.gateways[gw][mode]?.[field], env) || '';
export const keyId = (settings, mode) => settings.gateways.razorpay[mode]?.keyId || '';

/** The pricing for one store: platform settings plus the store's bonus (extra % credits on every purchase). */
export function pricingFor(settings, shopRecord) {
  const bonus = Number.isFinite(shopRecord?.pricing?.bonusPct) ? shopRecord.pricing.bonusPct : 0;
  const boost = (c) => Math.floor(c * (1 + bonus / 100));
  return {
    currency: settings.currency,
    creditModel: settings.creditModel,
    bonusPct: bonus,
    creditsPerUnit: settings.creditsPerUnit * (1 + bonus / 100),
    creditsPerTryon: settings.creditsPerTryon,
    minPurchaseCredits: settings.minPurchaseCredits,
    minTopup: Math.max(settings.minTopup, settings.creditsPerUnit > 0 ? Math.ceil((settings.minPurchaseCredits / (settings.creditsPerUnit * (1 + bonus / 100))) * 100) / 100 : 0),
    maxTopup: settings.maxTopup,
    quickAmounts: settings.quickAmounts,
    packs: settings.packs.filter((p) => p.credits >= settings.minPurchaseCredits).map((p) => ({ ...p, credits: boost(p.credits) })),
    custom: bonus !== 0,
  };
}

/** Cost of one image in the payment currency (milli), from the cost currency and exchange rate. */
export const imageCostMilli = (settings) => Math.round(toMilli(settings.aiCostPerImage) / (settings.fxRate || 1));

/**
 * What a purchase gives: price and credits, plus (for your reports only) the estimated image cost and gross profit.
 * Pass { amount } in the amount model or { packId } in the packs model. Throws a 400 error when invalid.
 */
export function quote(pricing, { amount, packId }, settings) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  let price, credits, pack = null;
  if (pricing.creditModel === 'packs') {
    pack = pricing.packs.find((p) => p.id === packId);
    if (!pack) bad('Choose one of the credit packs.');
    price = pack.price; credits = pack.credits;
  } else {
    price = Number(amount);
    if (!Number.isFinite(price) || Math.round(price * 100) !== Math.round(price * 100 * 1000) / 1000 || price < pricing.minTopup || price > pricing.maxTopup) bad(`Enter an amount between ${pricing.minTopup} and ${pricing.maxTopup} ${pricing.currency}.`);
    credits = Math.floor(price * pricing.creditsPerUnit + 1e-9);
    if (credits < Math.max(1, pricing.minPurchaseCredits)) bad(`The smallest purchase is ${pricing.minPurchaseCredits} credits.`);
  }
  const amountMilli = toMilli(price);
  const images = pricing.creditsPerTryon > 0 ? Math.floor(credits / pricing.creditsPerTryon) : 0;
  const costMilli = settings ? images * imageCostMilli(settings) : 0;
  return { price, credits, images, packId: pack?.id || null, amountMilli, creditMilli: credits * 1000, marginMilli: amountMilli - costMilli };
}

/** Profit view of a purchase, in the cost currency: what the super admin's package table shows. */
export function economics(settings, price, credits) {
  const images = settings.creditsPerTryon > 0 ? Math.floor(credits / settings.creditsPerTryon) : 0;
  const revenue = price * settings.fxRate;
  const cost = images * settings.aiCostPerImage;
  const profit = revenue - cost;
  return { price, credits, images, revenue, cost, profit, margin: revenue > 0 ? (profit / revenue) * 100 : 0, costCurrency: settings.costCurrency };
}

/** Which ways to pay a store may use right now (depends on test/live mode). */
export function gatewaysFor(settings, shopRecord) {
  const g = settings.gateways;
  const mode = modeFor(settings, shopRecord);
  const channel = settings.appStoreMode ? 'shopify' : shopRecord?.billingChannel || '';
  const list = [];
  if (g.shopify.enabled && channel !== 'external') list.push('shopify');
  if (channel !== 'shopify') {
    if (g.stripe.enabled && g.stripe[mode].secretKey) list.push('stripe');
    if (g.razorpay.enabled && g.razorpay[mode].keyId && g.razorpay[mode].keySecret) list.push('razorpay');
  }
  if (mode === 'test' && settings.allowInstantTest) list.push('test');
  return list;
}

const usesPerTryon = (settings) => Math.max(1, Math.round(settings.creditsPerTryon * 1000));
export const tryonCostMilli = (settings) => usesPerTryon(settings);

/** Balance summary for one store, in credits. Old money-based balances are converted by ensureCredits. */
export function creditSummary(settings, shopRecord) {
  const c = shopRecord?.credits || { balance: 0, purchased: 0, spent: 0 };
  const per = usesPerTryon(settings);
  const tryonsLeft = Math.max(0, Math.floor(c.balance / per));
  return {
    credits: Math.floor(c.balance / 1000 * 100) / 100,
    imagesLeft: tryonsLeft,
    purchased: Math.floor(c.purchased / 10) / 100,
    used: Math.floor(c.spent / 10) / 100,
    creditsPerTryon: settings.creditsPerTryon,
    tryonsLeft,
    low: tryonsLeft < settings.lowBalanceTryons,
    empty: c.balance < per,
    mode: modeFor(settings, shopRecord),
  };
}

/** One page of a list. */
export function paginate(list, page, pageSize, max = 100) {
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), max);
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(Number(page) || 1, 1), pages);
  return { items: list.slice((p - 1) * size, p * size), page: p, pageSize: size, total, pages };
}

// ---------------- Stripe (Checkout Sessions over the REST API; no SDK needed) ----------------
export async function stripeCreateSession({ fetch: f, secretKey, amountMinor, currency, name, successUrl, cancelUrl, paymentId, shop }) {
  const body = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(amountMinor),
    'line_items[0][price_data][product_data][name]': name,
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: paymentId,
    'metadata[paymentId]': paymentId,
    'metadata[shop]': shop,
  });
  const r = await f('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw gatewayError('Stripe', r.status, j.error?.message);
  return { id: j.id, url: j.url };
}
export async function stripeGetSession({ fetch: f, secretKey, id }) {
  const r = await f(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${secretKey}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw gatewayError('Stripe', r.status, j.error?.message);
  return { paid: j.payment_status === 'paid', amountMinor: j.amount_total, currency: String(j.currency || '').toUpperCase(), paymentId: j.metadata?.paymentId || j.client_reference_id, ref: j.payment_intent || j.id };
}
/** Stripe-Signature: "t=<ts>,v1=<hex hmac of `${t}.${body}`>". */
export function stripeVerifyWebhook(raw, header, webhookSecret, now = Date.now(), toleranceSec = 300) {
  if (!header || !webhookSecret || !Buffer.isBuffer(raw)) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header).split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(`${t}.${raw.toString('utf8')}`).digest('hex');
  return sigs.some((s) => safeEqual(s, expected));
}

// ---------------- Razorpay (Orders API + Checkout) ----------------
export async function razorpayCreateOrder({ fetch: f, keyId, keySecret, amountMinor, currency, receipt, notes }) {
  const r = await f('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountMinor, currency, receipt: receipt.slice(0, 40), notes }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw gatewayError('Razorpay', r.status, j.error?.description);
  return { id: j.id };
}
/** Checkout returns razorpay_signature = hex HMAC-SHA256(`${order_id}|${payment_id}`, key_secret). */
export function razorpayVerifyPayment({ orderId, paymentId, signature, keySecret }) {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  return safeEqual(crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex'), signature);
}
export function razorpayVerifyWebhook(raw, header, webhookSecret) {
  if (!header || !webhookSecret || !Buffer.isBuffer(raw)) return false;
  return safeEqual(crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex'), header);
}

// ---------------- Shopify Billing (one-time app purchase) ----------------
async function shopifyGraphql({ fetch: f, shop, token, query, variables }) {
  const r = await f(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw gatewayError('Shopify Billing', r.status, Array.isArray(j.errors) ? j.errors.map((e) => e.message).join('; ') : j.errors);
  return j.data;
}
export async function shopifyCreatePurchase({ fetch: f, shop, token, name, amount, currency, returnUrl, test }) {
  const data = await shopifyGraphql({
    fetch: f, shop, token,
    query: `mutation Buy($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean) {
      appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
        appPurchaseOneTime { id status } confirmationUrl userErrors { field message }
      }
    }`,
    variables: { name, price: { amount: amount.toFixed(2), currencyCode: currency }, returnUrl, test: Boolean(test) },
  });
  const out = data?.appPurchaseOneTimeCreate;
  if (!out || out.userErrors?.length || !out.confirmationUrl) throw gatewayError('Shopify Billing', 422, out?.userErrors?.map((e) => e.message).join('; '));
  return { id: out.appPurchaseOneTime.id, url: out.confirmationUrl };
}
export async function shopifyGetPurchase({ fetch: f, shop, token, id }) {
  const data = await shopifyGraphql({ fetch: f, shop, token, query: 'query P($id: ID!) { node(id: $id) { ... on AppPurchaseOneTime { id status price { amount currencyCode } } } }', variables: { id } });
  const n = data?.node;
  return { status: n?.status || 'UNKNOWN', paid: n?.status === 'ACTIVE', amount: Number(n?.price?.amount), currency: n?.price?.currencyCode };
}

// ---------------- helpers ----------------
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function gatewayError(name, status, detail) {
  const e = new Error(`${name} could not start the payment${detail ? `: ${detail}` : ''}.`);
  e.status = 502; e.gatewayStatus = status;
  return e;
}

/** Signed, short-lived token for the hosted pay page (so the payment link cannot be guessed or reused later). */
export function payToken(paymentId, env, now = Date.now()) {
  const key = String(env.PLATFORM_SESSION_SECRET || env.SHOPIFY_API_SECRET || '');
  const body = Buffer.from(JSON.stringify({ p: paymentId, exp: now + 60 * 60_000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', key).update('pay.' + body).digest('base64url')}`;
}
export function readPayToken(token, env, now = Date.now()) {
  const key = String(env.PLATFORM_SESSION_SECRET || env.SHOPIFY_API_SECRET || '');
  const [body, sig] = String(token || '').split('.');
  if (!key || !body || !sig || !safeEqual(sig, crypto.createHmac('sha256', key).update('pay.' + body).digest('base64url'))) return null;
  try { const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return d.exp > now ? d.p : null; } catch { return null; }
}
