// The data contract. Converts a raw source row into one canonical lead shape.
// Pure, no I/O. NFULL and MFULL use DIFFERENT source-sheet column names (e.g.
// NFULL 'Phone Number' vs MFULL 'Primary Contact', NFULL 'Lead Statement' vs
// MFULL 'Business Note'), sometimes with trailing spaces — so lookups are
// trimmed + case-insensitive and every field has aliases for both schemas.

import { createHash } from 'node:crypto';
import { normalizePermalink, extractPostId } from './fburl.js';
import { firstUkPhone } from './phone.js';

// Legacy exact header constants (kept for reference/back-compat).
export const H = {
  TIMESTAMP: 'Timestamp',
  COMPANY: 'Company Name',
  PHONE: 'Phone Number',
  PROOF_URL: 'Lead Proof URL',
  STATEMENT: 'Lead Statement',
  POSTCODE: 'Post Code (Please Put The Full Postcode, Example: CH41 5LH)',
  ADDR1: 'Address 1 (Road/Street/Lane/Park/Industrial Estate)',
  ADDR2: 'Address 2 (Village/Town/City)',
  PHONE2: 'Phone 2'
};

// The 9 display columns both frontends render (NFULL's vocabulary / order).
export const EXPECTED_HEADERS = [
  'Lead Statement',
  'Timestamp',
  'Company Name',
  'Phone Number',
  'Address 1 (Road/Street/Lane/Park/Industrial Estate)',
  'Address 2 (Village/Town/City)',
  'Phone 2',
  'Post Code (Please Put The Full Postcode, Example: CH41 5LH)',
  'Lead Proof URL'
];

// Field aliases: NFULL verbose names + MFULL sheet names. Matched trimmed+lower.
const ALIASES = {
  timestamp: ['Timestamp'],
  business_name: ['Company Name'],
  phone: ['Phone Number', 'Primary Contact'],
  phone2: ['Phone 2', 'Secondary Contact'],
  phone3: ['Phone 3'],
  url: ['Lead Proof URL'],
  message: ['Lead Statement', 'Business Note'],
  postcode: ['Post Code (Please Put The Full Postcode, Example: CH41 5LH)', 'Post Code', 'Postal Code'],
  town: ['Address 2 (Village/Town/City)', 'Address 2 (Town or City)', 'Address 2'],
  address1: ['Address 1 (Road/Street/Lane/Park/Industrial Estate)', 'Address 1 (Road or Street)', 'Address 1'],
  county: ['County'],
  email: ['Email Address ("." if None)', 'Email Address', 'Email'],
  industry: ['Industry Type', 'Business Type'],
  old_address: ['Old Address? (For relocation, new branch, and moving premises only with no given address)', 'Old Address'],
  posting_date: ['Lead Posting Date']
};

function buildLookup(row) {
  const m = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (k == null) continue;
    m[String(k).trim().toLowerCase()] = v;
  }
  return m;
}

