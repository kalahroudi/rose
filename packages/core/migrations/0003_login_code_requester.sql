-- SPDX-License-Identifier: Apache-2.0
-- Sign-in codes are limited and verified per requester (a keyed hash of the client
-- address) as well as per target address. Existing rows keep a NULL requester.
ALTER TABLE login_codes ADD COLUMN requester TEXT;
CREATE INDEX login_codes_requester ON login_codes (scope, email, requester, created_at);
