// SPDX-License-Identifier: Apache-2.0
// Static check for AGENTS.md invariant 4 on the core tenant app: every signed-in route must call
// `need(<ctx>, <permission>)`. TypeScript 7 has no JS API and we add no dependencies, so this is a small
// tokenizer plus a token-level walk, not a regex over text. See docs/pentest.md (AUTHZ-07).

const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const REGISTRARS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all", "on", "use", "route", "mount"]);
const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** Exemptions for the real tenant-app.ts: "METHOD path" -> reason (string) or { reason, onlyThrows: "notFound" }. */
export const CORE_EXEMPTIONS = {
  "GET /api/overview": "Counts are visible to every member; the audit panel is gated inline with can(role, \"audit:read\"). A permission every role holds would add nothing.",
  "ALL /api/*": { reason: "Catch-all 404 for unknown API paths; holds only while the handler does nothing but throw notFound().", onlyThrows: "notFound" },
};

/**
 * Tokenize TypeScript/JavaScript source. Comments are dropped. Strings are one token; template literals are a
 * `template` token, their `${...}` code inline as ordinary tokens, then `templateEnd`. Regex literals are one token.
 *
 * Regex vs division is decided from the previous significant token: a `/` starts a regex when there is none, when
 * it is punctuation other than `)`, `]`, `}`, or when it is a keyword such as `return`/`typeof`. After an
 * identifier, number, string, template, regex, `)`, `]` or `}` it is division. Known blind spot: a regex right after
 * `)` or `}` (e.g. `if (x) /re/.test(y)`) reads as division.
 */
export function tokenize(src) {
  const nl = [];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") nl.push(i);
  const lineOf = (pos) => {
    let lo = 0, hi = nl.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < pos) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
  let pos = 0;
  const fail = (msg, at) => { throw new Error(`${msg} (line ${lineOf(at)})`); };

  const regexAllowed = (out) => {
    const prev = out[out.length - 1];
    if (!prev) return true;
    const p2 = out[out.length - 2];
    if (prev.type === "punct") {
      if ((prev.value === "+" || prev.value === "-") && p2 && p2.type === "punct" && p2.value === prev.value && p2.pos + 1 === prev.pos) {
        const p3 = out[out.length - 3];
        if (p3 && (p3.type === "id" || (p3.type === "punct" && (p3.value === ")" || p3.value === "]")))) return false; // postfix ++/--: division follows
      }
      return !CLOSE.has(prev.value);
    }
    if (prev.type === "id") {
      if (!KEYWORDS_BEFORE_REGEX.has(prev.value)) return false;
      if (p2 && p2.type === "punct" && (p2.value === "." || p2.value === "?.")) return false; // property name, not a keyword
      if (prev.value === "of") return !!p2 && (p2.type === "id" || (p2.type === "punct" && (p2.value === "]" || p2.value === "}"))); // `for (x of /re/...)` vs an identifier named `of`
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
      const prev = out[out.length - 1];
      if (c === "/" && n === "/") { while (pos < src.length && src[pos] !== "\n") pos++; continue; }
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
          if (src[pos] === "\n") fail("Unterminated string", start);
          if (src[pos] === "\\") { v += src.slice(pos, pos + 2); pos += 2; continue; }
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
        for (;;) {
          if (pos >= src.length) fail("Unterminated template literal", start);
          if (src[pos] === "\\") { pos += 2; continue; }
          if (src[pos] === "`") { pos++; break; }
          if (src[pos] === "$" && src[pos + 1] === "{") { pos += 2; lex(out, true); continue; }
          pos++;
        }
        out.push({ type: "templateEnd", value: "`", pos, line: lineOf(pos - 1) });
        continue;
      }
      if (c === "/" && regexAllowed(out)) {
        let i = pos + 1, inClass = false, ok = false;
        while (i < src.length && src[i] !== "\n") {
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
        else if (c === "}") { if (depth === 0) { pos++; return; } depth--; }
      }
      pos++;
      push("punct", c);
    }
  }

  const out = [];
  lex(out, false);
  return out;
}

const isP = (t, v) => t?.type === "punct" && t.value === v;
const isId = (t, v) => t?.type === "id" && (v === undefined || t.value === v);
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
  if (!(nc + 1 === end || isP(toks[nc + 1], ";"))) return null;
  const rest = toks.slice(k + 4, nc);
  if (!rest.length || (rest.length === 1 && rest[0].type === "str" && rest[0].value === "")) return null;
  if (rest.length === 2 && rest[0].type === "template" && rest[1].type === "templateEnd") return null;
  return rest.length === 1 && rest[0].type === "str" ? rest[0].value : brief(rest);
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
 * @returns {{routes: object[], ungated: object[], unparsed: object[], stale: string[]}}
 */
export function scan(src, exemptions = {}) {
  const result = { routes: [], ungated: [], unparsed: [], stale: [] };
  let toks;
  try { toks = tokenize(src); } catch (e) { result.unparsed.push({ line: 0, reason: `Could not tokenize: ${e.message}` }); return result; }

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
  const chain = (after) => {
    let p = after;
    while (isP(toks[p], ".") || isP(toks[p], "?.")) {
      const line = toks[p].line;
      if (isP(toks[p], "?.") || !isId(toks[p + 1]) || (!REGISTRARS.has(toks[p + 1].value) && toks[p + 1].value !== "onError")) {
        result.unparsed.push({ line, reason: `Chained call after a route registration that is not a recognised registration: ${brief(toks.slice(p, p + 3))}` });
        return;
      }
      const reg = parseCall(p + 1, line, "chained .");
      if (!reg) return;
      reg.tok = p;
      if (toks[p + 1].value !== "onError") regs.push(reg);
      p = reg.argTo + 1;
    }
  };
  if (isP(toks[from], ".") || isP(toks[from], "?.")) chain(from); // app.use("/api/*", authenticate).get(...)
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
    if (!isOnError && (!isP(toks[i + 1], ".") || !isId(toks[i + 2]) || !REGISTRARS.has(toks[i + 2].value))) {
      result.unparsed.push({ line: t.line, reason: `Use of \`app\` that is not a recognised route registration: ${brief(toks.slice(i, i + 4))}` });
      continue;
    }
    const reg = parseCall(i + 2, t.line, "app.");
    if (!reg) continue;
    reg.tok = i;
    if (i < from) {
      // Before the authentication line: out of scope, but only as a top-level statement of the factory, because a
      // registration inside a function or block there can run after authentication.
      if (!topLevel(i)) result.unparsed.push({ line: t.line, reason: `Registration before the authentication line is not a top-level statement of the factory: ${brief(toks.slice(i, i + 4))}` });
      continue;
    }
    if (!isOnError) regs.push(reg);
    chain(reg.argTo + 1);
  }

  const seenExempt = new Set();
  for (const reg of regs) {
    const args = splitArgs(toks, reg.argFrom, reg.argTo);
    let label = reg.method.toUpperCase();
    let pathArg;
    if (reg.method === "on") {
      const m = args[0];
      const mt = m ? toks.slice(m[0], m[1]) : [];
      const literalMethods = mt.length > 0 && mt.every((t) => t.type === "str" || (t.type === "punct" && ["[", "]", ","].includes(t.value)));
      label = literalMethods ? mt.filter((t) => t.type === "str").map((t) => t.value.toUpperCase()).join("|") : "ON";
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
