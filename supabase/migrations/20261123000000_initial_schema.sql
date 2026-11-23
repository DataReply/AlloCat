create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id text primary key,
  name text not null,
  owner_id uuid not null references auth.users(id),
  available_years integer[] not null default array[extract(year from now())::integer],
  selected_year integer not null default extract(year from now())::integer,
  departments text[] not null default array['General'],
  leave_types jsonb not null default '{}'::jsonb,
  updated_by_uid uuid references auth.users(id),
  updated_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  photo_url text not null default '',
  role text not null check (role in ('admin', 'editor')),
  joined_via text not null check (joined_via in ('bootstrap', 'invite', 'code', 'approval')),
  invite_code text,
  invite_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.workspace_member_private (
  workspace_id text not null,
  user_id uuid not null,
  email text not null default '',
  primary key (workspace_id, user_id),
  foreign key (workspace_id, user_id)
    references public.workspace_members(workspace_id, user_id) on delete cascade
);

create table if not exists public.workspace_join_codes (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  code text not null,
  label text not null,
  active boolean not null default true,
  created_by_uid uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, code)
);

create table if not exists public.workspace_invites (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  id text not null,
  email text not null,
  role text not null check (role in ('admin', 'editor')),
  invited_by_uid uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id)
);

create table if not exists public.workspace_join_requests (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  email text not null,
  photo_url text not null default '',
  note text not null default '',
  status text not null check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.workspace_people (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (workspace_id, id)
);

create table if not exists public.workspace_clients (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (workspace_id, id)
);

create table if not exists public.workspace_projects (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (workspace_id, id)
);

create table if not exists public.workspace_allocations (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (workspace_id, id)
);

create table if not exists public.workspace_leaves (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (workspace_id, id)
);

create or replace function public.is_workspace_member(target_workspace_id text)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = target_workspace_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_admin(target_workspace_id text)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'ictismylife@gmail.com'
    or exists (
      select 1
      from public.workspace_members m
      where m.workspace_id = target_workspace_id
        and m.user_id = auth.uid()
        and m.role = 'admin'
    );
$$;

create or replace function public.test_connection()
returns boolean
language plpgsql
stable
security invoker
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in before testing the Supabase database connection.';
  end if;
  perform 1 from public.workspaces limit 1;
  return true;
end;
$$;

create or replace function public.ensure_workspace_access(
  p_invite_code text default null,
  p_seed_state jsonb default '{}'::jsonb,
  p_display_name text default '',
  p_photo_url text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  current_uid uuid := auth.uid();
  current_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  current_display_name text := left(coalesce(nullif(trim(p_display_name), ''), current_email, 'Collaborator'), 120);
  current_photo_url text := left(coalesce(p_photo_url, ''), 500);
  v_workspace_id constant text := 'default';
  member_row public.workspace_members%rowtype;
  request_row public.workspace_join_requests%rowtype;
  invite_row public.workspace_invites%rowtype;
  code_row public.workspace_join_codes%rowtype;
  is_bootstrap boolean;
begin
  if current_uid is null then
    raise exception 'You must be signed in to access the workspace.';
  end if;
  is_bootstrap := current_email = 'ictismylife@gmail.com';

  if is_bootstrap and not exists (
    select 1 from public.workspaces w where w.id = v_workspace_id
  ) then
    insert into public.workspaces (
      id, name, owner_id, available_years, selected_year, departments,
      leave_types, updated_by_uid, updated_by_name
    )
    values (
      v_workspace_id,
      'AlloCat Team Workspace',
      current_uid,
      coalesce(array(select jsonb_array_elements_text(p_seed_state -> 'availableYears')::integer), array[extract(year from now())::integer]),
      coalesce((p_seed_state ->> 'selectedYear')::integer, extract(year from now())::integer),
      coalesce(array(select jsonb_array_elements_text(p_seed_state -> 'departments')), array['General']),
      coalesce(p_seed_state -> 'leaveTypes', '{}'::jsonb),
      current_uid,
      current_display_name
    );

    insert into public.workspace_people (workspace_id, id, data)
      select v_workspace_id, item ->> 'id', item
      from jsonb_array_elements(coalesce(p_seed_state -> 'people', '[]'::jsonb)) item
      where nullif(item ->> 'id', '') is not null;
    insert into public.workspace_clients (workspace_id, id, data)
      select v_workspace_id, item ->> 'id', item
      from jsonb_array_elements(coalesce(p_seed_state -> 'clients', '[]'::jsonb)) item
      where nullif(item ->> 'id', '') is not null;
    insert into public.workspace_projects (workspace_id, id, data)
      select v_workspace_id, item ->> 'id', item
      from jsonb_array_elements(coalesce(p_seed_state -> 'projects', '[]'::jsonb)) item
      where nullif(item ->> 'id', '') is not null;
    insert into public.workspace_allocations (workspace_id, id, data)
      select v_workspace_id, item ->> 'id', item
      from jsonb_array_elements(coalesce(p_seed_state -> 'allocations', '[]'::jsonb)) item
      where nullif(item ->> 'id', '') is not null;
    insert into public.workspace_leaves (workspace_id, id, data)
      select v_workspace_id, item ->> 'id', item
      from jsonb_array_elements(coalesce(p_seed_state -> 'leaves', '[]'::jsonb)) item
      where nullif(item ->> 'id', '') is not null;

    insert into public.workspace_join_codes (workspace_id, code, label, active, created_by_uid)
    values (
      v_workspace_id,
      'team-' || substr(encode(gen_random_bytes(8), 'hex'), 1, 12),
      'Default Team Invite Link',
      true,
      current_uid
    );
  end if;

  select * into member_row
  from public.workspace_members m
  where m.workspace_id = v_workspace_id and m.user_id = current_uid;

  if found then
    if is_bootstrap and member_row.role <> 'admin' then
      update public.workspace_members
      set role = 'admin', updated_at = now()
      where workspace_id = v_workspace_id and user_id = current_uid
      returning * into member_row;
    end if;
    return jsonb_build_object(
      'status', 'granted',
      'member', jsonb_build_object(
        'uid', member_row.user_id,
        'displayName', member_row.display_name,
        'photoURL', member_row.photo_url,
        'role', member_row.role,
        'joinedVia', member_row.joined_via,
        'email', current_email
      ),
      'isAdmin', member_row.role = 'admin',
      'bootstrapped', is_bootstrap,
      'migratedFromLocal', false
    );
  end if;

  if is_bootstrap then
    insert into public.workspace_members (
      workspace_id, user_id, display_name, photo_url, role, joined_via
    ) values (v_workspace_id, current_uid, current_display_name, current_photo_url, 'admin', 'bootstrap')
    returning * into member_row;
  elsif nullif(trim(p_invite_code), '') is not null then
    select * into code_row
    from public.workspace_join_codes c
    where c.workspace_id = v_workspace_id and c.code = trim(p_invite_code) and c.active;
    if found then
      insert into public.workspace_members (
        workspace_id, user_id, display_name, photo_url, role, joined_via, invite_code
      ) values (v_workspace_id, current_uid, current_display_name, current_photo_url, 'editor', 'code', code_row.code)
      returning * into member_row;
    end if;
  end if;

  if member_row.user_id is null and current_email <> '' then
    select * into invite_row
    from public.workspace_invites i
    where i.workspace_id = v_workspace_id and lower(i.email) = current_email
    order by i.created_at
    limit 1
    for update;
    if found then
      insert into public.workspace_members (
        workspace_id, user_id, display_name, photo_url, role, joined_via, invite_id
      ) values (
        v_workspace_id, current_uid, current_display_name, current_photo_url, invite_row.role, 'invite', invite_row.id
      ) returning * into member_row;
      delete from public.workspace_invites where workspace_id = v_workspace_id and id = invite_row.id;
    end if;
  end if;

  if member_row.user_id is not null then
    insert into public.workspace_member_private (workspace_id, user_id, email)
    values (v_workspace_id, current_uid, current_email)
    on conflict (workspace_id, user_id) do update set email = excluded.email;
    return jsonb_build_object(
      'status', 'granted',
      'member', jsonb_build_object(
        'uid', member_row.user_id,
        'displayName', member_row.display_name,
        'photoURL', member_row.photo_url,
        'role', member_row.role,
        'joinedVia', member_row.joined_via,
        'email', current_email
      ),
      'isAdmin', member_row.role = 'admin',
      'bootstrapped', is_bootstrap,
      'migratedFromLocal', false
    );
  end if;

  select * into request_row
  from public.workspace_join_requests r
  where r.workspace_id = v_workspace_id and r.user_id = current_uid;

  return jsonb_build_object(
    'status', 'needs_access',
    'existingRequest', case when found then jsonb_build_object(
      'uid', request_row.user_id,
      'displayName', request_row.display_name,
      'email', request_row.email,
      'photoURL', request_row.photo_url,
      'note', request_row.note,
      'status', request_row.status,
      'createdAt', request_row.created_at,
      'updatedAt', request_row.updated_at
    ) else null end
  );
end;
$$;

create or replace function public.join_workspace_by_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  return public.ensure_workspace_access(p_code, '{}'::jsonb, '', '');
end;
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_member_private enable row level security;
alter table public.workspace_join_codes enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.workspace_join_requests enable row level security;
alter table public.workspace_people enable row level security;
alter table public.workspace_clients enable row level security;
alter table public.workspace_projects enable row level security;
alter table public.workspace_allocations enable row level security;
alter table public.workspace_leaves enable row level security;

create policy "workspace members can read workspace"
  on public.workspaces for select to authenticated
  using (public.is_workspace_member(id) or public.is_workspace_admin(id));
create policy "bootstrap admin can create workspace"
  on public.workspaces for insert to authenticated
  with check (
    lower(coalesce(auth.jwt() ->> 'email', '')) = 'ictismylife@gmail.com'
    and owner_id = auth.uid()
  );
create policy "members can update workspace settings"
  on public.workspaces for update to authenticated
  using (public.is_workspace_member(id))
  with check (public.is_workspace_member(id));

create policy "members can read workspace members"
  on public.workspace_members for select to authenticated
  using (public.is_workspace_member(workspace_id) or user_id = auth.uid());
create policy "admins can manage workspace members"
  on public.workspace_members for all to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

create policy "users and admins can read private member data"
  on public.workspace_member_private for select to authenticated
  using (user_id = auth.uid() or public.is_workspace_admin(workspace_id));
create policy "admins can manage private member data"
  on public.workspace_member_private for all to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

create policy "admins can manage join codes"
  on public.workspace_join_codes for all to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy "admins can manage invites"
  on public.workspace_invites for all to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

create policy "users can read own join request and admins can read all"
  on public.workspace_join_requests for select to authenticated
  using (user_id = auth.uid() or public.is_workspace_admin(workspace_id));
create policy "users can create own join request"
  on public.workspace_join_requests for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending');
create policy "admins can update join requests"
  on public.workspace_join_requests for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

do $$
declare
  entity_table text;
begin
  foreach entity_table in array array[
    'workspace_people',
    'workspace_clients',
    'workspace_projects',
    'workspace_allocations',
    'workspace_leaves'
  ] loop
    execute format(
      'create policy "workspace members manage data" on public.%I for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id))',
      entity_table
    );
  end loop;
end;
$$;

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.workspaces,
  public.workspace_members,
  public.workspace_member_private,
  public.workspace_join_codes,
  public.workspace_invites,
  public.workspace_join_requests,
  public.workspace_people,
  public.workspace_clients,
  public.workspace_projects,
  public.workspace_allocations,
  public.workspace_leaves
to authenticated;
grant execute on function public.is_workspace_member(text) to authenticated;
grant execute on function public.is_workspace_admin(text) to authenticated;
grant execute on function public.test_connection() to authenticated;
grant execute on function public.ensure_workspace_access(text, jsonb, text, text) to authenticated;
grant execute on function public.join_workspace_by_code(text) to authenticated;
revoke all on function public.is_workspace_member(text) from public, anon;
revoke all on function public.is_workspace_admin(text) from public, anon;
revoke all on function public.test_connection() from public, anon;
revoke all on function public.ensure_workspace_access(text, jsonb, text, text) from public, anon;
revoke all on function public.join_workspace_by_code(text) from public, anon;

do $$
declare
  realtime_table text;
begin
  foreach realtime_table in array array[
    'workspaces',
    'workspace_members',
    'workspace_join_requests',
    'workspace_join_codes',
    'workspace_invites',
    'workspace_member_private',
    'workspace_people',
    'workspace_clients',
    'workspace_projects',
    'workspace_allocations',
    'workspace_leaves'
  ] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = realtime_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', realtime_table);
    end if;
  end loop;
end;
$$;
