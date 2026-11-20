-- SPDX-License-Identifier: Apache-2.0
-- Each sign-in code also carries a 100-bit key, stored as an HMAC bound to email and
-- scope. The key signs the device in without touching the per-account guess budget.
ALTER TABLE login_codes ADD COLUMN link_hash TEXT;
CREATE UNIQUE INDEX login_codes_link_hash ON login_codes (link_hash) WHERE link_hash IS NOT NULL;
