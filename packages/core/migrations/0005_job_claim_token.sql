-- SPDX-License-Identifier: Apache-2.0
-- Unique per claim, so a run can tell whether it still owns the job (attempts repeats after an operator retry).
ALTER TABLE jobs ADD COLUMN claim TEXT;
