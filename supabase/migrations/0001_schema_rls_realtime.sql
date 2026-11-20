-- =============================================================================
-- TaskMaster AI · Esquema, RLS y Realtime
-- -----------------------------------------------------------------------------
-- Entidades: profiles (usuarios), projects, project_members, tasks, comments.
-- Regla de seguridad central: un usuario solo ve/modifica datos de los
-- proyectos de los que es miembro. Los hooks NUNCA usan la service_role key:
-- todas las consultas viajan con el JWT del usuario y Postgres aplica RLS.
-- =============================================================================

-- ---------- Tipos -------------------------------------------------------------
create type public.task_status   as enum ('todo', 'in_progress', 'done');
create type public.task_priority as enum ('low', 'medium', 'high');
create type public.member_role   as enum ('owner', 'member');

-- ---------- Usuarios ----------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

-- Crea el perfil automáticamente al registrarse.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Proyectos y membresía --------------------------------------------
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  owner_id    uuid not null default auth.uid() references public.profiles (id),
  created_at  timestamptz not null default now()
);

create table public.project_members (
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        public.member_role not null default 'member',
  joined_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- El dueño queda como miembro al crear el proyecto.
create function public.add_owner_as_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

create trigger on_project_created
  after insert on public.projects
  for each row execute function public.add_owner_as_member();

-- Helper de RLS. SECURITY DEFINER evita la recursión de políticas sobre
-- project_members; `(select auth.uid())` se evalúa una sola vez por consulta.
create function public.is_project_member(p_project_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_members
    where project_id = p_project_id and user_id = (select auth.uid())
  );
$$;

create function public.is_project_owner(p_project_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_members
    where project_id = p_project_id and user_id = (select auth.uid()) and role = 'owner'
  );
$$;

-- ---------- Tareas ------------------------------------------------------------
create table public.tasks (
  id           uuid primary key default gen_random_uuid(),   -- el cliente puede enviarlo (idempotencia)
  project_id   uuid not null references public.projects (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 200),
  description  text,
  status       public.task_status   not null default 'todo',
  priority     public.task_priority not null default 'medium',
  assignee_id  uuid references public.profiles (id) on delete set null,
  due_date     date,
  position     double precision not null default 0,
  created_by   uuid not null default auth.uid() references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index tasks_project_position_idx on public.tasks (project_id, position, created_at);

-- updated_at lo pone SIEMPRE el servidor: es el "reloj" para last-write-wins.
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_updated_at();

-- ---------- Comentarios -------------------------------------------------------
create table public.comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks (id) on delete cascade,
  project_id  uuid not null references public.projects (id) on delete cascade,
  author_id   uuid not null default auth.uid() references public.profiles (id),
  body        text not null check (char_length(body) between 1 and 4000),
  created_at  timestamptz not null default now()
);

create index comments_task_idx on public.comments (task_id, created_at);

-- project_id se deriva de la tarea: el cliente no puede falsearlo.
create function public.comments_set_project() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select t.project_id into new.project_id from public.tasks t where t.id = new.task_id;
  return new;
end;
$$;

create trigger comments_set_project
  before insert on public.comments
  for each row execute function public.comments_set_project();

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks           enable row level security;
alter table public.comments        enable row level security;

-- profiles: me veo a mí y a quienes comparten proyecto conmigo.
create policy "profiles_select_shared" on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.project_members pm
      where pm.user_id = profiles.id and public.is_project_member(pm.project_id)
    )
  );
create policy "profiles_update_self" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- projects
create policy "projects_select_member" on public.projects for select to authenticated
  using (public.is_project_member(id));
create policy "projects_insert_self" on public.projects for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "projects_update_owner" on public.projects for update to authenticated
  using (public.is_project_owner(id)) with check (public.is_project_owner(id));
create policy "projects_delete_owner" on public.projects for delete to authenticated
  using (public.is_project_owner(id));

-- project_members
create policy "members_select_member" on public.project_members for select to authenticated
  using (public.is_project_member(project_id));
create policy "members_insert_owner" on public.project_members for insert to authenticated
  with check (public.is_project_owner(project_id));
create policy "members_delete_owner_or_self" on public.project_members for delete to authenticated
  using (public.is_project_owner(project_id) or user_id = (select auth.uid()));

-- tasks: cualquier miembro lee y escribe; no se puede "mover" a un proyecto ajeno.
create policy "tasks_select_member" on public.tasks for select to authenticated
  using (public.is_project_member(project_id));
create policy "tasks_insert_member" on public.tasks for insert to authenticated
  with check (public.is_project_member(project_id) and created_by = (select auth.uid()));
create policy "tasks_update_member" on public.tasks for update to authenticated
  using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));
create policy "tasks_delete_member" on public.tasks for delete to authenticated
  using (public.is_project_member(project_id));

-- comments
create policy "comments_select_member" on public.comments for select to authenticated
  using (public.is_project_member(project_id));
create policy "comments_insert_member" on public.comments for insert to authenticated
  with check (public.is_project_member(project_id) and author_id = (select auth.uid()));
create policy "comments_delete_author" on public.comments for delete to authenticated
  using (author_id = (select auth.uid()));

-- =============================================================================
-- Realtime
-- -----------------------------------------------------------------------------
-- Supabase Realtime evalúa las políticas SELECT anteriores para cada
-- suscriptor: un usuario solo recibe INSERT/UPDATE de filas que puede leer.
-- Para DELETE, Postgres no puede comprobar RLS sobre una fila borrada, así que
-- el evento solo trae la clave primaria (los hooks borran por id).
-- =============================================================================
alter publication supabase_realtime add table public.tasks, public.comments;
