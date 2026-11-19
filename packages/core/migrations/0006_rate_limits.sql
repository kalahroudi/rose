-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX rate_limits_window ON rate_limits (window_start);
