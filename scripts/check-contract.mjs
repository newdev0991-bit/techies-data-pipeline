// Phase 1 verification (no DB, no network, no cost): proves the pure data-contract
// modules behave. Doc Phase 1 completion: one NFULL row and one MFULL row for the
// same lead convert to the same canonical structure / dedup keys.
import assert from 'node:assert/strict';
import { normalizePermalink, extractPostId } from '../src/lib/fburl.js';
import { normalizeUkPhone } from '../src/lib/phone.js';
import { businessKey, fingerprint } from '../src/lib/fingerprint.js';
import { toCanonical } from '../src/lib/canonical.js';
import { A_NFULL, A_MFULL, B_NFULL } from './sample-leads.mjs';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, `FAILED: ${name}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('fburl.normalizePermalink');
ok('m.facebook host + fbclid == www.facebook canonical',
  normalizePermalink('https://m.facebook.com/abccafe/posts/1000000000000001') ===
  normalizePermalink('https://www.facebook.com/abccafe/posts/1000000000000001?fbclid=IwAR_abc123'));
ok('invalid url -> null', normalizePermalink('not a url at all') === null);

console.log('fburl.extractPostId');
ok('/posts/{id}', extractPostId('https://www.facebook.com/x/posts/1000000000000001') === '1000000000000001');
ok('story_fbid', extractPostId('https://www.facebook.com/permalink.php?story_fbid=2000000000000002&id=555') === '2000000000000002');
ok('pfbid token preferred', extractPostId('https://www.facebook.com/x/posts/pfbid0ABCdef123') === 'pfbid0ABCdef123');

console.log('phone.normalizeUkPhone (doc duplicate example collapses)');
ok('01234567890 == +44 1234 567890',
  normalizeUkPhone('01234567890') === normalizeUkPhone('+44 1234 567890'));
ok('+44 (0)1234 567890 collapses too',
  normalizeUkPhone('+44 (0)1234 567890') === '+441234567890');
ok('mobile 07123 456789 -> +447123456789', normalizeUkPhone('07123 456789') === '+447123456789');
ok('junk -> null', normalizeUkPhone('N/A') === null);
ok('too short -> null', normalizeUkPhone('12345') === null);

console.log('fingerprint (café vs Cafe Ltd)');
ok('ABC Café == ABC Cafe Ltd', businessKey('ABC Café') === businessKey('ABC Cafe Ltd'));

console.log('canonical: same real-world lead from NFULL and MFULL converges');
const a1 = toCanonical('NFULL', A_NFULL);
const a2 = toCanonical('MFULL', A_MFULL);
ok('same canonical keys/shape', JSON.stringify(Object.keys(a1).sort()) === JSON.stringify(Object.keys(a2).sort()));
ok('same normalized permalink', a1.norm_permalink && a1.norm_permalink === a2.norm_permalink);
ok('same post_id', a1.post_id === '1000000000000001' && a2.post_id === '1000000000000001');
ok('same normalized phone', a1.norm_phone === '+441234567890' && a2.norm_phone === '+441234567890');
ok('same business fingerprint identity', businessKey(a1.business_name) === businessKey(a2.business_name));
ok('per-source id differs (source prefix)', a1.source_record_id !== a2.source_record_id);
ok('MFULL has post_timestamp, NFULL does not', a2.post_timestamp !== null && a1.post_timestamp === null);
ok('raw_payload retained', a1.raw_payload === A_NFULL);

const b = toCanonical('NFULL', B_NFULL);
ok('distinct lead has distinct permalink', b.norm_permalink !== a1.norm_permalink);
ok('fingerprint present for located lead', fingerprint(a1) !== null);

console.log(`\nPhase 1 contract: ${passed} checks passed ✅`);
