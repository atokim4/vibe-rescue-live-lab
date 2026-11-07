-- Fix 2: notes were readable by everyone and writable into anyone's account.
-- Every policy now ties the row to the signed-in user. `(select auth.uid())` is
-- evaluated once per statement instead of once per row (Supabase's RLS performance advice).

drop policy "Enable read access for all users" on public.notes;
drop policy "Enable insert for authenticated users only" on public.notes;
drop policy "Users can delete own notes" on public.notes;

create policy "Users can read own notes"
  on public.notes for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can add own notes"
  on public.notes for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can edit own notes"
  on public.notes for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete own notes"
  on public.notes for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- The policies filter on user_id and the dashboard sorts by created_at.
create index notes_user_id_created_at_idx on public.notes (user_id, created_at desc);
