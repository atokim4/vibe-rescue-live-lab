// Copies the SQL this lab runs from the case-study repo (github.com/atokim4/vibe-rescue-nextjs-supabase):
//   src/sql/shim.sql    the test suite's Supabase stand-in (roles, auth.users, auth.uid())
//   src/sql/before/     supabase/migrations at tag v0-broken
//   src/sql/after/      supabase/migrations at main
// Files are taken with `git show <ref>:<path>`, so they are byte-for-byte what the repo has at that ref.
//
// Usage: npm run sql:sync -- <path to a clone of the case-study repo>

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = process.argv[2];
if (!repo) {
  console.error("Usage: npm run sql:sync -- <path to a clone of vibe-rescue-nextjs-supabase>");
  process.exit(1);
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sql");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

const sources = [];
function copy(ref, from, to) {
  writeFileSync(path.join(out, to), git("show", `${ref}:${from}`));
  sources.push(`- \`${to}\` = \`${from}\` at \`${ref}\``);
}

rmSync(out, { recursive: true, force: true });
for (const dir of ["before", "after"]) mkdirSync(path.join(out, dir), { recursive: true });

copy("main", "tests/supabase-shim.sql", "shim.sql");
for (const [version, ref] of [
  ["before", "v0-broken"],
  ["after", "main"],
]) {
  const files = git("ls-tree", "--name-only", `${ref}:supabase/migrations`)
    .split("\n")
    .filter((f) => f.endsWith(".sql"));
  for (const file of files) copy(ref, `supabase/migrations/${file}`, `${version}/${file}`);
}

const commits = ["v0-broken", "main"].map((ref) => `- \`${ref}\` = ${git("rev-parse", "--short", ref).trim()}`);
writeFileSync(
  path.join(out, "SOURCE.md"),
  [
    "# Where these files come from",
    "",
    "Copied by `npm run sql:sync` from the case-study repo",
    "(https://github.com/atokim4/vibe-rescue-nextjs-supabase). Do not edit them here; change the case study and sync.",
    "",
    "Refs in the case study's commit history at the time of the copy:",
    "",
    ...commits,
    "",
    ...sources,
    "",
  ].join("\n"),
);
console.log(`Wrote ${sources.length} files to src/sql/`);
