// Storage for installed shops and their synced products.
//  - no MONGODB_URI: a JSON file (DATA_FILE, default ./data/db.json). Fine for one server with a disk (Render, Railway, Fly, VPS).
//  - MONGODB_URI set: MongoDB (needed on Vercel/serverless, where local files are not kept).
// Both expose the same small interface, so the rest of the code does not care which one is used.
import fs from 'node:fs/promises';
import path from 'node:path';

export function createFileStore(file) {
  let db = null;
  let queue = Promise.resolve();
  const load = async () => {
    if (db) return db;
    try {
      db = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      db = { shops: {}, products: {}, users: {}, audit: [] };
    }
    db.settings ||= {};
    db.ledger ||= {};
    db.payments ||= {};
    db.events ||= {};
    db.leads ||= {};
    db.shops ||= {};
    db.products ||= {};
    db.users ||= {};
    db.audit ||= [];
    return db;
  };
  const persist = () => {
    if (!file) return Promise.resolve();
    queue = queue
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(db));
        await fs.rename(tmp, file);
      })
      .catch((e) => console.error('[store] could not write', e.message));
    return queue;
  };
  return {
    kind: file ? 'file' : 'memory',
    async getShop(shop) { return (await load()).shops[shop] || null; },
    // The credit balance is only ever changed through adjustCredits, so a stale copy of the record can never overwrite it.
    async putShop(shop, data) {
      // The balance (and its unit) change only through adjustCredits / ensureCredits: never overwrite them from a stale copy.
      const d = await load(); const old = d.shops[shop] || {};
      const next = old.credits ? { ...data, credits: old.credits } : { ...data };
      if (old.creditUnit && !next.creditUnit) next.creditUnit = old.creditUnit;
      d.shops[shop] = next; await persist();
    },
    async disconnectShop(shop, data = {}) {
      const d = await load();
      if (!d.shops[shop]) return;
      d.shops[shop] = { ...d.shops[shop], ...data, token: null, status: 'disconnected', uninstalledAt: Date.now() };
      await persist();
    },
    async purgeShop(shop) { const d = await load(); delete d.shops[shop]; delete d.products[shop]; await persist(); },
    async deleteShop(shop) { const d = await load(); delete d.shops[shop]; delete d.products[shop]; await persist(); },
    async listShops() { return Object.keys((await load()).shops); },
    async getUser(id) { return (await load()).users[id] || null; },
    async putUser(id, data) { (await load()).users[id] = data; await persist(); },
    async deleteUser(id) { delete (await load()).users[id]; await persist(); },
    async listUsers() { return Object.values((await load()).users); },
    async addAudit(entry) { const d = await load(); d.audit.push(entry); if (d.audit.length > 5000) d.audit.splice(0, d.audit.length - 5000); await persist(); },
    async listAudit(limit = 200) { return (await load()).audit.slice(-Math.min(Math.max(Number(limit) || 200, 1), 2000)).reverse(); },
    async getProduct(shop, handle) { return (await load()).products[shop]?.[handle] || null; },
    async putProducts(shop, list) {
      const d = await load();
      d.products[shop] ||= {};
      for (const p of list) d.products[shop][p.handle] = p;
      await persist();
    },
    async deleteProduct(shop, id) {
      const d = await load();
      const all = d.products[shop] || {};
      for (const h of Object.keys(all)) if (String(all[h].id) === String(id)) delete all[h];
      await persist();
    },
    async listProducts(shop) { return Object.values((await load()).products[shop] || {}); },

    // ---- platform settings (pricing rules, gateways) ----
    async getSettings() { return (await load()).settings || {}; },
    async putSettings(data) { (await load()).settings = data; await persist(); },

    // ---- credits: balance lives on the shop record, every change is a ledger row ----
    // delta is in milli-units (1000 = 1.00). With requireBalance, a debit only happens if the balance covers it.
    async adjustCredits(shop, delta, entry = {}, { requireBalance = false } = {}) {
      const d = await load();
      const rec = d.shops[shop];
      if (!rec) return null;
      const credits = rec.credits || { balance: 0, purchased: 0, spent: 0 };
      if (requireBalance && delta < 0 && credits.balance + delta < 0) return null;
      credits.balance += delta;
      if (entry.type === 'topup') credits.purchased += delta;
      if (entry.type === 'tryon') credits.spent += -delta;
      rec.credits = credits;
      const row = { id: entry.id || cryptoId(), shop, at: Date.now(), ...entry, amount: delta, balanceAfter: credits.balance };
      (d.ledger[shop] ||= []).push(row);
      if (d.ledger[shop].length > 20000) d.ledger[shop].splice(0, d.ledger[shop].length - 20000);
      await persist();
      return row;
    },
    async listLedger(shop, limit = 200) {
      const rows = (await load()).ledger[shop] || [];
      return rows.slice(-Math.min(Math.max(Number(limit) || 200, 1), 2000)).reverse();
    },

    // ---- payments ----
    async putPayment(p) { (await load()).payments[p.id] = p; await persist(); },
    async getPayment(id) { return (await load()).payments[id] || null; },
    async listPayments({ shop, limit = 200 } = {}) {
      const all = Object.values((await load()).payments).filter((p) => !shop || p.shop === shop).sort((a, b) => b.createdAt - a.createdAt);
      return all.slice(0, Math.min(Math.max(Number(limit) || 200, 1), 2000));
    },
    // Moves a payment from pending to paid exactly once. Returns the updated payment, or null if it was not pending.
    // ---- try-on activity (no photos) and emails shoppers gave ----
    async addEvent(shop, ev) {
      const d = await load();
      const list = (d.events[shop] ||= []);
      list.push({ id: ev.id || cryptoId(), shop, at: Date.now(), ...ev });
      if (list.length > EVENT_CAP) list.splice(0, list.length - EVENT_CAP);
      await persist();
    },
    async listEvents(shop, { since = 0, limit = EVENT_CAP } = {}) {
      return ((await load()).events[shop] || []).filter((e) => e.at >= since).sort((a, b) => b.at - a.at).slice(0, limit);
    },
    async putLead(shop, lead) {
      const d = await load();
      const map = (d.leads[shop] ||= {});
      map[lead.email] = { ...(map[lead.email] || { at: Date.now() }), ...lead, updatedAt: Date.now() };
      await persist();
    },
    async listLeads(shop) { return Object.values((await load()).leads[shop] || {}).sort((a, b) => b.at - a.at); },
    async markPaymentPaid(id, patch = {}) {
      const d = await load();
      const p = d.payments[id];
      if (!p || p.status !== 'pending') return null;
      Object.assign(p, patch, { status: 'paid', paidAt: Date.now() });
      await persist();
      return p;
    },
  };
}

