// Guards on the theme toggle.
//
// A manual toggle has to beat `prefers-color-scheme`, and CSS gives no way to
// say "these two selectors share one body". So the dark palette is written
// twice: once for readers whose system asks for dark, once for readers who
// picked dark themselves. Two copies of the same values is a drift bug waiting
// to happen, and the worst kind, because it only shows up for people whose
// setup differs from whoever last edited the file.
//
// These tests hold the copies together and keep the control honest: it is
// hidden until the script that gives it behaviour has run, and it never
// depends on JS to render the page itself.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const CSS = fs.readFileSync(path.join(ROOT, 'themes/stand/style.css'), 'utf8');
const LAYOUT = fs.readFileSync(path.join(ROOT, 'themes/stand/layout.html'), 'utf8');

// Pull the declarations out of a rule, normalised, so ordering and whitespace
// differences do not read as drift but a changed value does.
function declarations(css, selector) {
  const i = css.indexOf(selector);
  assert.ok(i !== -1, `selector not found: ${selector}`);
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  assert.ok(open !== -1 && close !== -1, `unterminated rule: ${selector}`);
  return css
    .slice(open + 1, close)
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .sort();
}

test('the two dark palettes stay identical', () => {
  const viaSystem = declarations(CSS, ':root:not([data-theme="light"])');
  const viaChoice = declarations(CSS, ':root[data-theme="dark"]');

  assert.ok(viaSystem.length > 0, 'system dark palette is empty');
  assert.deepStrictEqual(
    viaChoice,
    viaSystem,
    'the manual dark palette has drifted from the system one; a reader who ' +
      'picks dark would see different colours from one who has it set in the OS'
  );
});

test('an explicit choice narrows color-scheme', () => {
  // Without this the scrollbar and form controls keep the system colour while
  // the page changes underneath them.
  assert.match(CSS, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/);
  assert.match(CSS, /:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/);
});

test('the toggle is hidden until scripted', () => {
  // A control that cannot work must not be offered. The button is display:none
  // by default and only the `js` class, set by the head script, reveals it.
  assert.match(CSS, /\.theme-toggle\s*\{[^}]*display:\s*none/);
  assert.match(CSS, /\.js\s+\.theme-toggle\s*\{[^}]*display:\s*inline-flex/);
});

test('the theme is applied before first paint', () => {
  // The stored theme must be read in head. Applying it later means painting
  // the wrong ground colour and repainting, which is a white flash on a dark
  // page.
  const head = LAYOUT.slice(0, LAYOUT.indexOf('</head>'));
  assert.ok(head.includes("localStorage.getItem('hb-theme')"), 'theme is not restored in head');
  assert.ok(head.includes('data-theme'), 'head script does not set data-theme');
});

test('the page never depends on the toggle to render', () => {
  // Content visibility must not be conditional on this script. Nothing may be
  // hidden by a selector that only the theme script satisfies.
  assert.doesNotMatch(
    CSS,
    /\.js\s+(main|body|\.hero|\.prose)\b/,
    'page content is gated behind the js class'
  );
});

test('the button carries an accessible name', () => {
  assert.match(LAYOUT, /class="theme-toggle"[^>]*aria-label=/);
  assert.match(LAYOUT, /aria-hidden="true"/, 'decorative icons must be hidden from assistive tech');
  assert.ok(
    LAYOUT.includes("setAttribute('aria-label'"),
    'the accessible name must follow the resolved theme, not stay fixed'
  );
});

test('the switch never depends on the animation', () => {
  // A browser without view transitions, or a reader who asked for less
  // motion, must still get the theme change. The guard has to come before
  // the transition call, not after it.
  const guard = LAYOUT.indexOf("typeof document.startViewTransition !== 'function'");
  const call = LAYOUT.indexOf('document.startViewTransition(function');
  assert.ok(guard !== -1, 'no capability check for startViewTransition');
  assert.ok(call !== -1, 'view transition is never started');
  assert.ok(guard < call, 'the capability check must precede the transition');
  assert.match(LAYOUT, /prefers-reduced-motion: reduce[\s\S]{0,400}?apply\(next\);\s*return;/);
});

test('reduced motion gets no reveal animation', () => {
  // The view-transition overrides sit inside a no-preference query, so a
  // reader asking for less motion keeps the browser default and the script
  // never animates for them either.
  const i = CSS.indexOf('@media (prefers-reduced-motion: no-preference)');
  const vt = CSS.indexOf('::view-transition-old(root)');
  assert.ok(i !== -1 && vt > i, 'view-transition rules are not gated on reduced motion');
});
