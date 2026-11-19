// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import { generateDek, unwrapDek, wrapDek } from "../crypto";

export interface TenantMigration {
  id: string;
  sql: string;
}

export type SqlValue = string | number | null | ArrayBuffer;
export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}
export interface SqlResult {
  rows: Record<string, SqlValue>[];
  changes: number;
}

export const CORE_TENANT_MIGRATIONS: TenantMigration[] = [
  {
    id: "core_001_audit",
    sql: `CREATE TABLE audit_log (
            id TEXT PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
            target TEXT, meta TEXT, ip TEXT);
          CREATE INDEX audit_log_at ON audit_log (at);`,
  },
  {
    id: "core_002_api_keys",
    sql: `CREATE TABLE api_keys (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL, role TEXT NOT NULL,
            created_by TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER);`,
  },
];

interface TenantDoEnv {
  ROSE_MASTER_KEY: string;
  ROSE_MASTER_KEY_PREVIOUS?: string;
}

export abstract class TenantDurableObject extends DurableObject<TenantDoEnv> {
  protected abstract migrations(): TenantMigration[];

  constructor(ctx: DurableObjectState, env: TenantDoEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS _rose_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const applied = new Set(sql.exec("SELECT id FROM _rose_migrations").toArray().map((r) => r.id as string));
    for (const m of this.migrations()) {
      if (applied.has(m.id)) continue;
      this.ctx.storage.transactionSync(() => {
        sql.exec(m.sql);
        sql.exec("INSERT INTO _rose_migrations (id, applied_at) VALUES (?, ?)", m.id, Date.now());
      });
    }
  }

  private assertTenant(tenantId: string): void {
    if (!tenantId) throw new Error("Tenant id required");
    const pinned = this.ctx.storage.kv.get<string>("tenant_id");
    if (pinned === undefined) this.ctx.storage.kv.put("tenant_id", tenantId);
    else if (pinned !== tenantId) throw new Error("Tenant mismatch: refusing cross-tenant access");
  }

  private run(s: SqlStatement): SqlResult {
    const cursor = this.ctx.storage.sql.exec(s.sql, ...(s.params ?? []));
    const rows = cursor.toArray() as Record<string, SqlValue>[];
    const changes = cursor.rowsWritten > 0 ? (this.ctx.storage.sql.exec("SELECT changes() AS c").one().c as number) : 0;
    return { rows, changes };
  }

  async exec(tenantId: string, statement: SqlStatement): Promise<SqlResult> {
    this.assertTenant(tenantId);
    return this.run(statement);
  }

  async batch(tenantId: string, statements: SqlStatement[]): Promise<SqlResult[]> {
    this.assertTenant(tenantId);
    return this.ctx.storage.transactionSync(() => statements.map((s) => this.run(s)));
  }

  async dataKey(tenantId: string): Promise<ArrayBuffer> {
    this.assertTenant(tenantId);
    return this.ctx.blockConcurrencyWhile(async () => {
      const wrapped = this.ctx.storage.kv.get<string>("wrapped_dek");
      if (!wrapped) {
        const dek = generateDek();
        this.ctx.storage.kv.put("wrapped_dek", await wrapDek(this.env.ROSE_MASTER_KEY, tenantId, dek));
        return dek.buffer;
      }
      const { dek, rotated } = await unwrapDek(this.env, tenantId, wrapped);
      if (rotated) this.ctx.storage.kv.put("wrapped_dek", await wrapDek(this.env.ROSE_MASTER_KEY, tenantId, dek));
      return dek.buffer;
    });
  }

  async purge(tenantId: string): Promise<void> {
    this.assertTenant(tenantId);
    await this.ctx.storage.deleteAll();
  }
}
