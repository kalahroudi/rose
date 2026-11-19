// SPDX-License-Identifier: Apache-2.0
// Static check for AGENTS.md invariant 4 on the core tenant app: every signed-in route must call
// `need(<ctx>, <permission>)`. TypeScript 7 has no JS API and we add no dependencies, so this is a small
// tokenizer plus a token-level walk, not a regex over text. See docs/pentest.md (AUTHZ-07).

const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "extends"]);
const REGISTRARS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all", "on", "use", "route", "mount"]);
const isLT = (ch) => ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** Exemptions for the real tenant-app.ts: "METHOD path" -> reason (string) or { reason, onlyThrows: "notFound" }. */
export const CORE_EXEMPTIONS = {
  "GET /api/overview": "Counts are visible to every member; the audit panel is gated inline with can(role, \"audit:read\"). A permission every role holds would add nothing.",
  "ALL /api/*": { reason: "Catch-all 404 for unknown API paths; holds only while the handler does nothing but throw notFound().", onlyThrows: "notFound" },
};

/**
 * Routes registered before app.use("/api/*", authenticate) in the real tenant-app.ts: they run without a session
 * and without need(), so each must be listed here with the reason it is public. "METHOD path" -> reason (same key
 * format as CORE_EXEMPTIONS: ALL for app.all, ROUTE for app.route mounts). `app.use(...)` middleware before the
 * authentication line is NOT covered by this list (it never answers a request on its own by convention; the scanner
 * leaves it out of scope).
 */
export const PUBLIC_CORE_ROUTES = {
  "GET /api/bootstrap": "The signed-out SPA needs the host kind, brand and sign-in options before anyone can authenticate; it returns only what the request host already reveals and no tenant data.",
  "POST /api/root/code/request": "Sign-in on the root (apex) host starts signed out; protected by the per-address rate limit and a response that is identical whether or not the address is known.",
  "POST /api/root/code/verify": "Completes the root-host sign-in, so it cannot require a session; the one-time code is hashed, single-use, expires quickly and is attempt-limited.",
  "GET /api/root/slug": "Lets a person find their workspace address from the root host before signing in; rate-limited and returns no tenant data beyond the address.",
  "POST /api/root/enter": "Hands a freshly verified root-host sign-in to a workspace host; it checks the signed, short-lived proof itself and issues no session without it.",
  "GET /auth/handoff": "Receives the one-time handoff from the root host and creates the session on the workspace host; the token is signed, single-use and short-lived, and the host decides the tenant.",
  "ROUTE /api/auth": "The sign-in, sign-out, passkey and session routes cannot require a session; each handler enforces its own checks (rate limits, one-time codes, CSRF guard in front of them).",
};

/**
 * Tokenize TypeScript/JavaScript source. Comments are dropped. Strings are one token; template literals are a
 * `template` token, their `${...}` code inline as ordinary tokens, then `templateEnd`. Regex literals are one token.
 *
 * Regex vs division is decided from the previous significant token: a `/` starts a regex when there is none, when
 * it is punctuation other than `)`, `]`, `}`, or when it is a keyword such as `return`/`typeof`. After an
 * identifier, number, string, template, regex, `)`, `]` or `}` it is division, except after the `)` that closes the
 * condition of `if`/`while`/`for`/`with`, where a regex follows.
 *
 * That guess is only a guess: after `}`, `)`, `]`, `>`, a postfix `++`/`--`, a contextual keyword (`of` in a for
 * header, `await`, `yield`) both readings can be valid JS/TS, and crafted source can make them disagree about what is
 * code. Every such `/` is AMBIGUOUS. `tokenize` returns the heuristic reading and records the ambiguous slashes
 * (`opts.record`); `opts.mode` ("regex" | "division") forces all of them one way and `opts.flip` flips one. Use
 * `tokenizeSafe` for scanning: it fails closed when the readings disagree.
 */
