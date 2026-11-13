// Credits, pricing rules, payments (Stripe, Razorpay, Shopify Billing), merchant texts and category mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, makeWorld, photo, hmacB64, SHOP } from './helpers.mjs';
import { quote, pricingFor, withDefaults, economics, stripeVerifyWebhook, razorpayVerifyPayment } from '../lib/billing.js';

const ENV = {
  TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok', RATE_PER_MINUTE: '50', DAILY_CAP_PER_SHOP: '100',
  SHOPIFY_API_KEY: 'key', SHOPIFY_API_SECRET: 'sec', APP_URL: 'https://lookon.example.com', OPEN_SHOPS: '0',
  SUPER_ADMIN_EMAIL: 'owner@lookon.test', SUPER_ADMIN_PASSWORD: 'a-very-long-password', PLATFORM_SESSION_SECRET: 'x'.repeat(40),
};

// Shopify App Bridge ID token (HS256 signed with the app secret).
function idToken(shop = SHOP) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b({ alg: 'HS256', typ: 'JWT' });
  const body = b({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: 'key', sub: '42', exp: now + 60, nbf: now - 5, iat: now, jti: crypto.randomUUID() });
  const sig = crypto.createHmac('sha256', 'sec').update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// The fake internet plus Stripe, Razorpay and Shopify's GraphQL billing API.
function world() {
  const w = makeWorld();
  const base = w.fetch;
  w.stripe = { sessions: {} };
  w.shopifyPurchases = {};
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'api.stripe.com') {
      w.calls.push({ url: String(url), init });
      if (init.method === 'POST') {
        const f = new URLSearchParams(init.body);
        const id = 'cs_test_' + crypto.randomBytes(4).toString('hex');
        w.stripe.sessions[id] = { id, url: 'https://checkout.stripe.com/c/pay/' + id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), metadata: { paymentId: f.get('metadata[paymentId]') }, client_reference_id: f.get('client_reference_id'), payment_status: 'unpaid', success_url: f.get('success_url') };
        return new Response(JSON.stringify(w.stripe.sessions[id]), { status: 200 });
      }
      const s = w.stripe.sessions[u.pathname.split('/').pop()];
      return new Response(JSON.stringify(s ? { ...s, payment_intent: 'pi_1' } : { error: { message: 'no' } }), { status: s ? 200 : 404 });
    }
    if (u.hostname === 'api.razorpay.com') {
      w.calls.push({ url: String(url), init });
      w.razorpayOrder = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'order_ABC', ...w.razorpayOrder }), { status: 200 });
    }
    if (u.pathname.endsWith('/graphql.json')) {
      const q = JSON.parse(init.body);
      if (/appPurchaseOneTimeCreate/.test(q.query)) {
        const id = 'gid://shopify/AppPurchaseOneTime/' + (Object.keys(w.shopifyPurchases).length + 1);
        w.shopifyPurchases[id] = { status: 'PENDING', price: q.variables.price, returnUrl: q.variables.returnUrl, test: q.variables.test };
        return new Response(JSON.stringify({ data: { appPurchaseOneTimeCreate: { appPurchaseOneTime: { id, status: 'PENDING' }, confirmationUrl: `https://${u.hostname}/admin/charges/confirm?id=${encodeURIComponent(id)}`, userErrors: [] } } }), { status: 200 });
      }
      const p = w.shopifyPurchases[q.variables.id];
      return new Response(JSON.stringify({ data: { node: p ? { id: q.variables.id, status: p.status, price: p.price } : null } }), { status: 200 });
    }
    return base(url, init);
  };
  return w;
}

async function setup(env = {}) {
  const t = await boot({ env: { ...ENV, ...env }, world: world() });
  t.app = (method, path, body) => t.call(method, path, body, { authorization: `Bearer ${idToken()}` });
  const login = await t.call('POST', '/panel/api/login', { email: ENV.SUPER_ADMIN_EMAIL, password: ENV.SUPER_ADMIN_PASSWORD });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  t.admin = (method, path, body) => t.call(method, path, body, { cookie });
  const s = await t.app('POST', '/app/api/session');
  assert.equal(s.status, 200, s.text);
  return t;
}
const tryon = (t, extra = {}) => t.call('POST', '/api/tryon', { shop: SHOP, handle: 'classic-wool-beanie', variantId: '1002', image: photo(), consent: true, ...extra });


