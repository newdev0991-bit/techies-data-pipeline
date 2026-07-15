// Direct Google Sheets ingestion: read a source's sheet straight from Google
// (same OAuth token the source backend uses), instead of pulling the backend's
// CSV endpoint. This keeps ingestion off the memory-constrained backends.
//
// Raw values are turned into row objects keyed by the sheet's own header row
// (leading blank rows skipped — MFULL's raw export has an empty first row + a
// junk trailing column). The existing toCanonical() then maps either schema.
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

// Service Account (preferred for a headless pipeline — no token expiry). The SA's
// email must be granted read access to the sheet.
function serviceAccountClient(saJson) {
  const info = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  if (!info.client_email || !info.private_key) {
    throw new Error('GOOGLE_SA_JSON missing client_email/private_key');
  }
  return new google.auth.JWT({ email: info.client_email, key: info.private_key, scopes: SCOPES });
}

// OAuth user token (fallback). NOTE: refresh tokens from an OAuth app in "testing"
// publishing status expire after ~7 days (Google), yielding invalid_grant — prefer
// a Service Account, or publish the OAuth app to production.
function oauthClient(tokenJson) {
  const info = typeof tokenJson === 'string' ? JSON.parse(tokenJson) : tokenJson;
  const required = ['client_id', 'client_secret', 'refresh_token'];
  for (const k of required) {
    if (!info[k]) throw new Error(`GOOGLE_OAUTH_TOKEN_JSON missing "${k}"`);
  }
  const client = new google.auth.OAuth2(info.client_id, info.client_secret);
  client.setCredentials({ refresh_token: info.refresh_token, token: info.token, token_uri: info.token_uri });
  return client;
}

function authClient({ saJson, tokenJson }) {
  if (saJson) return serviceAccountClient(saJson);
  if (tokenJson) return oauthClient(tokenJson);
  throw new Error('no Google credentials: set a *_GOOGLE_SA_JSON (preferred) or *_GOOGLE_OAUTH_TOKEN_JSON');
}

/**
 * Convert a raw values matrix (array of arrays) into row objects. The header row
 * is the first row with at least 2 non-empty cells — this skips fully-blank rows
 * AND stray single-cell notes/titles some sheets put above the real headers
 * (e.g. MFULL's "Pure COT please" note in row 0).
 */
export function valuesToRows(values) {
  const rows = values || [];
  const nonEmptyCount = (r) => (r || []).filter((c) => c !== undefined && c !== null && String(c).trim() !== '').length;
  let start = 0;
  while (start < rows.length && nonEmptyCount(rows[start]) < 2) start += 1;
  if (rows.length - start < 2) return [];
  const headers = rows[start].map((h) => String(h ?? ''));
  return rows.slice(start + 1)
    .filter((r) => (r || []).some((c) => c && String(c).trim() !== ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });
      return obj;
    });
}

/**
 * Read a source sheet directly from Google and return row objects.
 * @param {object} cfg { tokenJson, spreadsheetId, range }
 */
// Google A1 notation requires sheet/tab names with spaces or special characters
// to be wrapped in single quotes (embedded quotes doubled). Quote defensively.
export function quoteRange(range) {
  if (!range) return range;
  const i = range.lastIndexOf('!');
  if (i <= 0) return range; // no sheet-name part
  let sheet = range.slice(0, i);
  const cells = range.slice(i + 1);
  if (sheet.startsWith("'") && sheet.endsWith("'")) return range; // already quoted
  sheet = `'${sheet.replace(/'/g, "''")}'`;
  return `${sheet}!${cells}`;
}

export async function readSheetRows({ saJson, tokenJson, spreadsheetId, range }) {
  if (!spreadsheetId) throw new Error('missing spreadsheetId');
  const auth = authClient({ saJson, tokenJson });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: quoteRange(range || 'A:Z')
  });
  return valuesToRows(res.data.values || []);
}

/** List the tab titles of a spreadsheet (for diagnosing range/name issues). */
export async function listSheetTitles({ saJson, tokenJson, spreadsheetId }) {
  const auth = authClient({ saJson, tokenJson });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  return (res.data.sheets || []).map((s) => s.properties.title);
}

// Per-source config from env. Falls back to a shared GOOGLE_OAUTH_TOKEN_JSON if a
// source-specific one isn't set.
export function sourceConfigs() {
  const sharedSa = process.env.GOOGLE_SA_JSON;
  const sharedOauth = process.env.GOOGLE_OAUTH_TOKEN_JSON;
  return [
    {
      name: 'NFULL',
      saJson: process.env.NFULL_GOOGLE_SA_JSON || sharedSa,
      tokenJson: process.env.NFULL_GOOGLE_OAUTH_TOKEN_JSON || sharedOauth,
      spreadsheetId: process.env.NFULL_SPREADSHEET_ID,
      range: process.env.NFULL_SHEET_RANGE || 'Sheet1!A:Z'
    },
    {
      name: 'MFULL',
      saJson: process.env.MFULL_GOOGLE_SA_JSON || sharedSa,
      tokenJson: process.env.MFULL_GOOGLE_OAUTH_TOKEN_JSON || sharedOauth,
      spreadsheetId: process.env.MFULL_SPREADSHEET_ID,
      range: process.env.MFULL_SHEET_RANGE || 'A1:Z'
    }
  ].filter((c) => c.spreadsheetId && (c.saJson || c.tokenJson));
}