export function tokenize(src, opts = {}) {
  // Line terminators are the JS set (\n, \r, U+2028, U+2029) everywhere; CRLF counts as one.
  const nl = [];
  for (let i = 0; i < src.length; i++) if (isLT(src[i]) && !(src[i] === "\r" && src[i + 1] === "\n")) nl.push(i);
  const lineOf = (pos) => {
    let lo = 0, hi = nl.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < pos) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
  let pos = 0;
  const parens = []; // for each open `(`: did an if/while/for/with keyword open it?
  const fors = []; // for each open `(`: is it the header of a `for` loop?
  const fail = (msg, at) => { throw new Error(`${msg} (line ${lineOf(at)})`); };

  let amb = false; // set by regexAllowed when the `/` being decided is ambiguous
  const regexAllowed = (out) => {
    const prev = out[out.length - 1];
    if (!prev) return true;
    if (prev.type === "tmplOpen") return true;
    const p2 = out[out.length - 2];
    if (prev.type === "punct") {
      if (prev.value === "!") {
        // Postfix TypeScript non-null `x! / 2` is division; `!/re/` after an operator is a regex.
        let j = out.length - 1;
        while (j >= 0 && out[j].type === "punct" && out[j].value === "!") j--;
        const base = out[j];
        const dotBefore = out[j - 1]?.type === "punct" && (out[j - 1].value === "." || out[j - 1].value === "?." || out[j - 1].value === "#");
        const operand = base && (
          (base.type === "id" && (dotBefore || !KEYWORDS_BEFORE_REGEX.has(base.value))) ||
          (base.type === "punct" && ((base.value === ")" && !base.ctl) || base.value === "]")));
        const odd = base && ["num", "str", "regex", "templateEnd"].includes(base.type);
        if (operand || odd) {
          const first = out[j + 1];
          if (operand && base.pos + base.value.length === first.pos) return false; // `x!/`: postfix, division
          if (odd || first.line === base.line) fail("Ambiguous `!` before `/` (non-null assertion or logical not)", first.pos);
          return true; // `!` on a new line: ASI, so a prefix operator and a regex follows
        }
      }
      if ((prev.value === "+" || prev.value === "-") && p2 && p2.type === "punct" && p2.value === prev.value && p2.pos + 1 === prev.pos) {
        const p3 = out[out.length - 3];
        if (p3 && (p3.type === "id" || (p3.type === "punct" && (p3.value === ")" || p3.value === "]")))) { amb = true; return false; } // postfix ++/-- (division) or prefix on the next line (regex)
      }
      if (prev.value === ")" && prev.ctl) return true;
      if (CLOSE.has(prev.value) || prev.value === ">") { amb = true; return prev.value === ">"; } // `}` block/object, `)`, `]`, generic `>`: heuristic only
      return true;
    }
    if (prev.type === "id") {
      if (!KEYWORDS_BEFORE_REGEX.has(prev.value)) return false;
      if (p2 && p2.type === "punct" && (p2.value === "." || p2.value === "?." || p2.value === "#")) return false; // property name (`.name`, `#name`), not a keyword
      if (prev.value === "extends") { amb = true; return true; } // `class A extends /re/.x {}` is a regex; `extends` as a plain identifier is division
      if (prev.value === "of") {
        // `of` is a keyword only directly inside a `for (` header; anywhere else it is an identifier (division follows).
        if (!fors[fors.length - 1]) return false;
        if (p2 && p2.type === "id" && ["let", "var", "const"].includes(p2.value)) fail("Ambiguous `of` before `/` in a for header (identifier or for-of keyword)", prev.pos);
        amb = true; // for-of keyword or identifier named `of`: both readings are valid after any left side (`x!`, `(x)`, `x`, ...)
        return !!p2 && (p2.type === "id" || (p2.type === "punct" && (p2.value === "]" || p2.value === "}")));
      }
      if (prev.value === "await" || prev.value === "yield") amb = true; // contextual: keyword in async/generator code, identifier elsewhere
      return true;
    }
    return false;
  };

  function lex(out, stopAtBrace) {
    let depth = 0;
    for (;;) {
      while (pos < src.length && /\s/.test(src[pos])) pos++;
      if (pos >= src.length) { if (stopAtBrace) fail("Unterminated template expression", pos); return; }
      const c = src[pos], start = pos, n = src[pos + 1];
      const push = (type, value) => out.push({ type, value, pos: start, line: lineOf(start) });
      if (c === "/" && n === "/") { while (pos < src.length && !isLT(src[pos])) pos++; continue; }
      if (c === "/" && n === "*") {
        const end = src.indexOf("*/", pos + 2);
        if (end < 0) fail("Unterminated block comment", pos);
        pos = end + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        pos++;
        let v = "";
        while (pos < src.length && src[pos] !== c) {
          if (isLT(src[pos])) fail("Unterminated string", start);
          if (src[pos] === "\\") { const w = src[pos + 1] === "\r" && src[pos + 2] === "\n" ? 3 : 2; v += src.slice(pos, pos + w); pos += w; continue; }
          v += src[pos++];
        }
        if (pos >= src.length) fail("Unterminated string", start);
        pos++;
        push("str", v);
        continue;
      }
      if (c === "`") {
        pos++;
        push("template", "`");
        const tk = out[out.length - 1];
        tk.text = "";
        tk.interp = false;
        for (;;) {
          if (pos >= src.length) fail("Unterminated template literal", start);
          if (src[pos] === "\\") { tk.text += src.slice(pos, pos + 2); pos += 2; continue; }
          if (src[pos] === "`") { pos++; break; }
          if (src[pos] === "$" && src[pos + 1] === "{") { tk.interp = true; out.push({ type: "tmplOpen", value: "${", pos, line: lineOf(pos) }); pos += 2; lex(out, true); continue; }
          tk.text += src[pos];
          pos++;
        }
        out.push({ type: "templateEnd", value: "`", pos, line: lineOf(pos - 1) });
        continue;
      }
      let asRegex = false;
      if (c === "/") {
        amb = false;
        asRegex = regexAllowed(out);
        if (amb) {
          opts.record?.push({ pos: start, line: lineOf(start) });
          if (opts.mode) asRegex = opts.mode === "regex";
          if (opts.flip === start) asRegex = !asRegex;
        }
      }
      if (c === "/" && asRegex) {
        let i = pos + 1, inClass = false, ok = false;
        while (i < src.length && !isLT(src[i])) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "[") inClass = true;
          else if (src[i] === "]") inClass = false;
          else if (src[i] === "/" && !inClass) { ok = true; break; }
          i++;
        }
        if (ok) {
          i++;
          while (i < src.length && /[A-Za-z]/.test(src[i])) i++;
          pos = i;
          push("regex", src.slice(start, i));
          continue;
        }
      }
      if (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127 || (c === "\\" && n === "u")) {
        // Identifiers may contain \uXXXX / \u{X} escapes; the scanner reports those as unparsed.
        while (pos < src.length) {
          if (src[pos] === "\\" && src[pos + 1] === "u") {
            pos += 2;
            if (src[pos] === "{") { const e = src.indexOf("}", pos); pos = e < 0 ? src.length : e + 1; }
          } else if (/[\w$]/.test(src[pos]) || src.charCodeAt(pos) > 127) pos++;
          else break;
        }
        push("id", src.slice(start, pos));
        continue;
      }
      if (/\d/.test(c) || (c === "." && /\d/.test(n ?? ""))) {
        pos++;
        while (pos < src.length && /[\w.]/.test(src[pos])) pos++;
        push("num", src.slice(start, pos));
        continue;
      }
      if (c === "=" && n === ">") { pos += 2; push("punct", "=>"); continue; }
      if (c === "?" && n === "." && !/\d/.test(src[pos + 2] ?? "")) { pos += 2; push("punct", "?."); continue; }
      if (c === "." && n === "." && src[pos + 2] === ".") { pos += 3; push("punct", "..."); continue; }
      if (stopAtBrace) {
        if (c === "{") depth++;
        else if (c === "}") { if (depth === 0) { out.push({ type: "tmplClose", value: "}", pos, line: lineOf(pos) }); pos++; return; } depth--; }
      }
      pos++;
      push("punct", c);
      if (c === "(") {
        const k = out.length >= 2 ? out[out.length - 2] : undefined, k2 = out.length >= 3 ? out[out.length - 3] : undefined;
        const afterDot = k2 && k2.type === "punct" && (k2.value === "." || k2.value === "?.");
        fors.push(!!k && k.type === "id" && !afterDot && (k.value === "for" || (k.value === "await" && k2 && k2.type === "id" && k2.value === "for")));
        parens.push(!!k && k.type === "id" && !afterDot && (["if", "while", "for", "with"].includes(k.value) || (k.value === "await" && k2 && k2.type === "id" && k2.value === "for")));
      } else if (c === ")") { out[out.length - 1].ctl = parens.pop() === true; fors.pop(); }
    }
  }

  const out = [];
  lex(out, false);
  return out;
}

