// Thin client for the existing techies-validator-backend. We REUSE its endpoints
// rather than duplicating its Apify/OpenAI/prompt logic (see plan Milestone 2):
//   POST /fetch-results  -> Facebook evidence (freshness, post history)
//   POST /analyze        -> AI decision (verdict + opportunity_score + analysis)
// Both take { lead: <row keyed by the verbose Google-Sheet headers> }.

function withTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(t) };
}

async function postJson(url, body, ms) {
  const { signal, done } = withTimeout(ms);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`validator HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.retriable = res.status >= 500 || res.status === 429;
      throw err;
    }
    return text;
  } catch (err) {
    if (err.name === 'AbortError') { err.retriable = true; }
    throw err;
  } finally {
    done();
  }
}

/** Fetch Facebook evidence for a lead. Returns the parsed /fetch-results object. */
export async function fetchEvidence(baseUrl, leadRow, ms = 480000) {
  const text = await postJson(`${baseUrl.replace(/\/$/, '')}/fetch-results`, { lead: leadRow }, ms);
  return JSON.parse(text);
}

/** Run the AI decision. Returns the parsed enriched response object. */
export async function analyzeLead(baseUrl, leadRow, ms = 60000) {
  const text = await postJson(`${baseUrl.replace(/\/$/, '')}/analyze`, { lead: leadRow }, ms);
  const outer = JSON.parse(text);
  // Contract: { content: [ { text: "<stringified decision JSON>" } ] }
  let inner = outer?.content?.[0]?.text;
  if (typeof inner !== 'string') {
    // tolerate a raw object too
    return outer;
  }
  inner = inner.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(inner);
}
