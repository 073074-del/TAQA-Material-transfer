// storage.js — plain JSON-file data store, no external dependencies.
// Everything the app needs to know how to do with inventory/requests/admin
// sessions/push subscriptions lives here, independent of the HTTP layer,
// so it can be tested directly with `node` and no npm install.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.json');
const SEED_PATH = path.join(__dirname, '..', 'data', 'seed-inventory.json');

function emptyDb() {
  return {
    inventory: [],
    requests: [],
    pushSubscriptions: [],
    meta: { createdAt: new Date().toISOString() },
  };
}

let cache = null;

function ensureLoaded() {
  if (cache) return cache;
  if (fs.existsSync(DB_PATH)) {
    try {
      cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (err) {
      // Corrupt file — back it up rather than silently losing data.
      fs.copyFileSync(DB_PATH, DB_PATH + '.corrupt-' + Date.now());
      cache = emptyDb();
    }
  } else {
    cache = emptyDb();
    if (fs.existsSync(SEED_PATH)) {
      const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
      cache.inventory = seed.map((it) => ({ ...it }));
    }
    persist();
  }
  // Backfill fields for older records / partial seeds.
  cache.inventory.forEach((it) => {
    if (typeof it.qtyAvailable !== 'number') it.qtyAvailable = it.qtyReceived || 0;
    if (typeof it.qtyIssued !== 'number') it.qtyIssued = 0;
  });
  cache.pushSubscriptions = cache.pushSubscriptions || [];
  cache.requests = cache.requests || [];
  return cache;
}

function persist() {
  // Synchronous, atomic (write-then-rename) write. The store is small (a
  // few hundred KB at most for a crew this size) and requests are
  // human-paced, so a blocking write is the simplest way to guarantee that
  // by the time an API response goes out, the change is safely on disk —
  // no async race between "we said it saved" and a later crash/restart.
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

// ---------- inventory ----------

function listInventory() {
  ensureLoaded();
  return cache.inventory;
}

function getInventoryItem(id) {
  ensureLoaded();
  return cache.inventory.find((i) => i.id === id) || null;
}

function addInventoryItem(fields) {
  ensureLoaded();
  const item = {
    id: newId('item'),
    mrr: fields.mrr || '',
    tag: fields.tag || '',
    description: String(fields.description || '').trim(),
    discipline: fields.discipline || 'Other',
    qtyReceived: Number(fields.qtyReceived) || 0,
    qtyIssued: 0,
    qtyAvailable: Number(fields.qtyAvailable ?? fields.qtyReceived) || 0,
    storageLocation: fields.storageLocation || '',
    serial: fields.serial || '',
    receiptStatus: fields.receiptStatus || '',
    hasCerts: fields.hasCerts || '',
    notes: fields.notes || '',
    createdAt: new Date().toISOString(),
  };
  if (!item.description) throw new Error('description is required');
  cache.inventory.push(item);
  persist();
  return item;
}

const INVENTORY_EDITABLE_FIELDS = [
  'description',
  'discipline',
  'tag',
  'mrr',
  'qtyAvailable',
  'qtyReceived',
  'storageLocation',
  'serial',
  'receiptStatus',
  'hasCerts',
  'notes',
];

function updateInventoryItem(id, patch) {
  ensureLoaded();
  const item = cache.inventory.find((i) => i.id === id);
  if (!item) throw new Error('item not found');
  for (const key of INVENTORY_EDITABLE_FIELDS) {
    if (key in patch) {
      if (key === 'qtyAvailable' || key === 'qtyReceived') {
        const n = Number(patch[key]);
        if (!Number.isFinite(n) || n < 0) throw new Error(key + ' must be a non-negative number');
        item[key] = n;
      } else {
        item[key] = String(patch[key]);
      }
    }
  }
  item.updatedAt = new Date().toISOString();
  persist();
  return item;
}

function deleteInventoryItem(id) {
  ensureLoaded();
  const before = cache.inventory.length;
  cache.inventory = cache.inventory.filter((i) => i.id !== id);
  persist();
  return cache.inventory.length < before;
}

// ---------- requests ----------

function listRequests(status) {
  ensureLoaded();
  let out = cache.requests.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (status) out = out.filter((r) => r.status === status);
  return out;
}

function getRequest(id) {
  ensureLoaded();
  return cache.requests.find((r) => r.id === id) || null;
}

function createRequest({ items, name, company, notes }) {
  ensureLoaded();
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('at least one item is required');
  }
  if (!name || !String(name).trim()) {
    throw new Error('name is required');
  }
  const lines = items.map(({ id, qty }) => {
    const item = cache.inventory.find((i) => i.id === id);
    if (!item) throw new Error('unknown item: ' + id);
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) throw new Error('quantity must be a positive number for ' + item.description);
    return {
      id: item.id,
      description: item.description,
      tag: item.tag,
      qtyRequested: q,
      qtyAvailableAtRequest: item.qtyAvailable,
    };
  });
  const request = {
    id: newId('req'),
    items: lines,
    requestedBy: { name: String(name).trim(), company: company ? String(company).trim() : '' },
    notes: notes ? String(notes).trim() : '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  cache.requests.push(request);
  persist();
  return request;
}

function fulfillRequest(id) {
  ensureLoaded();
  const request = cache.requests.find((r) => r.id === id);
  if (!request) throw new Error('request not found');
  if (request.status !== 'pending') throw new Error('request is not pending');
  const fulfillment = [];
  for (const line of request.items) {
    const item = cache.inventory.find((i) => i.id === line.id);
    if (!item) {
      fulfillment.push({ id: line.id, description: line.description, fulfilledQty: 0, note: 'item no longer exists' });
      continue;
    }
    const give = Math.max(0, Math.min(line.qtyRequested, item.qtyAvailable));
    item.qtyAvailable -= give;
    item.qtyIssued = (item.qtyIssued || 0) + give;
    fulfillment.push({
      id: item.id,
      description: item.description,
      fulfilledQty: give,
      note: give < line.qtyRequested ? 'partial — only ' + give + ' of ' + line.qtyRequested + ' were in stock' : '',
    });
  }
  request.status = 'fulfilled';
  request.fulfillment = fulfillment;
  request.updatedAt = new Date().toISOString();
  persist();
  return request;
}

function cancelRequest(id, reason) {
  ensureLoaded();
  const request = cache.requests.find((r) => r.id === id);
  if (!request) throw new Error('request not found');
  if (request.status !== 'pending') throw new Error('request is not pending');
  request.status = 'cancelled';
  request.cancelReason = reason || '';
  request.updatedAt = new Date().toISOString();
  persist();
  return request;
}

function pendingCount() {
  ensureLoaded();
  return cache.requests.filter((r) => r.status === 'pending').length;
}

// ---------- push subscriptions ----------

function addPushSubscription(sub, label) {
  ensureLoaded();
  cache.pushSubscriptions = cache.pushSubscriptions.filter((s) => s.endpoint !== sub.endpoint);
  cache.pushSubscriptions.push({ ...sub, label: label || '', addedAt: new Date().toISOString() });
  persist();
}

function removePushSubscription(endpoint) {
  ensureLoaded();
  cache.pushSubscriptions = cache.pushSubscriptions.filter((s) => s.endpoint !== endpoint);
  persist();
}

function listPushSubscriptions() {
  ensureLoaded();
  return cache.pushSubscriptions;
}

// ---------- VAPID keys (auto-generated once, then persisted) ----------
// Lets push notifications work immediately with zero configuration; set
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars instead if you want to
// control them yourself (e.g. to keep the same keys across a fresh deploy).

function getOrCreateVapidKeys() {
  ensureLoaded();
  if (cache.meta.vapidKeys && cache.meta.vapidKeys.publicKey && cache.meta.vapidKeys.privateKey) {
    return cache.meta.vapidKeys;
  }
  function pad32(buf) {
    if (buf.length === 32) return buf;
    if (buf.length > 32) return buf.subarray(buf.length - 32);
    return Buffer.concat([Buffer.alloc(32 - buf.length), buf]);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const x = pad32(Buffer.from(pubJwk.x, 'base64url'));
  const y = pad32(Buffer.from(pubJwk.y, 'base64url'));
  const d = pad32(Buffer.from(privJwk.d, 'base64url'));
  const keys = {
    publicKey: Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url'),
    privateKey: d.toString('base64url'),
  };
  cache.meta.vapidKeys = keys;
  persist();
  return keys;
}

module.exports = {
  DB_PATH,
  listInventory,
  getInventoryItem,
  addInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  listRequests,
  getRequest,
  createRequest,
  fulfillRequest,
  cancelRequest,
  pendingCount,
  addPushSubscription,
  removePushSubscription,
  listPushSubscriptions,
  getOrCreateVapidKeys,
  _resetForTests(db) {
    cache = db || emptyDb();
  },
};
