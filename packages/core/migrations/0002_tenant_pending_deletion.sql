-- SPDX-License-Identifier: Apache-2.0
-- Tenant deletion now has a 48 hour grace period: status 'pending_deletion' plus the time
-- after which the purge may run (delete_after, epoch ms).
--
-- SQLite can not change a CHECK constraint in place, so the tenants table is rebuilt.
-- Dropping it fires the ON DELETE CASCADE of the three tables that reference it, so their
-- rows are copied aside first and put back afterwards.

CREATE TABLE _bak_tenant_domains AS SELECT * FROM tenant_domains;
CREATE TABLE _bak_memberships AS SELECT * FROM memberships;
CREATE TABLE _bak_invitations AS SELECT * FROM invitations;

CREATE TABLE tenants_new (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending_deletion', 'deleting')),
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delete_after INTEGER,
  prior_status TEXT
);
INSERT INTO tenants_new (id, slug, name, status, plan, created_at, updated_at, delete_after, prior_status)
  SELECT id, slug, name, status, plan, created_at, updated_at, NULL, NULL FROM tenants;

DROP TABLE tenants;
ALTER TABLE tenants_new RENAME TO tenants;
CREATE INDEX tenants_status ON tenants (status, created_at);

INSERT INTO tenant_domains SELECT * FROM _bak_tenant_domains;
INSERT INTO memberships SELECT * FROM _bak_memberships;
INSERT INTO invitations SELECT * FROM _bak_invitations;
DROP TABLE _bak_tenant_domains;
DROP TABLE _bak_memberships;
DROP TABLE _bak_invitations;
