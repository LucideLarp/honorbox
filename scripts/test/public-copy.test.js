// Guards on what the STORE says, as opposed to whether the builder works.
//
// Everything else in this suite tests behaviour. This file tests claims and
// house style, because that is where our defects have actually been: a
// headline price that was arithmetically false, a docs link that pointed at a
// page we had never published, line counts that went stale three times in one
// day, and a FAQ item that explained our own pricing strategy to customers.
//
// A rule that lives only in someone's memory decays the moment the thing it
// describes moves. These run on every build instead.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Everything a visitor or a buyer can read. dist/ is generated, so checking
// the sources catches it before it is ever built, and the dist check below
// catches anything that reaches the page by another route.
function publicSources() {
  const out = [];
  for (const dir of ['products', 'pages', 'docs']) {
    const d = path.join(ROOT, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.md')) out.push(path.join(dir, f));
    }
  }
  out.push('store.config.json', 'README.md');
  return out.filter((f) => fs.existsSync(path.join(ROOT, f)));
}

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// How many we have sold is nobody's business but ours. The trap is that this
// leaks sideways rather than as a number: "$29 for the first 25 copies" is a
// price sentence that also announces we have sold fewer than 25. It shipped
// on both product pages and read as pricing, not as disclosure, until the
// owner caught it.
const SALES_STATE = [
  /first\s+\d+\s+copies/i,
  /first\s+(ten|twenty|twenty-five|fifty|hundred)\s+copies/i,
  /after\s+those\s+are\s+sold/i,
  /copies\s+(sold|remaining|left)/i,
  /\b\d+\s+(sales|orders|customers|buyers)\s+(so far|to date)/i,
  /(sold|shipped)\s+\d+\s+(copies|licen[cs]es)/i,
];

// OUR OWN operating data, as distinct from an example store's. This is the
// rule that got broken worst: a sample run of `reconcile` against the real
// account was pasted into the Pro page as proof, so the live sales page told
// every visitor we had collected nothing and that our ledger's sales were
// fake. It read as a transparency win while being exactly the disclosure our
// own rules forbid.
//
// Illustrative output is fine and is how these docs should teach. What is
// never fine is OUR numbers, OUR identities, or OUR live object ids. Example
// data must be obviously synthetic: placeholder handles and XXXX-style ids.
const OUR_OWN_DATA = [
  /\bLucideLarp\b/,                       // our GitHub identity
  /\bHonorboxx\/(honorbox-pro|crew-full)\b(?=[^\n]*@)/,  // our product repo beside a buyer handle
  /cs_live_(?!X)[A-Za-z0-9]{6,}/,         // a real Stripe session id (synthetic uses XXXX)
  /"total_sales"\s*:\s*\d+/,              // a ledger value, quoted
  /\b(run\s+)?against\s+our\s+own\s+(store|account)\b/i, // the phrase that framed the leak
  /\bour\s+(sales\s+)?ledger\s+(records|says|shows)\b/i,
  /\bwe\s+have\s+(collected|sold|made)\b/i,
];

