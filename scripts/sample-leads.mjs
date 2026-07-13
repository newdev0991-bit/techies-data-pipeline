// SYNTHETIC test fixtures only — never real lead data.
// Rows are keyed by the exact verbose Google-Sheet headers each source emits.
// Lead A is deliberately found by BOTH sources (same Facebook post, different
// host + tracking params + business-name/phone formatting) to exercise dedup.

// ---- Lead A: found by BOTH NFULL and MFULL (same post 1000000000000001) ----
export const A_NFULL = {
  'Lead Statement': 'Grand opening this Saturday! Our new cafe on the high street.',
  'Timestamp': '2026-07-12 09:05:00',
  'Company Name': 'ABC Café',
  'Phone Number': '01234 567890',
  'Address 1 (Road/Street/Lane/Park/Industrial Estate)': '10 High Street',
  'Address 2 (Village/Town/City)': 'Birkenhead',
  'Phone 2': '',
  'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'CH41 5LH',
  'Lead Proof URL': 'https://www.facebook.com/abccafe/posts/1000000000000001?fbclid=IwAR_abc123'
};

export const A_MFULL = {
  'Timestamp': '2026-07-12 08:40:00',
  'Company Name': 'ABC Cafe Ltd',
  'Phone Number': '+44 (0)1234 567890',
  'Industry Type': 'Hospitality',
  'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'CH41 5LH',
  'Old Address? (For relocation, new branch, and moving premises only with no given address)': '',
  'Address 1 (Road/Street/Lane/Park/Industrial Estate)': '10 High Street',
  'Address 2 (Village/Town/City)': 'Birkenhead',
  'County': 'Merseyside',
  'Phone 2': '',
  'Phone 3': '',
  'Lead Proof URL': 'https://m.facebook.com/abccafe/posts/1000000000000001',
  'Lead Posting Date': '2026-07-12 08:30:00',
  'Phone Number URL': 'tel:+441234567890',
  'Lead Statement': 'Grand opening this Saturday! Our new cafe on the high street.',
  'Lead Generation Specialist': 'agent-synthetic'
};

// ---- Lead B: NFULL only ----
export const B_NFULL = {
  'Lead Statement': "We've moved! Find our salon at its new premises on Oak Road.",
  'Timestamp': '2026-07-12 10:15:00',
  'Company Name': 'Beacon Beauty',
  'Phone Number': '07123 456789',
  'Address 1 (Road/Street/Lane/Park/Industrial Estate)': 'Oak Road',
  'Address 2 (Village/Town/City)': 'Chester',
  'Phone 2': '',
  'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'CH1 1AA',
  'Lead Proof URL': 'https://www.facebook.com/permalink.php?story_fbid=2000000000000002&id=555'
};

// ---- Lead C: MFULL only ----
export const C_MFULL = {
  'Timestamp': '2026-07-12 11:00:00',
  'Company Name': 'Corner Bistro',
  'Phone Number': '0161 496 0000',
  'Industry Type': 'Restaurant',
  'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'M1 2AB',
  'Address 1 (Road/Street/Lane/Park/Industrial Estate)': '5 Corner Lane',
  'Address 2 (Village/Town/City)': 'Manchester',
  'County': 'Greater Manchester',
  'Phone 2': '',
  'Phone 3': '',
  'Lead Proof URL': 'https://www.facebook.com/cornerbistro/posts/3000000000000003',
  'Lead Posting Date': '2026-07-12 10:45:00',
  'Lead Statement': 'Under new management! The bistro has been taken over.',
  'Lead Generation Specialist': 'agent-synthetic'
};

// ---- Lead D: NFULL, secondary (fuzzy) match to nothing exact but flaggable ----
// Same business + postcode as a hypothetical MFULL record but a missing/rubbish
// URL and differently-formatted phone — should FLAG possible_duplicate, not merge.
export const D_NFULL = {
  'Lead Statement': 'Now open — new bakery in town!',
  'Timestamp': '2026-07-12 12:00:00',
  'Company Name': 'Dockside Bakery',
  'Phone Number': '(0151) 555 9999',
  'Address 1 (Road/Street/Lane/Park/Industrial Estate)': 'Dock Road',
  'Address 2 (Village/Town/City)': 'Liverpool',
  'Phone 2': '',
  'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'L1 8JQ',
  'Lead Proof URL': ''
};

export const D_MFULL = {
  'Timestamp': '2026-07-12 12:10:00',
  'Company Name': 'Dockside Bakery Ltd',
  'Phone Number': '+44 151 555 1234',
  'Industry Type': 'Bakery',
  'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'L1 8JQ',
  'Address 1 (Road/Street/Lane/Park/Industrial Estate)': 'Dock Road',
  'Address 2 (Village/Town/City)': 'Liverpool',
  'County': 'Merseyside',
  'Phone 2': '',
  'Phone 3': '',
  'Lead Proof URL': 'https://www.facebook.com/docksidebakery/posts/4000000000000004',
  'Lead Posting Date': '2026-07-12 11:50:00',
  'Lead Statement': 'Now open — new bakery in town!',
  'Lead Generation Specialist': 'agent-synthetic'
};

// Convenience batches for the smoke test.
export const NFULL_BATCH = [A_NFULL, B_NFULL, D_NFULL];
export const MFULL_BATCH = [A_MFULL, C_MFULL, D_MFULL];
