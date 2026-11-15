-- SPDX-License-Identifier: Apache-2.0
-- Guesses made by a requester other than the one a sign-in code was issued to spend this
-- separate, smaller budget, so a stranger can never use up the code owner's own guesses.
ALTER TABLE login_codes ADD COLUMN foreign_attempts INTEGER NOT NULL DEFAULT 0;