const cryptoId = () => globalThis.crypto.randomUUID();
const EVENT_CAP = 50000;

export async function createMongoStore(uri) {
  let mongodb;
  try {
    mongodb = await import('mongodb');
  } catch {
    throw new Error('MONGODB_URI is set but the "mongodb" package is not installed. Run: npm install mongodb');
  }
  const client = new mongodb.MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'universal_tryon');
  const shops = db.collection('shops');
  const products = db.collection('products');
  const users = db.collection('users');
  const settings = db.collection('settings');
  const events = db.collection('events');
  const leads = db.collection('leads');
  await events.createIndex({ shop: 1, at: -1 });
  await leads.createIndex({ shop: 1, email: 1 }, { unique: true });
  const ledger = db.collection('ledger');
  const payments = db.collection('payments');
  await products.createIndex({ shop: 1, id: 1 });
  await ledger.createIndex({ shop: 1, at: -1 });
  await payments.createIndex({ shop: 1, createdAt: -1 });
  return {
    kind: 'mongo',
    async getShop(shop) { const d = await shops.findOne({ _id: shop }); return d ? d.data : null; },
    async putShop(shop, data) {
      // Never overwrite the balance from a stale copy: it is changed only by adjustCredits ($inc).
      const { credits: _ignored, ...rest } = data || {};
      const set = Object.fromEntries(Object.entries(rest).map(([k, v]) => [`data.${k}`, v]));
      const current = await shops.findOne({ _id: shop }, { projection: { 'data.credits': 1 } });
      const unset = {};
      if (current) for (const k of Object.keys((await shops.findOne({ _id: shop })).data || {})) if (k !== 'credits' && k !== 'creditUnit' && !(k in rest)) unset[`data.${k}`] = '';
      const update = { $set: set };
      if (Object.keys(unset).length) update.$unset = unset;
      if (data?.credits && !current?.data?.credits) update.$set['data.credits'] = data.credits;
      await shops.updateOne({ _id: shop }, update, { upsert: true });
    },
    async disconnectShop(shop, data = {}) {
      const current = await shops.findOne({ _id: shop });
      if (!current) return;
      await shops.replaceOne({ _id: shop }, { _id: shop, data: { ...current.data, ...data, token: null, status: 'disconnected', uninstalledAt: Date.now() } });
    },
    async purgeShop(shop) { await shops.deleteOne({ _id: shop }); await products.deleteMany({ shop }); },
    async deleteShop(shop) { await shops.deleteOne({ _id: shop }); await products.deleteMany({ shop }); },
    async listShops() { return (await shops.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id); },
    async getUser(id) { const d = await users.findOne({ _id: id }); return d ? d.data : null; },
    async putUser(id, data) { await users.replaceOne({ _id: id }, { _id: id, data }, { upsert: true }); },
    async deleteUser(id) { await users.deleteOne({ _id: id }); },
    async listUsers() { return (await users.find({}).toArray()).map((d) => d.data); },
    async addAudit(entry) { await db.collection('audit').insertOne(entry); },
    async listAudit(limit = 200) { return (await db.collection('audit').find({}).sort({ at: -1 }).limit(Math.min(Math.max(Number(limit) || 200, 1), 2000)).toArray()); },
    async getProduct(shop, handle) { const d = await products.findOne({ _id: `${shop}|${handle}` }); return d ? d.data : null; },
    async putProducts(shop, list) {
      if (!list.length) return;
      await products.bulkWrite(list.map((p) => ({
        replaceOne: { filter: { _id: `${shop}|${p.handle}` }, replacement: { _id: `${shop}|${p.handle}`, shop, id: String(p.id), data: p }, upsert: true },
      })));
    },
    async deleteProduct(shop, id) { await products.deleteMany({ shop, id: String(id) }); },
    async listProducts(shop) { return (await products.find({ shop }).toArray()).map((d) => d.data); },

    async getSettings() { const d = await settings.findOne({ _id: 'platform' }); return d ? d.data : {}; },
    async putSettings(data) { await settings.replaceOne({ _id: 'platform' }, { _id: 'platform', data }, { upsert: true }); },

    async adjustCredits(shop, delta, entry = {}, { requireBalance = false } = {}) {
      const filter = { _id: shop };
      if (requireBalance && delta < 0) filter['data.credits.balance'] = { $gte: -delta };
      const inc = { 'data.credits.balance': delta };
      if (entry.type === 'topup') inc['data.credits.purchased'] = delta;
      if (entry.type === 'tryon') inc['data.credits.spent'] = -delta;
      const updated = await shops.findOneAndUpdate(filter, { $inc: inc }, { returnDocument: 'after' });
      const doc = updated && (updated.value !== undefined ? updated.value : updated);
      if (!doc) return null;
      const row = { _id: entry.id || cryptoId(), shop, at: Date.now(), ...entry, amount: delta, balanceAfter: doc.data.credits.balance };
      row.id = row._id;
      await ledger.insertOne(row);
      return row;
    },
    async listLedger(shop, limit = 200) {
      return ledger.find({ shop }).sort({ at: -1 }).limit(Math.min(Math.max(Number(limit) || 200, 1), 2000)).toArray();
    },
    async putPayment(p) { await payments.replaceOne({ _id: p.id }, { ...p, _id: p.id }, { upsert: true }); },
    async getPayment(id) { return payments.findOne({ _id: id }); },
    async listPayments({ shop, limit = 200 } = {}) {
      return payments.find(shop ? { shop } : {}).sort({ createdAt: -1 }).limit(Math.min(Math.max(Number(limit) || 200, 1), 2000)).toArray();
    },
    async addEvent(shop, ev) { const id = ev.id || cryptoId(); await events.insertOne({ _id: id, id, shop, at: Date.now(), ...ev }); },
    async listEvents(shop, { since = 0, limit = EVENT_CAP } = {}) { return events.find({ shop, at: { $gte: since } }).sort({ at: -1 }).limit(limit).toArray(); },
    async putLead(shop, lead) { await leads.updateOne({ shop, email: lead.email }, { $set: { ...lead, shop, updatedAt: Date.now() }, $setOnInsert: { at: Date.now() } }, { upsert: true }); },
    async listLeads(shop) { return leads.find({ shop }).sort({ at: -1 }).toArray(); },
    async markPaymentPaid(id, patch = {}) {
      const r = await payments.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { ...patch, status: 'paid', paidAt: Date.now() } }, { returnDocument: 'after' });
      return (r && (r.value !== undefined ? r.value : r)) || null;
    },
  };
}

export async function createStore(env = process.env) {
  if (env.MONGODB_URI) return createMongoStore(env.MONGODB_URI);
  return createFileStore(env.DATA_FILE === 'memory' ? null : env.DATA_FILE || path.resolve('data/db.json'));
}
