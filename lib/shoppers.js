// Shoppers, their limits, and the try-on activity log the merchant sees.
//
// A shopper is recognised by up to three things the block sends: a random visitor id kept in their browser,
// the email they gave, and their Shopify customer id when signed in to the store. Usage is counted across all three,
// so clearing the browser does not reset the count once an email or account is attached.
// No photos are ever stored: an event is who, what product, when, and how it went.

export const DEFAULT_LIMITS = Object.freeze({
  gate: 'none',        // 'none' | 'email' | 'login' | 'either': what a shopper must give after the free try-ons
  freeTryons: 1,       // previews before the gate applies
  perProduct: 0,       // most previews per shopper for one product (0 = no limit)
  perDay: 0,           // most previews per shopper per day (0 = no limit)
  askMarketing: false, // show an "email me offers" box with the email field
});

export function limitsFor(record) {
  const l = { ...DEFAULT_LIMITS, ...(record?.widget?.limits || {}) };
  return l;
}

export function cleanLimits(body, current) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  const next = { ...DEFAULT_LIMITS, ...(current || {}) };
  if (body.gate !== undefined) { if (!['none', 'email', 'login', 'either'].includes(body.gate)) bad('Choose what shoppers must give: nothing, email, sign-in, or either.'); next.gate = body.gate; }
  for (const [k, max, label] of [['freeTryons', 1000, 'Free previews'], ['perProduct', 10000, 'Previews per product'], ['perDay', 10000, 'Previews per day']]) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 0 || n > max) bad(`${label} must be a whole number from 0 to ${max}.`);
    next[k] = n;
  }
  if (body.askMarketing !== undefined) next.askMarketing = Boolean(body.askMarketing);
  return next;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;
export const cleanEmail = (e) => { const v = String(e || '').trim().toLowerCase(); return EMAIL.test(v) && v.length <= 254 ? v : ''; };
const cleanId = (v, max = 64) => String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, max);

/** Who is asking, from what the block sends. The customer id comes from the theme (signed-in shoppers). */
export function shopperFrom(src = {}) {
  const customer = src.customer && typeof src.customer === 'object' ? src.customer : { id: src.customerId, email: src.customerEmail };
  const customerId = cleanId(customer.id, 24);
  const email = cleanEmail(src.email) || cleanEmail(customer.email);
  return { visitor: cleanId(src.visitor), email, customerId, identified: Boolean(email || customerId) };
}
export const shopperKey = (s) => (s.customerId ? `c:${s.customerId}` : s.email ? `e:${s.email}` : s.visitor ? `v:${s.visitor}` : '');

const dayStart = (now) => { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };

/** How much this shopper has used, and whether they may make another preview of this product. */
export async function access(store, shop, record, shopper, handle, now = Date.now()) {
  const limits = limitsFor(record);
  const all = await store.listEvents(shop, { since: 0, limit: 50000 });
  // Link every browser this shopper used with their email or account, so a new browser does not reset the count.
  const visitors = new Set(shopper.visitor ? [shopper.visitor] : []);
  for (const e of all) if (e.visitor && ((shopper.email && e.email === shopper.email) || (shopper.customerId && e.customerId === shopper.customerId))) visitors.add(e.visitor);
  if (shopper.email && store.listLeads) for (const l of await store.listLeads(shop)) if (l.email === shopper.email && l.visitor) visitors.add(l.visitor);
  const isMine = (e) => (e.visitor && visitors.has(e.visitor)) || (shopper.email && e.email === shopper.email) || (shopper.customerId && e.customerId === shopper.customerId);
  const mine = all.filter((e) => e.status === 'success' && isMine(e));
  const used = mine.length;
  const onProduct = handle ? mine.filter((e) => e.handle === handle).length : 0;
  const today = mine.filter((e) => e.at >= dayStart(now)).length;
  const needsIdentity = limits.gate !== 'none' && !shopper.identified && used >= limits.freeTryons;
  const productLeft = limits.perProduct ? Math.max(0, limits.perProduct - onProduct) : null;
  const todayLeft = limits.perDay ? Math.max(0, limits.perDay - today) : null;
  return {
    gate: limits.gate, askMarketing: limits.askMarketing, used, needsIdentity,
    freeLeft: limits.gate !== 'none' && !shopper.identified ? Math.max(0, limits.freeTryons - used) : null,
    productLeft, todayLeft,
    blocked: needsIdentity ? 'identify' : productLeft === 0 ? 'product' : todayLeft === 0 ? 'day' : null,
  };
}

