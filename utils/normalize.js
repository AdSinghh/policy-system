/**
 * Field-level cleanup shared by the importer and the search routes.
 *
 * The sample sheet mixes two data generations: synthetic rows with bare 10-digit
 * phone numbers and lowercase names, and what look like real exported rows with
 * "(336) 245-8310", extensions, and SHOUTING NAMES. Normalising on the way in is
 * what makes a lookup key usable later.
 */

/** Collapse internal whitespace and trim. Non-strings become their string form. */
function text(value) {
  if (value === undefined || value === null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).replace(/\s+/g, " ").trim();
}

/** Lowercased `text()` — the form stored in *Key fields and used for lookups. */
function key(value) {
  return text(value).toLowerCase();
}

/** ISO or Date in, UTC-midnight Date out. Unparseable or empty gives null. */
function date(value) {
  const raw = value instanceof Date ? value : text(value);
  if (!raw) return null;

  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }

  // Bare YYYY-MM-DD must not be shifted by the server's local zone.
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (isoDay) {
    const [, y, m, d] = isoDay;
    const parsed = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Numeric fields, distinguishing "absent" from "zero". Returning 0 for a missing
 * premium would quietly drag down every aggregate that averages it.
 */
function number(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Phones arrive as "8677356559", "(336) 245-8310" and
 * "(336) 761-8572 Ext.0012". Keep the original for display, and derive a
 * digits-only form so those three can never be mistaken for different numbers.
 */
function phone(value) {
  const raw = text(value);
  if (!raw) return { phone: null, phoneDigits: null, phoneExtension: null };

  const extMatch = /(?:ext|x|extension)\.?\s*(\d+)/i.exec(raw);
  const extension = extMatch ? extMatch[1] : null;
  const withoutExt = extMatch ? raw.slice(0, extMatch.index) : raw;
  const digits = withoutExt.replace(/\D/g, "");

  return {
    phone: raw,
    phoneDigits: digits || null,
    phoneExtension: extension,
  };
}

/**
 * ZIPs appear as 5-digit and ZIP+4 ("27101-3843"). Always a string — parsing a
 * ZIP as a number eats the leading zero on east-coast codes.
 */
function zip(value) {
  const raw = text(value);
  if (!raw) return { zip: null, zip5: null };
  const digits = raw.replace(/\D/g, "");
  return { zip: raw, zip5: digits ? digits.slice(0, 5) : null };
}

/** Escape user input before it goes anywhere near a RegExp. */
function escapeRegex(value) {
  return text(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drop null/undefined/"" so blank cells never become empty strings in Mongo. */
function compact(object) {
  const out = {};
  for (const [field, value] of Object.entries(object)) {
    if (value === undefined || value === null || value === "") continue;
    out[field] = value;
  }
  return out;
}

module.exports = { text, key, date, number, phone, zip, escapeRegex, compact };
