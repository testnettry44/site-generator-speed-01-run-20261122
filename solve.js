// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Written from the spec (README.md) and the reference's observable behaviour.
// No vendor code is copied: every routine below is a fresh implementation.
//
// Speed strategy:
//  - Markdown inline rendering scans plain runs with native indexOf and escapes
//    them in bulk instead of one regex call per character.
//  - slugify has a memoised ASCII fast path; the Unicode path is only taken
//    when a non-ASCII character actually appears.
//  - The block lexer and renderer are fused into one pass over the lines.
//  - Templates are parsed once per case into node trees and rendered by a
//    small interpreter over a scope stack; cards/pages are built once.
//  - Word counts are taken over the body lines directly (a newline separates
//    words exactly as it does in the joined body text).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

// HTML escape: & < > " ' -- nothing else.
const ESC_RE = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  ESC_RE.lastIndex = 0;
  let m;
  let out = '';
  let start = 0;
  let found = false;
  while ((m = ESC_RE.exec(s)) !== null) {
    found = true;
    out += s.slice(start, m.index) + ESC_MAP[m[0]];
    start = m.index + 1;
  }
  return found ? out + s.slice(start) : s;
}

/** The characters a backslash escapes in inline text. */
const ESCAPABLE = new Uint8Array(128);
for (const c of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[c.charCodeAt(0)] = 1;

/** Memoised slugify. Pure ASCII strings take the fast path; anything with a
 *  non-ASCII character falls back to the exact reference rule (NFKD, drop
 *  combining marks, lowercase A-Z, runs of other characters to one '-'). */
const slugCache = new Map();
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) { ascii = false; break; }
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { if (out.length > 0) gap = true; continue; }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(keep);
  }
  let res;
  if (ascii) {
    res = out.slice(0, 64);
    while (res.endsWith('-')) res = res.slice(0, -1);
    if (res === '') res = 'untitled';
  } else {
    res = slugifySlow(text);
  }
  slugCache.set(text, res);
  return res;
}

function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  for (;;) {
    const out = slug + '-' + n;
    if (!taken.has(out)) { taken.add(out); return out; }
    n++;
  }
}

/** "2026-11-09" -> "9 November 2026". */
function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

