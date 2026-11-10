// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Hard ceiling for any list endpoint. No endpoint may return unbounded data. */
export const MAX_PAGE_SIZE = 100;

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  q: z.string().trim().max(100).default(""),
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

/** Escape user text for a `LIKE ? ESCAPE '\'` pattern and wrap it for "contains". */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
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