const MAX_AMBIGUOUS = 200;
// Tokens that decide what the scan sees: brackets, strings, templates and the identifiers it looks for. A different
// reading of an ambiguous `/` only matters when it changes this sequence (numbers, operators, other identifiers and
// regex bodies do not), which keeps ordinary division such as `(a) / 2 + b / 3` from being reported.
const RELEVANT_IDS = new Set([...REGISTRARS, "app", "need", "authenticate", "can", "forbidden", "notFound", "Hono", "onError", "function", "return", "throw", "const", "let", "var", "async", "await", "new"]);
const significant = (toks) => toks
  .filter((t) => (t.type === "id" ? RELEVANT_IDS.has(t.value) : t.type === "punct" ? "(){}[]".includes(t.value) : t.type !== "num" && t.type !== "regex"))
  .map((t) => `${t.type}\u0000${t.value}\u0000${t.text ?? ""}`)
  .join("\n");

/**
 * Tokenize for scanning, failing closed on regex-vs-division ambiguity. The heuristic reading is tokenized; every
 * ambiguous `/` is then re-read (a) all as regex, (b) all as division, (c) each one flipped on its own, which is at most
 * 2 + MAX_AMBIGUOUS extra passes (no exponential search; mixed flips of several slashes are not tried). If any reading
 * yields a different `significant` token sequence, the source is reported unparsed. A reading that fails to tokenize
 * (unterminated string, template or comment) is discarded: the source must be valid JS/TS, so such a reading cannot be
 * the real one. Heuristic reading failing is still an error.
 */
const NOT_AFTER_REGEX = new Set(["in", "instanceof", "of", "as", "satisfies"]);
/**
 * True when a reading puts a regex token directly followed, on the same line, by a number, identifier (other than
 * in/instanceof/of/as/satisfies), string, template or regex token, with no operator between. That is a syntax error in
 * JS/TS, so such a reading cannot be the real one (it is how `(1) / 2 + [4][0] / 2` read as a regex is rejected).
 */
function impossibleReading(toks) {
  for (let i = 0; i + 1 < toks.length; i++) {
    if (toks[i].type !== "regex") continue;
    const n = toks[i + 1];
    if (n.line !== toks[i].line) continue;
    if (n.type === "num" || n.type === "str" || n.type === "template" || n.type === "regex") return true;
    if (n.type === "id" && !NOT_AFTER_REGEX.has(n.value)) return true;
  }
  return false;
}

export function tokenizeSafe(src) {
  const record = [];
  const main = tokenize(src, { record });
  if (!record.length) return main;
  const err = (msg, line) => Object.assign(new Error(`${msg} (line ${line})`), { line });
  if (record.length > MAX_AMBIGUOUS) throw err(`More than ${MAX_AMBIGUOUS} ambiguous \`/\` (regex literal or division) in the source`, record[0].line);
  const want = significant(main);
  const readings = [[{ mode: "regex" }, record[0]], [{ mode: "division" }, record[0]], ...record.map((r) => [{ flip: r.pos }, r])];
  for (const [o, at] of readings) {
    let t;
    try { t = tokenize(src, o); } catch { continue; }
    if (impossibleReading(t)) continue;
    if (significant(t) !== want) throw err("Ambiguous `/` (regex literal or division): the source tokenizes differently under the two readings, so a route could be hidden in what looks like a regex or string", at.line);
  }
  return main;
}

const PERMISSION = /^[a-z][a-z-]*:[a-z][a-z-]*$/;
const NOT_A_PATH = new Set(["undefined", "null", "this", "true", "false", "void", "typeof", "new", "function", "class", "NaN", "Infinity", "super", "async", "await", "yield", "delete", "in", "of", "instanceof"]);
const CONTINUES = new Set(["(", "[", ".", "?.", "+", "-", "*", "/", "%", "<", ">", "=", "&", "|", "^", "?", ":", ",", "!", "=>"]);

/**
 * Permission argument of need(): a string literal or interpolation-free template that looks like `area:action`, or a
 * dotted identifier path such as `route.permission` (not undefined, null, this, ...). Returns its text, or null.
 */
function permissionText(rest) {
  if (rest.length && isP(rest[rest.length - 1], ",")) rest = rest.slice(0, -1);
  if (rest.length === 1 && rest[0].type === "str") return PERMISSION.test(rest[0].value) ? rest[0].value : null;
  if (rest.length === 2 && rest[0].type === "template" && rest[1].type === "templateEnd") return !rest[0].interp && PERMISSION.test(rest[0].text) ? rest[0].text : null;
  if (rest.length % 2 === 1) {
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k];
      if (k % 2 === 0 ? !(t.type === "id" && !t.value.includes("\\") && !(k === 0 && NOT_A_PATH.has(t.value))) : !isP(t, ".")) return null;
    }
    return rest.map((t) => t.value).join("");
  }
  return null;
}

const isP = (t, v) => t?.type === "punct" && t.value === v;
const isId = (t, v) => t?.type === "id" && (v === undefined || t.value === v);
/** True when the statement whose last token is toks[last] ends there: `;`, `}`, the end, or a newline (ASI) not followed by a continuation. */
function endsStatement(toks, last, hi = toks.length) {
  const next = toks[last + 1];
  if (last + 1 >= hi || !next) return true;
  if (isP(next, ";") || isP(next, "}")) return true;
  if (next.line <= toks[last].line) return false;
  if (next.type === "punct") return !CONTINUES.has(next.value);
  if (next.type === "template") return false; // tagged template
  if (next.type === "id") return !["as", "satisfies", "in", "instanceof"].includes(next.value);
  return true;
}
const brief = (toks) => toks.map((t) => (t.type === "str" ? JSON.stringify(t.value) : t.value)).join(" ");