/** Rough device and browser from the user agent, for the activity list. */
export function device(ua = '') {
  const s = String(ua);
  const type = /iPad|Tablet/i.test(s) ? 'Tablet' : /Mobi|Android|iPhone/i.test(s) ? 'Mobile' : s ? 'Desktop' : 'Unknown';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'Other';
  const os = /iPhone|iPad|iOS/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return { type, browser, os };
}
export const countryOf = (req) => String(req.get('x-vercel-ip-country') || req.get('cf-ipcountry') || req.get('x-country') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || null;

/** Apply the merchant's filters to the activity list. */
export function filterEvents(list, q = {}) {
  const from = Number(q.from) || 0, to = Number(q.to) || Infinity;
  const text = String(q.q || '').trim().toLowerCase();
  return list.filter((e) => e.at >= from && e.at <= to
    && (!q.status || e.status === q.status)
    && (!q.product || e.handle === q.product)
    && (!q.who || (q.who === 'email' ? e.email && !e.customerId : q.who === 'customer' ? e.customerId : !e.email && !e.customerId))
    && (!q.device || e.device?.type === q.device)
    && (!text || [e.email, e.productTitle, e.handle, e.customerId, e.visitor, e.country].some((v) => String(v || '').toLowerCase().includes(text))));
}

/** Totals for the filtered list: what the summary row shows. */
export function summarize(list) {
  const ok = list.filter((e) => e.status === 'success');
  const shoppers = new Set(list.map((e) => (e.customerId ? 'c' + e.customerId : e.email ? 'e' + e.email : 'v' + e.visitor)));
  const emails = new Set(list.map((e) => e.email).filter(Boolean));
  const byProduct = new Map();
  for (const e of ok) { const p = byProduct.get(e.handle) || { handle: e.handle, title: e.productTitle, previews: 0, shoppers: new Set() }; p.previews += 1; p.shoppers.add(e.visitor || e.email || e.customerId); byProduct.set(e.handle, p); }
  const devices = {};
  for (const e of list) devices[e.device?.type || 'Unknown'] = (devices[e.device?.type || 'Unknown'] || 0) + 1;
  return {
    attempts: list.length, previews: ok.length, failed: list.filter((e) => e.status === 'failed').length, blocked: list.filter((e) => e.status === 'blocked').length,
    shoppers: shoppers.size, emails: emails.size, credits: Math.round(ok.reduce((t, e) => t + (e.credits || 0), 0) * 100) / 100,
    topProducts: [...byProduct.values()].sort((a, b) => b.previews - a.previews).slice(0, 5).map((p) => ({ handle: p.handle, title: p.title, previews: p.previews, shoppers: p.shoppers.size })),
    devices,
  };
}

/** One row per shopper, newest activity first. */
export function shopperRows(events, leads = []) {
  const map = new Map();
  const keyOf = (e) => (e.customerId ? 'c:' + e.customerId : e.email ? 'e:' + e.email : 'v:' + e.visitor);
  for (const e of events) {
    const k = keyOf(e);
    const r = map.get(k) || { key: k, email: e.email || null, customerId: e.customerId || null, visitor: e.visitor || null, previews: 0, attempts: 0, products: new Set(), firstSeen: e.at, lastSeen: e.at, country: e.country || null, device: e.device?.type || null };
    r.attempts += 1; if (e.status === 'success') r.previews += 1;
    r.products.add(e.handle); r.firstSeen = Math.min(r.firstSeen, e.at); r.lastSeen = Math.max(r.lastSeen, e.at);
    if (!r.email && e.email) r.email = e.email;
    map.set(k, r);
  }
  for (const l of leads) {
    const k = 'e:' + l.email;
    if (!map.has(k) && ![...map.values()].some((r) => r.email === l.email)) map.set(k, { key: k, email: l.email, customerId: null, visitor: l.visitor || null, previews: 0, attempts: 0, products: new Set(), firstSeen: l.at, lastSeen: l.at, country: null, device: null });
  }
  const leadBy = new Map(leads.map((l) => [l.email, l]));
  return [...map.values()].map((r) => ({ ...r, products: r.products.size, marketing: Boolean(r.email && leadBy.get(r.email)?.marketing) })).sort((a, b) => b.lastSeen - a.lastSeen);
}

export function toCsv(rows, cols) {
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
  return [cols.map(([, h]) => cell(h)).join(','), ...rows.map((r) => cols.map(([k]) => cell(typeof k === 'function' ? k(r) : r[k])).join(','))].join('\n');
}
