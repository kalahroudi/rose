// SPDX-License-Identifier: Apache-2.0

export function objReturn(x: number): { ok: boolean; meta: { n: number } } {
  return { ok: x > 0, meta: { n: x } };
}

export async function unionReturn(x: number): Promise<{ ok: boolean } | { err: string }> {
  return x > 0 ? { ok: true } : { err: "bad" };
}

export function fnReturn(x: number): (y: number) => { sum: number } {
  return (y) => ({ sum: x + y });
}

export function predReturn(x: unknown): x is { id: string } {
  return typeof x === "object" && x !== null && "id" in x;
}

export function overloaded(x: string): { kind: "s"; v: string };
export function overloaded(x: number): { kind: "n"; v: number };
export function overloaded(x: string | number): { kind: "s"; v: string } | { kind: "n"; v: number } {
  return typeof x === "string" ? { kind: "s", v: x } : { kind: "n", v: x };
}

export function genericFn<
  T extends { id: string; tags: Record<string, { v: number }> },
  U = { ok: boolean },
>(item: T): { id: string; extra?: U } {
  return { id: item.id };
}

export const genericArrow = <
  T extends { a: number },
  F extends (x: T) => { b: number },
>(x: T, fn: F): { b: number } => {
  return fn(x);
};

export const typedArrow: (a: number, b: { limit: number }) => { ok: boolean } = (
  a,
  b,
): { ok: boolean } => {
  return { ok: a <= b.limit };
};

export const typedFuncExpr: Record<string, (v: { n: number }) => { n: number }>["k"] = function <
  T extends { n: number },
>(v: T): { n: number } {
  return { n: v.n + 1 };
};

export function postfixDiv(a: number, b: number): number { return a++ / b + a-- / b; } export const afterDiv = 1 / 2;

export function bracesInLiterals(x: boolean): string {
  return "}" + "{" + `${/* comment with } */ x ? "{" : "}"} } ${`{`}` + /}/.source;
}
