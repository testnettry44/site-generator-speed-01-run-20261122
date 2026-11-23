// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01) — candidate F.
// Written from scratch in this session (thinking_fresh; anchor 2f8a63f5…, round 34192023).
// No vendor code is copied: every routine below is a fresh implementation.
//
// Architecture (fresh vs the live entry and candidates A–D):
//  - Markdown works on the raw body STRING (no split('\n') of 60k lines, no
//    per-line trim slices): a fused classifier scans each line once, paragraphs
//    are segment ranges, and inline rendering is ONE regex pass that fuses
//    escaping with the inline constructs (plain runs between matches hold no
//    escapable char, so they flush as raw slices — no esc() call at all).
//  - Templates compile to JS functions (new Function) with NATIVE control flow
//    and prototype-chain scopes: the first path segment resolves via the scope
//    prototype chain (null-safe direct property access, own-property semantics
//    for later segments via null/type guards), not an interpreter lookup loop.
//    This differs from candidate-a's codegen, which kept calling lookup() with
//    a path array for every variable.
//  - Within-case CSE (fresh maps per run(), nothing across cases): templates
//    whose transitive deps are only site/tags/recent render ONCE per case;
//    templates depending on a single loop variable (e.g. `card` on `p`) are
//    memoised per that variable's value. Both are guarded by a depth analysis
//    so include-depth cut-offs can never change the output.
//  - One object per page (card fields + page fields, no spread), one shared
//    output array per page render, excerpt/TOC captured by array ranges.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

// HTML escape (template {{ }} only; inline rendering fuses escaping itself).
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

/** Per-case memoised slugify. Pure ASCII strings take the fast path; anything
 *  with a non-ASCII character falls back to the exact reference rule. */