const hidden = (r) => /margin|profit|aiCost|fxRate|costCurrency|tax|imageCost/i.test(r.text);
const live = (t, extra = {}) => t.admin('PUT', '/panel/api/billing/settings', { mode: 'live', ...extra });

test('maths: the screenshot logic — packs, 10 credits per image, cost in INR', () => {
  const s = withDefaults({});
  const p = pricingFor(s, null);
  assert.deepEqual(p.packs.map((x) => [x.price, x.credits]), [[10, 500], [20, 1000], [50, 2500], [100, 5000]]);
  const q = quote(p, { packId: 'p100' }, s);
  assert.deepEqual([q.price, q.credits, q.images], [100, 5000, 500]);
  const e = economics(s, 100, 5000);
  assert.deepEqual([e.revenue, e.cost, e.profit, Math.round(e.margin * 10) / 10, e.costCurrency], [9400, 5000, 4400, 46.8, 'INR']);
  assert.equal(economics(s, 10, 500).revenue, 940);
  assert.throws(() => quote(p, { amount: 100 }), /Choose one of the credit packs/);
  const amount = pricingFor({ ...s, creditModel: 'amount' }, null);
  assert.equal(quote(amount, { amount: 33.33 }, s).credits, 1666, '50 credits per $1, never rounds up');
  assert.throws(() => quote(amount, { amount: 5 }), /between 10 and 5000/);
  assert.equal(pricingFor({ ...s, minPurchaseCredits: 1000 }, null).packs.length, 3, 'packs below the minimum are hidden');
  assert.equal(pricingFor(s, { pricing: { bonusPct: 20 } }).packs[3].credits, 6000, 'per-store bonus');
  const old = withDefaults({ creditModel: 'share', merchantCreditPct: 50, pricePerTryon: 0.1, aiCostPerCall: 0.04 });
  assert.equal(old.creditModel, 'amount');
  assert.equal(old.creditsPerUnit, 50, 'older "share" settings keep the same credits per $1');
  assert.deepEqual([old.costCurrency, old.aiCostPerImage, old.fxRate], ['USD', 0.04, 1]);
});

test('a new store starts at 0 credits; it sees packs with images, and a test payment adds credits instantly', async () => {
  const t = await setup();
  const c = await t.app('GET', '/app/api/credits');
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.credits.credits, 0);
  assert.equal(c.json.credits.empty, true);
  assert.equal(c.json.credits.creditsPerTryon, 10);
  assert.equal(c.json.offers.kind, 'packs');
  assert.equal(c.json.offers.creditsPerImage, 10);
  assert.deepEqual(c.json.offers.packs.map((p) => [p.price, p.credits, p.images]), [[10, 500, 50], [20, 1000, 100], [50, 2500, 250], [100, 5000, 500]]);
  assert.deepEqual(c.json.gateways.map((g) => g.id), ['test']);
  assert.ok(!hidden(c), 'merchants never see your cost, profit or exchange rate');
  assert.equal((await tryon(t)).status, 402, 'no credit: no preview, no AI call');
  assert.equal(t.world.cf, undefined);
  const pay = await t.app('POST', '/app/api/credits/checkout', { packId: 'p20', gateway: 'test' });
  assert.equal(pay.status, 200, pay.text);
  assert.deepEqual([pay.json.paid, pay.json.credits, pay.json.images], [true, 1000, 100]);
  assert.equal((await tryon(t)).status, 200);
  const after = await t.app('GET', '/app/api/credits');
  assert.equal(after.json.credits.credits, 990, 'one image = 10 credits');
  assert.equal(after.json.credits.imagesLeft, 99);
  const hist = await t.app('GET', '/app/api/credits/history?page=1&pageSize=1');
  assert.equal(hist.json.total, 2);
  assert.deepEqual([hist.json.items[0].type, hist.json.items[0].credits], ['tryon', -10]);
  const pays = await t.app('GET', '/app/api/credits/payments');
  assert.equal(pays.json.items[0].credits, 1000);
  assert.ok(!hidden(pays) && !hidden(hist));
  await t.close();
});

