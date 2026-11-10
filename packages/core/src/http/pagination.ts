// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Hard ceiling for any list endpoint. No endpoint may return unbounded data. */
export const MAX_PAGE_SIZE = 100;

/**
 * D1 and Durable Object SQLite refuse LIKE patterns longer than 50 bytes, so search
 * terms are capped here and patterns are trimmed to fit after escaping.
 */
export const MAX_SEARCH_LENGTH = 40;
const MAX_LIKE_BYTES = 50;

/**
 * A search term that is safe to hand to `likePattern`. Use it for any search text that
 * arrives outside the list query, e.g. the filter of a "select all matching" bulk action.
 */
export const searchTermSchema = z
  .string()
  // Control characters are dropped: SQLite ends a bound string at a NUL byte, which would
  // turn "%\0%" into a match-everything pattern.
  .transform((v) => v.replace(/[\u0000-\u001f\u007f]/g, "").trim())
  .pipe(z.string().max(MAX_SEARCH_LENGTH, `Search for at most ${MAX_SEARCH_LENGTH} characters.`))
  .default("");

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  q: searchTermSchema,
  sort: z.string().trim().max(40).default(""),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const offsetOf = (q: Pick<ListQuery, "page" | "pageSize">): number => (q.page - 1) * q.pageSize;

const likeEscape = (q: string) => q.replace(/[\\%_]/g, (m) => `\\${m}`);

function fitBytes(escaped: string, budget: number): string {
  const enc = new TextEncoder();
  let out = escaped;
  while (enc.encode(out).length > budget) out = out.slice(0, -1);
  // Never leave a dangling escape character at the end.
  return /(^|[^\\])(\\\\)*\\$/.test(out) ? out.slice(0, -1) : out;
}

/** Escape user text for a `LIKE ? ESCAPE '\'` pattern and wrap it for "contains". */
export function likePattern(q: string): string {
  return `%${fitBytes(likeEscape(q), MAX_LIKE_BYTES - 2)}%`;
}

/** As `likePattern`, for "starts with". */
export function likePrefix(q: string): string {
  return `${fitBytes(likeEscape(q), MAX_LIKE_BYTES - 1)}%`;
}

/**
 * Resolve a user-supplied sort key against an allowlist. SQL identifiers can not be
 * bound as parameters, so this is the only way a sort column may reach a query.
 */
export function orderBy(sort: string, allowed: Record<string, string>, fallback: string): string {
  const desc = sort.startsWith("-");
  const column = allowed[desc ? sort.slice(1) : sort];
  return column ? `${column} ${desc ? "DESC" : "ASC"}` : fallback;
}
