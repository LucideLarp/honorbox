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
      // Repo-relative names keep forward slashes on every OS: claims are
      // registered under 'pages/x.md', and path.join would hand back
      // 'pages\x.md' on Windows, which matches no registered claim.
      if (f.endsWith('.md')) out.push(`${dir}/${f}`);
    }
  }
  out.push('store.config.json', 'README.md');
  return out.filter((f) => fs.existsSync(path.join(ROOT, f)));
}

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Runs of whitespace are flattened before any claim is compared, because prose
// wraps. Comparing raw text would mean a claim stayed "true" only until someone
// reflowed the paragraph, which is the same class of invisible breakage this
// file exists to catch: a line-based reader cannot see a sentence that spans
// two lines, and half the claims here do.
const flat = (s) => s.replace(/\s+/g, ' ');

// Negation, read against the words immediately before a matched verb or noun.
// Several guards below need it, because in every one of them denying the claim
// is the correction rather than the offence.
const NEGATION_BEFORE = /\b(no|not|never|cannot|can't|doesn't|don't|without)\b[^.]{0,12}$/i;

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

// Where the evidence doc came from, as opposed to what it shows.
//
// pro-evidence.md carried a stats line reading "14 orders, gross 406.00 USD,
// 1 refund" under the heading "rendered from the live Stripe account", and a
// reconcile block introduced as "Real output. One edit, and only this one...
// Nothing else is changed: not a date, not a status" above rows for
// @ada-example and @grace-example buying a product called Widget Pro.
//
// Those two cannot both be well. Either the figures were ours, and we published
// our own revenue on the page a launch links to, or they were invented, and the
// page insisting on its own literal accuracy was the least accurate thing on
// it. It is the audit surface for a blind purchase, so a false provenance claim
// there costs more than the same claim anywhere else.
//
// The rule that removes both failure modes at once is about provenance, not
// figures: illustrative output is how these docs should teach, so the numbers
// stay. What may never be claimed is that any of it came from OUR live store.
// Claim it and the sentence is either a leak or a lie.
// "real output FORMAT" is the honest claim and has to survive, so the noun
// after the phrase is part of what is matched. Saying we reproduce the format
// is a promise about shape; saying we reproduce the output is a promise about
// provenance, and only the second one can be a leak or a lie.
const LIVE_PROVENANCE = [
  /\b(run|ran|rendered|generated|measured|captured|taken)\s+(against|from|on)\s+(the|our)\s+live\b/i,
  /\bagainst\s+(the\s+)?live\s+\w*\s*(store|account)\b/i,
  /\bfrom\s+the\s+live\s+stripe\s+account\b/i,
  /\breal\s+output\b(?!\s*\**\s*format)/i,
  /\bour\s+(live\s+)?(stripe\s+)?account'?s?\s+(own\s+)?(data|numbers|figures|revenue)\b/i,
];

test('public copy never presents our own live data as evidence', () => {
  const hits = [];
  for (const f of publicSources()) {
    flat(read(f)).split(/(?<=[.!?])\s+/).forEach((sentence) => {
      for (const re of LIVE_PROVENANCE) {
        const m = sentence.match(re);
        // Denying the claim is the correction, not the offence: "it is
        // deliberately not our account's data" has to read as safe, the same
        // way the invitation-cap guard lets a doc rebut GitHub's wording.
        if (!m || NEGATION_BEFORE.test(sentence.slice(0, m.index))) continue;
        hits.push(`${f}  ${sentence.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(hits, [],
    'this claims the output shown came from our own live store or account. If ' +
    'it is true it publishes our operating data; if it is not it is a false ' +
    'claim on the page buyers audit us by. Show the format on synthetic data ' +
    'and say so:\n  ' + hits.join('\n  '));
});

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

// Section numbers move. Inserting one step into setup.md renumbered six
// references across three files today, two of them in code comments that no
// test could see. A link to a heading that no longer exists is a dead link on
// a published page, and we have shipped one before: docs/setup.md pointed at
// its own cost section for days while the headings emitted no anchors at all.
test('every doc link points at a heading that exists', () => {
  const docs = path.join(ROOT, 'docs');
  if (!fs.existsSync(docs)) return;
  const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-');
  const headings = {};
  for (const f of fs.readdirSync(docs).filter((f) => f.endsWith('.md'))) {
    const body = fs.readFileSync(path.join(docs, f), 'utf8');
    headings[f] = new Set([...body.matchAll(/^#+\s+(.+)$/gm)].map((m) => slug(m[1])));
  }
  const dead = [];
  for (const f of Object.keys(headings)) {
    const body = fs.readFileSync(path.join(docs, f), 'utf8');
    for (const m of body.matchAll(/\]\(([a-z0-9.-]*\.md)?#([a-z0-9-]+)\)/g)) {
      const target = m[1] || f;
      if (headings[target] && !headings[target].has(m[2])) dead.push(`${f} -> ${target}#${m[2]}`);
    }
  }
  assert.deepEqual(dead, [], `doc links pointing at headings that do not exist:\n  ${dead.join('\n  ')}`);
});

// The "move your repo to an organization to lift the 50/day invitation cap"
// claim was false and shipped in three places: two prose sections and a table
// row inside a file whose prose had already been corrected. It is false twice
// over. Org invitations are capped too, and org membership lets every buyer
// enumerate every other buyer.
//
// What this bans is the INSTRUCTION, not the topic. Docs stay free to quote
// GitHub's "no limit for organization members" wording in order to rebut it,
// and to say plainly that the ceiling cannot be removed. The harm is only in
// telling a seller to migrate: they do the work, gain nothing, and expose
// their buyer list.
//
// Negation is checked against the lifting verb, not the sentence. A sentence
// scoped check reads "that ceiling is lifted by moving to an organization, NOT
// by delivering faster" as safe, because it finds a "not" that is negating
// something else entirely. Negation binds to a verb, so that is where to look.
// A seller can be told the ceiling is gone in two grammatically opposite ways,
// and the first version of this test only understood one of them. It looked for
// a LIFTING VERB ("moving to an org lifts the cap") and treated a negation in
// front of that verb as the rebuttal, which is right for that shape. But the
// claim can equally be made by naming the limit and denying it: "inviting org
// members to an org repo has no cap". There the negation is the harmful part,
// so a test that reads "no" as a rebuttal scores the worst sentence as the
// safest one. It shipped in docs/setup.md for exactly that reason, in a file
// whose other section already rebutted it correctly, while this suite stayed
// green.
//
// So negation is read against two vocabularies with opposite polarity:
//   lifting verbs  (lift, remove, uncapped) are harmful when NOT negated
//   limit nouns    (cap, limit, ceiling)    are harmful when negated
// Both are scoped to a sentence that also tells the seller to MOVE to an
// organization, which is what keeps GitHub's own "no limit if you are inviting
// organization members" wording quotable in order to rebut it: that sentence
// says "inviting", not "moving", so it never reaches either vocabulary.
const LIFT_VERBS = /\b(lift|lifts|lifted|remove|removes|removed|uncapped?)\b/gi;
const LIMIT_NOUNS = /\b(cap|capped|caps|limit|limits|limited|ceiling|restriction)\b/gi;

test('no doc tells a seller to move to an organization to lift the cap', () => {
  const MOVE_TO_ORG = /\b(move|moving|migrate|migrating|put|putting|host)\b[^.]{0,90}\borgani[sz]ation\b/i;

  const offenders = [];
  for (const file of publicSources()) {
    // Splitting too eagerly only shrinks the window, so it can raise a false
    // alarm but never hide a real one. Table cells split on the pipe likewise.
    for (const sentence of read(file).split(/(?<=[.!?])\s+|\n\s*\n|\|/)) {
      if (!MOVE_TO_ORG.test(sentence)) continue;
      const negated = (m) => NEGATION_BEFORE.test(sentence.slice(0, m.index));
      // One asserted lift is enough to mislead, however the rest of it reads.
      const asserted = [
        ...[...sentence.matchAll(LIFT_VERBS)].filter((m) => !negated(m)),
        ...[...sentence.matchAll(LIMIT_NOUNS)].filter((m) => negated(m)),
      ];
      if (!asserted.length) continue;
      offenders.push(`${file}: ${sentence.trim().replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }

  assert.deepEqual(offenders, [],
    'moving to an organization does not lift the 50/day invitation cap: org ' +
    'invites are capped too, and org membership lets every buyer enumerate ' +
    'every other buyer. Sending a seller to migrate costs them the work and ' +
    'their buyers the privacy:\n  ' + offenders.join('\n  '));
});

// The same false claim, caught by what it ASSERTS rather than by what it
// recommends. The test above models a bad sentence as "a lifting verb that
// nothing negates", and that model has one blind spot it cannot see out of:
// the claim can be made entirely in the negative. On 2026-07-20 it came back
// as "move the product repo into a GitHub organization first: organizations
// are free, and inviting org members to an org repo HAS NO CAP", which the
// guard read as safe because it found a negation in front of the only token it
// recognised. "Does not lift the cap" and "has no cap" are both negations, and
// they mean opposite things, so negation cannot be the discriminator.
//
// What is actually dangerous is the bare proposition "an organization repo is
// uncapped", because a seller who reads it migrates and gains nothing. The
// proposition is TRUE of people who are already organization members, which is
// exactly why it keeps being repeated and exactly why it keeps misleading. So
// the rule is not "never say it": it is that saying it obliges you to say who
// it applies to, in the same breath.
test('an "organization repos are uncapped" claim must name who it applies to', () => {
  // Asserting the absence of a cap, however the sentence is worded.
  const NO_CAP = /\b(no (cap|limit)|uncapped|not capped|without a (cap|limit))\b/i;
  const ORG = /\borgani[sz]ation|\borg\b/i;
  // The qualifier that makes it true. GitHub's exemption covers EXISTING
  // members, and a buyer who just paid is not one; any honest use of this
  // sentence has to carry that, and every correct use in our docs does.
  const QUALIFIED = /\balready\b/i;

  const offenders = [];
  for (const file of publicSources()) {
    // Blockquoted lines are dropped before splitting, because this rule is
    // about what WE assert and a blockquote is what GitHub said. how-it-works
    // quotes the limit and its organization-member exception verbatim and then
    // spends a section rebutting it, which is the correct way to handle a true
    // sentence that misleads. Prose around the quote is still checked, so the
    // rebuttal itself cannot go missing without one of these guards noticing.
    const ours = read(file).split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
    for (const sentence of ours.split(/(?<=[.!?])\s+|\n\s*\n|\|/)) {
      if (!NO_CAP.test(sentence) || !ORG.test(sentence)) continue;
      if (QUALIFIED.test(sentence)) continue;
      offenders.push(`${file}: ${sentence.trim().replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }

  assert.deepEqual(offenders, [],
    'an organization repo is only uncapped for people who are ALREADY org ' +
    'members, and creating that membership is itself capped. Stating it ' +
    'unqualified is the claim that sent a seller off to migrate for nothing. ' +
    'Say who it applies to in the same sentence:\n  ' + offenders.join('\n  '));
});

// ---------- How big we say the engine is ------------------------------------
// The single most repeated defect in this repo. "About 170 lines" survived
// until an outside reviewer measured it against a 359-line file, and at the
// time this guard was written the same claim was wrong in four more places at
// once: "under 300 lines" twice, "354 dependency-free lines" twice, and a
// breakdown into "a 190-line driver on a 164-line pure core" whose core had
// since grown to 407. Nobody edits a file and then goes looking for the five
// pages that describe its size, so the number rots the moment the code moves,
// and it rots in the direction that flatters us.
//
// Grep cannot police this. Two of the five read "354 dependency-free lines",
// where an adjective sits between the number and the noun, so a line-based
// search for a digit next to "lines" walks straight past them.
//
// The fix is to stop storing the number in prose at all. Every size sentence we
// publish is BUILT here from a live `wc -l`, and the doc has to contain the
// string this produces. A refactor that moves a line makes this test name the
// exact file and the exact sentence to update, in the same run that CI already
// gates the push on.
const lineCount = (f) => {
  const body = read(f);
  const n = body.split('\n').length;
  return body.endsWith('\n') ? n - 1 : n;
};

const ENGINE = {
  driver: 'scripts/fulfill.js',
  core: 'scripts/lib/fulfill-core.js',
  relayWorkers: 'webhook-mode/relay-cloudflare.mjs',
  relayNode: 'webhook-mode/relay-node.mjs',
};

// The claims we publish, each as the exact text the doc must carry. Anything
// matching the size-claim shape that is NOT one of these fails the test below,
// so a newly written size sentence has to be registered here before it can
// ship, and registering it is what keeps it true afterwards.
function sizeClaims() {
  const driver = lineCount(ENGINE.driver);
  const core = lineCount(ENGINE.core);
  const workers = lineCount(ENGINE.relayWorkers);
  const node = lineCount(ENGINE.relayNode);
  return [
    { file: 'README.md', text: `a ${driver}-line driver on a ${core}-line pure logic core` },
    { file: 'docs/least-privilege.md', text: `${driver} lines, read it` },
    { file: 'docs/instant-delivery.md', text: `${workers} lines on Cloudflare Workers and ${node} on Node` },
    { file: 'webhook-mode/README.md', text: `${workers}-line relay (${node} lines on Node)` },
    {
      file: 'pages/deliver-digital-products-github.md',
      text: `${driver + core} dependency-free lines you can read before trusting: a ${driver}-line driver on a ${core}-line pure core`,
    },
    { file: 'pages/sell-code-without-a-marketplace.md', text: `${driver + core} dependency-free lines of` },
  ];
}

test('every published line count matches the file it describes', () => {
  // A fork that followed the README has deleted our pages/, and a claim about
  // prose that no longer ships has nothing to be wrong about. The upstream
  // store ships every registered file, so the filter passes everything there.
  const shipped = sizeClaims().filter((c) => fs.existsSync(path.join(ROOT, c.file)));
  const wrong = shipped.filter((c) => !flat(read(c.file)).includes(flat(c.text)));
  assert.deepEqual(wrong.map((c) => `${c.file} must say: ${c.text}`), [],
    'a file changed size and its description did not. Update the prose to the ' +
    'measured value (this list is generated from wc -l, so it is the truth):\n  ' +
    wrong.map((c) => `${c.file} must say: ${c.text}`).join('\n  '));
});

// The other half, and the half that matters for the NEXT one: find every
// sentence shaped like a size claim and require it to be registered above.
// Without this, deleting a claim from sizeClaims() and leaving the stale prose
// in place would pass, which is precisely how a guard becomes decoration.
//
// A size claim is recognised grammatically rather than by pattern-matching
// digits near the word: walk left from "line"/"lines" over at most two
// adjective-ish words and require a number. That reads "354 dependency-free
// lines" and "a 190-line driver" as claims, and correctly declines to read
// "expanding line items", "the lines above are an excerpt (14 of the 18)" or
// "that line is the one to read" as claims, because walking left from those
// reaches a word rather than a number.
const NUMBER_TOKEN = /^~?\d[\d,]*$/;
const FILLER_TOKEN = /^[a-z][a-z-]*$/;

function sizeClaimSpans(body) {
  const spans = [];
  for (const m of body.matchAll(/\b(\d[\d,]*)[- ]lines?\b/gi)) {
    spans.push({ index: m.index, text: m[0] });
  }
  // The adjective case: <number> <adjective>{1,2} lines
  for (const m of body.matchAll(/\blines?\b/gi)) {
    const before = body.slice(Math.max(0, m.index - 60), m.index).trimEnd();
    const tokens = before.split(/\s+/);
    for (let back = 1; back <= 3 && back <= tokens.length; back++) {
      const tok = tokens[tokens.length - back];
      if (NUMBER_TOKEN.test(tok)) {
        spans.push({ index: m.index, text: `${tok} ... ${m[0]}` });
        break;
      }
      if (!FILLER_TOKEN.test(tok)) break;
    }
  }
  return spans;
}

test('every size claim in public copy is one this suite pins', () => {
  const claims = sizeClaims();
  const unregistered = [];
  for (const file of [...publicSources(), 'webhook-mode/README.md']) {
    const body = read(file);
    const pinned = claims.filter((c) => c.file === file).map((c) => c.text);
    for (const span of sizeClaimSpans(body)) {
      // Covered if any pinned string for this file overlaps the claim's line.
      const line = body.slice(0, span.index).split('\n').length;
      const context = flat(body.split('\n').slice(Math.max(0, line - 3), line + 2).join(' '));
      if (pinned.some((p) => context.includes(flat(p)))) continue;
      unregistered.push(`${file}:${line}  ${span.text}`);
    }
  }
  assert.deepEqual(unregistered, [],
    'this reads as a claim about how many lines we ship, and nothing derives ' +
    'it from the file. Add it to sizeClaims() so it is rebuilt from wc -l, or ' +
    'reword it so it states no number:\n  ' + unregistered.join('\n  '));
});