test('super admin: credit logic, cost, exchange rate, minimum purchase, modes and keys are editable', async () => {
  const t = await setup();
  assert.equal((await t.call('GET', '/panel/api/billing/settings')).status, 401, 'needs sign-in');
  const g = await t.admin('GET', '/panel/api/billing/settings');
  assert.deepEqual(g.json.packages.map((x) => [x.price, x.revenue, x.cost, x.profit]), [[10, 940, 500, 440], [20, 1880, 1000, 880], [50, 4700, 2500, 2200], [100, 9400, 5000, 4400]]);
  assert.equal((await t.admin('PUT', '/panel/api/billing/settings', { creditsPerTryon: 0 })).status, 400);
  assert.equal((await t.admin('PUT', '/panel/api/billing/settings', { minPurchaseCredits: 99999 })).status, 400, 'no pack would be left');
  assert.equal((await live(t, { gateways: { stripe: { enabled: true, test: { secretKey: 'sk_test_1' } } } })).status, 400, 'live mode needs the live key');
  const r = await t.admin('PUT', '/panel/api/billing/settings', { aiCostPerImage: 8, fxRate: 90, minPurchaseCredits: 1000, gateways: { stripe: { enabled: true, test: { secretKey: 'sk_test_123', webhookSecret: 'whsec_1' }, live: { secretKey: 'sk_live_9' } } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.packages.find((x) => x.price === 100), { id: 'p100', name: null, price: 100, credits: 5000, images: 500, revenue: 9000, cost: 4000, profit: 5000, margin: 5000 / 9000 * 100, costCurrency: 'INR' });
  assert.equal(r.json.settings.gateways.stripe.test.secretKeySet, true);
  assert.ok(!/sk_test_123|sk_live_9|whsec_1/.test(r.text), 'secrets not echoed');
  assert.ok((await t.store.getSettings()).gateways.stripe.live.secretKey.startsWith('enc1:'), 'stored encrypted');
  const c = await t.app('GET', '/app/api/credits');
  assert.deepEqual(c.json.offers.packs.map((p) => p.credits), [1000, 2500, 5000], 'the $10 pack is under the minimum');
  assert.equal(c.json.offers.minPurchaseCredits, 1000);
  assert.deepEqual(c.json.gateways.map((x) => x.id), ['stripe', 'test']);
  // any amount at a rate
  const amt = await t.admin('PUT', '/panel/api/billing/settings', { creditModel: 'amount', creditsPerUnit: 40, quickAmounts: '25, 100' });
  assert.equal(amt.status, 200, amt.text);
  const o = (await t.app('GET', '/app/api/credits')).json.offers;
  assert.equal(o.kind, 'amount');
  assert.equal(o.minTopup, 25, 'smallest payment rises to meet the 1,000-credit minimum');
  assert.deepEqual(o.quickAmounts, [{ amount: 25, credits: 1000, images: 100 }, { amount: 100, credits: 4000, images: 400 }]);
  assert.equal((await t.app('POST', '/app/api/credits/checkout', { amount: 20, gateway: 'test' })).status, 400);
  const buy = await t.app('POST', '/app/api/credits/checkout', { amount: 30, gateway: 'test' });
  assert.equal(buy.json.credits, 1200);
  await t.close();
});

test('Stripe (live mode): the $100 pack gives 5,000 credits; credited once; report matches the screenshot', async () => {
  const t = await setup();
  await live(t, { gateways: { stripe: { enabled: true, live: { secretKey: 'sk_live_1', webhookSecret: 'whsec_9' } } } });
  assert.deepEqual((await t.app('GET', '/app/api/credits')).json.gateways.map((g) => g.id), ['stripe'], 'no test payments in live mode');
  const co = await t.app('POST', '/app/api/credits/checkout', { packId: 'p100', gateway: 'stripe' });
  assert.equal(co.status, 200, co.text);
  const session = Object.values(t.world.stripe.sessions)[0];
  assert.equal(session.amount_total, 10000);
  assert.ok(!/profit|margin|tax|cost/i.test(JSON.stringify(t.world.calls.at(-1).init.body)), 'the checkout line shows credits only');
  const event = { type: 'checkout.session.completed', data: { object: { ...session, payment_status: 'paid', payment_intent: 'pi_1' } } };
  const raw = Buffer.from(JSON.stringify(event));
  assert.equal((await t.call('POST', '/webhooks/stripe', raw, { 'stripe-signature': 't=1,v1=bad' })).status, 400);
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=${crypto.createHmac('sha256', 'whsec_9').update(`${ts}.${raw}`).digest('hex')}`;
  assert.equal((await t.call('POST', '/webhooks/stripe', raw, { 'stripe-signature': sig })).status, 200);
  assert.equal((await t.call('POST', '/webhooks/stripe', raw, { 'stripe-signature': sig })).status, 200, 'repeat delivery');
  session.payment_status = 'paid';
  const back = await t.call('GET', `/billing/stripe/return?payment=${co.json.paymentId}&session_id=${session.id}`);
  assert.equal(back.headers.get('location'), 'https://admin.shopify.com/store/cool-store/apps/key');
  assert.equal((await t.app('GET', '/app/api/credits')).json.credits.credits, 5000, 'credited once');
  assert.equal((await tryon(t)).status, 200);
  const rep = await t.admin('GET', '/panel/api/billing/report');
  const T = rep.json.totals;
  assert.deepEqual([T.revenue, T.revenueCc, T.creditsSold, T.images, T.imageCost, T.potentialProfit, T.margin], [100, 9400, 5000, 1, 10, 4400, 46.8]);
  assert.equal(T.profit, 9390, 'profit so far: one image made');
  assert.equal(rep.json.costCurrency, 'INR');
  await t.close();
});

test('Razorpay (test keys): hosted pay page, signature-checked confirmation, webhook does not double-credit', async () => {
  const t = await setup();
  await t.admin('PUT', '/panel/api/billing/settings', { currency: 'INR', costCurrency: 'INR', packs: [{ name: 'Starter', price: 1000, credits: 5000 }], gateways: { razorpay: { enabled: true, test: { keyId: 'rzp_test_1', keySecret: 'rzsecret', webhookSecret: 'rzhook' } } } });
  const co = await t.app('POST', '/app/api/credits/checkout', { packId: 'starter', gateway: 'razorpay' });
  assert.equal(co.status, 200, co.text);
  assert.equal(t.world.razorpayOrder.amount, 100000, '1000 INR in paise');
  const url = new URL(co.json.url);
  const page = await t.call('GET', url.pathname + url.search);
  assert.equal(page.status, 200);
  assert.match(page.text, /order_ABC/);
  assert.match(page.text, /TEST MODE/);
  assert.match(page.text, /5,000/);
  assert.ok(!/profit|margin|tax/i.test(page.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')));
  assert.equal((await t.call('GET', url.pathname + '?t=forged')).status, 404, 'payment link is signed');
  const tok = url.searchParams.get('t');
  const verify = (sig) => t.call('POST', `${url.pathname}/razorpay/verify`, { t: tok, razorpay_order_id: 'order_ABC', razorpay_payment_id: 'pay_1', razorpay_signature: sig });
  assert.equal((await verify('nope')).status, 400);
  const good = crypto.createHmac('sha256', 'rzsecret').update('order_ABC|pay_1').digest('hex');
  assert.ok(razorpayVerifyPayment({ orderId: 'order_ABC', paymentId: 'pay_1', signature: good, keySecret: 'rzsecret' }));
  assert.equal((await verify(good)).status, 200);
  const hook = Buffer.from(JSON.stringify({ event: 'order.paid', payload: { order: { entity: { id: 'order_ABC', notes: { paymentId: co.json.paymentId } } }, payment: { entity: { id: 'pay_1', order_id: 'order_ABC', notes: { paymentId: co.json.paymentId } } } } }));
  assert.equal((await t.call('POST', '/webhooks/razorpay', hook, { 'x-razorpay-signature': crypto.createHmac('sha256', 'rzhook').update(hook).digest('hex') })).status, 200);
  assert.equal((await t.app('GET', '/app/api/credits')).json.credits.credits, 5000);
  const rep = await t.admin('GET', '/panel/api/billing/report');
  assert.equal(rep.json.totals.revenue, 0, 'test payments are not revenue');
  assert.deepEqual(rep.json.test, { payments: 1, amount: 1000 });
  await t.close();
});

test('Shopify Billing: test charges in test mode, real ones for a live store; App Store mode allows only Shopify Billing', async () => {
  const t = await setup();
  await t.admin('PUT', '/panel/api/billing/settings', { appStoreMode: true, allowInstantTest: false, gateways: { shopify: { enabled: true }, stripe: { enabled: true, test: { secretKey: 'sk_1' } } } });
  assert.deepEqual((await t.app('GET', '/app/api/credits')).json.gateways.map((g) => g.id), ['shopify']);
  const co = await t.app('POST', '/app/api/credits/checkout', { packId: 'p50', gateway: 'shopify' });
  assert.equal(co.status, 200, co.text);
  const [gid, purchase] = Object.entries(t.world.shopifyPurchases)[0];
  assert.equal(purchase.price.amount, '50.00');
  assert.equal(purchase.test, true);
  await t.call('GET', `/billing/shopify/return?payment=${co.json.paymentId}`);
  assert.equal((await t.app('GET', '/app/api/credits')).json.credits.credits, 0, 'not approved yet');
  purchase.status = 'ACTIVE';
  const raw = Buffer.from(JSON.stringify({ app_purchase_one_time: { admin_graphql_api_id: gid, status: 'ACTIVE' } }));
  assert.equal((await t.call('POST', '/webhooks/shopify', raw, { 'x-shopify-hmac-sha256': hmacB64(raw, 'sec'), 'x-shopify-topic': 'app_purchases_one_time/update', 'x-shopify-shop-domain': SHOP })).status, 200);
  await t.call('GET', `/billing/shopify/return?payment=${co.json.paymentId}`);
  assert.equal((await t.app('GET', '/app/api/credits')).json.credits.credits, 2500, 'credited once');
  await t.admin('PATCH', `/panel/api/shops/${SHOP}/pricing`, { billingMode: 'live' });
  await t.app('POST', '/app/api/credits/checkout', { packId: 'p50', gateway: 'shopify' });
  assert.equal(Object.values(t.world.shopifyPurchases)[1].test, false, 'live store: real charge');
  await t.close();
});

test('super admin: per-store bonus and mode, manual credits, paginated stores, ledger and audit', async () => {
  const t = await setup();
  assert.equal((await t.admin('PATCH', `/panel/api/shops/${SHOP}/pricing`, { bonusPct: 20 })).status, 200);
  assert.equal((await t.app('GET', '/app/api/credits')).json.offers.packs[3].credits, 6000);
  const add = await t.admin('POST', `/panel/api/shops/${SHOP}/credits`, { credits: 200, note: 'Launch bonus' });
  assert.equal(add.status, 200, add.text);
  assert.equal(add.json.credits.credits, 200);
  assert.equal((await tryon(t)).status, 200);
  const l = await t.admin('GET', `/panel/api/shops/${SHOP}/ledger?pageSize=10`);
  assert.deepEqual(l.json.items.map((x) => [x.type, x.credits]), [['tryon', -10], ['adjustment', 200]]);
  for (let i = 0; i < 12; i++) await t.store.putShop(`extra-${String(i).padStart(2, '0')}.myshopify.com`, { status: 'installed', installedAt: 1000 + i });
  const p1 = await t.admin('GET', '/panel/api/overview?page=1&pageSize=5');
  assert.deepEqual([p1.json.total, p1.json.pages, p1.json.items.length, p1.json.items[0].shop], [13, 3, 5, SHOP]);
  assert.equal((await t.admin('GET', '/panel/api/overview?page=3&pageSize=5')).json.items.length, 3);
  assert.equal((await t.admin('GET', '/panel/api/overview?q=extra-07')).json.total, 1);
  assert.equal((await t.admin('GET', '/panel/api/audit?pageSize=2')).json.items.length, 2);
  await t.close();
});

test('merchant products are paginated and searchable', async () => {
  const t = await setup();
  const all = await t.app('GET', '/app/api/products?pageSize=2');
  assert.equal(all.json.total, 3);
  assert.equal(all.json.items.length, 2);
  assert.equal((await t.app('GET', '/app/api/products?page=2&pageSize=2')).json.items.length, 1);
  assert.equal((await t.app('GET', '/app/api/products?q=beanie')).json.items[0].handle, 'classic-wool-beanie');
  assert.ok((await t.app('GET', '/app/api/products?filter=off')).json.items.some((p) => p.handle === 'hair-oil'));
  await t.close();
});

test('balances from the earlier money-based version are converted to credits once', async () => {
  const t = await setup();
  await t.store.adjustCredits(SHOP, 2500, { type: 'adjustment' }); // 2.50 of money at 0.10 per try-on = 25 images
  const rec = await t.store.getShop(SHOP); delete rec.creditUnit; await t.store.putShop(SHOP, rec);
  assert.equal((await t.app('GET', '/app/api/credits')).json.credits.credits, 250, '25 images x 10 credits');
  assert.equal((await t.app('GET', '/app/api/credits')).json.credits.credits, 250, 'only once');
  await t.close();
});

// ---------------- shopper limits and activity ----------------
const who = (extra = {}) => ({ visitor: 'v-abc123', ...extra });
test('shopper limits: one free preview, then an email; at most 2 previews per product', async () => {
  const t = await setup();
  await t.admin('POST', `/panel/api/shops/${SHOP}/credits`, { credits: 1000 });
  const bad = await t.app('PATCH', '/app/api/limits', { gate: 'sometimes' });
  assert.equal(bad.status, 400);
  const l = await t.app('PATCH', '/app/api/limits', { gate: 'email', freeTryons: 1, perProduct: 2, askMarketing: true });
  assert.equal(l.status, 200, l.text);
  const info = async (q = '') => (await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie&visitor=v-abc123${q}`)).json.access;
  assert.deepEqual((await info()), { gate: 'email', askMarketing: true, used: 0, needsIdentity: false, freeLeft: 1, productLeft: 2, todayLeft: null, blocked: null });
  assert.equal((await tryon(t, who())).status, 200, 'the free one');
  const a1 = await info();
  assert.equal(a1.needsIdentity, true);
  const stop = await tryon(t, who());
  assert.equal(stop.status, 403);
  assert.equal(stop.json.code, 'identify');
  assert.equal(stop.json.gate, 'email');
  assert.match(stop.json.error, /email/i);
  assert.equal(t.world.calls.filter((c) => c.url.includes('cloudflare')).length, 1, 'no AI call for a blocked shopper');
  // the shopper gives their email
  assert.equal((await t.call('POST', '/api/shopper', { shop: SHOP, visitor: 'v-abc123', email: 'not-an-email' })).status, 400);
  const sub = await t.call('POST', '/api/shopper', { shop: SHOP, visitor: 'v-abc123', email: 'Ana@Example.com', marketing: true, handle: 'classic-wool-beanie' });
  assert.equal(sub.status, 200, sub.text);
  assert.equal(sub.json.email, 'ana@example.com');
  assert.equal(sub.json.access.needsIdentity, false);
  assert.equal((await tryon(t, who({ email: 'ana@example.com' }))).status, 200);
  const lim = await tryon(t, who({ email: 'ana@example.com' }));
  assert.equal(lim.status, 429, 'two per product');
  assert.equal(lim.json.code, 'limit');
  assert.match(lim.json.error, /limit for this product/);
  assert.equal((await info('&email=ana@example.com')).productLeft, 0);
  // a new browser with the same email is still the same shopper
  assert.equal((await tryon(t, { visitor: 'v-other', email: 'ana@example.com' })).status, 429);
  // sign-in gate
  await t.app('PATCH', '/app/api/limits', { gate: 'login', freeTryons: 0, perProduct: 0 });
  assert.equal((await tryon(t, { visitor: 'v-new' })).json.gate, 'login');
  assert.equal((await tryon(t, { visitor: 'v-new', customer: { id: '7001', email: 'cus@example.com' } })).status, 200, 'signed-in customer');
  await t.close();
});

