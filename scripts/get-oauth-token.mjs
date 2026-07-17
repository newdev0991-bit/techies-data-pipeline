// One-off helper: generate a FRESH Google OAuth token JSON (read-only Sheets) via
// a loopback consent flow, reusing the client_id/client_secret already present in
// the expired token in .env (they don't change). Writes the result to a gitignored
// file — never prints the token to stdout. You then paste it into .env / Render.
//
// Run:  node scripts/get-oauth-token.mjs
// Then: paste .env.new-oauth-token into NFULL_/MFULL_GOOGLE_OAUTH_TOKEN_JSON and run
//       `npm run list:tabs`.
//
// NOTE: log in with a Google account that can OPEN BOTH sheets. And because the
// OAuth app is in "Testing" mode, this token still expires in ~7 days — the durable
// fix is a service account or publishing the OAuth app to Production.
import 'dotenv/config';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const PORT = Number(process.env.OAUTH_PORT || 4180);
const REDIRECT = `http://localhost:${PORT}`;
// Optional label (e.g. `nfull`/`mfull`) → each account's token gets its own file,
// since NFULL and MFULL sheets are owned by different Google accounts.
const LABEL = (process.argv[2] || '').replace(/[^a-z0-9_-]/gi, '');
const OUT = fileURLToPath(new URL(`../.env.new-oauth-token${LABEL ? '.' + LABEL : ''}`, import.meta.url));

function clientCreds() {
  const candidates = [
    process.env.NFULL_GOOGLE_OAUTH_TOKEN_JSON,
    process.env.MFULL_GOOGLE_OAUTH_TOKEN_JSON,
    process.env.GOOGLE_OAUTH_TOKEN_JSON
  ].filter(Boolean);
  for (const raw of candidates) {
    try {
      const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (j.client_id && j.client_secret) return { client_id: j.client_id, client_secret: j.client_secret };
    } catch { /* try next */ }
  }
  if (process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET) {
    return { client_id: process.env.OAUTH_CLIENT_ID, client_secret: process.env.OAUTH_CLIENT_SECRET };
  }
  throw new Error('No client_id/client_secret found in *_GOOGLE_OAUTH_TOKEN_JSON or OAUTH_CLIENT_ID/OAUTH_CLIENT_SECRET.');
}

const { client_id, client_secret } = clientCreds();
const oauth2 = new google.auth.OAuth2(client_id, client_secret, REDIRECT);
const authUrl = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

const server = http.createServer(async (req, res) => {
  const code = (() => { try { return new URL(req.url, REDIRECT).searchParams.get('code'); } catch { return null; } })();
  if (!code) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('waiting for OAuth redirect…'); return; }
  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h2>No refresh_token returned</h2><p>Revoke this app at myaccount.google.com/permissions, then re-run.</p>');
      console.error('\n❌ No refresh_token. Revoke at https://myaccount.google.com/permissions and re-run.');
      server.close(); process.exitCode = 1; return;
    }
    const out = {
      token: tokens.access_token || '',
      refresh_token: tokens.refresh_token,
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id, client_secret,
      scopes: SCOPES,
      universe_domain: 'googleapis.com',
      account: '',
      expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : ''
    };
    writeFileSync(OUT, JSON.stringify(out), { mode: 0o600 });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h2>✅ Fresh token saved</h2><p>Return to your terminal — you can close this tab.</p>');
    console.log(`\n✅ Fresh token written to: ${OUT}`);
    console.log('   → paste its contents (single-quoted) into .env as BOTH:');
    console.log('       NFULL_GOOGLE_OAUTH_TOKEN_JSON=\'<contents>\'');
    console.log('       MFULL_GOOGLE_OAUTH_TOKEN_JSON=\'<contents>\'');
    console.log('   → then run:  npm run list:tabs');
    server.close();
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error: ' + err.message);
    console.error('\n❌ ' + err.message);
    if (/redirect_uri_mismatch/i.test(err.message)) {
      console.error('   → Your OAuth client rejects the loopback redirect. Either make it a');
      console.error(`     "Desktop app" client, or add ${REDIRECT} to its Authorized redirect URIs in GCP.`);
    }
    server.close(); process.exitCode = 1;
  }
});

server.listen(PORT, () => {
  console.log(`OAuth helper listening on ${REDIRECT}${LABEL ? `  (label: ${LABEL})` : ''}`);
  console.log('\n1) A browser window will open (or copy the URL below).');
  console.log(`2) Log in with the Google account for${LABEL ? ` the ${LABEL.toUpperCase()} sheet` : ' the sheet(s) you need'}.`);
  console.log('3) Approve the read-only Sheets permission, then return here.\n');
  console.log(authUrl + '\n');
  try { spawn('open', [authUrl], { stdio: 'ignore', detached: true }); } catch { /* no browser auto-open */ }
});
