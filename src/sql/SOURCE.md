# Where these files come from

Copied by `npm run sql:sync` from the case-study repo
(https://github.com/atokim4/vibe-rescue-nextjs-supabase). Do not edit them here; change the case study and sync.

Refs in the case study's local commit history at the time of the copy (the public repo is a snapshot of `main`,
so these hashes and the `v0-broken` tag are not in it; `before/` here is the public copy of the broken migration):

- `v0-broken` = 9fce369
- `main` = de978f7

- `shim.sql` = `tests/supabase-shim.sql` at `main`
- `before/20261106000000_init.sql` = `supabase/migrations/20261106000000_init.sql` at `v0-broken`
- `after/20261106000000_init.sql` = `supabase/migrations/20261106000000_init.sql` at `main`
- `after/20261107000000_notes_owner_rls.sql` = `supabase/migrations/20261107000000_notes_owner_rls.sql` at `main`
- `after/20261108000000_server_side_paywall.sql` = `supabase/migrations/20261108000000_server_side_paywall.sql` at `main`