function get(lookup, field) {
  for (const name of ALIASES[field] || []) {
    const v = lookup[name.trim().toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

// MFULL stores "." for "no email".
function cleanEmail(v) {
  if (!v) return null;
  const s = String(v).trim();
  return s === '' || s === '.' ? null : s;
}

function toIso(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function sourceRecordId(source, row) {
  // A source occurrence is a stable row signature, not its URL or phone alone.
  // This preserves distinct NFULL rows that happen to share either value.
  const values = Object.keys(row)
    .filter((k) => !String(k).startsWith('__pipeline_'))
    .sort()
    .map((k) => `${k}=${row[k]}`)
    .join('\u001f');
  return sha256(`${source}|${values}`);
}

/**
 * Give repeated, canonically equivalent source rows stable occurrence
 * ordinals. The ordinal is per row signature, rather than an absolute sheet row
 * number, so inserting an unrelated row above it does not change its identity.
 */
export function tagSourceOccurrences(source, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.every((row) => Number.isInteger(row?.__pipeline_source_occurrence))) return list;

  const seen = new Map();
  return list.map((row) => {
    const clean = { ...(row || {}) };
    delete clean.__pipeline_source_occurrence;
    const baseId = toCanonical(source, clean).source_record_id;
    const occurrence = (seen.get(baseId) || 0) + 1;
    seen.set(baseId, occurrence);
    return { ...clean, __pipeline_source_occurrence: occurrence };
  });
}

/**
 * Source-precedence identity policy:
 * - NFULL is authoritative, so its distinct source rows never merge by phone.
 * - MFULL keeps one row per normalized phone.
 * - A phone-less MFULL row cannot be matched safely, so it keeps a row identity.
 *
 * Cross-source MFULL-vs-NFULL suppression happens during ingestion, where the
 * database can check whether an NFULL phone is already present.
 */
export function dedupKey(source, sourceRecordIdValue, normPhone) {
  if (source === 'NFULL') return `nfull-row:${sourceRecordIdValue}`;
  if (source === 'MFULL' && normPhone) return `mfull-phone:${normPhone}`;
  return `mfull-row:${sourceRecordIdValue}`;
}

/** Map any source row (NFULL or MFULL vocabulary) to the canonical lead. */
export function toCanonical(source, row) {
  const lookup = buildLookup(row);
  const url = get(lookup, 'url');
  const message = get(lookup, 'message');
  const timestamp = get(lookup, 'timestamp');
  const postingDate = get(lookup, 'posting_date');
  const businessName = get(lookup, 'business_name');
  const primaryPhone = get(lookup, 'phone');
  const phone2 = get(lookup, 'phone2');
  const phone3 = get(lookup, 'phone3');
  const postcode = get(lookup, 'postcode');
  const address1 = get(lookup, 'address1');
  const norm_permalink = normalizePermalink(url);
  const post_id = extractPostId(url);
  const norm_phone = firstUkPhone(primaryPhone, phone2, phone3);

  const town = get(lookup, 'town');
  const county = get(lookup, 'county');
  const location = [town, county].filter(Boolean).join(', ') || null;

  // Use the stable cross-adapter fields exposed by the source CSVs. Direct
  // Google rows can contain extra columns, while the legacy CSV adapter returns
  // only display columns; those two paths must still identify the same row.
  const source_record_id = sourceRecordId(source, {
    source_occurrence: Number.isInteger(row?.__pipeline_source_occurrence)
      ? row.__pipeline_source_occurrence
      : null,
    timestamp,
    posting_date: postingDate,
    business_name: businessName,
    phone: primaryPhone,
    phone2,
    message,
    postcode,
    address1,
    town,
    url
  });
  const dedup_key = dedupKey(source, source_record_id, norm_phone);

  return {
    source,
    source_record_id,
    dedup_key,
    post_id,
    url,
    owner_name: null,
    message,
    post_timestamp: toIso(postingDate),
    scrape_timestamp: toIso(timestamp),
    business_name: businessName,
    phone: primaryPhone || phone2,
    phone2,
    email: cleanEmail(get(lookup, 'email')),
    postcode,
    address1,
    location,
    norm_permalink,
    norm_phone,
    raw_payload: row
  };
}

/**
 * Build a lead row in the verbose header vocabulary the validator and both
 * frontends expect, populated from the canonical master (schema-agnostic) plus
 * the merged raw payload for fields the master doesn't retain (address1, phone2,
 * industry, county, old address). Works uniformly for NFULL and MFULL leads.
 */
export function toLeadRow(master, mergedPayload = {}) {
  const lookup = buildLookup(mergedPayload);
  return {
    'Lead Statement': master.message || get(lookup, 'message') || '',
    'Timestamp': master.scrape_timestamp || get(lookup, 'timestamp') || '',
    'Company Name': master.business_name || get(lookup, 'business_name') || '',
    'Phone Number': master.phone || '',
    'Phone 2': master.phone2 || get(lookup, 'phone2') || '',
    'Industry Type': get(lookup, 'industry') || '',
    'Address 1 (Road/Street/Lane/Park/Industrial Estate)': master.address1 || get(lookup, 'address1') || '',
    'Address 2 (Village/Town/City)': get(lookup, 'town') || master.location || '',
    'County': get(lookup, 'county') || '',
    'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': master.postcode || '',
    'Lead Proof URL': master.url || '',
    'Lead Posting Date': master.post_timestamp || '',
    'Old Address? (For relocation, new branch, and moving premises only with no given address)': get(lookup, 'old_address') || '',
    'Email': master.email || ''
  };
}
