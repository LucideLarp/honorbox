#!/usr/bin/env node
// WCAG 2.x contrast audit for the mono "stand" theme.
// Every text/background pair the stylesheet produces, both schemes.
// Run: node design/contrast-check.mjs   (exit 1 if any AA text pair fails)

const lum = (hex) => {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// srgb composite of fg at `alpha` over bg (for the one translucent case: .btn-disabled)
const mix = (fg, bg, alpha) => {
  const ch = (h, i) => parseInt(h.replace('#', '').slice(i, i + 2), 16);
  return '#' + [0, 2, 4].map((i) =>
    Math.round(alpha * ch(fg, i) + (1 - alpha) * ch(bg, i)).toString(16).padStart(2, '0')
  ).join('');
};

const L = { paper: '#ffffff', wash: '#f4f4f6', ink: '#0d0d0f', soft: '#5d5d66', plate: '#0d0d0f', plateInk: '#f2f2f4', plateSoft: '#c9c9cf' };
const D = { paper: '#0e0e10', wash: '#19191c', ink: '#f2f2f4', soft: '#a2a2ab', plate: '#f2f2f4', plateInk: '#131316', plateSoft: '#3f3f46' };

// [label, fg, bg, min] — min 4.5 (AA normal text; smallest run is 0.72rem
// figcaptions, still "normal" under WCAG), 3.0 for non-text UI (1.4.11).
const pairs = (t, s) => [
  [`${t} body/headings: ink on paper`, s.ink, s.paper, 4.5],
  [`${t} muted/lede/kicker/th: soft on paper`, s.soft, s.paper, 4.5],
  [`${t} compare our column, attn rows, code: ink on wash`, s.ink, s.wash, 4.5],
  [`${t} buy button label: paper on ink`, s.paper, s.ink, 4.5],
  [`${t} note aside body: plate-soft on plate`, s.plateSoft, s.plate, 4.5],
  [`${t} note aside links: plate-ink on plate`, s.plateInk, s.plate, 4.5],
  [`${t} focus ring / borders: ink on paper (non-text)`, s.ink, s.paper, 3.0],
  [`${t} disabled btn (inactive, AA-exempt): ink@55% on paper`, mix(s.ink, s.paper, 0.55), s.paper, 0],
];

let fail = 0;
for (const [label, fg, bg, min] of [...pairs('light', L), ...pairs('dark', D)]) {
  const r = ratio(fg, bg);
  const ok = min === 0 ? true : r >= min;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(6)}:1  (min ${min || 'n/a'})  ${label}  ${fg} on ${bg}`);
}
process.exit(fail ? 1 : 0);
