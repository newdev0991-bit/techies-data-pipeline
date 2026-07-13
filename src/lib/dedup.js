// Deduplication. Given a canonical lead, find-or-create its master_lead using
// EXACT keys (post_id -> permalink -> phone), then FLAG secondary/fuzzy matches
// (business + postcode) for review without ever auto-merging (doc section 3).
import { fingerprint } from './fingerprint.js';

const MASTER_COLUMNS = `
  post_id, url, owner_name, message, post_timestamp, scrape_timestamp,
  business_name, phone, email, postcode, location,
  norm_permalink, norm_phone, fingerprint
`;

// Find an existing master by any present exact key, in priority order.
async function findMasterByExactKeys(client, c) {
  const { rows } = await client.query(
    `SELECT * FROM master_leads
      WHERE (post_id        IS NOT NULL AND post_id        = $1)
         OR (norm_permalink IS NOT NULL AND norm_permalink = $2)
         OR (norm_phone     IS NOT NULL AND norm_phone     = $3)
      ORDER BY
        (post_id        = $1) DESC NULLS LAST,
        (norm_permalink = $2) DESC NULLS LAST,
        (norm_phone     = $3) DESC NULLS LAST,
        id ASC
      LIMIT 1`,
    [c.post_id, c.norm_permalink, c.norm_phone]
  );
  return rows[0] || null;
}

/**
 * Ensure a master_lead exists for this canonical lead.
 * Returns { masterId, created, flaggedDuplicateOf }.
 * - created=true  => a brand-new master was inserted (a genuinely new lead)
 * - created=false => it matched an existing master (a duplicate occurrence)
 */
export async function findOrCreateMaster(client, c) {
  const fp = fingerprint(c);

  // Attempt insert; ON CONFLICT DO NOTHING catches ANY of the three partial-unique
  // exact-key indexes, which is race-safe across concurrent imports.
  const ins = await client.query(
    `INSERT INTO master_leads (${MASTER_COLUMNS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      c.post_id, c.url, c.owner_name, c.message, c.post_timestamp, c.scrape_timestamp,
      c.business_name, c.phone, c.email, c.postcode, c.location,
      c.norm_permalink, c.norm_phone, fp
    ]
  );

  if (ins.rows.length === 0) {
    // Conflicted on an exact key -> an existing master already represents this lead.
    const existing = await findMasterByExactKeys(client, c);
    if (existing) {
      await client.query('UPDATE master_leads SET updated_at = now() WHERE id = $1', [existing.id]);
      return { masterId: existing.id, created: false, flaggedDuplicateOf: null };
    }
    // Extremely unlikely (conflict then vanished); re-raise by trying once more.
    const retry = await client.query(
      `INSERT INTO master_leads (${MASTER_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        c.post_id, c.url, c.owner_name, c.message, c.post_timestamp, c.scrape_timestamp,
        c.business_name, c.phone, c.email, c.postcode, c.location,
        c.norm_permalink, c.norm_phone, fp
      ]
    );
    if (retry.rows.length) return { masterId: retry.rows[0].id, created: true, flaggedDuplicateOf: null };
    const again = await findMasterByExactKeys(client, c);
    return { masterId: again.id, created: false, flaggedDuplicateOf: null };
  }

  const masterId = ins.rows[0].id;

  // New master: check for a secondary/fuzzy match (same business + postcode) on a
  // DIFFERENT master and flag it for human review. Never merge/delete.
  let flaggedDuplicateOf = null;
  if (fp) {
    const match = await client.query(
      `SELECT id FROM master_leads
        WHERE fingerprint = $1 AND id <> $2
        ORDER BY id ASC LIMIT 1`,
      [fp, masterId]
    );
    if (match.rows.length) {
      flaggedDuplicateOf = match.rows[0].id;
      await client.query(
        'UPDATE master_leads SET possible_duplicate_of = $2 WHERE id = $1',
        [masterId, flaggedDuplicateOf]
      );
      await client.query(
        `INSERT INTO audit_logs (entity, entity_id, action, actor, detail)
         VALUES ('master_lead', $1, 'possible_duplicate_flagged', 'system', $2)`,
        [String(masterId), { fingerprint: fp, possible_duplicate_of: flaggedDuplicateOf }]
      );
    }
  }

  return { masterId, created: true, flaggedDuplicateOf };
}