/** Index of the token closing the group opened at `open` (any of ( [ { count), or -1. */
function matching(toks, open) {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    if (OPEN.has(toks[i].value) && toks[i].type === "punct") depth++;
    else if (CLOSE.has(toks[i].value) && toks[i].type === "punct" && --depth === 0) return i;
  }
  return -1;
}

/** Split tokens at top-level commas. Returns arrays of {from,to} index ranges (to exclusive). */
function splitArgs(toks, from, to) {
  const args = [];
  let depth = 0, s = from;
  for (let i = from; i < to; i++) {
    const t = toks[i];
    if (t.type === "punct") {
      if (OPEN.has(t.value)) depth++;
      else if (CLOSE.has(t.value)) depth--;
      else if (t.value === "," && depth === 0) { args.push([s, i]); s = i + 1; }
    }
  }
  if (s < to) args.push([s, to]);
  return args;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
/** app.on with literal methods: every method must be a standard HTTP verb, so the label never equals a synthetic one (ROUTE, MOUNT, ALL, USE, ON). */
const onMethodsOk = (mt) => mt.filter((t) => t.type === "str").every((t) => HTTP_METHODS.has(t.value.toUpperCase()));

const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with", "else", "return", "typeof", "await", "in", "of", "new", "do", "case", "throw", "void", "delete", "yield"]);

/** True when a parameter list closing at `m` is followed by `=>` (optionally after a `: ReturnType`). */
function arrowAfter(toks, m, to) {
  if (isP(toks[m + 1], "=>")) return true;
  if (!isP(toks[m + 1], ":")) return false;
  let d = 0;
  for (let j = m + 2; j < to; j++) {
    const t = toks[j];
    if (t.type === "punct") {
      if (OPEN.has(t.value)) d++;
      else if (CLOSE.has(t.value)) { if (--d < 0) return false; }
      else if (d === 0 && t.value === "=>") return true;
      else if (d === 0 && (t.value === ";" || t.value === ",")) return false;
    }
  }
  return false;
}

/**
 * Parse toks[from,to) as exactly one inline function (function expression or arrow). Returns
 * { from, pf, pt, bodyFrom, bodyTo, block, param } (params are toks[pf,pt); body is toks[bodyFrom,bodyTo)), or null.
 * `param` is the index of the first parameter token when it is a plain identifier, else -1.
 */
function parseFn(toks, from, to) {
  let i = from;
  if (isId(toks[i], "async")) i++;
  let pf, pt, bodyFrom, bodyTo, block;
  if (isId(toks[i], "function")) {
    i++;
    if (isP(toks[i], "*")) return null;
    if (isId(toks[i])) i++;
    if (!isP(toks[i], "(")) return null;
    const c = matching(toks, i);
    if (c < 0 || c >= to) return null;
    pf = i + 1; pt = c;
    let j = c + 1;
    while (j < to && !isP(toks[j], "{")) j++;
    if (j >= to) return null;
    const e = matching(toks, j);
    if (e !== to - 1) return null;
    bodyFrom = j + 1; bodyTo = e; block = true;
  } else {
    if (isP(toks[i], "(")) {
      const c = matching(toks, i);
      if (c < 0 || c >= to || !arrowAfter(toks, c, to)) return null;
      pf = i + 1; pt = c;
      i = c + 1;
      while (i < to && !isP(toks[i], "=>")) i++;
    } else if (isId(toks[i]) && isP(toks[i + 1], "=>")) {
      pf = i; pt = i + 1;
      i = i + 1;
    } else return null;
    const k = i + 1;
    if (k >= to) return null;
    if (isP(toks[k], "{") && matching(toks, k) === to - 1) { bodyFrom = k + 1; bodyTo = to - 1; block = true; }
    else { bodyFrom = k; bodyTo = to; block = false; }
  }
  const param = pf < pt && isId(toks[pf]) && (pf + 1 === pt || isP(toks[pf + 1], ",") || isP(toks[pf + 1], ":") || isP(toks[pf + 1], "?")) ? pf : -1;
  return { from, to, pf, pt, bodyFrom, bodyTo, block, param };
}

/** True when `name` is (re)declared anywhere in the function (any param, const/let/var, function, class, catch). */
function redeclares(toks, fn, name) {
  const lo = fn.from, hi = fn.to;
  const ids = (a, b) => { for (let k = a; k < b; k++) if (isId(toks[k], name) && k !== fn.param) return true; return false; };
  for (let k = lo; k < hi; k++) {
    const t = toks[k];
    if (isId(t, name) && k !== fn.param) {
      if (["function", "class", "const", "let", "var"].includes(toks[k - 1]?.value) && toks[k - 1].type === "id") return true;
      if (isP(toks[k + 1], "=>") && !isP(toks[k - 1], ".")) return true;
    }
    if (isP(t, "(")) {
      const m = matching(toks, k);
      if (m < 0) continue;
      const prev = toks[k - 1];
      const isParams = arrowAfter(toks, m, hi) || (isP(toks[m + 1], "{") && (isId(prev, "function") || (isId(prev) && !CONTROL.has(prev.value) && !isP(toks[k - 2], ".")) || (isId(prev) && isId(toks[k - 2], "function"))));
      const isCatch = isId(prev, "catch");
      if ((isParams || isCatch) && ids(k + 1, m)) return true;
    }
    if (t.type === "id" && ["const", "let", "var"].includes(t.value)) {
      let j = k + 1, d = 0;
      while (j < hi) {
        if (isP(toks[j], "{") || isP(toks[j], "[")) { const m = matching(toks, j); if (m < 0) break; if (ids(j + 1, m)) return true; j = m + 1; }
        else if (isId(toks[j])) { if (toks[j].value === name && j !== fn.param) return true; j++; }
        else break;
        // skip the initializer up to a depth-0 comma (next declarator) or the end of the statement
        d = 0;
        let next = false;
        for (; j < hi; j++) {
          const u = toks[j];
          if (u.type !== "punct") continue;
          if (OPEN.has(u.value)) d++;
          else if (CLOSE.has(u.value)) { if (--d < 0) break; }
          else if (d === 0 && u.value === ";") break;
          else if (d === 0 && u.value === ",") { j++; next = true; break; }
        }
        if (!next) break;
      }
    }
  }
  return false;
}

/**
 * The gate of a parsed handler: the first statement must call need(<first param>, <permission>), as an expression
 * statement or as the initializer of a const/let declaration (optionally awaited). Returns the permission text or null.
 */
function gateOf(toks, fn) {
  if (fn.param < 0) return null;
  const pname = toks[fn.param].value;
  let k = fn.bodyFrom;
  const end = fn.bodyTo;
  if (isId(toks[k], "const") || isId(toks[k], "let")) {
    k++;
    if (isP(toks[k], "{") || isP(toks[k], "[")) { const m = matching(toks, k); if (m < 0) return null; k = m + 1; }
    else if (isId(toks[k])) k++;
    else return null;
    if (isP(toks[k], ":")) { while (k < end && !isP(toks[k], "=")) k++; }
    if (!isP(toks[k], "=") || isP(toks[k + 1], "=")) return null;
    k++;
  }
  if (isId(toks[k], "await")) k++;
  if (!isId(toks[k], "need") || !isP(toks[k + 1], "(")) return null;
  const nc = matching(toks, k + 1);
  if (nc < 0 || nc >= end || !isId(toks[k + 2], pname) || !isP(toks[k + 3], ",")) return null;
  if (!endsStatement(toks, nc, end)) return null;
  return permissionText(toks.slice(k + 4, nc));
}

/**
 * True when toks[from,to) is a handler with zero parameters whose body is exactly
 * `throw <fnName>()` (block or expression form). Anything else (defaults, destructuring, types) is not.
 */
function onlyThrows(toks, from, to, fnName) {
  let i = from;
  if (isId(toks[i], "async")) i++;
  let params, bodyFrom;
  if (isId(toks[i], "function")) {
    i++;
    if (isId(toks[i])) i++;
    if (!isP(toks[i], "(")) return false;
    const c = matching(toks, i);
    if (c < 0 || !isP(toks[c + 1], "{")) return false;
    params = toks.slice(i + 1, c);
    bodyFrom = c + 1;
  } else if (isP(toks[i], "(")) {
    const c = matching(toks, i);
    if (c < 0 || !isP(toks[c + 1], "=>")) return false;
    params = toks.slice(i + 1, c);
    bodyFrom = c + 2;
  } else if (isId(toks[i]) && isP(toks[i + 1], "=>")) {
    params = [toks[i]];
    bodyFrom = i + 2;
  } else return false;
  if (params.length) return false; // a handler with any parameter (even an unused one) is not the plain catch-all
  let body = toks.slice(bodyFrom, to);
  if (isP(body[0], "{")) {
    if (matching(body, 0) !== body.length - 1) return false;
    body = body.slice(1, -1);
  }
  if (isP(body[body.length - 1], ";")) body = body.slice(0, -1);
  const want = ["throw", fnName, "(", ")"];
  return body.length === want.length && body.every((t, k) => t.value === want[k] && (t.type === "id" || t.type === "punct"));
}

/**
 * @param {string} src tenant-app.ts source
 * @param {Record<string, string | {reason: string, onlyThrows?: string}>} exemptions "METHOD path" -> reason
 * @param {Record<string, string>} publicRoutes "METHOD path" -> reason: the only non-middleware registrations allowed
 *   before the authentication line
 * @returns {{routes: object[], ungated: object[], unparsed: object[], stale: string[], stalePublic: string[]}}
 *   `stale` lists exemptions matching no signed-in route; `stalePublic` lists publicRoutes keys matching no pre-auth registration
 */
export function scan(src, exemptions = {}, publicRoutes = {}) {
  const result = { routes: [], ungated: [], unparsed: [], stale: [], stalePublic: [] };
  let toks;
  try { toks = tokenizeSafe(src); } catch (e) { result.unparsed.push({ line: e.line ?? 0, reason: `Could not tokenize: ${e.message}` }); return result; }

  // Mechanism-independent cross-check on the raw text: whatever the tokenizer decided, every occurrence of the words
  // the scan depends on must be an identifier token. A hit inside what was read as a string, regex, template or
  // comment is reported (fail closed). Prose or strings that legitimately contain e.g. `app.get(` are therefore
  // reported too; that is accepted, reword them.
  {
    const idAt = new Set(toks.filter((t) => t.type === "id").map((t) => t.pos));
    const reg = [...REGISTRARS].join("|");
    const patterns = [/\bapp\b/dg, /\bauthenticate\b/dg, /\bneed(?=\s*\()/dg, /\bcan(?=\s*\()/dg, /\bforbidden(?=\s*\()/dg, new RegExp(`\\??\\.\\s*(${reg})\\s*\\(`, "dg")];
    const lineAt = (i) => src.slice(0, i).split(/\r\n|[\n\r\u2028\u2029]/).length;
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const at = m.indices[1]?.[0] ?? m.index;
        if (!idAt.has(at)) result.unparsed.push({ line: lineAt(at), reason: `${JSON.stringify(src.slice(at, at + 12).split(/\W/)[0] || m[0])} appears inside what the scanner read as a string, regex or comment` });
      }
    }
  }

  // The authentication line: app.use("/api/*", authenticate)
  let from = -1;
  for (let i = 0; i + 8 < toks.length; i++) {
    if (isId(toks[i], "app") && !isP(toks[i - 1], ".") && isP(toks[i + 1], ".") && isId(toks[i + 2], "use") && isP(toks[i + 3], "(") && toks[i + 4].type === "str" && toks[i + 4].value === "/api/*" && isP(toks[i + 5], ",") && isId(toks[i + 6], "authenticate") && isP(toks[i + 7], ")")) { from = i + 8; break; }
  }
  if (from < 0) { result.unparsed.push({ line: 0, reason: 'Could not find the authentication line app.use("/api/*", authenticate); nothing was checked' }); return result; }

  // Escaped identifiers can spell `app`, `get`, `need`... in ways this scanner does not decode: refuse them.
  for (const t of toks) if (t.type === "id" && t.value.includes("\\")) result.unparsed.push({ line: t.line, reason: `Identifier with a unicode escape: ${t.value}` });

  // Pass 1: every use of the identifier `app` in the whole source. Registrations before the auth line are out of
  // scope, but any other use (alias, destructuring, passing it on) is reported wherever it is.
  const regs = [];
  const preRegs = []; // non-middleware registrations before the authentication line (must be on the public allow-list)
  // Parses `<method>[<generics>](...)` with the method token at `m`; returns the registration or null (reported).
  const parseCall = (m, line, label) => {
    const method = toks[m].value;
    let j = m + 1;
    if (isP(toks[j], "<")) {
      let d = 0;
      for (; j < toks.length; j++) {
        if (isP(toks[j], "<")) d++;
        else if (isP(toks[j], ">") && --d === 0) { j++; break; }
        else if (isP(toks[j], ";")) { j = -1; break; }
      }
    }
    if (j < 0 || !isP(toks[j], "(")) { result.unparsed.push({ line, reason: `${label}${method} is not followed by a call` }); return null; }
    const close = matching(toks, j);
    if (close < 0) { result.unparsed.push({ line, reason: `${label}${method}( is never closed` }); return null; }
    return { tok: m, line, method, argFrom: j + 1, argTo: close };
  };
  // Every `.method(` chained after a registration call's closing paren is itself a registration.
  // Returns the index just past the chain, or -1 when it was reported as unparsed. With collect=false (registrations
  // before the authentication line) the chain is only walked.
  const chain = (after, collect = true, into = regs) => {
    let p = after;
    while (isP(toks[p], ".") || isP(toks[p], "?.")) {
      const line = toks[p].line;
      if (isP(toks[p], "?.") || !isId(toks[p + 1]) || (!REGISTRARS.has(toks[p + 1].value) && toks[p + 1].value !== "onError")) {
        result.unparsed.push({ line, reason: `Chained call after a route registration that is not a recognised registration: ${brief(toks.slice(p, p + 3))}` });
        return -1;
      }
      const reg = parseCall(p + 1, line, "chained .");
      if (!reg) return -1;
      reg.tok = p;
      if (collect && toks[p + 1].value !== "onError") into.push(reg);
      p = reg.argTo + 1;
    }
    return p;
  };
  // A registration (with its chain) must be a whole expression statement that starts with `app`: its value is never
  // kept, chained on, cast, passed or wrapped, so no registration can hide behind an alias of the returned object.
  const wholeStatement = (i, end, line) => {
    const pv = toks[i - 1];
    const startsOk = !pv || isP(pv, ";") || isP(pv, "{") || isP(pv, "}") || isP(pv, ")") || isId(pv, "else") || isId(pv, "do");
    if (!startsOk || !endsStatement(toks, end - 1)) result.unparsed.push({ line, reason: `Route registration is not a whole expression statement starting with app (its value is used, chained or wrapped): ${brief(toks.slice(Math.max(0, i - 2), i + 4))} ... ${brief(toks.slice(end - 1, end + 2))}` });
  };
  // Scope: the function that contains the authentication line. Exactly one `const app = new Hono()` must be
  // declared in it; a decoy declaration in another function does not move the scope.
  const isDecl = (i) => ["const", "let", "var"].includes(toks[i - 1]?.value) && isP(toks[i + 1], "=") && isId(toks[i + 2], "new") && isId(toks[i + 3], "Hono");
  const authAt = from - 8;
  let lo = -1, hi = toks.length - 1;
  {
    let d = 0;
    for (let o = authAt - 1; o >= 0; o--) {
      if (isP(toks[o], "}")) d++;
      else if (isP(toks[o], "{") && d-- === 0) {
        const pv = toks[o - 1];
        let fnBody = isP(pv, "=>");
        if (isP(pv, ")")) {
          let dd = 0, q = o - 1;
          for (; q >= 0; q--) { if (isP(toks[q], ")")) dd++; else if (isP(toks[q], "(") && --dd === 0) break; }
          const h = toks[q - 1];
          fnBody = isId(h, "function") || (isId(h) && !CONTROL.has(h.value) && h.value !== "function") || isP(h, ">") || (isP(toks[q - 1], "*"));
        }
        if (fnBody) { const e = matching(toks, o); if (e >= 0) { lo = o; hi = e; } break; }
      }
    }
  }
  const inHole = new Array(toks.length);
  { let h = 0; toks.forEach((t, i) => { if (t.type === "tmplOpen") h++; inHole[i] = h > 0; if (t.type === "tmplClose") h--; }); }
  const dep = new Array(toks.length);
  { let cur = 0; toks.forEach((t, i) => { if (t.type === "punct" && OPEN.has(t.value)) { dep[i] = cur++; } else if (t.type === "punct" && CLOSE.has(t.value)) { dep[i] = --cur; } else dep[i] = cur; }); }
  const base = lo >= 0 ? dep[lo] + 1 : 0;
  // A statement that starts directly in the factory body (not nested in a function, block or expression).
  const topLevel = (i) => dep[i] === base && (i - 1 === lo || isP(toks[i - 1], ";") || isP(toks[i - 1], "}"));
  const decls = [];
  for (let i = Math.max(lo, 0); i <= hi; i++) if (isId(toks[i], "app") && isDecl(i)) decls.push(i);
  if (decls.length !== 1) {
    result.unparsed.push({ line: toks[authAt].line, reason: `Expected exactly one \`const app = new Hono()\` in the function that contains the authentication line, found ${decls.length}` });
  }
  for (let i = Math.max(lo, 0); i <= hi; i++) {
    const t = toks[i];
    if (!isId(t, "app") || isP(toks[i - 1], ".") || isP(toks[i - 1], "?.")) continue;
    if (isP(toks[i + 1], ":") && (isP(toks[i - 1], "{") || isP(toks[i - 1], ","))) continue; // object property key
    if (isId(toks[i - 1], "return") && (toks[i + 1] === undefined || isP(toks[i + 1], ";") || isP(toks[i + 1], "}")) && topLevel(i - 1)) continue; // `return app` of the factory
    if (isDecl(i)) continue; // the declaration
    const isOnError = isP(toks[i + 1], ".") && isId(toks[i + 2], "onError") && isP(toks[i + 3], "(");
    if (inHole[i]) { result.unparsed.push({ line: t.line, reason: `Use of \`app\` inside a template literal \`\${...}\` hole: ${brief(toks.slice(i, i + 4))}` }); continue; }
    if (!isOnError && (!isP(toks[i + 1], ".") || !isId(toks[i + 2]) || !REGISTRARS.has(toks[i + 2].value))) {
      result.unparsed.push({ line: t.line, reason: `Use of \`app\` that is not a recognised route registration: ${brief(toks.slice(i, i + 4))}` });
      continue;
    }
    const reg = parseCall(i + 2, t.line, "app.");
    if (!reg) continue;
    reg.tok = i;
    if (i < from) {
      // Before the authentication line: out of scope, but only as a top-level statement of the factory, because a
      // registration inside a function or block there can run after authentication. The authentication line itself
      // may chain registrations (app.use("/api/*", authenticate).get(...)).
      if (!topLevel(i)) result.unparsed.push({ line: t.line, reason: `Registration before the authentication line is not a top-level statement of the factory: ${brief(toks.slice(i, i + 4))}` });
      if (i !== authAt && !isOnError && reg.method !== "use") preRegs.push(reg);
      const e = chain(reg.argTo + 1, true, i === authAt ? regs : preRegs);
      if (e >= 0) wholeStatement(i, e, t.line);
      continue;
    }
    if (!isOnError) regs.push(reg);
    const e = chain(reg.argTo + 1);
    if (e >= 0) wholeStatement(i, e, t.line);
  }

  // Registrations outside the factory (the returned app is public API; helpers may receive it) are not analysed, so
  // refuse the shapes that register routes there: `app.<registrar>(` or any `.<registrar>(` with a "/..." path argument.
  if (lo >= 0) {
    for (let i = 0; i < toks.length; i++) {
      if (i >= lo && i <= hi) continue;
      if (!isId(toks[i]) || !REGISTRARS.has(toks[i].value) || !(isP(toks[i - 1], ".") || isP(toks[i - 1], "?.")) || !isP(toks[i + 1], "(")) continue;
      const close = matching(toks, i + 1);
      const first = close < 0 ? [] : splitArgs(toks, i + 2, close).slice(0, 2).map(([x]) => toks[x]);
      const slashPath = first.some((t) => (t.type === "str" && t.value.startsWith("/")) || (t.type === "template" && t.text.startsWith("/")));
      if (slashPath || isId(toks[i - 2], "app")) result.unparsed.push({ line: toks[i].line, reason: `Route registration outside the factory function that holds the authentication line: ${brief(toks.slice(Math.max(0, i - 2), i + 4))}` });
    }
  }

  // `need`: exactly one declaration in the whole source, `const need = (...) => { ... }` directly in the factory,
  // whose body checks `can(` and `throw forbidden()`. Any other binding of the name, anywhere, is reported.
  {
    const needAt = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!isId(t, "need")) continue;
      if (isP(toks[i - 1], ".") || isP(toks[i - 1], "?.")) continue; // property access
      if (isP(toks[i + 1], "(") && !isId(toks[i - 1], "function") && !isId(toks[i - 1], "class")) continue; // a call (or method name)
      if (isId(toks[i - 1], "const") && isP(toks[i + 1], "=") && !isP(toks[i + 2], "=") && topLevel(i - 1) && i - 1 >= lo && i <= hi) { needAt.push(i); continue; }
      result.unparsed.push({ line: t.line, reason: `\`need\` is declared or bound other than by the single factory-level \`const need = (...) => {...}\` (shadowing could turn a check into a no-op): ${brief(toks.slice(Math.max(0, i - 2), i + 3))}` });
    }
    if (needAt.length !== 1) result.unparsed.push({ line: needAt.length ? toks[needAt[1]].line : toks[authAt].line, reason: `Expected exactly one factory-level \`const need = (...) => {...}\`, found ${needAt.length}` });
    else {
      const eq = needAt[0] + 1;
      let m = isP(toks[eq + 1], "(") ? matching(toks, eq + 1) : -1, b = -1;
      if (m >= 0 && arrowAfter(toks, m, toks.length)) { b = m + 1; while (b < toks.length && !isP(toks[b], "=>")) b++; b++; }
      const e = b > 0 && isP(toks[b], "{") ? matching(toks, b) : -1;
      const fn = e >= 0 ? parseFn(toks, eq + 1, e + 1) : null;
      let can = false, thr = false;
      if (fn && fn.block) {
        for (let k = fn.bodyFrom; k < fn.bodyTo; k++) {
          if (isId(toks[k], "can") && isP(toks[k + 1], "(") && !isP(toks[k - 1], ".")) can = true;
          if (isId(toks[k], "throw") && isId(toks[k + 1], "forbidden") && isP(toks[k + 2], "(") && isP(toks[k + 3], ")")) thr = true;
        }
      }
      if (!(can && thr)) result.unparsed.push({ line: toks[needAt[0]].line, reason: "The factory-level `need` is not `(...) => { ... }` whose body calls can( and does throw forbidden()" });
    }
  }

  const seenExempt = new Set();
  // Pre-auth registrations: public only when listed. Middleware (`use`) is out of scope and never reaches here.
  const seenPublic = new Set();
  for (const reg of preRegs) {
    if (reg.method === "use") continue; // chained middleware
    const args = splitArgs(toks, reg.argFrom, reg.argTo);
    let label = reg.method.toUpperCase();
    let pathArg;
    if (reg.method === "on") {
      const mt = args[0] ? toks.slice(args[0][0], args[0][1]) : [];
      const literalMethods = mt.length > 0 && mt.every((t) => t.type === "str" || (t.type === "punct" && ["[", "]", ","].includes(t.value)));
      label = literalMethods ? mt.filter((t) => t.type === "str").map((t) => t.value.toUpperCase()).join("|") : "ON";
      if (literalMethods && !onMethodsOk(mt)) { result.unparsed.push({ line: reg.line, reason: `app.on registered before the authentication line uses a method that is not a standard HTTP method (could collide with a synthetic key such as ROUTE): ${brief(mt)}` }); continue; }
      pathArg = args[1];
    } else pathArg = args[0];
    const ptoks = pathArg ? toks.slice(pathArg[0], pathArg[1]) : [];
    if (!(ptoks.length === 1 && ptoks[0].type === "str" && !ptoks[0].value.includes("\\"))) {
      result.unparsed.push({ line: reg.line, reason: `${label} registered before the authentication line has a path that is not a plain string literal, so it cannot be matched against the public allow-list: ${brief(ptoks) || "?"}` });
      continue;
    }
    const key = `${label} ${ptoks[0].value}`;
    const entry = { key, method: label, path: ptoks[0].value, line: reg.line, gated: false, gates: [], exempt: null };
    if (reg.method !== "route" && reg.method !== "mount") {
      const rest = reg.method === "on" ? args.slice(2) : args.slice(1);
      const bad = rest.findIndex(([a, b]) => !parseFn(toks, a, b));
      if (bad >= 0) { result.unparsed.push({ line: reg.line, reason: `${label} ${ptoks[0].value}: extra argument before the authentication line is not an inline function: ${brief(toks.slice(rest[bad][0], Math.min(rest[bad][1], rest[bad][0] + 6)))}` }); continue; }
    }
    if (!Object.hasOwn(publicRoutes, key)) {
      result.ungated.push({ ...entry, reason: "Registered before the authentication line (unauthenticated) and not on the public allow-list (PUBLIC_CORE_ROUTES)" });
    } else if (seenPublic.has(key)) {
      result.ungated.push({ ...entry, reason: "Duplicate registration of a public route before the authentication line; only one is allowed" });
    }
    seenPublic.add(key);
  }
  for (const key of Object.keys(publicRoutes)) if (!seenPublic.has(key)) result.stalePublic.push(key);
  for (const reg of regs) {
    const args = splitArgs(toks, reg.argFrom, reg.argTo);
    let label = reg.method.toUpperCase();
    let pathArg;
    if (reg.method === "on") {
      const m = args[0];
      const mt = m ? toks.slice(m[0], m[1]) : [];
      const literalMethods = mt.length > 0 && mt.every((t) => t.type === "str" || (t.type === "punct" && ["[", "]", ","].includes(t.value)));
      label = literalMethods ? mt.filter((t) => t.type === "str").map((t) => t.value.toUpperCase()).join("|") : "ON";
      if (literalMethods && !onMethodsOk(mt)) { result.unparsed.push({ line: reg.line, reason: `app.on uses a method that is not a standard HTTP method (could collide with a synthetic key such as ROUTE): ${brief(mt)}` }); continue; }
      pathArg = args[1];
    } else if (reg.method === "use") {
      pathArg = args[0] && (toks[args[0][0]].type === "str" || toks[args[0][0]].type === "template") ? args[0] : null;
    } else pathArg = args[0];

    // Path classification.
    const ptoks = pathArg ? toks.slice(pathArg[0], pathArg[1]) : [];
    let path, literal = false;
    if (pathArg === null) path = "*";
    else if (ptoks.length === 1 && ptoks[0].type === "str" && !ptoks[0].value.includes("\\")) { path = ptoks[0].value; literal = true; }
    else path = brief(ptoks) || "?";
    if (literal) {
      const first = path.startsWith("/") ? path.slice(1).split("/")[0] : null;
      if (first !== null && /^[A-Za-z0-9_.~-]+$/.test(first) && first !== "api" && first !== "svc") continue; // out of scope
    }
    // Re-applying authentication is not a route.
    if (reg.method === "use" && args.length === 2 && literal && args[1][1] - args[1][0] === 1 && isId(toks[args[1][0]], "authenticate")) continue;

    // Handlers: every argument after the path must be an inline function; the gate must be in the first one.
    const hargs = reg.method === "on" ? args.slice(2) : reg.method === "use" ? (pathArg ? args.slice(1) : args) : args.slice(1);
    const fns = hargs.map(([a, b]) => parseFn(toks, a, b));
    const badAt = fns.findIndex((f) => !f);
    if (badAt >= 0) {
      result.unparsed.push({ line: reg.line, reason: `${label} ${path}: handler argument is not an inline function: ${brief(toks.slice(hargs[badAt][0], Math.min(hargs[badAt][1], hargs[badAt][0] + 6)))}` });
      continue;
    }
    const gates = [];
    let shadowed = false;
    if (fns.length) {
      const g = gateOf(toks, fns[0]);
      if (g !== null) {
        if (redeclares(toks, fns[0], "need") || redeclares(toks, fns[0], toks[fns[0].param].value)) shadowed = true;
        else gates.push(g);
      }
    }

    const key = `${label} ${path}`;
    const entry = { key, method: label, path, line: reg.line, gated: gates.length > 0, gates, exempt: null };
    let reported = false;
    const ex = Object.hasOwn(exemptions, key) ? exemptions[key] : undefined;
    if (ex !== undefined && !entry.gated) {
      const spec = typeof ex === "string" ? { reason: ex } : ex;
      if (seenExempt.has(key)) {
        reported = true;
        result.ungated.push({ ...entry, reason: "Duplicate registration of an exempted route; only one is exempt" });
      } else if (spec.onlyThrows && !(hargs.length === 1 && args.length === (reg.method === "on" ? 3 : 2) && onlyThrows(toks, hargs[0][0], hargs[0][1], spec.onlyThrows))) {
        reported = true;
        result.ungated.push({ ...entry, reason: `Exempt only while the handler does nothing but throw ${spec.onlyThrows}()` });
      } else entry.exempt = spec.reason;
      seenExempt.add(key);
    } else if (ex !== undefined) {
      seenExempt.add(key); // exemption present and route is gated anyway: still "used"
    }
    result.routes.push(entry);
    if (!entry.gated && !entry.exempt && !reported) {
      result.ungated.push({ ...entry, reason: reg.method === "use" ? "Middleware in scope can answer requests without a permission check" : shadowed ? "need or the context parameter is redeclared inside the handler" : "The first statement of the handler is not need(<ctx>, <permission>)" });
    }
  }
  for (const key of Object.keys(exemptions)) if (!seenExempt.has(key)) result.stale.push(key);
  return result;
}
