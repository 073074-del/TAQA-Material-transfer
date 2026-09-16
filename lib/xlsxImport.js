// xlsxImport.js — turns an uploaded copy of the TAQA Ferrier Receiving
// Material Control workbook (RECEIVED ITEMS tab) into plain row objects
// that lib/storage.js knows how to merge into inventory.
//
// Written defensively: field order, extra columns, and minor header
// wording differences shouldn't break this — we match headers by meaning,
// not position, and we auto-detect which column is the stable per-row ID
// rather than trusting a specific header label (see findIdColumn below,
// this workbook's own "Inventory ID" / "Lookup Key" headers are swapped
// relative to what their formulas actually compute).

const XLSX = require('xlsx');

// Each entry: our field name -> header text(s) that mean that field,
// matched case-insensitively after trimming.
const FIELD_ALIASES = {
  mrr: ['mrr #', 'mrr#', 'mrr'],
  tag: ['tag / location / unit #', 'tag/location/unit#', 'tag'],
  description: ['description'],
  qtyReceived: ['qty received'],
  discipline: ['discipline'],
  area: ['area', 'work area', 'zone'],
  serial: ['serial / heat #', 'serial/heat#', 'serial'],
  hasCerts: ['certificates / letter of compliance', 'certificates', 'certs'],
  storageLocation: ['storage location'],
  receiptStatus: ['receipt status'],
  notes: ['damage / discrepancy notes', 'damage/discrepancy notes', 'notes'],
};

// Columns that, in this workbook, hold a stable-ish per-row identifier.
// We don't trust the header text alone (see note above) — we check both
// candidates and use whichever one actually contains numbers.
const ID_COLUMN_CANDIDATES = ['inventory id', 'lookup key'];

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

function findSheet(workbook) {
  const wanted = 'received items';
  const name = workbook.SheetNames.find((n) => norm(n) === wanted) ||
    workbook.SheetNames.find((n) => norm(n).includes('received'));
  if (!name) return null;
  return workbook.Sheets[name];
}

function findHeaderRowIndex(grid) {
  const limit = Math.min(grid.length, 10);
  for (let i = 0; i < limit; i++) {
    const row = grid[i] || [];
    if (row.some((cell) => norm(cell) === 'description')) return i;
  }
  return -1;
}

function buildColumnMap(headerRow) {
  const map = {}; // ourField -> column index
  headerRow.forEach((cell, colIdx) => {
    const h = norm(cell);
    if (!h) return;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.some((a) => norm(a) === h)) map[field] = colIdx;
    }
  });
  return map;
}

function findIdColumn(headerRow, dataRows) {
  const candidates = [];
  headerRow.forEach((cell, colIdx) => {
    if (ID_COLUMN_CANDIDATES.includes(norm(cell))) candidates.push(colIdx);
  });
  // Prefer whichever candidate column is (mostly) numeric across the data rows.
  let best = null;
  let bestScore = -1;
  for (const colIdx of candidates) {
    let numeric = 0;
    let total = 0;
    for (const row of dataRows) {
      const v = row[colIdx];
      if (v === undefined || v === '' || v === null) continue;
      total++;
      if (typeof v === 'number' && Number.isFinite(v)) numeric++;
    }
    if (total > 0 && numeric / total > bestScore) {
      bestScore = numeric / total;
      best = colIdx;
    }
  }
  return bestScore > 0.9 ? best : null;
}

/**
 * @param {Buffer} buffer - the raw .xlsx file
 * @returns {{ rows: object[], warnings: string[] }}
 */
function parseReceivedItems(buffer) {
  const warnings = [];
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    throw new Error('Could not read that file as an Excel workbook (' + err.message + ')');
  }

  const sheet = findSheet(workbook);
  if (!sheet) {
    throw new Error('No "RECEIVED ITEMS" tab found in that workbook. Sheets found: ' + workbook.SheetNames.join(', '));
  }

  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  const headerIdx = findHeaderRowIndex(grid);
  if (headerIdx === -1) {
    throw new Error('Could not find the header row (looking for a "Description" column) in the RECEIVED ITEMS tab.');
  }
  const headerRow = grid[headerIdx];
  const dataRows = grid.slice(headerIdx + 1);

  const colMap = buildColumnMap(headerRow);
  if (colMap.description === undefined) {
    throw new Error('Could not find a "Description" column in the RECEIVED ITEMS tab.');
  }
  const idCol = findIdColumn(headerRow, dataRows);
  if (idCol === null) {
    warnings.push('Could not find a reliable ID column (Inventory ID / Lookup Key) — new rows will be added as new items, but re-importing the same row later may create a duplicate instead of updating it.');
  }

  const rows = [];
  let skipped = 0;
  dataRows.forEach((row, i) => {
    const description = String(row[colMap.description] ?? '').trim();
    if (!description) { skipped++; return; }
    const get = (field) => (colMap[field] !== undefined ? row[colMap[field]] : '');
    const qtyReceivedRaw = get('qtyReceived');
    const qtyReceived = Number(qtyReceivedRaw);
    rows.push({
      sourceId: idCol !== null ? row[idCol] : null,
      mrr: String(get('mrr') ?? '').trim(),
      tag: String(get('tag') ?? '').trim(),
      description,
      discipline: String(get('discipline') ?? '').trim() || 'Other',
      area: String(get('area') ?? '').trim(),
      qtyReceived: Number.isFinite(qtyReceived) ? qtyReceived : 0,
      storageLocation: String(get('storageLocation') ?? '').trim(),
      serial: String(get('serial') ?? '').trim(),
      receiptStatus: String(get('receiptStatus') ?? '').trim(),
      hasCerts: String(get('hasCerts') ?? '').trim(),
      notes: String(get('notes') ?? '').trim(),
      _rowNumber: headerIdx + 2 + i, // 1-based, matches what the user sees in Excel
    });
  });

  if (rows.length === 0) {
    throw new Error('No item rows found under the header in the RECEIVED ITEMS tab.');
  }

  return { rows, warnings };
}

module.exports = { parseReceivedItems };