test('activity: every attempt with product, shopper, device and result; filters, shoppers list and CSV', async () => {
  const t = await setup();
  await t.admin('POST', `/panel/api/shops/${SHOP}/credits`, { credits: 1000 });
  await t.app('PATCH', '/app/api/limits', { gate: 'email', freeTryons: 1 });
  const ua = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'x-vercel-ip-country': 'IN' };
  await t.call('POST', '/api/tryon', { shop: SHOP, handle: 'classic-wool-beanie', variantId: '1002', image: photo(), consent: true, visitor: 'v1' }, ua);
  await t.call('POST', '/api/tryon', { shop: SHOP, handle: 'classic-wool-beanie', variantId: '1002', image: photo(), consent: true, visitor: 'v1' }, ua);
  await t.call('POST', '/api/shopper', { shop: SHOP, visitor: 'v1', email: 'ana@example.com', marketing: true });
  await t.call('POST', '/api/tryon', { shop: SHOP, handle: 'kinky-straight', variantId: '2002', image: photo(), consent: true, visitor: 'v1', email: 'ana@example.com' });
  const all = await t.app('GET', '/app/api/activity?range=7d');
  assert.equal(all.status, 200, all.text);
  assert.equal(all.json.total, 3);
  assert.deepEqual(all.json.items.map((e) => e.status), ['success', 'blocked', 'success']);
  const first = all.json.items[2];
  assert.deepEqual([first.productTitle, first.variant, first.device, first.os, first.country, first.credits, first.shopper], ['Classic Wool Beanie', 'Blue / S', 'Mobile', 'iOS', 'IN', 10, 'visitor']);
  assert.equal(all.json.items[1].reason, 'identify');
  assert.deepEqual([all.json.summary.previews, all.json.summary.blocked, all.json.summary.emails, all.json.summary.credits], [2, 1, 1, 20]);
  assert.equal(all.json.summary.topProducts.length, 2);
  assert.equal((await t.app('GET', '/app/api/activity?status=blocked')).json.total, 1);
  assert.equal((await t.app('GET', '/app/api/activity?product=kinky-straight')).json.total, 1);
  assert.equal((await t.app('GET', '/app/api/activity?who=email')).json.total, 1);
  assert.equal((await t.app('GET', '/app/api/activity?device=Mobile')).json.total, 2);
  assert.equal((await t.app('GET', '/app/api/activity?q=ana@')).json.total, 1);
  assert.equal((await t.app('GET', '/app/api/activity?pageSize=1&page=2')).json.items.length, 1);
  const shoppers = await t.app('GET', '/app/api/activity/shoppers');
  assert.ok(shoppers.json.items.some((r) => r.email === 'ana@example.com' && r.marketing === true));
  const csv = await t.app('GET', '/app/api/activity/export?kind=tryons');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /Time \(UTC\),Result,Reason,Product/);
  assert.match(csv.text, /Classic Wool Beanie/);
  const csv2 = await t.app('GET', '/app/api/activity/export?kind=shoppers');
  assert.match(csv2.text, /ana@example.com/);
  assert.ok(!/data:image|base64/.test(JSON.stringify(await t.store.listEvents(SHOP))), 'no photos are stored');
  await t.close();
});

