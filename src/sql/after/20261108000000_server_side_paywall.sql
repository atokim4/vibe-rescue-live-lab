-- Fix 6: the paywall only existed in the React form.
--  * "Users can update own profile" covered every column, so a free user could set plan = 'pro' themselves.
--    Profiles have nothing users need to edit, so the policy goes: only the service role (the Stripe webhook)
--    changes a profile now.
--  * The 3-note limit is enforced in the notes insert policy, so it holds for every client, not just the UI.

drop policy "Users can update own profile" on public.profiles;

-- security definer: the function counts the user's notes and reads their plan without depending on
-- the caller's RLS. It only ever looks at auth.uid()'s own rows, so it leaks nothing.
create function public.can_add_note()
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    return false;
  end if;

  -- Two inserts sent at the same moment would both see 2 notes and both pass. The transaction-scoped
  -- lock makes a user's inserts check the limit one after another.
  perform pg_advisory_xact_lock(hashtextextended('notes:' || uid::text, 0));

  return exists (select 1 from public.profiles where id = uid and plan = 'pro')
    or (select count(*) from public.notes where user_id = uid) < 3;
end;
$$;

revoke execute on function public.can_add_note() from public, anon;
grant execute on function public.can_add_note() to authenticated;

drop policy "Users can add own notes" on public.notes;

create policy "Users can add own notes within their plan"
  on public.notes for insert
  to authenticated
  with check ((select auth.uid()) = user_id and public.can_add_note());
