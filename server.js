// server.js — Ferrier Field Inventory
//
// Two kinds of people use this app, both through the same URL:
//   - Field crews / subcontractors: open the link, search inventory,
//     tick quantities, hit Send. No login.
//   - You (the material manager): unlock the Admin tab with a PIN to see
//     incoming requests live, fulfill/cancel them, and manage inventory.
//     Unlocking Admin also offers to enable push notifications, so new
//     requests alert your phone/computer even if the tab isn't open.
//
// Only two dependencies (express, web-push) — everything else is Node's
// standard library, so `npm install` has almost nothing to fetch.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const storage = require('./lib/storage');
const { parseReceivedItems } = require('./lib/xlsxImport');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '7749';
const CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL || 'admin@example.com';

const envKeysPresent = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY;
const vapidKeys = envKeysPresent
  ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
  : storage.getOrCreateVapidKeys();

webpush.setVapidDetails('mailto:' + CONTACT_EMAIL, vapidKeys.publicKey, vapidKeys.privateKey);

const app = express();
app.set('trust proxy', 1); // Render/Railway/etc sit behind a TLS-terminating proxy
app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------------
// Admin sessions — simple in-memory token store. Restarting the server
// logs admins out (they just re-enter the PIN); nothing else depends on
// sessions surviving a restart.
// ---------------------------------------------------------------------

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const sessions = new Map(); // token -> expiresAt

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function setSessionCookie(req, res, token) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `ferrier_admin=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax${secure}`
  );
}

