// The SQL the lab runs, copied from the case-study repo by `npm run sql:sync` (see src/sql/SOURCE.md).
import shim from "../sql/shim.sql?raw";

export type Version = "before" | "after";

export interface SqlFile {
  /** File name in the case study's supabase/migrations folder. */
  name: string;
  sql: string;
}

const files = {
  before: import.meta.glob<string>("../sql/before/*.sql", { query: "?raw", import: "default", eager: true }),
  after: import.meta.glob<string>("../sql/after/*.sql", { query: "?raw", import: "default", eager: true }),
};

function toSqlFiles(glob: Record<string, string>): SqlFile[] {
  return Object.entries(glob)
    .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf("/") + 1), sql }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const SUPABASE_SHIM: SqlFile = { name: "supabase-shim.sql", sql: shim };

/** Migrations in the order Supabase applies them: v0-broken for "before", main for "after". */
export const MIGRATIONS: Record<Version, SqlFile[]> = {
  before: toSqlFiles(files.before),
  after: toSqlFiles(files.after),
};
