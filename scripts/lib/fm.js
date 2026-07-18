// Frontmatter parser: leading `---` block with `key: value` scalars and
// block lists (`key:` followed by `  - item` lines). Returns { data, body }.
'use strict';

function parseFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = {};
  let currentList = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const listItem = /^\s+-\s+(.*)$/.exec(rawLine);
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
  return { data, body: src.slice(m[0].length) };
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

module.exports = { parseFrontmatter };