test('merchant: every storefront line is editable, and product types / single products can be mapped to a try-on type', async () => {
  const t = await setup();
  await t.admin('POST', `/panel/api/shops/${SHOP}/credits`, { credits: 100 });
  const saved = await t.app('PUT', '/app/api/texts', { texts: { heading: 'See it on you', chooseButton: 'Upload a selfie for {category}', unknownKey: 'x', subheading: '' } });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.changed, ['heading', 'chooseButton']);
  const p = await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`);
  assert.equal(p.json.texts.heading, 'See it on you');
  assert.equal(p.json.texts.subheading, 'Add a front-facing photo to see this on you.', 'blank = default');
  assert.equal((await t.app('PUT', '/app/api/texts', { texts: { heading: 'x'.repeat(500) } })).status, 400);

  // the hair oil is not wearable; the merchant can still map it, and can switch a hat off
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=hair-oil`)).json.tryable, false);
  assert.equal((await t.app('PATCH', '/app/api/products/hair-oil', { category: 'necklace' })).status, 200);
  const oil = await t.call('GET', `/api/product?shop=${SHOP}&handle=hair-oil`);
  assert.equal(oil.json.category.id, 'necklace');
  assert.equal(oil.json.category.by, 'merchant');
  await t.app('PATCH', '/app/api/products/classic-wool-beanie', { category: 'none' });
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`)).json.tryable, false);
  await t.app('PATCH', '/app/api/products/classic-wool-beanie', { category: '' });

  // map a product type
  assert.equal((await t.app('PUT', '/app/api/type-map', { type: 'Hats', category: 'headwear' })).status, 200);
  const hat = await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`);
  assert.equal(hat.json.category.id, 'headwear');
  assert.equal(hat.json.category.by, 'type-map');
  const ov = await t.app('GET', '/app/api/overview');
  assert.ok(ov.json.productTypes.includes('hats'));
  assert.equal((await t.app('GET', '/app/api/products?q=beanie')).json.items[0].category, 'headwear');
  assert.ok(ov.json.textGroups.length >= 4);

  // the general fallback is off by default and opt-in per store
  t.world.products['aurora-7'] = { id: 777, title: 'Aurora Piece No. 7', handle: 'aurora-7', type: '', tags: [], options: [], featured_image: 'https://cdn.shopify.com/s/files/a.jpg', images: ['https://cdn.shopify.com/s/files/a.jpg'], variants: [{ id: 7001, title: 'Default Title', options: ['Default Title'], available: true }] };
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=aurora-7`)).json.tryable, false);
  await t.app('PATCH', '/app/api/widget', { tryUncategorized: true });
  assert.equal((await t.call('GET', `/api/product?shop=${SHOP}&handle=aurora-7`)).json.category.id, 'generic');
  await t.close();
});

test('stripe webhook signature: timestamp tolerance', () => {
  const raw = Buffer.from('{}');
  const old = 1_000_000;
  const sig = `t=${old},v1=${crypto.createHmac('sha256', 's').update(`${old}.{}`).digest('hex')}`;
  assert.equal(stripeVerifyWebhook(raw, sig, 's', old * 1000), true);
  assert.equal(stripeVerifyWebhook(raw, sig, 's', (old + 3600) * 1000), false, 'replayed an hour later');
});

test('the older 7-field Try-On text API still works and shares the same texts', async () => {
  const t = await setup();
  const g = await t.app('GET', '/app/api/settings');
  assert.equal(g.status, 200, g.text);
  assert.equal(g.json.settings.buttonLabel, 'Choose photo');
  assert.equal((await t.call('GET', `/api/settings?shop=${SHOP}`)).json.settings, null, 'nothing customised: theme values stay');
  assert.equal((await t.app('PATCH', '/app/api/settings', { heading: '' })).status, 400);
  const p = await t.app('PATCH', '/app/api/settings', { buttonLabel: 'Upload a photo', consentText: 'OK to use my photo' });
  assert.equal(p.status, 200, p.text);
  const info = await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`);
  assert.equal(info.json.texts.chooseButton, 'Upload a photo');
  assert.deepEqual(info.json.textsCustom.sort(), ['chooseButton', 'consent']);
  assert.equal((await t.call('GET', `/api/settings?shop=${SHOP}`)).json.settings.consentText, 'OK to use my photo');
  const ov = await t.app('GET', '/app/api/overview');
  assert.equal(ov.json.texts.chooseButton, 'Upload a photo', 'the Texts tab shows the same values');
  assert.equal((await t.app('DELETE', '/app/api/settings')).status, 200);
  assert.deepEqual((await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`)).json.textsCustom, []);
  // a store saved with the older version keeps its wording
  await t.store.putShop(SHOP, { ...(await t.store.getShop(SHOP)), tryOnSettings: { heading: 'Old heading', buttonLabel: 'Choose photo' } });
  const old = await t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie`);
  assert.equal(old.json.texts.heading, 'Old heading');
  assert.deepEqual(old.json.textsCustom, ['heading']);
  await t.close();
});

test('installing gives no free credits, even with the old DEFAULT_TRYON_CREDITS variable still set', async () => {
  const t = await setup({ DEFAULT_TRYON_CREDITS: '100' });
  const c = await t.app('GET', '/app/api/credits');
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.credits.credits, 0);
  await t.close();
});
