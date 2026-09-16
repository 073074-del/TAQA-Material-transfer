// lib/areaCodes.js — deriving an item's plant Area from its tag.
//
// Ryan's RECEIVED ITEMS tab has an AREA column (column B) whose own Excel
// formula computes the area as the tag's leading 3-digit prefix, whenever
// the tag follows the "NNN-..." pattern (e.g. "703-FE/FIT-1101" → area
// "703"). Tags that don't follow that pattern (structural/bolt tags like
// "A1" or "4SB-C1") are left blank — there's no area to derive.
//
// This mirrors that exact formula:
//   =IF(AND(LEN(tag)>=4, MID(tag,4,1)="-", ISNUMBER(VALUE(LEFT(tag,3)))),
//       LEFT(tag,3), "")
//
// We run this ourselves rather than trusting the workbook's own computed
// value for that column, because a workbook uploaded without being
// recalculated in Excel first (or edited by some other tool) can have a
// stale/blank cached formula result — reading the raw value in that case
// would silently import blank areas even though the tag clearly encodes one.

function deriveAreaFromTag(tag) {
  const s = String(tag == null ? '' : tag).trim();
  if (s.length < 4) return null;
  if (s[3] !== '-') return null;
  const prefix = s.slice(0, 3);
  return /^\d{3}$/.test(prefix) ? prefix : null;
}

module.exports = { deriveAreaFromTag };