function clearSessionCookie(req, res) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ferrier_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`);
}

function requireAdmin(req, res, next) {
  const token = parseCookies(req).ferrier_admin;
  if (!isValidSession(token)) return res.status(401).json({ error: 'admin login required' });
  next();
}

// Basic brute-force guard on the PIN — a handful of tries per IP, then a cooldown.
const loginAttempts = new Map(); // ip -> { count, windowStart }
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

function loginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 0, windowStart: now });
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginAttempt(ip, success) {
  const entry = loginAttempts.get(ip) || { count: 0, windowStart: Date.now() };
  if (success) {
    loginAttempts.delete(ip);
  } else {
    entry.count += 1;
    loginAttempts.set(ip, entry);
  }
}

function asyncRoute(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(400).json({ error: err.message || 'something went wrong' });
  });
}

// ---------------------------------------------------------------------
// Live updates: Server-Sent Events for any open admin dashboards, plus
// Web Push for phones/desktops that aren't looking at the page right now.
// ---------------------------------------------------------------------

const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

async function sendPushToAll(payload) {
  const subs = storage.listPushSubscriptions();
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          storage.removePushSubscription(sub.endpoint); // subscription expired/revoked — clean it up
        } else {
          console.error('push send failed:', err.statusCode, err.message);
        }
      }
    })
  );
}

function summarizeRequest(request) {
  const first = request.items[0];
  const extra = request.items.length - 1;
  const itemSummary = extra > 0 ? `${first.description} +${extra} more` : first.description;
  return {
    title: 'New material request',
    body: `${request.requestedBy.name}${request.requestedBy.company ? ' (' + request.requestedBy.company + ')' : ''} — ${itemSummary}`,
    url: '/#admin',
    requestId: request.id,
  };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

app.get('/api/inventory', (req, res) => {
  res.json(storage.listInventory());
});

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post(
  '/api/requests',
  asyncRoute(async (req, res) => {
    const request = storage.createRequest(req.body || {});
    broadcastSSE('new_request', request);
    sendPushToAll(summarizeRequest(request)).catch((e) => console.error(e));
    res.status(201).json(request);
  })
);

// ---------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginRateLimited(ip)) {
    return res.status(429).json({ error: 'too many attempts — wait a few minutes and try again' });
  }
  const { pin } = req.body || {};
  const ok = typeof pin === 'string' && pin === ADMIN_PIN;
  recordLoginAttempt(ip, ok);
  if (!ok) return res.status(401).json({ error: 'wrong PIN' });
  const token = createSession();
  setSessionCookie(req, res, token);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = parseCookies(req).ferrier_admin;
  if (token) sessions.delete(token);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ ok: true, pendingCount: storage.pendingCount() });
});

// A one-click backup of the whole database (inventory + request history) —
// handy on a host with ephemeral storage: download this occasionally, or
// before any redeploy, so nothing is lost.
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const fs = require('fs');
  const raw = fs.readFileSync(storage.DB_PATH, 'utf8');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="ferrier-inventory-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.end(raw);
});

// ---------------------------------------------------------------------
// Admin: requests
// ---------------------------------------------------------------------

app.get('/api/admin/requests', requireAdmin, (req, res) => {
  res.json(storage.listRequests(req.query.status));
});

app.post(
  '/api/admin/requests/:id/fulfill',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const request = storage.fulfillRequest(req.params.id);
    broadcastSSE('request_updated', request);
    res.json(request);
  })
);

app.post(
  '/api/admin/requests/:id/cancel',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const request = storage.cancelRequest(req.params.id, (req.body || {}).reason);
    broadcastSSE('request_updated', request);
    res.json(request);
  })
);

// ---------------------------------------------------------------------
// Admin: inventory
// ---------------------------------------------------------------------

app.post(
  '/api/admin/inventory',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const item = storage.addInventoryItem(req.body || {});
    broadcastSSE('inventory_updated', item);
    res.status(201).json(item);
  })
);

app.patch(
  '/api/admin/inventory/:id',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const item = storage.updateInventoryItem(req.params.id, req.body || {});
    broadcastSSE('inventory_updated', item);
    res.json(item);
  })
);

app.delete(
  '/api/admin/inventory/:id',
  requireAdmin,
  asyncRoute(async (req, res) => {
    storage.deleteInventoryItem(req.params.id);
    broadcastSSE('inventory_deleted', { id: req.params.id });
    res.json({ ok: true });
  })
);

// Update inventory straight from the RECEIVED ITEMS tab of Ryan's Excel
// workbook, instead of re-typing each new item by hand. The browser sends
// the .xlsx as base64 in a JSON body (simplest way to do a file upload
// without adding a multipart-parsing dependency); a dedicated, larger body
// limit is used here only, since the app-wide limit (256kb) is sized for
// small JSON requests, not a spreadsheet.
const importBodyParser = express.json({ limit: '20mb' });
app.post(
  '/api/admin/inventory/import',
  requireAdmin,
  importBodyParser,
  asyncRoute(async (req, res) => {
    const { dataBase64 } = req.body || {};
    if (!dataBase64) return res.status(400).json({ error: 'no file received' });
    let buffer;
    try {
      buffer = Buffer.from(dataBase64, 'base64');
    } catch (err) {
      return res.status(400).json({ error: 'could not decode the uploaded file' });
    }
    const { rows, warnings } = parseReceivedItems(buffer);
    const result = storage.importInventoryRows(rows);
    broadcastSSE('inventory_updated', { imported: true });
    res.json({ ...result, warnings });
  })
);

// ---------------------------------------------------------------------
// Admin: push subscriptions + live SSE stream
// ---------------------------------------------------------------------

app.post('/api/admin/push/subscribe', requireAdmin, (req, res) => {
  const { subscription, label } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'invalid subscription' });
  }
  storage.addPushSubscription(subscription, label);
  res.json({ ok: true });
});

app.post('/api/admin/push/unsubscribe', requireAdmin, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) storage.removePushSubscription(endpoint);
  res.json({ ok: true });
});

app.post(
  '/api/admin/push/test',
  requireAdmin,
  asyncRoute(async (req, res) => {
    await sendPushToAll({ title: 'Test alert', body: 'Push notifications are working.', url: '/#admin' });
    res.json({ ok: true, subscriberCount: storage.listPushSubscriptions().length });
  })
);

app.get('/api/admin/events', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// ---------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ferrier Field Inventory listening on port ${PORT}`);
  console.log(`Admin PIN: ${ADMIN_PIN}${process.env.ADMIN_PIN ? '' : '  (default — set ADMIN_PIN env var to change it)'}`);
  if (!envKeysPresent) {
    console.log('VAPID push keys were auto-generated and saved to the database file.');
  }
});
