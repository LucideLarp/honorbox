// Frontmatter parser: leading `---` block with `key: value` scalars and
// block lists (`key:` followed by `  - item` lines). Returns { data, body }.
'use strict';

function parseFrontmatter(src) {
  // A BOM ahead of the `---` would defeat the anchor and silently publish the
  // frontmatter as body text, so drop it before matching.
  const text = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) {
    // A file that opens a block but never closes it is a typo, not a body. Say
    // so: otherwise every `key: value` line ships as a visible paragraph and
    // the page title falls back to the filename.
    const unterminated = /^---\r?\n/.test(text);
    return { data: {}, body: text, ...(unterminated ? { error: 'frontmatter opened with --- but never closed (add a closing --- line)' } : {}) };
  }
  const data = {};
  let currentList = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    // Indentation is optional in YAML: a block sequence may sit flush-left
    // under its key. Only consumed while a list is actually open.
    const listItem = /^\s*-\s+(.*)$/.exec(rawLine);
    if (listItem && currentList) {
      currentList.push(listItem[1].trim());
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '') {
      currentList = [];
      data[key] = currentList;
    } else {
      currentList = null;
      data[key] = stripQuotes(value.trim());
    }
  }
  return { data, body: text.slice(m[0].length) };
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

module.exports = { parseFrontmatter };
