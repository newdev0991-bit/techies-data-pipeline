// The data contract. Converts a raw source row (NFULL 9-col or MFULL 16-col,
// keyed by the EXACT verbose Google-Sheet headers) into one canonical lead shape.
// Pure, no I/O. These verbose header strings must match the sources exactly and
// must never be renamed (they are shared with techies-validator-backend).

import { createHash } from 'node:crypto';
import { normalizePermalink, extractPostId } from './fburl.js';
import { firstUkPhone } from './phone.js';

// Exact source header names (verbose forms + short fallbacks the validator uses).
export const H = {
  TIMESTAMP: 'Timestamp',
  COMPANY: 'Company Name',
  PHONE: 'Phone Number',
  INDUSTRY: 'Industry Type',
  POSTCODE: 'Post Code (Please Put The Full Postcode, Example: CH41 5LH)',
  POSTCODE_SHORT: 'Post Code',
  OLD_ADDRESS: 'Old Address? (For relocation, new branch, and moving premises only with no given address)',
  ADDR1: 'Address 1 (Road/Street/Lane/Park/Industrial Estate)',
  ADDR1_SHORT: 'Address 1',
  ADDR2: 'Address 2 (Village/Town/City)',
  ADDR2_SHORT: 'Address 2',
  COUNTY: 'County',
  PHONE2: 'Phone 2',
  PHONE3: 'Phone 3',
  PROOF_URL: 'Lead Proof URL',
  POSTING_DATE: 'Lead Posting Date',
  PHONE_URL: 'Phone Number URL',
  STATEMENT: 'Lead Statement',
  SPECIALIST: 'Lead Generation Specialist'
};

// The 9 display columns both frontends render (NFULL's EXPECTED_HEADERS order).
// The public read API returns rows shaped with exactly these keys.
export const EXPECTED_HEADERS = [
  H.STATEMENT,
  H.TIMESTAMP,
  H.COMPANY,
  H.PHONE,
  H.ADDR1,
  H.ADDR2,
  H.PHONE2,
  H.POSTCODE,
  H.PROOF_URL
];

function pick(row, ...keys) {
  for (const k of keys) {
    const v = row?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

// Parse a loose sheet timestamp to an ISO string, or null. We do not guess a
// timezone: if the value lacks one, Postgres stores it as given. Invalid -> null
// (the original is always retained in raw_payload).
function toIso(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Synthesize a stable source_record_id. Prefers the normalized proof URL so the
 * same row re-imported upserts rather than duplicates; falls back to a hash of
 * the whole row when no usable URL is present.
 */
export function sourceRecordId(source, row, normPermalink) {
  if (normPermalink) return sha256(`${source}|${normPermalink}`);
  const values = Object.keys(row)
    .sort()
    .map((k) => `${k}=${row[k]}`)
    .join('');
  return sha256(`${source}|${values}`);
}

/**
 * Map a raw source row object to the canonical lead. `source` is 'NFULL'|'MFULL'.
 * Works for both the 9-col and 16-col shapes because it looks up fields by name.
 */
export function toCanonical(source, row) {
  const url = pick(row, H.PROOF_URL);
  const norm_permalink = normalizePermalink(url);
  const post_id = extractPostId(url);
  const norm_phone = firstUkPhone(
    pick(row, H.PHONE),
    pick(row, H.PHONE2),
    pick(row, H.PHONE3)
  );

  const town = pick(row, H.ADDR2, H.ADDR2_SHORT);
  const county = pick(row, H.COUNTY);
  const location = [town, county].filter(Boolean).join(', ') || null;

  return {
    source,
    source_record_id: sourceRecordId(source, row, norm_permalink),
    post_id,
    url,
    owner_name: null, // page/profile name not present in the source columns
    message: pick(row, H.STATEMENT),
    post_timestamp: toIso(pick(row, H.POSTING_DATE)), // MFULL only; null for NFULL
    scrape_timestamp: toIso(pick(row, H.TIMESTAMP)),
    business_name: pick(row, H.COMPANY),
    phone: pick(row, H.PHONE, H.PHONE2, H.PHONE3),
    email: null, // no email column in either source
    postcode: pick(row, H.POSTCODE, H.POSTCODE_SHORT),
    location,
    norm_permalink,
    norm_phone,
    raw_payload: row
  };
}