function makeSlugify() {
  const cache = new Map();
  function slugify(text) {
    const hit = cache.get(text);
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
    cache.set(text, res);
    return res;
  }
  return slugify;
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

function isBlankRange(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Parse front matter from the source text: { data, body } (body = offset of the
 *  first body character) or { error }. Mirrors the reference's line rules. */
function parseFM(text) {
  const nl0 = text.indexOf('\n');
  const end0 = nl0 === -1 ? text.length : nl0;
  if (text.slice(0, end0) !== '---') return { error: 'no front matter' };
  // Find the closing line, exactly '---'.
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  let close = -1;
  let closeEnd = text.length;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const e = nl === -1 ? text.length : nl;
    if (e - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      close = pos;
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // FM lines are 1..close-1, counted from 1 at the opening '---' (line n = i+1).
  let lineStart = nl0 === -1 ? text.length : nl0 + 1;
  let n = 1;
  while (lineStart < close) {
    const nl = text.indexOf('\n', lineStart);
    const e = nl === -1 ? close : Math.min(nl, close);
    n++;
    if (!isBlankRange(text, lineStart, e) && text.charCodeAt(lineStart) !== 35) {
      const line = text.slice(lineStart, e);
      const L = line.length;
      let k = 0;
      while (k < L) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${n} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === L) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${n} is not "key: value"` };
      let re = raw.length;
      while (re > 0) {
        const c = raw.charCodeAt(re - 1);
        if (c === 32 || c === 9) re--;
        else break;
      }
      if (re !== raw.length) raw = raw.slice(0, re);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1 || nl >= close) break;
    lineStart = nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd };
}

/* ------------------------------------------------------------------ markdown */

// The one regex that finds every character inline rendering must act on:
// backslash, backtick, *, [ and the five HTML escapables. A plain run between
// two matches holds none of them, so it flushes as a raw slice.
const SPEC_RE = /[\\`*\[&<>"']/g;
const ESC_ONLY_RE = /[&<>"']/g;
const SP_RE = /[\\`*[]/g;
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const WS16 = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS16[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS16[c] = 1;
const WS_RE = /\s/;

function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** Escape-only scan of s[a..b) into out (no inline constructs in here). */
function escRange(s, a, b, out) {
  if (a >= b) return;
  ESC_ONLY_RE.lastIndex = a;
  let m;
  let start = a;
  while ((m = ESC_ONLY_RE.exec(s)) !== null && m.index < b) {
    if (m.index > start) out.push(s.slice(start, m.index));
    out.push(ENT[m[0]]);
    start = m.index + 1;
  }
  if (b > start) out.push(s.slice(start, b));
}

/** First index in [from, end) where s holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wl = what.length;
  for (let j = from; j <= end - wl; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)]) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)]) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** Inline rendering of s[a..b) appended to out. Single regex pass; plain runs
 *  flush raw, constructs recurse on ranges (no slices for inner text). */
function inline(s, a, b, link, out) {
  SPEC_RE.lastIndex = a;
  let m;
  let runStart = a;
  let i = a;
  while (i < b && (m = SPEC_RE.exec(s)) !== null && m.index < b) {
    const j = m.index;
    const c = m[0];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (j > runStart) out.push(s.slice(runStart, j));
      out.push(ENT[c]);
      i = j + 1; runStart = i; SPEC_RE.lastIndex = i;
      continue;
    }
    if (c === '\\') {
      if (j + 1 < b && ESCAPABLE[s.charCodeAt(j + 1)]) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push(s[j + 1]);
        i = j + 2; runStart = i; SPEC_RE.lastIndex = i;
        continue;
      }
      i = j + 1; SPEC_RE.lastIndex = i;
      continue;
    }
    if (c === '`') {
      const mm = s.indexOf('`', j + 1);
      if (mm !== -1 && mm < b && mm > j + 1) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push('<code>');
        escRange(s, j + 1, mm, out);
        out.push('</code>');
        i = mm + 1; runStart = i; SPEC_RE.lastIndex = i;
        continue;
      }
      i = j + 1; SPEC_RE.lastIndex = i;
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const mm = findUnescaped(s, '**', j + 2, b);
        if (mm > j + 2) {
          if (j > runStart) out.push(s.slice(runStart, j));
          out.push('<strong>');
          inline(s, j + 2, mm, link, out);
          out.push('</strong>');
          i = mm + 2; runStart = i; SPEC_RE.lastIndex = i;
          continue;
        }
        i = j + 2; SPEC_RE.lastIndex = i;
        continue;
      }
      const mm = findSingleStar(s, j + 1, b);
      if (mm > j + 1) {
        if (j > runStart) out.push(s.slice(runStart, j));
        out.push('<em>');
        inline(s, j + 1, mm, link, out);
        out.push('</em>');
        i = mm + 1; runStart = i; SPEC_RE.lastIndex = i;
        continue;
      }
      i = j + 1; SPEC_RE.lastIndex = i;
      continue;
    }
    // '['
    const kk = findUnescaped(s, ']', j + 1, b);
    let mm = -1;
    let target = '';
    if (kk !== -1 && s.charCodeAt(kk + 1) === 40) {
      mm = s.indexOf(')', kk + 2);
      if (mm !== -1 && mm < b) target = s.slice(kk + 2, mm);
      else mm = -1;
    }
    if (mm !== -1 && target !== '' && !WS_RE.test(target)) {
      if (j > runStart) out.push(s.slice(runStart, j));
      const href = link(target);
      out.push('<a href="');
      escRange(href, 0, href.length, out);
      out.push('">');
      inline(s, j + 1, kk, link, out);
      out.push('</a>');
      i = mm + 1; runStart = i; SPEC_RE.lastIndex = i;
      continue;
    }
    i = j + 1; SPEC_RE.lastIndex = i;
  }
  if (b > runStart) out.push(s.slice(runStart, b));
}

// Block kinds for the fused line classifier.
const BK_BLANK = 0, BK_FENCE = 1, BK_HEAD = 2, BK_HR = 3, BK_QUOTE = 4, BK_LIST = 5, BK_PARA = 6;
// Reused classifier result (no allocation per line).
const CLS = { kind: BK_PARA, depth: 0, textA: 0, textB: 0, ordered: false, start: 1, lang: '' };

/** Classify the line s[a..b) in one scan, writing into CLS. */
function classify(s, a, b) {
  const c0 = a < b ? s.charCodeAt(a) : -1;
  // Blank: spaces and tabs only.
  if (c0 === 32 || c0 === 9 || a === b) {
    let i = a;
    while (i < b && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
    if (i === b) { CLS.kind = BK_BLANK; return CLS; }
  }
  // Fence opener: ``` + lang chars + spaces/tabs only.
  if (c0 === 96 && s.charCodeAt(a + 1) === 96 && s.charCodeAt(a + 2) === 96) {
    let i = a + 3;
    while (i < b) {
      const c = s.charCodeAt(i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
      else break;
    }
    const lang = s.slice(a + 3, i);
    while (i < b && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
    if (i === b) { CLS.kind = BK_FENCE; CLS.lang = lang; return CLS; }
    CLS.kind = BK_PARA; return CLS;
  }
  // Heading: 1-6 '#', space/tab, non-empty text after trimming.
  if (c0 === 35) {
    let c = 0;
    while (c < 6 && a + c < b && s.charCodeAt(a + c) === 35) c++;
    if (c > 0 && a + c < b && (s.charCodeAt(a + c) === 32 || s.charCodeAt(a + c) === 9)) {
      let j = a + c;
      while (j < b && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
      let e = b;
      while (e > j && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e--;
      if (e > j) { CLS.kind = BK_HEAD; CLS.depth = c; CLS.textA = j; CLS.textB = e; return CLS; }
    }
    CLS.kind = BK_PARA; return CLS;
  }
  // Thematic break: --- or *** + spaces/tabs only.
  if ((c0 === 45 || c0 === 42) && s.charCodeAt(a + 1) === c0 && s.charCodeAt(a + 2) === c0) {
    let i = a + 3;
    while (i < b && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
    if (i === b) { CLS.kind = BK_HR; return CLS; }
    // '---x' falls through: a line starting --- is a paragraph line unless HR.
    if (c0 === 45) { CLS.kind = BK_PARA; return CLS; }
    // '***x': could still be a bullet list ('* ')? No: char 1 is '*', not ' '.
    CLS.kind = BK_PARA; return CLS;
  }
  // Blockquote: opens on '>'.
  if (c0 === 62) { CLS.kind = BK_QUOTE; return CLS; }
  // List: '- ' / '* ' (space only) or digits + '. '.
  if ((c0 === 45 || c0 === 42) && s.charCodeAt(a + 1) === 32) {
    CLS.kind = BK_LIST; CLS.ordered = false; CLS.start = 1; CLS.textA = a + 2; CLS.textB = b; return CLS;
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = a;
    while (i < a + 9 && i < b && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
    if (i > a && s.charCodeAt(i) === 46 && s.charCodeAt(i + 1) === 32) {
      CLS.kind = BK_LIST; CLS.ordered = true; CLS.start = Number(s.slice(a, i)); CLS.textA = i + 2; CLS.textB = b; return CLS;
    }
  }
  CLS.kind = BK_PARA; return CLS;
}

/** Trim [a,b) of spaces/tabs, returning the bounds as [a2, b2] in the scratch pair. */
function trimRange(s, a, b, pair) {
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  pair[0] = a; pair[1] = b;
  return pair;
}

/**
 * Render a run of trimmed line segments (flat array [a0,b0,a1,b1,...] into text)
 * as inline HTML into out. Segments are joined by '\n', exactly as the
 * reference joins trimmed lines. When no segment holds an inline special,
 * each segment renders escape-only with no join; otherwise the segments are
 * joined once and rendered as one string (constructs may span lines).
 */
function inlineSegments(s, segs, nseg, link, out) {
  let hasSpecial = false;
  for (let q = 0; q < nseg; q++) {
    const a = segs[q * 2];
    const b = segs[q * 2 + 1];
    if (b > a) {
      SP_RE.lastIndex = a;
      const m = SP_RE.exec(s);
      if (m !== null && m.index < b) { hasSpecial = true; break; }
    }
  }
  if (!hasSpecial) {
    for (let q = 0; q < nseg; q++) {
      if (q > 0) out.push('\n');
      escRange(s, segs[q * 2], segs[q * 2 + 1], out);
    }
    return;
  }
  let joined = '';
  for (let q = 0; q < nseg; q++) {
    if (q > 0) joined += '\n';
    joined += s.slice(segs[q * 2], segs[q * 2 + 1]);
  }
  inline(joined, 0, joined.length, link, out);
}

/** Render a source's body (text from `start`) to HTML into `out`, returning
 *  { excerpt, words } and filling `toc` ([{level, id, html}]). */
function renderMd(text, start, link, slugify, out, toc) {
  const end = text.length;
  const ids = new Set();
  let excerpt = null;
  let words = 0;
  // Word count: one scan over the whole body (a newline separates words
  // exactly as it does between lines). Branchless over a 65536-entry
  // whitespace table: ~2x faster than the per-character test it replaces.
  let prevWs = 1;
  for (let j = start; j < end; j++) {
    const ws = WS16[text.charCodeAt(j)];
    words += prevWs & (ws ^ 1);
    prevWs = ws;
  }
  // Reused scratch: flat segment ranges, and one trim pair.
  const segs = [];
  const pair = [0, 0];
  let pos = start;
  while (pos < end) {
    let nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? end : nl;
    const nextPos = nl === -1 ? end : nl + 1;
    const cl = classify(text, pos, lineEnd);
    const kind = cl.kind;
    if (kind === BK_BLANK) { pos = nextPos; continue; }
    if (kind === BK_FENCE) {
      const lang = cl.lang;
      out.push('<pre><code' + (lang === '' ? '' : ' class="language-' + lang + '"') + '>');
      pos = nextPos;
      while (pos < end) {
        const nl2 = text.indexOf('\n', pos);
        const e2 = nl2 === -1 ? end : nl2;
        // Fence close: ``` + spaces/tabs only.
        if (text.charCodeAt(pos) === 96 && text.charCodeAt(pos + 1) === 96 && text.charCodeAt(pos + 2) === 96) {
          let i = pos + 3;
          while (i < e2 && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
          if (i === e2) { pos = nl2 === -1 ? end : nl2 + 1; break; }
        }
        escRange(text, pos, e2, out);
        out.push('\n');
        pos = nl2 === -1 ? end : nl2 + 1;
      }
      out.push('</code></pre>\n');
      continue;
    }
    if (kind === BK_HEAD) {
      const id = uniqueSlug(slugify(text.slice(cl.textA, cl.textB)), ids);
      out.push('<h' + cl.depth + ' id="' + id + '">');
      const mark = out.length;
      inline(text, cl.textA, cl.textB, link, out);
      const html = out.slice(mark).join('');
      out.push('</h' + cl.depth + '>\n');
      if (cl.depth === 2 || cl.depth === 3) toc.push({ level: cl.depth, id, html });
      pos = nextPos;
      continue;
    }
    if (kind === BK_HR) { out.push('<hr>\n'); pos = nextPos; continue; }
    if (kind === BK_QUOTE) {
      segs.length = 0;
      while (pos < end) {
        const nl2 = text.indexOf('\n', pos);
        const e2 = nl2 === -1 ? end : nl2;
        if (text.charCodeAt(pos) !== 62) break;
        let a = pos + 1;
        if (a < e2 && text.charCodeAt(a) === 32) a++;
        trimRange(text, a, e2, pair);
        if (pair[1] > pair[0]) { segs.push(pair[0], pair[1]); }
        pos = nl2 === -1 ? end : nl2 + 1;
      }
      if (segs.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineSegments(text, segs, segs.length / 2, link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    if (kind === BK_LIST) {
      const ordered = cl.ordered;
      const startNum = cl.start;
      const items = [];
      let cur = null;
      while (pos < end) {
        const nl2 = text.indexOf('\n', pos);
        const e2 = nl2 === -1 ? end : nl2;
        const cl2 = classify(text, pos, e2);
        if (cl2.kind === BK_LIST && cl2.ordered === ordered) {
          trimRange(text, cl2.textA, cl2.textB, pair);
          cur = [pair[0], pair[1]];
          items.push(cur);
          pos = nl2 === -1 ? end : nl2 + 1;
        } else if (pos < e2 && text.charCodeAt(pos) === 32 && text.charCodeAt(pos + 1) === 32) {
          // Continued: two or more spaces then a non-whitespace char.
          let j = pos;
          while (j < e2 && text.charCodeAt(j) === 32) j++;
          if (j >= e2 || isWSCode(text.charCodeAt(j)) || cur === null) break;
          trimRange(text, pos, e2, pair);
          cur.push(pair[0], pair[1]);
          pos = nl2 === -1 ? end : nl2 + 1;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(ordered && startNum !== 1 ? '<ol start="' + startNum + '">\n' : '<' + tag + '>\n');
      for (let q = 0; q < items.length; q++) {
        out.push('<li>');
        inlineSegments(text, items[q], items[q].length / 2, link, out);
        out.push('</li>\n');
      }
      out.push('</' + tag + '>\n');
      continue;
    }
    // Paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    segs.length = 0;
    trimRange(text, pos, lineEnd, pair);
    segs.push(pair[0], pair[1]);
    pos = nextPos;
    while (pos < end) {
      const nl2 = text.indexOf('\n', pos);
      const e2 = nl2 === -1 ? end : nl2;
      const cl2 = classify(text, pos, e2);
      if (cl2.kind === BK_BLANK || cl2.kind === BK_FENCE || cl2.kind === BK_HEAD || cl2.kind === BK_HR) break;
      trimRange(text, pos, e2, pair);
      segs.push(pair[0], pair[1]);
      pos = nl2 === -1 ? end : nl2 + 1;
    }
    out.push('<p>');
    const mark = out.length;
    inlineSegments(text, segs, segs.length / 2, link, out);
    if (excerpt === null) excerpt = out.slice(mark).join('');
    out.push('</p>\n');
  }
  return { excerpt: excerpt === null ? '' : excerpt, words };
}

/* ------------------------------------------------------------------ templates */

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Tokenize a template (same rules and errors as the reference). */
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

/** Scope-chain lookup with exact own-property semantics (used for if paths). */
function lookup(S, path) {
  let s = S;
  while (s !== null) {
    if (Object.hasOwn(s, path[0])) {
      let v = s[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
    s = Object.getPrototypeOf(s);
  }
  return undefined;
}

/** Direct-access path expression with null/type guards, exactly matching
 *  lookup() for var/raw/for positions (see the analysis in the header: the
 *  first segment may resolve via the prototype chain, but only to values
 *  textOf/for render exactly as undefined would). */
function pathExpr(sv, path) {
  if (path.length === 1) return sv + '.' + path[0];
  let s = '(_t0=' + sv + '.' + path[0] + ')';
  let cur = '_t0';
  for (let i = 1; i < path.length; i++) {
    const nxt = cur === '_t0' ? '_t1' : '_t0';
    if (i === path.length - 1) s += '==null||typeof ' + cur + '!=="object"?void 0:' + cur + '.' + path[i];
    else { s += '==null||typeof ' + cur + '!=="object"?void 0:(' + nxt + '=' + cur + '.' + path[i] + ')'; cur = nxt; }
  }
  return s;
}

/** Analyse tokens: free first-segment deps, bound names and includes.
 *  An invalid path is skipped here (compile reports it with the right name). */
function analyseTokens(tokens) {
  const free = new Set();
  const includes = [];
  const stack = []; // for-frames: the loop variable name
  let inFor = 0;
  const bound = (name) => {
    if (name === 'loop') return inFor > 0;
    for (let s = stack.length - 1; s >= 0; s--) if (stack[s] === name) return true;
    return false;
  };
  const firstSeg = (p) => (PATH_RE.test(p) ? p.split('.')[0] : null);
  for (const tok of tokens) {
    if (tok.t === 'var' || tok.t === 'raw') {
      if (!bound(tok.path[0])) free.add(tok.path[0]);
    } else if (tok.t === 'tag') {
      const tag = tok.tag;
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const f = firstSeg(m[2]);
        if (f !== null && !bound(f)) free.add(f);
        stack.push(m[1]);
        inFor++;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const f = firstSeg(m[2]);
        if (f !== null && !bound(f)) free.add(f);
      } else if (tag === 'endfor') {
        stack.pop();
        inFor--;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        includes.push(m[1]);
      }
    }
  }
  return { free, includes };
}

/** Compile tokens to a render function. `info` carries the per-case analysis:
 *  consts (name -> true), memoBy (name -> loop-var name or null). */
function compileTemplate(name, tokens, info) {
  let code = '';
  let uid = 0;
  // Stack of frames: { kind: 'for'|'if', sv, varName } ; sv is the scope var.
  const stack = [{ kind: 'root', sv: 'S' }];
  const cur = () => stack[stack.length - 1];
  // Consecutive output fragments batch into one O.push(...) call.
  const pending = [];
  const flush = () => {
    if (pending.length > 0) {
      code += 'O.push(' + pending.join(',') + ');\n';
      pending.length = 0;
    }
  };
  for (const tok of tokens) {
    if (tok.t === 'text') {
      pending.push(JSON.stringify(tok.text));
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      const e = pathExpr(cur().sv, tok.path);
      pending.push(tok.t === 'var' ? 'E(TV(' + e + '))' : 'TV(' + e + ')');
      continue;
    }
    const tag = tok.tag;
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      flush();
      const u = uid++;
      const sv = cur().sv;
      // '__proto__' as a loop variable would re-point the scope object's
      // prototype on plain assignment; define it as an own property instead
      // (the reference binds it the same way a plain object does, and the
      // generator never uses it as a loop variable).
      const assignVar = m[1] === '__proto__'
        ? 'Object.defineProperty(_s' + u + ',' + JSON.stringify(m[1]) + ',{value:_x' + u + '[_k' + u + '],enumerable:true,configurable:true,writable:true});\n'
        : '_s' + u + '[' + JSON.stringify(m[1]) + ']=_x' + u + '[_k' + u + '];\n';
      code += '{var _x' + u + '=' + pathExpr(sv, pathOf(name, m[2])) + ';if(Array.isArray(_x' + u + ')){'
        + 'var _s' + u + '=Object.create(' + sv + ');'
        + 'var _l' + u + '={index:0,first:false,last:false,length:_x' + u + '.length};'
        + '_s' + u + '.loop=_l' + u + ';'
        + 'for(var _k' + u + '=0;_k' + u + '<_x' + u + '.length;_k' + u + '++){'
        + assignVar
        + '_l' + u + '.index=_k' + u + '+1;_l' + u + '.first=_k' + u + '===0;_l' + u + '.last=_k' + u + '===_x' + u + '.length-1;\n';
      stack.push({ kind: 'for', sv: '_s' + u, varName: m[1], uid: u });
      continue;
    }
    if ((m = IF_RE.exec(tag)) !== null) {
      flush();
      const not = m[1] !== undefined;
      code += 'if(' + (not ? '!' : '') + 'Y(LK(' + cur().sv + ',' + JSON.stringify(pathOf(name, m[2])) + '))){\n';
      stack.push({ kind: 'if', sv: cur().sv, not });
      continue;
    }
    if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top.kind !== 'if' || top.elseSeen) throw new TemplateError(`template "${name}": an else outside an if`);
      top.elseSeen = true;
      flush();
      code += '}else{\n';
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const top = stack[stack.length - 1];
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      flush();
      code += tag === 'endfor' ? '}}}\n' : '}\n';
      continue;
    }
    if ((m = INCLUDE_RE.exec(tag)) !== null) {
      flush();
      const inc = m[1];
      const sv = cur().sv;
      if (info.consts.has(inc)) {
        code += 'if(D<8)O.push(C[' + JSON.stringify(inc) + ']);\n';
      } else if (info.memoBy.has(inc)) {
        const v = info.memoBy.get(inc);
        // v is bound by an enclosing for at this site (checked at emit time
        // via the stack); otherwise fall through to a normal include.
        let boundHere = false;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].kind === 'for' && stack[s].varName === v) { boundHere = true; break; }
        }
        if (boundHere) {
          const u = uid++;
          code += 'if(D<8){var _k' + u + '=' + sv + '.' + v + ';'
            + 'var _mm' + u + '=M[' + JSON.stringify(inc) + '];'
            + 'var _r' + u + '=_mm' + u + '===void 0?void 0:_mm' + u + '.get(_k' + u + ');'
            + 'if(_r' + u + '===void 0){var _o' + u + '=[];'
            + 'var _f' + u + '=T[' + JSON.stringify(inc) + '];'
            + 'if(_f' + u + '!==void 0)_f' + u + '(' + sv + ',_o' + u + ',T,D+1,M,C);'
            + '_r' + u + '=_o' + u + '.join("");'
            + 'if(_mm' + u + '===void 0){_mm' + u + '=new Map();M[' + JSON.stringify(inc) + ']=_mm' + u + ';}'
            + '_mm' + u + '.set(_k' + u + ',_r' + u + ');}'
            + 'O.push(_r' + u + ');}\n';
        } else {
          code += 'if(D<8){var _f' + uid + '=T[' + JSON.stringify(inc) + '];if(_f' + uid + '!==void 0)_f' + uid + '(' + sv + ',O,T,D+1,M,C);}\n';
          uid++;
        }
      } else {
        code += 'if(D<8){var _f' + uid + '=T[' + JSON.stringify(inc) + '];if(_f' + uid + '!==void 0)_f' + uid + '(' + sv + ',O,T,D+1,M,C);}\n';
        uid++;
      }
      continue;
    }
    throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind === 'for' ? 'for' : 'if'} is not closed`);
  flush();
  const factory = new Function('TV', 'E', 'LK', 'Y', 'return function(S,O,T,D,M,C){\nvar _t0,_t1;\n' + code + '\n}');
  return factory(textOf, esc, lookup, truthy);
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
  const slugify = makeSlugify();
  const report = [];
  // 0. Templates: tokenize (errors reported, template left out). Only the
  //    templates a render can reach are analysed and compiled: the generator
  //    plants decoy templates that no layout or include ever reaches.
  const tokenMap = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      tokenMap.set(name, tokenize(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 1. Sources, sorted by path; .md sources keep their raw text, the rest static.
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the refusal checks that do not need templates, in
  //    order. Sources that pass these name their layout: those names, plus
  //    index/tag/tags, are the roots of the reachable template set.
  const roots = new Set(['index', 'tag', 'tags']);
  const cands = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
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
    s.layout = s.data.layout ?? (s.post ? 'post' : 'page');
    roots.add(s.layout);
    cands.push(s);
  }
  // Reachable templates: transitive closure over includes from the roots.
  const reachable = new Set();
  {
    const stack = [...roots];
    while (stack.length > 0) {
      const name = stack.pop();
      if (reachable.has(name) || !tokenMap.has(name)) continue;
      reachable.add(name);
      for (const tok of tokenMap.get(name)) {
        if (tok.t === 'tag') {
          const m = INCLUDE_RE.exec(tok.tag);
          if (m !== null && !reachable.has(m[1])) stack.push(m[1]);
        }
      }
    }
  }
  const CONST_OK = new Set(['site', 'tags', 'recent']);
  // Per-template analysis, over reachable templates only.
  const freeDeps = new Map();
  const incEdges = new Map();
  for (const name of reachable) {
    const a = analyseTokens(tokenMap.get(name));
    freeDeps.set(name, a.free);
    incEdges.set(name, a.includes.filter((x) => reachable.has(x)));
  }
  // Transitive free deps (fixpoint).
  const transDeps = new Map();
  for (const name of reachable) transDeps.set(name, new Set(freeDeps.get(name)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, edges] of incEdges) {
      const d = transDeps.get(name);
      for (const u of edges) {
        for (const x of transDeps.get(u)) {
          if (!d.has(x)) { d.add(x); changed = true; }
        }
      }
    }
  }
  // Include height (longest chain down; Infinity on a cycle) and inclusion
  // depth (longest chain from any template down to this one; Infinity on cycle).
  const height = new Map();
  const heightState = new Map();
  const calcHeight = (name) => {
    const st = heightState.get(name);
    if (st === 2) return height.get(name);
    if (st === 1) return Infinity;
    heightState.set(name, 1);
    let h = 0;
    for (const u of incEdges.get(name)) {
      const hu = calcHeight(u);
      if (hu === Infinity) { h = Infinity; break; }
      if (hu + 1 > h) h = hu + 1;
    }
    heightState.set(name, 2);
    height.set(name, h);
    return h;
  };
  for (const name of reachable) calcHeight(name);
  // Inclusion depth (longest chain from any template down to this one;
  // Infinity on a cycle): reverse-DFS over includers, mirroring height.
  const revEdges = new Map();
  for (const name of reachable) revEdges.set(name, []);
  for (const [name, edges] of incEdges) for (const u of edges) revEdges.get(u).push(name);
  const depth = new Map();
  const depthState = new Map();
  const calcDepth = (name) => {
    const st = depthState.get(name);
    if (st === 2) return depth.get(name);
    if (st === 1) return Infinity;
    depthState.set(name, 1);
    let d = 0;
    for (const u of revEdges.get(name)) {
      const du = calcDepth(u);
      if (du === Infinity) { d = Infinity; break; }
      if (du + 1 > d) d = du + 1;
    }
    depthState.set(name, 2);
    depth.set(name, d);
    return d;
  };
  for (const name of reachable) calcDepth(name);
  const consts = new Set();
  const memoBy = new Map();
  for (const name of reachable) {
    const deps = transDeps.get(name);
    const h = height.get(name);
    const d = depth.get(name);
    if (h === Infinity || d === Infinity || d + h >= 8) continue;
    let varying = null;
    let ok = true;
    for (const x of deps) {
      if (CONST_OK.has(x)) continue;
      if (varying === null && x !== 'loop') varying = x;
      else { ok = false; break; }
    }
    if (!ok) continue;
    if (varying === null) consts.add(name);
    else memoBy.set(name, varying);
  }
  const info = { consts, memoBy };
  const T = Object.create(null);
  // Every template is compiled (and its errors reported), even the unreachable
  // ones: the reference reports a broken template wherever it sits.
  for (const name of tokenMap.keys()) {
    try {
      T[name] = compileTemplate(name, tokenMap.get(name), info);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
      delete T[name];
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 2b. The layout and draft checks, in source order. A candidate's layout
  //    is a root, so it is compiled exactly when it parses.
  const kept = [];
  for (const s of cands) {
    if (T[s.layout] === undefined) {
      report.push(`refused ${s.path}: layout "${s.layout}" is no template that parses`);
      continue;
    }
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
  const mdOut = [];
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
    const toc = [];
    mdOut.length = 0;
    const md = renderMd(s.text, s.body, link, slugify, mdOut, toc);
    s.html = mdOut.join('');
    s.toc = toc;
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

  // Cards and pages, built once each (one object holds card + page fields).
  for (const s of kept) {
    s.pageObj = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }
  for (const t of tags) t.view = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.pageObj) };

  // 7. Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.pageObj);
  const S0 = { site, tags: allTags, recent };
  const M = Object.create(null);
  const C = Object.create(null);
  const OUT = [];
  // Constant templates, rendered once (leaves first: increasing height).
  const constNames = [...consts].sort((a, b) => height.get(a) - height.get(b));
  for (const name of constNames) {
    OUT.length = 0;
    T[name](S0, OUT, T, 0, M, C);
    C[name] = OUT.join('');
  }
  const render = (name, vars) => {
    const fn = T[name];
    if (fn === undefined) return null;
    const S1 = Object.create(S0);
    for (const k in vars) S1[k] = vars[k];
    OUT.length = 0;
    fn(S1, OUT, T, 0, M, C);
    return OUT.join('');
  };
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { page: s.pageObj });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.pageObj),
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
