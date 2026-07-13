// Money-free stand-in for techies-validator-backend. Mocks /fetch-results and
// /analyze so the worker's 3-layer flow can be verified without OpenAI/Apify.
// Decision is keyed off the company name so tests are deterministic.
import http from 'node:http';

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

function analyzeFor(lead) {
  const name = String(lead['Company Name'] || '').toLowerCase();
  const caption = {
    has_opening_keywords: /opening|now open/i.test(lead['Lead Statement'] || ''),
    has_relocation_keywords: /moved|relocat/i.test(lead['Lead Statement'] || ''),
    has_ownership_keywords: /new management|taken over/i.test(lead['Lead Statement'] || ''),
    has_minor_update_keywords: /new menu|renovated/i.test(lead['Lead Statement'] || ''),
    summary: 'mock'
  };
  const base = {
    reasoning: 'mock decision', confidence: 90,
    key_factors: ['mock factor'], red_flags: [], recommended_action: 'mock',
    caption_analysis: caption,
    post_history_analysis: { total_posts: 5, page_maturity: 'new', posting_pattern: 'mock', assessment: 'mock' }
  };
  if (name.includes('corner')) return { ...base, verdict: 'BAD', opportunity_score: 20 };
  if (name.includes('beacon')) return { ...base, verdict: 'GOOD', opportunity_score: 60 };
  if (name.includes('edu')) return { ...base, verdict: 'GOOD', opportunity_score: 90 }; // AI likes it; rules flag education
  return { ...base, verdict: 'GOOD', opportunity_score: 88 }; // default -> APPROVED
}

export function startMockValidator(port) {
  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const lead = body.lead || {};
    const name = String(lead['Company Name'] || '').toLowerCase();

    if (req.url.startsWith('/fetch-results')) {
      const iso = new Date().toISOString();
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        success: true, postDate: iso, postUrl: lead['Lead Proof URL'] || null,
        postText: lead['Lead Statement'] || null, status: 'success',
        previousPosts: ['p1', 'p2'],
        rawData: { posted_at_iso: iso, previousPosts: ['p1', 'p2'], postText: lead['Lead Statement'] || null }
      }));
    }

    if (req.url.startsWith('/analyze')) {
      if (name.includes('boom')) { // simulate a persistent upstream failure
        return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'mock upstream error' }));
      }
      const decision = analyzeFor(lead);
      return res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ content: [{ text: JSON.stringify(decision) }] }));
    }

    res.writeHead(404).end('not found');
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && process.argv[1].endsWith('mock-validator.mjs')) {
  const port = Number(process.argv[2] || 4600);
  startMockValidator(port).then(() => console.log(`[mock-validator] listening on ${port}`));
}