test('public copy contains none of our own operating data', () => {
  const hits = [];
  for (const f of publicSources()) {
    const body = read(f);
    body.split('\n').forEach((line, i) => {
      for (const re of OUR_OWN_DATA) {
        if (re.test(line)) hits.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `our own data on a public surface:\n  ${hits.join('\n  ')}`);
});

test('public copy states no sales figures and no sales state', () => {
  const hits = [];
  for (const f of publicSources()) {
    const body = read(f);
    body.split('\n').forEach((line, i) => {
      for (const re of SALES_STATE) {
        if (re.test(line)) hits.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `sales state on a public surface:\n  ${hits.join('\n  ')}`);
});

// We reason about pricing psychology, funnels and conversion constantly. None
// of it belongs in front of a customer. The removed FAQ did not just state the
// ladder, it explained why we had chosen it and why we had left a counter off
// the page, which tells a reader they are being managed.
// Deliberately NOT a vocabulary blocklist. The first draft of this flagged
// "launch price" and "upsell treadmill" and caught two innocent lines: the Pro
// page listing the playbook's chapters, and a buyer-facing promise not to
// nickel and dime anyone. Pricing words are legitimate here because a pricing
// playbook is part of what Pro sells. A guard that cries wolf gets switched
// off, so these match the SHAPE of us narrating ourselves, not the topic.
const INTERNAL_REASONING = [
  /why\s+(does|do|did)\s+(the|our|we)\s+(price|pricing)/i,  // the FAQ that started this
  /why\s+we\s+(price|charge|chose|decided)/i,
  /\bour\s+(margin|pricing strategy|positioning|conversion)\b/i,
  /because\s+a\s+number\s+nobody\s+can\s+audit/i,           // the exact sentence that shipped
  /\bwe\s+(decided|chose)\s+(not\s+)?to\s+(show|put|add|display)\b/i,
];

test('public copy does not explain our own commercial reasoning', () => {
  const hits = [];
  for (const f of publicSources()) {
    // The playbook and evidence docs teach pricing to BUYERS as the product;
    // that is the thing they paid for, not us thinking out loud.
    if (/pro-evidence|playbook/i.test(f)) continue;
    const body = read(f);
    body.split('\n').forEach((line, i) => {
      for (const re of INTERNAL_REASONING) {
        if (re.test(line)) hits.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `internal commercial reasoning on a public surface:\n  ${hits.join('\n  ')}`);
});

// The sources can be clean while the built page is not: a section type, a
// theme layout or a config string can put text on the page that never appears
// in products/ or pages/. Check what actually ships, when it exists.
test('the built store carries neither, if it has been built', () => {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) return; // build not run in this environment
  const hits = [];
  for (const f of fs.readdirSync(dist)) {
    if (!f.endsWith('.html')) continue;
    const body = fs.readFileSync(path.join(dist, f), 'utf8');
    for (const re of [...SALES_STATE, ...INTERNAL_REASONING, ...OUR_OWN_DATA]) {
      const m = body.match(re);
      if (m) hits.push(`dist/${f}  ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], `leaked into the built store:\n  ${hits.join('\n  ')}`);
});

// ---------- House style: no long dashes --------------------------------------
// Heavy em dash use is the most recognisable tell of machine-written prose, so
// we ship none: not in copy, not in a comment, not in a workflow file. A comma,
// a colon, a full stop or brackets says the same thing without the tell.
//
// Both long dashes are barred, and the reason they are handled together is that
// splitting them needs a heuristic. The em dash (U+2014) is never legitimate
// here. The en dash (U+2013) is only ever barred when it does a comma's job,
// which no checker can tell from a genuine range, so we sidestep the judgement
// call: ranges are written with the ordinary hyphen ("6-12 months"), which
// leaves any en dash in the tree a defect by construction.
//
// The plain hyphen is untouched, in compound words, flags, file names, code and
// URLs, because only these two codepoints are matched. A minus sign is a third
// character again and is likewise never matched.
//
// Built from codepoints rather than typed, because this file sits inside the
// tree it scans: a literal here is a hit on itself. The first run of this test
// proved that by failing on its own definition.
const LONG_DASHES = [String.fromCodePoint(0x2014), String.fromCodePoint(0x2013)];

// Binary and third-party files. assets/fonts/ holds the upstream OFL licence
// texts, which we are not free to reword, so a dash arriving there is not our
// defect to fix and must not be able to fail our suite.
const NOT_OUR_PROSE = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot)$|^assets\/fonts\//;

// Files whose copy this lane does not own. Each still has to be cleaned; until
// then it is named here with a reason, so the debt sits in the suite instead of
// in somebody's memory.
//
// Asserted in BOTH directions on purpose. Nothing outside the list may carry an
// em dash, and every file inside it must still carry one, so cleaning a file
// fails this test until its entry is deleted. That is what stops a quarantine
// list quietly turning into the place exceptions go to live forever.
const LONG_DASH_QUARANTINE = {
  'scripts/fulfill.js': 'money path; edits route through the engine lane',
  'scripts/lib/fulfill-core.js': 'money path, and its log strings are asserted in fulfill-driver.test.js',
  'scripts/lib/imgsize.js': 'the engine lane owns scripts/lib',
  'scripts/lib/md.js': 'the engine lane owns scripts/lib',
  'scripts/test/fulfill-driver.test.js': 'three regexes match fulfill-core.js log strings; both sides have to move together',
  'webhook-mode/relay-cloudflare.mjs': 'deployed relay; edits route through the engine lane',
  'webhook-mode/relay-node.mjs': 'deployed relay; edits route through the engine lane',
};

// posix separators throughout, so the quarantine keys above read the same and
// compare the same on Windows as they do here.
function walk(rel, out = []) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(child, out);
    else if (!NOT_OUR_PROSE.test(child)) out.push(child);
  }
  return out;
}

// Everything else we ship: the engine, the themes, the workflows a seller
// copies, and the relays. publicSources() already covers the prose.
function shippedSources() {
  const out = [];
  for (const dir of ['scripts', 'themes', 'setup', 'webhook-mode', 'assets', 'static', '.github']) {
    walk(dir, out);
  }
  for (const f of ['package.json', 'LICENSE']) {
    if (fs.existsSync(path.join(ROOT, f))) out.push(f);
  }
  return out;
}

const hasLongDash = (s) => LONG_DASHES.some((d) => s.includes(d));

function longDashHits(files) {
  const hits = [];
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => {
      if (hasLongDash(line)) hits.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  return hits;
}

test('public copy carries no long dashes', () => {
  const hits = longDashHits(publicSources());
  assert.deepEqual(hits, [], `long dash on a public surface, use a comma, colon, full stop or brackets (ranges take a plain hyphen):\n  ${hits.join('\n  ')}`);
});

test('shipped source carries no long dashes outside the quarantine', () => {
  const hits = longDashHits(shippedSources().filter((f) => !(f in LONG_DASH_QUARANTINE)));
  assert.deepEqual(hits, [], `long dash in shipped source, use a comma, colon, full stop or brackets (ranges take a plain hyphen):\n  ${hits.join('\n  ')}`);
});

test('the long dash quarantine lists only files that still need cleaning', () => {
  const stale = Object.keys(LONG_DASH_QUARANTINE).filter((f) => {
    const abs = path.join(ROOT, f);
    return !fs.existsSync(abs) || !hasLongDash(fs.readFileSync(abs, 'utf8'));
  });
  assert.deepEqual(stale, [], `clean already, so delete these entries from LONG_DASH_QUARANTINE:\n  ${stale.join('\n  ')}`);
});

test('the built store carries no long dashes, if it has been built', () => {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) return; // build not run in this environment
  const hits = [];
  for (const f of fs.readdirSync(dist)) {
    if (!f.endsWith('.html')) continue;
    fs.readFileSync(path.join(dist, f), 'utf8').split('\n').forEach((line, i) => {
      if (hasLongDash(line)) hits.push(`dist/${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], `long dash reached the built store:\n  ${hits.join('\n  ')}`);
});
