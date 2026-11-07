import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS, SUPABASE_SHIM, type Version } from "./migrations";
import { ALICE_NOTE_TITLE, USERS, claimsFor, dbRoleFor, type Actor } from "./personas";

export type QueryOutcome =
  { ok: true; rows: Record<string, unknown>[]; affectedRows: number } | { ok: false; code: string; message: string };

export interface QueryRecord {
  actor: Actor;
  sql: string;
  params: unknown[];
  outcome: QueryOutcome;
}

/** The seed every run starts from: two users (the signup trigger gives each a free profile) and one note of Alice's. */
export const SEED_SQL = `insert into auth.users (id, email) values
  ('${USERS.alice.id}', '${USERS.alice.email}'),
  ('${USERS.bob.id}', '${USERS.bob.email}');
insert into public.notes (user_id, title, body)
  values ('${USERS.alice.id}', ${sqlString(ALICE_NOTE_TITLE)}, 'Only Alice should see this.');`;

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * A fresh in-memory Postgres with Supabase's roles, one version's migrations and the sample data.
 * Queries run the way PostgREST runs a request: in a transaction, as the JWT's role, with its claims set.
 */
export class LabDatabase {
  private constructor(
    private readonly db: PGlite,
    readonly version: Version,
  ) {}

  static async create(version: Version): Promise<LabDatabase> {
    const db = await PGlite.create();
    try {
      await db.exec(SUPABASE_SHIM.sql);
      for (const migration of MIGRATIONS[version]) await db.exec(migration.sql);
      await db.exec(SEED_SQL);
    } catch (error) {
      await db.close();
      throw error;
    }
    return new LabDatabase(db, version);
  }

  async run(actor: Actor, sql: string, params: unknown[] = []): Promise<QueryRecord> {
    let outcome: QueryOutcome;
    try {
      const result = await this.db.transaction(async (tx) => {
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claimsFor(actor))]);
        await tx.exec(`set local role ${dbRoleFor(actor)}`);
        return tx.query<Record<string, unknown>>(sql, params);
      });
      outcome = { ok: true, rows: result.rows, affectedRows: result.affectedRows ?? 0 };
    } catch (error) {
      outcome = toFailure(error);
    }
    return { actor, sql, params, outcome };
  }

  /** An independent copy of this database, much faster than building a new one from the migrations. */
  async clone(): Promise<LabDatabase> {
    // clone() is typed as the PGliteInterface it shares with PGliteWorker, but on a PGlite it returns a PGlite.
    return new LabDatabase((await this.db.clone()) as PGlite, this.version);
  }

  close(): Promise<void> {
    return this.db.close();
  }
}

function toFailure(error: unknown): Extract<QueryOutcome, { ok: false }> {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return { ok: false, code: typeof code === "string" ? code : "", message: error.message };
  }
  return { ok: false, code: "", message: String(error) };
}