/* ------------------------------------------------------------------ front matter */

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TAG_RE = /^[^"[\]]+$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] === '' || !TAG_RE.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Parse front matter from the source's lines: { data, close } or { error }. */
function parseFM(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    const L = line.length;
    while (k < L) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === L) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

/* ------------------------------------------------------------------ markdown */

const WS_RE = /\s/;
const SPECIAL_RE = /[\\`*[]/;

function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

function countWords(line) {
  let n = 0;
  let inW = false;
  for (let j = 0; j < line.length; j++) {
    if (isWSCode(line.charCodeAt(j))) inW = false;
    else if (!inW) { inW = true; n++; }
  }
  return n;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Fence opener: the language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const L = line.length;
  while (i < L) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < L && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === L ? lang : null;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  let i = 3;
  const L = line.length;
  while (i < L && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === L;
}

/** A heading line: { depth, text } or null (text never empty). */
function headingOf(line) {
  let c = 0;
  while (c < line.length && line.charCodeAt(c) === 35) c++;
  if (c === 0 || c > 6) return null;
  if (c >= line.length) return null;
  const sc = line.charCodeAt(c);
  if (sc !== 32 && sc !== 9) return null;
  let j = c;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth: c, text: line.slice(j, e) };
}

function isHR(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  let i = 3;
  const L = line.length;
  while (i < L && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === L;
}

function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** A list item start: { ordered, start, text } or null. */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  let i = 0;
  while (i < 9 && i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !isWSCode(line.charCodeAt(j));
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wl = what.length;
  for (let j = from; j <= s.length - wl; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)]) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)]) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** Inline rendering. Plain runs are found with native indexOf and escaped in
 *  bulk; only the inline constructs are handled character by character. */
function inline(s, link) {
  if (!SPECIAL_RE.test(s)) return esc(s);
  const parts = [];
  const n = s.length;
  let i = 0;
  let runStart = 0;
  while (i < n) {
    let j = n;
    let k = s.indexOf('\\', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('`', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i); if (k !== -1 && k < j) j = k;
    if (j >= n) break;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n && ESCAPABLE[s.charCodeAt(j + 1)]) {
        if (j > runStart) parts.push(esc(s.slice(runStart, j)));
        parts.push(s[j + 1]);
        i = j + 2;
        runStart = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === 96) {
      const m = s.indexOf('`', j + 1);
      if (m > j + 1) {
        if (j > runStart) parts.push(esc(s.slice(runStart, j)));
        parts.push('<code>', esc(s.slice(j + 1, m)), '</code>');
        i = m + 1;
        runStart = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const m = findUnescaped(s, '**', j + 2);
        if (m > j + 2) {
          if (j > runStart) parts.push(esc(s.slice(runStart, j)));
          parts.push('<strong>', inline(s.slice(j + 2, m), link), '</strong>');
          i = m + 2;
          runStart = i;
          continue;
        }
        i = j + 2;
        continue;
      }
      const m = findSingleStar(s, j + 1);
      if (m > j + 1) {
        if (j > runStart) parts.push(esc(s.slice(runStart, j)));
        parts.push('<em>', inline(s.slice(j + 1, m), link), '</em>');
        i = m + 1;
        runStart = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    // '['
    const kk = findUnescaped(s, ']', j + 1);
    let m = -1;
    let target = '';
    if (kk !== -1 && s.charCodeAt(kk + 1) === 40) {
      m = s.indexOf(')', kk + 2);
      if (m !== -1) target = s.slice(kk + 2, m);
    }
    if (m !== -1 && target !== '' && !WS_RE.test(target)) {
      if (j > runStart) parts.push(esc(s.slice(runStart, j)));
      parts.push('<a href="', esc(link(target)), '">', inline(s.slice(j + 1, kk), link), '</a>');
      i = m + 1;
      runStart = i;
      continue;
    }
    i = j + 1;
  }
  if (n > runStart) parts.push(esc(s.slice(runStart, n)));
  return parts.join('');
}

/** Render a source's body lines (from `start`) to HTML, its table of
 *  contents, its excerpt and its word count. */
function renderMd(lines, start, link) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let words = 0;
  for (let j = start; j < lines.length; j++) words += countWords(lines[j]);
  const n = lines.length;
  let i = start;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const fenceLang = fenceOpen(line);
    if (fenceLang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = fenceLang === '' ? '' : ` class="language-${esc(fenceLang)}"`;
      const inner = body.length === 0 ? '' : esc(body.join('\n') + '\n');
      out.push(`<pre><code${cls}>${inner}</code></pre>\n`);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inline(hd.text, link);
      out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const ls = [];
      for (let q = 0; q < body.length; q++) {
        const t = trimLine(body[q]);
        if (t !== '') ls.push(t);
      }
      if (ls.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push('<blockquote>\n<p>' + inline(ls.join('\n'), link) + '</p>\n</blockquote>\n');
      continue;
    }
    const li = listStart(line);
    if (li !== null) {
      const ordered = li.ordered;
      const items = [];
      while (i < n) {
        const m2 = listStart(lines[i]);
        if (m2 !== null && m2.ordered === ordered) { items.push([trimLine(m2.text)]); i++; }
        else if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && li.start !== 1 ? `<ol start="${li.start}">` : `<${tag}>`;
      let s = open + '\n';
      for (let q = 0; q < items.length; q++) s += `<li>${inline(items[q].join('\n'), link)}</li>\n`;
      s += `</${tag}>\n`;
      out.push(s);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push('<p>' + html + '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt, words };
}

/* ------------------------------------------------------------------ templates */

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

// Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include, 6 root.
const T_TEXT = 0, T_VAR = 1, T_RAW = 2, T_IF = 3, T_FOR = 4, T_INC = 5, T_ROOT = 6;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let j = lineStart; j < open; j++) {
      const c = src.charCodeAt(j);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let j = end; j < lineEnd; j++) {
        const c = src.charCodeAt(j);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { k: T_ROOT, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: T_TEXT, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: tok.t === 'var' ? T_VAR : T_RAW, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: T_FOR, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: T_IF, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== T_IF || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? T_FOR : T_IF)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === T_ROOT ? parent.body : parent.k === T_FOR ? parent.body : (parent.els ?? parent.then);
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: T_INC, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === T_FOR ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** The value at `path` in the scope stack: first name from the innermost
 *  scope holding it, then own properties. */
function lookup(scopes, path) {
  for (let s = scopes.length - 1; s >= 0; s--) {
    const vars = scopes[s];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scopes, out, templates, depth) {
  for (let a = 0; a < nodes.length; a++) {
    const n = nodes[a];
    switch (n.k) {
      case T_TEXT:
        out.push(n.text);
        break;
      case T_VAR:
        out.push(esc(textOf(lookup(scopes, n.path))));
        break;
      case T_RAW:
        out.push(textOf(lookup(scopes, n.path)));
        break;
      case T_IF: {
        const v = truthy(lookup(scopes, n.path));
        const br = v !== n.not ? n.then : n.els;
        if (br !== null) renderNodes(br, scopes, out, templates, depth);
        break;
      }
      case T_FOR: {
        const xs = lookup(scopes, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          scopes.push(vars);
          renderNodes(n.body, scopes, out, templates, depth);
          scopes.pop();
        }
        break;
      }
      case T_INC: {
        const t = templates.get(n.name);
        if (t !== undefined && depth < 8) renderNodes(t, scopes, out, templates, depth + 1);
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ build */

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function isScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) continue;
    return false;
  }
  return false;
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, sorted by path; .md sources split into lines, the rest static.
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the refusal/draft checks, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.close = fm.close;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (!set) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (isScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return pg.url + frag;
        if (staticPaths.has(path)) return base + '/' + path + frag;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMd(s.lines, s.close + 1, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. Collections: posts newest first, then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const sl = slugify(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let t = bySlug.get(slug);
      if (!t) {
        t = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, t);
      }
      t.posts.push(p);
      p.tagRefs.push(t);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const sl = slugify(name);
        return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Cards and pages, built once.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of kept) s.card = cardOf(s);
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  for (const t of tags) t.view = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) };

  // 7. Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const baseScope = { site, tags: allTags, recent };
  const scopes = [baseScope, null];
  const outBuf = [];
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    scopes[1] = vars;
    outBuf.length = 0;
    renderNodes(nodes, scopes, outBuf, templates, 0);
    return outBuf.join('');
  };
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: t.view });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(cmp);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
