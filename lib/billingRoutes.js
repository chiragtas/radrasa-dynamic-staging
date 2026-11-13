// Credit purchases (Stripe, Razorpay, Shopify Billing, instant test payments) and the super admin billing endpoints.
// Merchants only see credits, images and the price they pay; your costs and profit stay in the super admin.
import crypto from 'node:crypto';
import express from 'express';
import { normalizeShop } from './shops.js';
import { decryptToken } from './shopifyAuth.js';
import {
  applySettingsUpdate, publicSettings, pricingFor, quote, economics, gatewaysFor, creditSummary, toMilli, fromMilli, toMinor, secret, keyId, modeFor, paginate,
  stripeCreateSession, stripeGetSession, stripeVerifyWebhook, razorpayCreateOrder, razorpayVerifyPayment, razorpayVerifyWebhook,
  shopifyCreatePurchase, shopifyGetPurchase, payToken, readPayToken,
} from './billing.js';

const GATEWAY_NAMES = { stripe: 'Card (Stripe)', razorpay: 'UPI / Card (Razorpay)', shopify: 'Shopify bill', test: 'Test payment' };
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const credits = (milli) => Math.round(Number(milli || 0) / 10) / 100;

export function createBilling({ store, env, fetch: f, audit, getSettings, ensureCredits, APP_URL, API_KEY }) {
  const superAdminOnly = (req, res, next) => (req.platformUser?.role === 'superadmin' ? next() : res.sendStatus(403));
  const adminAppUrl = (shop) => (API_KEY ? `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, '')}/apps/${API_KEY}` : `${APP_URL}/app`);
  const fail = (res, e, fallback) => res.status(e.status || 500).json({ error: e.message || fallback });

  /** Pending -> paid exactly once, then the credits are added. Safe to call from the return page and the webhook. */
  async function finalize(paymentId, patch = {}) {
    const p = await store.getPayment(paymentId);
    if (!p || p.status === 'paid') return p;
    const paid = await store.markPaymentPaid(paymentId, patch);
    if (!paid) return store.getPayment(paymentId);
    const rec = await store.getShop(paid.shop);
    if (rec) {
      await ensureCredits(paid.shop, rec, await getSettings());
      await store.adjustCredits(paid.shop, paid.creditMilli, { type: 'topup', paymentId: paid.id, gateway: paid.gateway, mode: paid.mode, amountPaid: paid.amountMilli, currency: paid.currency });
    }
    await audit('credits_purchased', { shop: paid.shop, paymentId: paid.id, gateway: paid.gateway, mode: paid.mode, amount: fromMilli(paid.amountMilli), credits: credits(paid.creditMilli) });
    return paid;
  }
  async function markFailed(paymentId, status, reason) {
    const p = await store.getPayment(paymentId);
    if (p?.status === 'pending') await store.putPayment({ ...p, status, failedReason: reason || null, closedAt: Date.now() });
  }
  // Webhooks arrive on one URL for both modes: accept a signature made with either mode's secret.
  const eitherSecret = (settings, gw, check) => ['test', 'live'].some((m) => { const s = secret(settings, gw, 'webhookSecret', env, m); return s && check(s); });

  // ---------------- webhooks (raw body; registered before the JSON parser) ----------------
  function registerWebhooks(app) {
    app.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
      const settings = await getSettings();
      if (!eitherSecret(settings, 'stripe', (s) => stripeVerifyWebhook(req.body, req.get('stripe-signature'), s))) return res.sendStatus(400);
      try {
        const event = JSON.parse(req.body.toString('utf8'));
        const session = event.data?.object || {};
        const id = session.metadata?.paymentId || session.client_reference_id;
        if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && session.payment_status === 'paid' && id) {
          const p = await store.getPayment(id);
          if (p && p.gateway === 'stripe' && Number(session.amount_total) === toMinor(p.amountMilli, p.currency)) await finalize(id, { gatewayRef: session.payment_intent || session.id });
        } else if ((event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') && id) {
          await markFailed(id, event.type.endsWith('expired') ? 'cancelled' : 'failed');
        }
        res.sendStatus(200);
      } catch (e) { console.error('[stripe-webhook]', e.message); res.sendStatus(500); }
    });

    app.post('/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
      const settings = await getSettings();
      if (!eitherSecret(settings, 'razorpay', (s) => razorpayVerifyWebhook(req.body, req.get('x-razorpay-signature'), s))) return res.sendStatus(400);
      try {
        const event = JSON.parse(req.body.toString('utf8'));
        const pay = event.payload?.payment?.entity || {};
        const order = event.payload?.order?.entity || {};
        const id = pay.notes?.paymentId || order.notes?.paymentId;
        const orderId = pay.order_id || order.id;
        if (id && (event.event === 'order.paid' || event.event === 'payment.captured')) {
          const p = await store.getPayment(id);
          if (p && p.gateway === 'razorpay' && p.gatewayOrderId === orderId) await finalize(id, { gatewayRef: pay.id || orderId });
        } else if (id && event.event === 'payment.failed') await markFailed(id, 'failed', pay.error_description);
        res.sendStatus(200);
      } catch (e) { console.error('[razorpay-webhook]', e.message); res.sendStatus(500); }
    });
  }

  /** Called from the Shopify webhook handler for app_purchases_one_time/update. */
  async function shopifyPurchaseUpdated(shop, body) {
    const purchase = body?.app_purchase_one_time || {};
    const gid = purchase.admin_graphql_api_id;
    if (!gid) return;
    const p = (await store.listPayments({ shop, limit: 2000 })).find((x) => x.gatewayRef === gid);
    if (!p) return;
    if (purchase.status === 'ACTIVE') await finalize(p.id);
    else if (['DECLINED', 'EXPIRED'].includes(purchase.status)) await markFailed(p.id, purchase.status === 'DECLINED' ? 'cancelled' : 'failed');
  }

  // ---------------- routes (after the JSON parser and the auth middlewares) ----------------
  function registerRoutes(app) {
    async function ownShop(req, res) {
      const shop = req.embedded.identity.shop;
      const record = await store.getShop(shop);
      if (!record || record.status === 'disconnected' || record.ownerId !== req.embedded.id) { res.status(403).json({ error: 'This Shopify store is not connected to your lookOn account.' }); return null; }
      return { shop, record };
    }
    // What the merchant may buy: price, credits and images. Never your cost or profit.
    function offers(pricing) {
      const per = pricing.creditsPerTryon;
      const images = (c) => (per > 0 ? Math.floor(c / per) : 0);
      const base = { currency: pricing.currency, creditsPerImage: per, minPurchaseCredits: pricing.minPurchaseCredits };
      if (pricing.creditModel === 'packs') return { ...base, kind: 'packs', packs: pricing.packs.map((p) => ({ id: p.id, name: p.name || null, price: p.price, credits: p.credits, images: images(p.credits), popular: Boolean(p.popular) })) };
      return {
        ...base, kind: 'amount', minTopup: pricing.minTopup, maxTopup: pricing.maxTopup, creditsPerUnit: pricing.creditsPerUnit,
        quickAmounts: pricing.quickAmounts.filter((a) => a >= pricing.minTopup && a <= pricing.maxTopup).map((a) => { const c = Math.floor(a * pricing.creditsPerUnit + 1e-9); return { amount: a, credits: c, images: images(c) }; }),
      };
    }

    // ----- merchant (inside Shopify admin) -----
    app.get('/app/api/credits', async (req, res) => {
      const own = await ownShop(req, res); if (!own) return;
      const settings = await getSettings();
      const record = await ensureCredits(own.shop, own.record, settings);
      res.json({
        credits: creditSummary(settings, record),
        offers: offers(pricingFor(settings, record)),
        gateways: gatewaysFor(settings, record).map((id) => ({ id, name: GATEWAY_NAMES[id] })),
        pending: (await store.listPayments({ shop: own.shop, limit: 20 })).filter((p) => p.status === 'pending' && Date.now() - p.createdAt < 15 * 60_000).length,
        // size of the last top-up, so the balance can be shown as "how much of it is left"
        lastTopup: credits((await store.listLedger(own.shop, 500)).find((l) => l.amount > 0 && ['topup', 'welcome', 'adjustment', 'migration'].includes(l.type))?.amount || 0),
      });
    });
    app.get('/app/api/credits/history', async (req, res) => {
      const own = await ownShop(req, res); if (!own) return;
      res.json(pageOf(await store.listLedger(own.shop, 2000), req.query, merchantLedgerRow));
    });
    app.get('/app/api/credits/payments', async (req, res) => {
      const own = await ownShop(req, res); if (!own) return;
      res.json(pageOf(await store.listPayments({ shop: own.shop, limit: 2000 }), req.query, merchantPaymentRow));
    });

    app.post('/app/api/credits/checkout', async (req, res) => {
      try {
        const own = await ownShop(req, res); if (!own) return;
        const { shop, record } = own;
        const settings = await getSettings();
        const pricing = pricingFor(settings, record);
        const gateway = String(req.body?.gateway || '');
        if (!gatewaysFor(settings, record).includes(gateway)) return res.status(400).json({ error: 'That payment method is not available. Choose another one.' });
        const q = quote(pricing, { amount: req.body?.amount, packId: req.body?.packId }, settings);
        const mode = modeFor(settings, record);
        const payment = {
          id: crypto.randomUUID(), shop, gateway, mode, currency: pricing.currency, status: 'pending', createdAt: Date.now(), createdBy: req.embedded.id,
          amountMilli: q.amountMilli, creditMilli: q.creditMilli, marginMilli: q.marginMilli, packId: q.packId,
          pricing: { creditModel: pricing.creditModel, bonusPct: pricing.bonusPct, creditsPerTryon: pricing.creditsPerTryon, fxRate: settings.fxRate, costCurrency: settings.costCurrency },
        };
        const name = `lookOn credits: ${q.credits.toLocaleString('en-US')}`;
        let url = null;
        if (gateway === 'test') {
          await store.putPayment({ ...payment, gatewayRef: 'test_' + payment.id.slice(0, 8) });
          await finalize(payment.id);
          await audit('credits_checkout_started', { shop, paymentId: payment.id, gateway, mode, amount: q.price }, req.embedded.id);
          return res.json({ paymentId: payment.id, paid: true, credits: q.credits, images: q.images });
        }
        if (gateway === 'stripe') {
          const s = await stripeCreateSession({
            fetch: f, secretKey: secret(settings, 'stripe', 'secretKey', env, mode), amountMinor: toMinor(q.amountMilli, pricing.currency), currency: pricing.currency, name,
            successUrl: `${APP_URL}/billing/stripe/return?payment=${payment.id}&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${APP_URL}/billing/cancel?payment=${payment.id}`, paymentId: payment.id, shop,
          });
          payment.gatewaySessionId = s.id; url = s.url;
        } else if (gateway === 'razorpay') {
          const o = await razorpayCreateOrder({ fetch: f, keyId: keyId(settings, mode), keySecret: secret(settings, 'razorpay', 'keySecret', env, mode), amountMinor: toMinor(q.amountMilli, pricing.currency), currency: pricing.currency, receipt: payment.id, notes: { paymentId: payment.id, shop } });
          payment.gatewayOrderId = o.id; url = `${APP_URL}/pay/${payment.id}?t=${encodeURIComponent(payToken(payment.id, env))}`;
        } else {
          const token = decryptToken(record.token, env);
          if (!token) return res.status(409).json({ error: 'Reopen the app from Shopify admin and try again.' });
          const p = await shopifyCreatePurchase({ fetch: f, shop, token, name, amount: q.price, currency: pricing.currency, returnUrl: `${APP_URL}/billing/shopify/return?payment=${payment.id}`, test: mode === 'test' });
          payment.gatewayRef = p.id; url = p.url;
        }
        await store.putPayment(payment);
        await audit('credits_checkout_started', { shop, paymentId: payment.id, gateway, mode, amount: q.price }, req.embedded.id);
        res.json({ paymentId: payment.id, url, credits: q.credits, images: q.images });
      } catch (e) { if (!e.status) console.error('[checkout]', e.message); fail(res, e, 'Could not start the payment.'); }
    });

    // ----- return pages: verify with the gateway, add credits, go back to the app in Shopify admin -----
    app.get('/billing/stripe/return', async (req, res) => {
      const p = await store.getPayment(String(req.query.payment || ''));
      if (!p || p.gateway !== 'stripe') return res.status(404).send('Payment not found.');
      try {
        const settings = await getSettings();
        const s = await stripeGetSession({ fetch: f, secretKey: secret(settings, 'stripe', 'secretKey', env, p.mode || 'live'), id: p.gatewaySessionId });
        if (s.paid && s.paymentId === p.id && s.amountMinor === toMinor(p.amountMilli, p.currency)) await finalize(p.id, { gatewayRef: s.ref });
      } catch (e) { console.error('[stripe-return]', e.message); } // the webhook will still add the credits
      res.redirect(adminAppUrl(p.shop));
    });
    app.get('/billing/shopify/return', async (req, res) => {
      const p = await store.getPayment(String(req.query.payment || ''));
      if (!p || p.gateway !== 'shopify') return res.status(404).send('Payment not found.');
      try {
        const rec = await store.getShop(p.shop);
        const r = await shopifyGetPurchase({ fetch: f, shop: p.shop, token: decryptToken(rec?.token, env), id: p.gatewayRef });
        if (r.paid) await finalize(p.id);
        else if (r.status === 'DECLINED') await markFailed(p.id, 'cancelled');
      } catch (e) { console.error('[shopify-billing-return]', e.message); }
      res.redirect(adminAppUrl(p.shop));
    });
    app.get('/billing/cancel', async (req, res) => {
      const p = await store.getPayment(String(req.query.payment || ''));
      if (!p) return res.status(404).send('Payment not found.');
      await markFailed(p.id, 'cancelled');
      res.redirect(adminAppUrl(p.shop));
    });

    // ----- hosted Razorpay page (Razorpay Checkout cannot run inside the Shopify admin frame reliably) -----
    app.get('/pay/:id', async (req, res) => {
      const p = await store.getPayment(req.params.id);
      if (!p || p.gateway !== 'razorpay' || readPayToken(req.query.t, env) !== p.id) return res.status(404).send('This payment link is not valid or has expired.');
      const back = adminAppUrl(p.shop);
      if (p.status !== 'pending') return res.redirect(back);
      const settings = await getSettings();
      const opts = { key: keyId(settings, p.mode || 'live'), amount: toMinor(p.amountMilli, p.currency), currency: p.currency, order_id: p.gatewayOrderId, name: 'lookOn', description: `${credits(p.creditMilli).toLocaleString('en-US')} credits`, notes: { paymentId: p.id } };
      const price = `${fromMilli(p.amountMilli).toFixed(2)} ${p.currency}`;
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>lookOn · Checkout</title>
<style>*{box-sizing:border-box}body{font:15px/1.5 Inter,system-ui,sans-serif;background:#f4f4f6;color:#16161d;margin:0;display:grid;place-items:center;min-height:100vh;padding:20px}.c{background:#fff;border-radius:18px;box-shadow:0 1px 2px #0000000d,0 12px 40px #0000000f;padding:32px;max-width:400px;width:100%;text-align:center}.logo{font-weight:800;font-size:18px;letter-spacing:-.02em}.logo span{color:#6b4eff}.big{font-size:40px;font-weight:800;letter-spacing:-.03em;margin:18px 0 0}.sub{color:#6a6a78}.price{display:flex;justify-content:space-between;background:#f6f6f9;border-radius:12px;padding:12px 14px;margin:20px 0 6px}button{width:100%;margin-top:14px;background:#16161d;color:#fff;border:0;border-radius:12px;padding:14px;font:inherit;font-weight:700;cursor:pointer}a{color:#6a6a78;font-size:14px}#m{min-height:22px;margin-top:12px;color:#6a6a78;font-size:14px}${p.mode === 'test' ? '.t{display:inline-block;background:#fff4d6;color:#7a5200;border-radius:99px;padding:2px 10px;font-size:12px;font-weight:700;margin-top:10px}' : '.t{display:none}'}</style></head>
<body><div class="c"><div class="logo">look<span>On</span></div><div class="t">TEST MODE</div><div class="big">${esc(credits(p.creditMilli).toLocaleString('en-US'))}</div><div class="sub">credits</div>
<div class="price"><span>Total</span><b>${esc(price)}</b></div>
<button id="pay">Continue to payment</button><div id="m"></div><p><a href="${esc(APP_URL)}/billing/cancel?payment=${esc(p.id)}">Cancel and go back</a></p></div>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>(function(){var o=${JSON.stringify(opts).replace(/</g, '\\u003c')},m=document.getElementById('m');
o.handler=function(r){m.textContent='Confirming your payment…';fetch(${JSON.stringify(`${APP_URL}/pay/${p.id}/razorpay/verify`)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:${JSON.stringify(String(req.query.t))},razorpay_order_id:r.razorpay_order_id,razorpay_payment_id:r.razorpay_payment_id,razorpay_signature:r.razorpay_signature})}).then(function(x){return x.json()}).then(function(j){if(j.redirect){m.textContent='Payment received. Taking you back…';location.href=j.redirect}else m.textContent=j.error||'We could not confirm the payment yet. If money was taken, your credits will appear shortly.'}).catch(function(){m.textContent='We could not confirm the payment yet. If money was taken, your credits will appear shortly.'})};
o.modal={ondismiss:function(){m.textContent='Payment window closed. You can try again.'}};
function open(){if(!window.Razorpay){m.textContent='The payment window could not load. Check your connection and try again.';return}new Razorpay(o).open()}
document.getElementById('pay').onclick=open;open()})();</script></body></html>`);
    });
    app.post('/pay/:id/razorpay/verify', async (req, res) => {
      const p = await store.getPayment(req.params.id);
      if (!p || p.gateway !== 'razorpay' || readPayToken(req.body?.t, env) !== p.id) return res.status(404).json({ error: 'This payment link is not valid or has expired.' });
      const settings = await getSettings();
      const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
      if (orderId !== p.gatewayOrderId || !razorpayVerifyPayment({ orderId, paymentId, signature, keySecret: secret(settings, 'razorpay', 'keySecret', env, p.mode || 'live') })) return res.status(400).json({ error: 'The payment could not be verified.' });
      await finalize(p.id, { gatewayRef: paymentId });
      res.json({ ok: true, redirect: adminAppUrl(p.shop) });
    });

    // ----- super admin -----
    const webhookUrls = () => ({ stripe: `${APP_URL}/webhooks/stripe`, razorpay: `${APP_URL}/webhooks/razorpay` });
    const packTable = (s) => (s.creditModel === 'packs' ? s.packs.map((p) => ({ id: p.id, name: p.name || null, ...economics(s, p.price, p.credits) })) : s.quickAmounts.map((a) => ({ id: String(a), ...economics(s, a, Math.floor(a * s.creditsPerUnit + 1e-9)) })));
    app.get('/panel/api/billing/settings', superAdminOnly, async (_req, res) => {
      const s = await getSettings();
      res.json({ settings: publicSettings(s), webhookUrls: webhookUrls(), packages: packTable(s) });
    });
    app.put('/panel/api/billing/settings', superAdminOnly, async (req, res) => {
      try {
        const next = applySettingsUpdate(await getSettings(), req.body || {}, env);
        await store.putSettings(next);
        res.locals.packages = packTable(next);
        await audit('billing_settings_changed', { mode: next.mode, creditModel: next.creditModel, creditsPerTryon: next.creditsPerTryon, minPurchaseCredits: next.minPurchaseCredits, currency: next.currency, appStoreMode: next.appStoreMode }, req.platformUser.id);
        res.json({ settings: publicSettings(next), webhookUrls: webhookUrls(), packages: res.locals.packages });
      } catch (e) { fail(res, e, 'Could not save the billing settings.'); }
    });
    app.patch('/panel/api/shops/:shop/pricing', superAdminOnly, async (req, res) => {
      const shop = normalizeShop(req.params.shop);
      const record = shop && (await store.getShop(shop));
      if (!record) return res.status(404).json({ error: 'That Shopify store is not connected.' });
      const pricing = { ...(record.pricing || {}) };
      const b = req.body || {};
      delete pricing.merchantCreditPct; delete pricing.pricePerTryon; // older per-store fields
      for (const [k, min, max, label] of [['bonusPct', -90, 500, 'Bonus']]) {
        if (b[k] === null || b[k] === '') delete pricing[k];
        else if (b[k] !== undefined) { const n = Number(b[k]); if (!Number.isFinite(n) || n < min || n > max) return res.status(400).json({ error: `${label} must be between ${min} and ${max}.` }); pricing[k] = n; }
      }
      let billingChannel = record.billingChannel || '';
      if (b.billingChannel !== undefined) { if (!['', 'shopify', 'external'].includes(b.billingChannel)) return res.status(400).json({ error: 'Choose a valid payment channel.' }); billingChannel = b.billingChannel; }
      let billingMode = record.billingMode || '';
      if (b.billingMode !== undefined) { if (!['', 'test', 'live'].includes(b.billingMode)) return res.status(400).json({ error: 'Mode must be platform default, test or live.' }); billingMode = b.billingMode; }
      await store.putShop(shop, { ...record, pricing, billingChannel, billingMode });
      await audit('store_pricing_changed', { shop, ...pricing, billingChannel, billingMode }, req.platformUser.id);
      res.json({ shop, pricing, billingChannel, billingMode });
    });
    app.post('/panel/api/shops/:shop/credits', superAdminOnly, async (req, res) => {
      const shop = normalizeShop(req.params.shop);
      let record = shop && (await store.getShop(shop));
      if (!record) return res.status(404).json({ error: 'That Shopify store is not connected.' });
      const amount = Number(req.body?.credits ?? req.body?.amount);
      const note = String(req.body?.note || '').slice(0, 200);
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e7) return res.status(400).json({ error: 'Enter a number of credits (negative to remove).' });
      const settings = await getSettings();
      record = await ensureCredits(shop, record, settings);
      await store.adjustCredits(shop, Math.round(amount * 1000), { type: 'adjustment', note, by: req.platformUser.id });
      await audit('credits_adjusted', { shop, credits: amount, note }, req.platformUser.id);
      res.json({ shop, credits: creditSummary(settings, await store.getShop(shop)) });
    });
    async function canSee(req, shop) {
      const record = shop && (await store.getShop(shop));
      return Boolean(record && (req.platformUser.role === 'superadmin' || record.ownerId === req.platformUser.id));
    }
    app.get('/panel/api/shops/:shop/ledger', async (req, res) => {
      const shop = normalizeShop(req.params.shop);
      if (!(await canSee(req, shop))) return res.sendStatus(404);
      res.json({ shop, ...pageOf(await store.listLedger(shop, 2000), req.query, adminLedgerRow) });
    });
    app.get('/panel/api/payments', async (req, res) => {
      const shop = req.query.shop ? normalizeShop(req.query.shop) : null;
      if (shop && !(await canSee(req, shop))) return res.sendStatus(404);
      if (!shop && req.platformUser.role !== 'superadmin') return res.sendStatus(403);
      let list = await store.listPayments({ shop, limit: 2000 });
      if (req.query.status) list = list.filter((p) => p.status === req.query.status);
      if (req.query.mode) list = list.filter((p) => (p.mode || 'live') === req.query.mode);
      res.json(pageOf(list, req.query, adminPaymentRow));
    });
    // Live payments only (test payments are listed apart). Money figures are in the cost currency, as in the package table:
    // revenue (converted at the exchange rate), image cost so far, gross profit and margin, and the same if every sold credit is used.
    app.get('/panel/api/billing/report', superAdminOnly, async (req, res) => {
      const settings = await getSettings();
      const fx = settings.fxRate || 1, per = settings.creditsPerTryon || 1;
      const rows = [];
      let testRevenue = 0, testPayments = 0;
      for (const shop of await store.listShops()) {
        const rec = await store.getShop(shop);
        const paid = (await store.listPayments({ shop, limit: 2000 })).filter((p) => p.status === 'paid');
        const live = paid.filter((p) => (p.mode || 'live') === 'live');
        for (const p of paid) if (p.mode === 'test') { testRevenue += p.amountMilli; testPayments += 1; }
        const tryons = (await store.listLedger(shop, 2000)).filter((l) => l.type === 'tryon');
        const revenue = fromMilli(live.reduce((t, p) => t + p.amountMilli, 0));
        const revenueCc = Math.round(live.reduce((t, p) => t + p.amountMilli * (p.pricing?.fxRate || fx), 0)) / 1000;
        const creditsSold = credits(live.reduce((t, p) => t + p.creditMilli, 0));
        const imageCost = Math.round(tryons.reduce((t, l) => t + (l.aiCostCc ?? (l.aiCost || 0) * fx), 0)) / 1000;
        const potentialCost = Math.floor(creditsSold / per) * settings.aiCostPerImage;
        rows.push({
          shop, revenue, revenueCc, creditsSold, images: tryons.length, aiCalls: tryons.reduce((t, l) => t + (l.tries || 1), 0), imageCost,
          profit: Math.round((revenueCc - imageCost) * 100) / 100,
          potentialProfit: Math.round((revenueCc - potentialCost) * 100) / 100,
          margin: revenueCc > 0 ? Math.round(((revenueCc - potentialCost) / revenueCc) * 1000) / 10 : null,
          balance: creditSummary(settings, rec).credits,
        });
      }
      rows.sort((a, b) => b.revenue - a.revenue || b.images - a.images);
      const sum = (k) => Math.round(rows.reduce((t, r) => t + r[k], 0) * 100) / 100;
      const totals = { revenue: sum('revenue'), revenueCc: sum('revenueCc'), creditsSold: sum('creditsSold'), images: sum('images'), aiCalls: sum('aiCalls'), imageCost: sum('imageCost'), profit: sum('profit'), potentialProfit: sum('potentialProfit') };
      totals.margin = totals.revenueCc > 0 ? Math.round((totals.potentialProfit / totals.revenueCc) * 1000) / 10 : null;
      res.json({ currency: settings.currency, costCurrency: settings.costCurrency, fxRate: fx, ...paginate(rows, req.query.page, req.query.pageSize), totals, test: { payments: testPayments, amount: fromMilli(testRevenue) } });
    });
  }

  return { registerWebhooks, registerRoutes, shopifyPurchaseUpdated, finalize };
}

function pageOf(list, query, map) {
  const pg = paginate(list, query.page, query.pageSize);
  return { ...pg, items: pg.items.map(map) };
}
// Rows from before credits were counted in credits carry money; they are shown without a credit figure.
const ledgerCredits = (l) => (l.at && l.type ? Math.round(Number(l.amount || 0) / 10) / 100 : 0);
function merchantLedgerRow(l) {
  return { id: l.id, at: l.at, type: l.type, credits: ledgerCredits(l), balance: Math.round(Number(l.balanceAfter || 0) / 10) / 100, product: l.handle || null, note: l.type === 'adjustment' ? l.note || null : null, mode: l.mode || null };
}
function merchantPaymentRow(p) {
  return { id: p.id, createdAt: p.createdAt, paidAt: p.paidAt || null, method: GATEWAY_NAMES[p.gateway] || p.gateway, status: p.status, price: fromMilli(p.amountMilli), currency: p.currency, credits: credits(p.creditMilli), mode: p.mode || 'live' };
}
function adminLedgerRow(l) {
  return { ...merchantLedgerRow(l), note: l.note || null, gateway: l.gateway || null, aiCost: l.aiCost ? fromMilli(l.aiCost) : null, tries: l.tries || null };
}
function adminPaymentRow(p) {
  return { id: p.id, shop: p.shop, gateway: p.gateway, method: GATEWAY_NAMES[p.gateway] || p.gateway, mode: p.mode || 'live', status: p.status, currency: p.currency, amount: fromMilli(p.amountMilli), credits: credits(p.creditMilli), estProfit: fromMilli(p.marginMilli), packId: p.packId || null, createdAt: p.createdAt, paidAt: p.paidAt || null, ref: p.gatewayRef || null };
}
