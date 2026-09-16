(() => {
  'use strict';

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const state = {
    inventory: [],
    cart: new Map(), // itemId -> qty
    search: '',
    discipline: 'All',
    inStockOnly: true,
    adminUnlocked: false,
    adminTab: 'requests',
    requests: [],
    adminSearch: '',
    editingItem: null, // item being added/edited in the item modal
  };

  // ------------------------------------------------------------------
  // Tiny helpers
  // ------------------------------------------------------------------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(message, isError) {
    const stack = $('#toast-stack');
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      method: (opts && opts.method) || 'GET',
      headers: opts && opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('request failed (' + res.status + ')'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function relativeTime(iso) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  // ------------------------------------------------------------------
  // Top-level tabs
  // ------------------------------------------------------------------
  function showTab(tab) {
    const isSearch = tab === 'search';
    $('#view-search').hidden = !isSearch;
    $('#view-admin').hidden = isSearch;
    $('#tab-search').setAttribute('aria-selected', String(isSearch));
    $('#tab-admin').setAttribute('aria-selected', String(!isSearch));
    if (!isSearch) {
      if (state.adminUnlocked) enterAdmin(); else showLockScreen();
    }
  }
  $('#tab-search').addEventListener('click', () => showTab('search'));
  $('#tab-admin').addEventListener('click', () => showTab('admin'));

  // ==================================================================
  // SEARCH & REQUEST VIEW
  // ==================================================================

  function disciplines() {
    const set = new Set(state.inventory.map((i) => i.discipline || 'Other'));
    return ['All', ...Array.from(set).sort()];
  }

  function renderChips() {
    const wrap = $('#discipline-chips');
    const chipsHtml = disciplines()
      .map((d) => `<button type="button" class="chip" data-discipline="${esc(d)}" aria-pressed="${d === state.discipline}">${esc(d)}</button>`)
      .join('');
    // rebuild, keeping the "in stock only" toggle which lives in the same row
    const stockToggle = $('#in-stock-only');
    wrap.innerHTML = chipsHtml + `<label class="stock-toggle"><input type="checkbox" id="in-stock-only" ${state.inStockOnly ? 'checked' : ''}> In stock only</label>`;
    $$('.chip', wrap).forEach((btn) => btn.addEventListener('click', () => {
      state.discipline = btn.dataset.discipline;
      renderChips();
      renderInventoryList();
    }));
    $('#in-stock-only').addEventListener('change', (e) => {
      state.inStockOnly = e.target.checked;
      renderInventoryList();
    });
  }

  function filteredInventory() {
    const q = state.search.trim().toLowerCase();
    return state.inventory.filter((it) => {
      if (state.discipline !== 'All' && (it.discipline || 'Other') !== state.discipline) return false;
      if (state.inStockOnly && it.qtyAvailable <= 0) return false;
      if (!q) return true;
      return (
        (it.description || '').toLowerCase().includes(q) ||
        (it.tag || '').toLowerCase().includes(q) ||
        String(it.mrr || '').toLowerCase().includes(q) ||
        (it.storageLocation || '').toLowerCase().includes(q)
      );
    });
  }

  function itemRowHtml(it) {
    const qty = state.cart.get(it.id) || 0;
    const meta = [it.tag ? 'Tag ' + it.tag : null, it.mrr ? 'MRR ' + it.mrr : null, it.storageLocation || null].filter(Boolean);
    return `
      <div class="item-row ${qty > 0 ? 'selected' : ''}" data-id="${esc(it.id)}">
        <div class="item-main">
          <div class="item-desc">${esc(it.description)}</div>
          <div class="item-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
        </div>
        <div class="item-avail ${it.qtyAvailable <= 0 ? 'zero' : ''}">
          <span class="n">${it.qtyAvailable}</span>
          <span class="u">avail</span>
        </div>
        <div class="stepper">
          <button type="button" class="step-down" aria-label="Decrease quantity">&minus;</button>
          <input type="text" inputmode="numeric" class="step-input" value="${qty}" aria-label="Quantity requested">
          <button type="button" class="step-up" aria-label="Increase quantity">&plus;</button>
        </div>
      </div>`;
  }

  function renderInventoryList() {
    const list = filteredInventory();
    $('#result-count').textContent = list.length + (list.length === 1 ? ' item' : ' items');
    const container = $('#inventory-list');
    if (list.length === 0) {
      container.innerHTML = `<div class="empty-state">No items match your search.</div>`;
      updateCartBar();
      return;
    }
    // group by discipline for scannability
    const groups = new Map();
    list.forEach((it) => {
      const key = it.discipline || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    });
    let html = '';
    Array.from(groups.keys()).sort().forEach((key) => {
      const items = groups.get(key).sort((a, b) => a.description.localeCompare(b.description));
      html += `<div class="group-heading">${esc(key)} &middot; ${items.length}</div><div class="item-list">`;
      html += items.map(itemRowHtml).join('');
      html += `</div>`;
    });
    container.innerHTML = html;

    $$('.item-row', container).forEach((row) => {
      const id = row.dataset.id;
      const item = state.inventory.find((i) => i.id === id);
      const input = $('.step-input', row);
      function setQty(n) {
        n = Math.max(0, Math.min(item.qtyAvailable, Math.round(n) || 0));
        if (n > 0) state.cart.set(id, n); else state.cart.delete(id);
        input.value = n;
        row.classList.toggle('selected', n > 0);
        updateCartBar();
      }
      $('.step-down', row).addEventListener('click', () => setQty((state.cart.get(id) || 0) - 1));
      $('.step-up', row).addEventListener('click', () => setQty((state.cart.get(id) || 0) + 1));
      input.addEventListener('change', () => setQty(parseInt(input.value, 10)));
      input.addEventListener('click', () => input.select());
    });
  }

  function updateCartBar() {
    const count = state.cart.size;
    $('#cart-count').textContent = count;
    $('#cart-bar').classList.toggle('visible', count > 0);
  }

  $('#search-input').addEventListener('input', (e) => { state.search = e.target.value; renderInventoryList(); });

  // ------------------------------------------------------------------
  // Review & send modal
  // ------------------------------------------------------------------

  function openReviewModal() {
    const backdrop = $('#review-modal');
    renderReviewModal();
    backdrop.hidden = false;
  }
  function closeReviewModal() { $('#review-modal').hidden = true; }

  function renderReviewModal() {
    const lines = Array.from(state.cart.entries()).map(([id, qty]) => {
      const item = state.inventory.find((i) => i.id === id);
      return { id, qty, item };
    }).filter((l) => l.item);

    const body = $('#review-modal-body');
    if (lines.length === 0) { closeReviewModal(); return; }

    body.innerHTML = `
      <h2>Review Request</h2>
      <p class="sub">Double-check quantities, then tell us who's asking.</p>
      <div id="review-lines">
        ${lines.map((l) => `
          <div class="modal-line" data-id="${esc(l.id)}">
            <div class="desc">${esc(l.item.description)}</div>
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="qty">${l.qty} of ${l.item.qtyAvailable}</span>
              <button type="button" class="remove">Remove</button>
            </div>
          </div>`).join('')}
      </div>
      <form id="request-form">
        <div class="field">
          <label for="req-name">Your name *</label>
          <input id="req-name" required autocomplete="name" placeholder="Jake Miller">
        </div>
        <div class="field">
          <label for="req-company">Company / subcontractor</label>
          <input id="req-company" autocomplete="organization" placeholder="Miller Electric">
        </div>
        <div class="field">
          <label for="req-notes">Notes (optional)</label>
          <textarea id="req-notes" placeholder="Where to drop it, when it's needed, etc."></textarea>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="review-cancel-btn">Cancel</button>
          <button type="submit" class="btn btn-accent" id="review-send-btn">Send Request</button>
        </div>
      </form>`;

    $$('.remove', body).forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.closest('.modal-line').dataset.id;
      state.cart.delete(id);
      renderInventoryList();
      renderReviewModal();
    }));
    $('#review-cancel-btn').addEventListener('click', closeReviewModal);
    $('#request-form').addEventListener('submit', onSubmitRequest);
  }

  async function onSubmitRequest(e) {
    e.preventDefault();
    const sendBtn = $('#review-send-btn');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    const items = Array.from(state.cart.entries()).map(([id, qty]) => ({ id, qty }));
    const name = $('#req-name').value.trim();
    const company = $('#req-company').value.trim();
    const notes = $('#req-notes').value.trim();
    try {
      await api('/api/requests', { method: 'POST', body: { items, name, company, notes } });
      $('#review-modal-body').innerHTML = `
        <div class="confirm-state">
          <div class="check">&#10003;</div>
          <h2>Request Sent</h2>
          <p class="sub">Thanks, ${esc(name.split(' ')[0] || name)}. The material manager has been notified.</p>
          <button type="button" class="btn btn-accent btn-block" id="confirm-close-btn">Done</button>
        </div>`;
      $('#confirm-close-btn').addEventListener('click', closeReviewModal);
      state.cart.clear();
      updateCartBar();
      loadInventory();
    } catch (err) {
      toast(err.message, true);
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Request';
    }
  }

  $('#review-btn').addEventListener('click', openReviewModal);
  $('#review-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeReviewModal(); });

  // ------------------------------------------------------------------
  // Load inventory (public)
  // ------------------------------------------------------------------
  async function loadInventory() {
    try {
      state.inventory = await api('/api/inventory');
      renderChips();
      renderInventoryList();
      if (state.adminUnlocked && state.adminTab === 'inventory') renderAdminInventory();
    } catch (err) {
      toast('Could not load inventory: ' + err.message, true);
    }
  }

  // ==================================================================
  // ADMIN
  // ==================================================================

  function showLockScreen() {
    $('#admin-lock-wrap').hidden = false;
    $('#admin-main').hidden = true;
  }

  async function enterAdmin() {
    $('#admin-lock-wrap').hidden = true;
    $('#admin-main').hidden = false;
    await Promise.all([loadRequests(), loadInventory()]);
    if (state.adminTab === 'alerts') refreshPushUI();
    connectSSE();
  }

  $('#pin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = $('#pin-input').value.trim();
    const errEl = $('#pin-error');
    errEl.textContent = '';
    try {
      await api('/api/admin/login', { method: 'POST', body: { pin } });
      state.adminUnlocked = true;
      $('#pin-input').value = '';
      await enterAdmin();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  $('#lock-btn').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    state.adminUnlocked = false;
    disconnectSSE();
    showLockScreen();
  });

  // check for an existing session on load so a refresh doesn't force re-login
  async function checkExistingSession() {
    try {
      const info = await api('/api/admin/me');
      state.adminUnlocked = true;
      updateAdminBadges(info.pendingCount);
    } catch (e) { /* not logged in — fine */ }
  }

  function updateAdminBadges(pendingCount) {
    const b1 = $('#admin-badge');
    const b2 = $('#requests-badge');
    [b1, b2].forEach((b) => {
      b.textContent = pendingCount;
      b.hidden = !pendingCount;
    });
  }

  // ------------------------------------------------------------------
  // Admin sub-tabs
  // ------------------------------------------------------------------
  function showSubtab(tab) {
    state.adminTab = tab;
    ['requests', 'inventory', 'alerts'].forEach((t) => {
      $('#admin-' + t).hidden = t !== tab;
      const btn = $('#subtab-' + t);
      if (btn) btn.setAttribute('aria-selected', String(t === tab));
    });
    if (tab === 'inventory') renderAdminInventory();
    if (tab === 'alerts') refreshPushUI();
  }
  $('#subtab-requests').addEventListener('click', () => showSubtab('requests'));
  $('#subtab-inventory').addEventListener('click', () => showSubtab('inventory'));
  $('#subtab-alerts').addEventListener('click', () => showSubtab('alerts'));

  // ------------------------------------------------------------------
  // Requests tab
  // ------------------------------------------------------------------
  async function loadRequests() {
    try {
      state.requests = await api('/api/admin/requests');
      renderRequests();
    } catch (err) {
      toast('Could not load requests: ' + err.message, true);
    }
  }

  function requestCardHtml(r, pending) {
    const lines = r.items.map((it) => {
      const over = it.qtyRequested > it.qtyAvailableAtRequest;
      return `<div class="req-item-line ${over ? 'over' : ''}"><span>${esc(it.description)}</span><span class="q">${it.qtyRequested}</span></div>`;
    }).join('');
    const pill = r.status === 'pending' ? 'pill-pending' : r.status === 'fulfilled' ? 'pill-fulfilled' : 'pill-cancelled';
    return `
      <div class="req-card" data-id="${esc(r.id)}">
        <div class="req-card-head">
          <div>
            <div class="req-who">${esc(r.requestedBy.name)}</div>
            ${r.requestedBy.company ? `<div class="req-company">${esc(r.requestedBy.company)}</div>` : ''}
          </div>
          <div style="text-align:right;">
            <span class="pill ${pill}">${esc(r.status)}</span>
            <div class="req-time">${relativeTime(r.createdAt)}</div>
          </div>
        </div>
        <div class="req-items">${lines}</div>
        ${r.notes ? `<div class="req-notes">${esc(r.notes)}</div>` : ''}
        ${pending ? `
          <div class="req-actions">
            <button type="button" class="btn btn-good btn-sm fulfill-btn">Fulfill</button>
            <button type="button" class="btn btn-critical-outline btn-sm cancel-btn">Cancel</button>
          </div>` : ''}
      </div>`;
  }

  function renderRequests() {
    const pending = state.requests.filter((r) => r.status === 'pending');
    const history = state.requests.filter((r) => r.status !== 'pending').slice(0, 25);
    updateAdminBadges(pending.length);

    $('#pending-list').innerHTML = pending.length
      ? pending.map((r) => requestCardHtml(r, true)).join('')
      : `<div class="empty-state">No pending requests right now.</div>`;

    $('#history-list').innerHTML = history.map((r) => requestCardHtml(r, false)).join('') || `<div class="empty-state">No history yet.</div>`;

    $$('.fulfill-btn', $('#pending-list')).forEach((btn) => btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.req-card').dataset.id;
      btn.disabled = true;
      try {
        await api('/api/admin/requests/' + id + '/fulfill', { method: 'POST' });
        toast('Marked fulfilled — inventory updated.');
        await Promise.all([loadRequests(), loadInventory()]);
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    }));
    $$('.cancel-btn', $('#pending-list')).forEach((btn) => btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.req-card').dataset.id;
      btn.disabled = true;
      try {
        await api('/api/admin/requests/' + id + '/cancel', { method: 'POST' });
        toast('Request cancelled.');
        await loadRequests();
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    }));
  }

  $('#history-title').addEventListener('click', () => {
    const list = $('#history-list');
    list.hidden = !list.hidden;
    $('#history-title').innerHTML = 'History ' + (list.hidden ? '&#9662;' : '&#9652;');
  });

  // ------------------------------------------------------------------
  // Inventory tab (admin)
  // ------------------------------------------------------------------
  function adminFilteredInventory() {
    const q = state.adminSearch.trim().toLowerCase();
    if (!q) return state.inventory;
    return state.inventory.filter((it) =>
      (it.description || '').toLowerCase().includes(q) ||
      (it.tag || '').toLowerCase().includes(q) ||
      String(it.mrr || '').toLowerCase().includes(q)
    );
  }

  function renderAdminInventory() {
    const list = adminFilteredInventory().slice().sort((a, b) => a.description.localeCompare(b.description));
    const container = $('#admin-inventory-list');
    if (list.length === 0) { container.innerHTML = `<div class="empty-state">No items match.</div>`; return; }
    container.innerHTML = list.map((it) => `
      <div class="inv-row" data-id="${esc(it.id)}">
        <div class="item-main">
          <div class="item-desc">${esc(it.description)}</div>
          <div class="item-meta"><span>${esc(it.discipline || 'Other')}</span>${it.tag ? `<span>Tag ${esc(it.tag)}</span>` : ''}</div>
        </div>
        <div>
          <span class="inv-field-label">Qty avail</span>
          <input type="text" inputmode="numeric" class="inv-edit qty-edit" value="${it.qtyAvailable}">
        </div>
        <div>
          <span class="inv-field-label">Location</span>
          <input type="text" class="inv-edit loc loc-edit" value="${esc(it.storageLocation || '')}">
        </div>
      </div>`).join('');

    $$('.inv-row', container).forEach((row) => {
      const id = row.dataset.id;
      const qtyInput = $('.qty-edit', row);
      const locInput = $('.loc-edit', row);
      async function saveQty() {
        const n = parseInt(qtyInput.value, 10);
        if (!Number.isFinite(n) || n < 0) { toast('Quantity must be a non-negative number', true); return; }
        try {
          await api('/api/admin/inventory/' + id, { method: 'PATCH', body: { qtyAvailable: n } });
          const item = state.inventory.find((i) => i.id === id);
          if (item) item.qtyAvailable = n;
          toast('Quantity updated.');
        } catch (err) { toast(err.message, true); }
      }
      async function saveLoc() {
        try {
          await api('/api/admin/inventory/' + id, { method: 'PATCH', body: { storageLocation: locInput.value } });
          const item = state.inventory.find((i) => i.id === id);
          if (item) item.storageLocation = locInput.value;
          toast('Location updated.');
        } catch (err) { toast(err.message, true); }
      }
      qtyInput.addEventListener('change', saveQty);
      locInput.addEventListener('change', saveLoc);
    });
  }

  $('#admin-search-input').addEventListener('input', (e) => { state.adminSearch = e.target.value; renderAdminInventory(); });

  function openItemModal() {
    const body = $('#item-modal-body');
    body.innerHTML = `
      <h2>Add Inventory Item</h2>
      <p class="sub">Add material that wasn't in the original import.</p>
      <form id="item-form">
        <div class="field"><label for="it-desc">Description *</label><input id="it-desc" required placeholder="e.g. Gasket, 4in 300#"></div>
        <div class="field"><label for="it-discipline">Discipline</label><input id="it-discipline" placeholder="e.g. Piping"></div>
        <div class="field"><label for="it-tag">Tag / location #</label><input id="it-tag"></div>
        <div class="field"><label for="it-qty">Qty available *</label><input id="it-qty" inputmode="numeric" required placeholder="0"></div>
        <div class="field"><label for="it-loc">Storage location</label><input id="it-loc"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="item-cancel-btn">Cancel</button>
          <button type="submit" class="btn btn-accent">Add Item</button>
        </div>
      </form>`;
    $('#item-cancel-btn').addEventListener('click', () => { $('#item-modal').hidden = true; });
    $('#item-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/inventory', { method: 'POST', body: {
          description: $('#it-desc').value,
          discipline: $('#it-discipline').value,
          tag: $('#it-tag').value,
          qtyAvailable: $('#it-qty').value,
          qtyReceived: $('#it-qty').value,
          storageLocation: $('#it-loc').value,
        }});
        toast('Item added.');
        $('#item-modal').hidden = true;
        await loadInventory();
      } catch (err) { toast(err.message, true); }
    });
    $('#item-modal').hidden = false;
  }
  $('#add-item-btn').addEventListener('click', openItemModal);
  $('#item-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#item-modal').hidden = true; });

  // ------------------------------------------------------------------
  // Import inventory from Ryan's Excel workbook (RECEIVED ITEMS tab)
  // ------------------------------------------------------------------
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // reader.result is a data: URL like "data:...;base64,AAAA..."
        const commaIdx = reader.result.indexOf(',');
        resolve(reader.result.slice(commaIdx + 1));
      };
      reader.onerror = () => reject(reader.error || new Error('could not read file'));
      reader.readAsDataURL(file);
    });
  }

  $('#import-excel-btn').addEventListener('click', () => $('#import-excel-input').click());
  $('#import-excel-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    const btn = $('#import-excel-btn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const dataBase64 = await fileToBase64(file);
      const result = await api('/api/admin/inventory/import', { method: 'POST', body: { dataBase64 } });
      const parts = [];
      if (result.added) parts.push(result.added + ' new item(s) added');
      if (result.updated) parts.push(result.updated + ' updated');
      if (result.unchanged) parts.push(result.unchanged + ' unchanged');
      if (result.skipped) parts.push(result.skipped + ' row(s) skipped (no description)');
      toast(parts.length ? parts.join(', ') + '.' : 'Nothing to import — the file had no recognizable item rows.');
      (result.warnings || []).forEach((w) => toast(w, true));
      await loadInventory();
    } catch (err) {
      toast('Import failed: ' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  // ------------------------------------------------------------------
  // Alerts tab: push notifications
  // ------------------------------------------------------------------
  function urlBase64ToUint8Array(base64url) {
    const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
    const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function refreshPushUI() {
    const statusEl = $('#push-status');
    const btn = $('#enable-push-btn');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      statusEl.textContent = 'Push notifications aren’t supported in this browser.';
      btn.disabled = true;
    } else {
      statusEl.textContent = Notification.permission === 'granted' ? 'Notifications are allowed in this browser.' : '';
      btn.disabled = false;
    }
    renderDeviceList();
  }

  function renderDeviceList() {
    // We only know about subscriptions from this browser's own registration
    // (the server doesn't label devices beyond what was sent at subscribe
    // time); show local status plus a reminder of what "on" means.
    navigator.serviceWorker && navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) { $('#device-list').innerHTML = `<div class="device-row"><span><span class="status-dot"></span>This device</span><span>Not enabled</span></div>`; return; }
      reg.pushManager.getSubscription().then((sub) => {
        $('#device-list').innerHTML = `<div class="device-row"><span><span class="status-dot ${sub ? 'on' : ''}"></span>This device</span><span>${sub ? 'Enabled' : 'Not enabled'}</span></div>`;
      });
    });
  }

  $('#enable-push-btn').addEventListener('click', async () => {
    const statusEl = $('#push-status');
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { statusEl.textContent = 'Notifications were blocked — allow them in your browser settings to enable alerts.'; return; }
      const { publicKey } = await api('/api/push/vapid-public-key');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      }
      await api('/api/admin/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 60) } });
      statusEl.textContent = 'Alerts are on for this device.';
      renderDeviceList();
      toast('Push alerts enabled on this device.');
    } catch (err) {
      statusEl.textContent = 'Could not enable alerts: ' + err.message;
    }
  });

  $('#test-push-btn').addEventListener('click', async () => {
    try {
      const result = await api('/api/admin/push/test', { method: 'POST' });
      toast(result.subscriberCount ? 'Test alert sent to ' + result.subscriberCount + ' device(s).' : 'No devices are enabled yet.');
    } catch (err) { toast(err.message, true); }
  });

  // ------------------------------------------------------------------
  // Live updates while the admin tab is open: Server-Sent Events
  // ------------------------------------------------------------------
  let sse = null;
  let audioCtx = null;

  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.4);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.42);
    } catch (e) { /* ignore — sound is a nice-to-have */ }
  }

  function showLiveBanner(text) {
    const banner = $('#live-banner');
    $('#live-banner-text').textContent = text;
    banner.classList.add('visible');
    clearTimeout(showLiveBanner._t);
    showLiveBanner._t = setTimeout(() => banner.classList.remove('visible'), 6000);
  }
  $('#live-banner-btn').addEventListener('click', () => {
    $('#live-banner').classList.remove('visible');
    showTab('admin');
    showSubtab('requests');
  });

  function connectSSE() {
    if (sse) return;
    sse = new EventSource('/api/admin/events');
    sse.addEventListener('new_request', (e) => {
      const r = JSON.parse(e.data);
      beep();
      showLiveBanner('New request from ' + r.requestedBy.name + ' — ' + r.items.length + ' item(s)');
      if (Notification.permission === 'granted') {
        try { new Notification('New material request', { body: r.requestedBy.name + ' — ' + r.items[0].description }); } catch (e2) {}
      }
      loadRequests();
    });
    sse.addEventListener('request_updated', () => loadRequests());
    sse.addEventListener('inventory_updated', () => loadInventory());
    sse.addEventListener('inventory_deleted', () => loadInventory());
    sse.onerror = () => { /* browser auto-reconnects EventSource */ };
  }
  function disconnectSSE() { if (sse) { sse.close(); sse = null; } }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  (async function init() {
    await loadInventory();
    await checkExistingSession();
    if (state.adminUnlocked) updateAdminBadges((state.requests.filter((r) => r.status === 'pending')).length);
    if (location.hash === '#admin') showTab('admin');
  })();
})();
