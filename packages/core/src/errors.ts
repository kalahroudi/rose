// SPDX-License-Identifier: Apache-2.0

/**
 * The only error type that is allowed to reach a client. Anything else is
 * reported as an opaque 500 so internals (SQL, stack traces) never leak.
 */
export class AppError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new AppError(400, "bad_request", message, fields);
export const invalid = (message: string, fields?: Record<string, string>) =>
  new AppError(422, "invalid", message, fields);
export const unauthorized = (message = "Sign in to continue.") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to do that.") =>
  new AppError(403, "forbidden", message);
/** Used for both "does not exist" and "exists in another tenant": never reveal which. */
export const notFound = (message = "Not found.") => new AppError(404, "not_found", message);
export const conflict = (message: string, fields?: Record<string, string>) =>
  new AppError(409, "conflict", message, fields);
export const tooMany = (message = "Too many attempts. Wait a moment and try again.") =>
  new AppError(429, "rate_limited", message);
export const misconfigured = (message: string) => new AppError(503, "misconfigured", message);
