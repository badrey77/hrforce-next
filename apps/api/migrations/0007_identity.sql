-- 0007: identity (docs/contracts/identity.md, ADR 004).
--
-- Accounts are GLOBAL (one login per person across the group's companies); membership is per company. Login runs
-- before any tenant is known, so these tables cannot sit behind the tenant RLS policy. They live in schema `auth`,
-- and hrforce_app has NO privilege on any auth table or sequence (nor does PUBLIC). The API reaches them only through
-- the SECURITY DEFINER functions below: owned by the migrator, `search_path = pg_catalog, auth`, every relation
-- schema-qualified, EXECUTE revoked from PUBLIC and granted to hrforce_app one function at a time. Each returns the
-- minimum its use case needs; none lists users, none takes a free-form filter, none sets a password without
-- consuming a valid single-use token in the same call.
--
-- Functions (EXECUTE granted to hrforce_app):
--   auth.find_login(email)                         → (user_id, status, password_hash, locale) for ONE exact email
--   auth.record_login_event(email, user_id, ip, user_agent, outcome) → void (append-only history + throttle source)
--   auth.login_failures(email, ip)                 → (db_now, email_failures[], ip_failures[]): failure timestamps,
--                                                     newest first — email: bad_credentials in the last 30 min (≤ 50);
--                                                     ip: bad_credentials|locked in the last 15 min (≤ 30)
--   auth.create_session(user_id, token_hash, ip, user_agent) → (session_id, company_id, expires_at, absolute_expires_at)
--                                                     only for an ACTIVE user with a membership (default company,
--                                                     else lowest code); new family; 12 h idle / 7 d absolute
--   auth.rotate_session(old_hash, new_hash, ip, user_agent) → (outcome, session_id, user_id, company_id, expires_at,
--                                                     absolute_expires_at); outcome ok|race|reuse|expired|invalid,
--                                                     decided under a row lock (see the function)
--   auth.session_sid(token_hash)                   → the session id of a refresh token (XSRF binding on refresh/logout)
--   auth.revoke_family(token_hash, sid, user_id)   → void; revokes (reason 'logout') the family of the presented
--                                                     refresh token and/or of session `sid` if it belongs to `user_id`
--   auth.me(user_id, company_id)                   → (user_id, email, display_name, locale, company_id, company_code,
--                                                     company_name) iff the user is active and a member of the company
--   auth.user_companies(user_id)                   → (company_id, code, name) of an ACTIVE user's memberships
--   auth.password_token_target(token_hash)         → (user_id, email, purpose) of a valid (unused, unexpired) token
--   auth.consume_password_token(token_hash, password_hash) → user_id | null. Atomically: marks the token (and every
--                                                     other pending token of the user) used, sets the argon2id hash,
--                                                     invited → active, revokes all the user's refresh sessions
--   auth.request_password_reset(email, token_hash) → (user_id, email, display_name, locale) and stores a 1 h reset
--                                                     token iff the account is active and < 3 reset tokens were issued
--                                                     for it in the last hour; otherwise no row, nothing stored
--
-- Not granted to the app: user creation / membership / setup tokens (CLI `user:invite` and `seed:dev` run as the
-- migrator). NOTE: EXECUTE is granted to PUBLIC by default on every new function and per-schema default privileges
-- cannot revoke that, so any future auth.* function must be revoked from PUBLIC explicitly (as done at the end).
-- Retention: login_event rows are kept 180 days; the cleanup job arrives with the worker (apps/api/README.md).

create schema auth;
revoke all on schema auth from public;
grant usage on schema auth to hrforce_app;

-- ---------------------------------------------------------------------------------------------------------
create table auth.user_account (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text not null,
  locale text not null default 'fr',
  status text not null default 'invited',
  created_at timestamptz not null default now(),
  constraint user_account_email_uk unique (email),
  constraint user_account_email_ck check (
    email = lower(btrim(email)) and char_length(email) between 3 and 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  ),
  constraint user_account_display_name_ck check (display_name = btrim(display_name) and char_length(display_name) between 1 and 120),
  constraint user_account_locale_ck check (locale in ('fr', 'ar', 'en')),
  constraint user_account_status_ck check (status in ('invited', 'active', 'disabled'))
);

create table auth.user_credential (
  user_id uuid primary key references auth.user_account (id) on delete cascade,
  password_hash text not null,
  updated_at timestamptz not null default now(),
  constraint user_credential_argon2id_ck check (password_hash like '$argon2id$%')
);

create table auth.user_company (
  user_id uuid not null references auth.user_account (id) on delete cascade,
  company_id uuid not null references public.company (id),
  is_default boolean not null default false,
  constraint user_company_pk primary key (user_id, company_id)
);
-- at most one default company per user
create unique index user_company_one_default_uk on auth.user_company (user_id) where is_default;
create index user_company_company_idx on auth.user_company (company_id);

create table auth.refresh_session (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  user_id uuid not null,
  company_id uuid not null,
  token_hash bytea not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  ip inet,
  user_agent text,
  constraint refresh_session_token_hash_uk unique (token_hash),
  constraint refresh_session_token_hash_ck check (octet_length(token_hash) = 32),
  -- a session only exists for a membership; removing the membership removes its sessions
  constraint refresh_session_membership_fk foreign key (user_id, company_id)
    references auth.user_company (user_id, company_id) on delete cascade,
  constraint refresh_session_revoked_ck check ((revoked_at is null) = (revoke_reason is null)),
  constraint refresh_session_revoke_reason_ck check (revoke_reason in ('logout', 'reuse', 'expired', 'password_change', 'account_inactive'))
);
create index refresh_session_family_idx on auth.refresh_session (family_id);
create index refresh_session_user_live_idx on auth.refresh_session (user_id) where revoked_at is null;

create table auth.password_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.user_account (id) on delete cascade,
  token_hash bytea not null,
  purpose text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint password_token_token_hash_uk unique (token_hash),
  constraint password_token_token_hash_ck check (octet_length(token_hash) = 32),
  constraint password_token_purpose_ck check (purpose in ('setup', 'reset'))
);
create index password_token_user_idx on auth.password_token (user_id, created_at);

-- Append-only (updates are refused; old rows are deleted by the retention job after 180 days).
create table auth.login_event (
  id bigserial primary key,
  at timestamptz not null default now(),
  email text not null,
  user_id uuid,
  ip inet,
  user_agent text,
  outcome text not null,
  constraint login_event_outcome_ck check (outcome in ('success', 'bad_credentials', 'locked', 'disabled', 'throttled_ip'))
);
create index login_event_email_at_idx on auth.login_event (email, at);
create index login_event_ip_at_idx on auth.login_event (ip, at);

create function auth.login_event_append_only() returns trigger
  language plpgsql
as $$
begin
  raise exception 'auth.login_event is append-only' using errcode = 'insufficient_privilege';
end
$$;

create trigger login_event_append_only_tg
  before update on auth.login_event
  for each row execute function auth.login_event_append_only();

-- ---------------------------------------------------------------------------------------------------------
-- Functions. `#variable_conflict use_column` makes column names win over the RETURNS TABLE output names.

create function auth.find_login(p_email text)
  returns table (user_id uuid, status text, password_hash text, locale text)
  language sql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
  select u.id, u.status, c.password_hash, u.locale
    from auth.user_account u
    left join auth.user_credential c on c.user_id = u.id
   where u.email = lower(btrim(p_email))
$$;

create function auth.record_login_event(p_email text, p_user_id uuid, p_ip inet, p_user_agent text, p_outcome text)
  returns void
  language sql
  security definer
  set search_path = pg_catalog, auth
as $$
  insert into auth.login_event (email, user_id, ip, user_agent, outcome)
  values (left(lower(btrim(p_email)), 320), p_user_id, p_ip, left(p_user_agent, 512), p_outcome)
$$;

create function auth.login_failures(p_email text, p_ip inet)
  returns table (db_now timestamptz, email_failures timestamptz[], ip_failures timestamptz[])
  language sql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
  select now(),
         coalesce((select array_agg(x.at order by x.at desc)
                     from (select e.at from auth.login_event e
                            where e.email = left(lower(btrim(p_email)), 320)
                              and e.outcome = 'bad_credentials'
                              and e.at > now() - interval '30 minutes'
                            order by e.at desc limit 50) x), '{}'),
         coalesce((select array_agg(y.at order by y.at desc)
                     from (select e.at from auth.login_event e
                            where p_ip is not null and e.ip = p_ip
                              and e.outcome in ('bad_credentials', 'locked')
                              and e.at > now() - interval '15 minutes'
                            order by e.at desc limit 30) y), '{}')
$$;

create function auth.create_session(p_user_id uuid, p_token_hash bytea, p_ip inet, p_user_agent text)
  returns table (session_id uuid, company_id uuid, expires_at timestamptz, absolute_expires_at timestamptz)
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
#variable_conflict use_column
declare
  v_company uuid;
  v_id uuid;
begin
  select m.company_id into v_company
    from auth.user_account u
    join auth.user_company m on m.user_id = u.id
    join public.company c on c.id = m.company_id
   where u.id = p_user_id and u.status = 'active'
   order by m.is_default desc, c.code
   limit 1;
  if v_company is null then
    return;
  end if;
  insert into auth.refresh_session (family_id, user_id, company_id, token_hash, expires_at, ip, user_agent)
  values (gen_random_uuid(), p_user_id, v_company, p_token_hash, now() + interval '12 hours', p_ip, left(p_user_agent, 512))
  returning id into v_id;
  return query select v_id, v_company, now() + interval '12 hours', now() + interval '7 days';
end
$$;

-- Rotation with reuse detection. The presented row is locked FOR UPDATE, so two concurrent rotations of the same
-- token serialise: the first rotates (ok); the second, once the first commits, sees rotated_at set → race (≤ 10 s)
-- and changes nothing. A revoked token, or a rotated one presented more than 10 s after its rotation, revokes every
-- live row of the family (reason 'reuse'). Expired (12 h idle / 7 d from the family's first row) → family revoked
-- ('expired'). A user no longer active / no longer a member → family revoked ('account_inactive'), outcome invalid.
create function auth.rotate_session(p_old_hash bytea, p_new_hash bytea, p_ip inet, p_user_agent text)
  returns table (outcome text, session_id uuid, user_id uuid, company_id uuid, expires_at timestamptz, absolute_expires_at timestamptz)
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
#variable_conflict use_column
declare
  r auth.refresh_session%rowtype;
  v_absolute timestamptz;
  v_expires timestamptz;
  v_id uuid;
begin
  select * into r from auth.refresh_session s where s.token_hash = p_old_hash for update;
  if not found then
    return query select 'invalid'::text, null::uuid, null::uuid, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if r.revoked_at is not null or (r.rotated_at is not null and now() - r.rotated_at > interval '10 seconds') then
    update auth.refresh_session s set revoked_at = now(), revoke_reason = 'reuse'
     where s.family_id = r.family_id and s.revoked_at is null;
    return query select 'reuse'::text, null::uuid, r.user_id, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if r.rotated_at is not null then
    return query select 'race'::text, null::uuid, null::uuid, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  select min(s.created_at) + interval '7 days' into v_absolute from auth.refresh_session s where s.family_id = r.family_id;
  if r.expires_at <= now() or v_absolute <= now() then
    update auth.refresh_session s set revoked_at = now(), revoke_reason = 'expired'
     where s.family_id = r.family_id and s.revoked_at is null;
    return query select 'expired'::text, null::uuid, null::uuid, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if not exists (select 1
                   from auth.user_account u
                   join auth.user_company m on m.user_id = u.id
                  where u.id = r.user_id and u.status = 'active' and m.company_id = r.company_id) then
    update auth.refresh_session s set revoked_at = now(), revoke_reason = 'account_inactive'
     where s.family_id = r.family_id and s.revoked_at is null;
    return query select 'invalid'::text, null::uuid, null::uuid, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  update auth.refresh_session s set rotated_at = now() where s.id = r.id;
  v_expires := least(now() + interval '12 hours', v_absolute);
  insert into auth.refresh_session (family_id, user_id, company_id, token_hash, expires_at, ip, user_agent)
  values (r.family_id, r.user_id, r.company_id, p_new_hash, v_expires, p_ip, left(p_user_agent, 512))
  returning id into v_id;
  return query select 'ok'::text, v_id, r.user_id, r.company_id, v_expires, v_absolute;
end
$$;

create function auth.session_sid(p_token_hash bytea)
  returns uuid
  language sql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
  select s.id from auth.refresh_session s where s.token_hash = p_token_hash
$$;

create function auth.revoke_family(p_token_hash bytea, p_sid uuid, p_user_id uuid)
  returns void
  language sql
  security definer
  set search_path = pg_catalog, auth
as $$
  update auth.refresh_session s set revoked_at = now(), revoke_reason = 'logout'
   where s.revoked_at is null
     and s.family_id in (select x.family_id from auth.refresh_session x where x.token_hash = p_token_hash
                         union all
                         select x.family_id from auth.refresh_session x where x.id = p_sid and x.user_id = p_user_id)
$$;

create function auth.me(p_user_id uuid, p_company_id uuid)
  returns table (user_id uuid, email text, display_name text, locale text, company_id uuid, company_code text, company_name text)
  language sql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
  select u.id, u.email, u.display_name, u.locale, c.id, c.code, c.name
    from auth.user_account u
    join auth.user_company m on m.user_id = u.id and m.company_id = p_company_id
    join public.company c on c.id = m.company_id
   where u.id = p_user_id and u.status = 'active'
$$;

create function auth.user_companies(p_user_id uuid)
  returns table (company_id uuid, code text, name text)
  language sql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
  select c.id, c.code, c.name
    from auth.user_account u
    join auth.user_company m on m.user_id = u.id
    join public.company c on c.id = m.company_id
   where u.id = p_user_id and u.status = 'active'
   order by c.code
$$;

create function auth.password_token_target(p_token_hash bytea)
  returns table (user_id uuid, email text, purpose text)
  language sql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
  select u.id, u.email, t.purpose
    from auth.password_token t
    join auth.user_account u on u.id = t.user_id
   where t.token_hash = p_token_hash and t.used_at is null and t.expires_at > now() and u.status <> 'disabled'
$$;

create function auth.consume_password_token(p_token_hash bytea, p_password_hash text)
  returns uuid
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
declare
  v_token auth.password_token%rowtype;
  v_status text;
begin
  select * into v_token from auth.password_token t where t.token_hash = p_token_hash for update;
  if not found or v_token.used_at is not null or v_token.expires_at <= now() then
    return null;
  end if;
  select u.status into v_status from auth.user_account u where u.id = v_token.user_id for update;
  if v_status is distinct from 'invited' and v_status is distinct from 'active' then
    return null;
  end if;
  -- single use: this token and every other pending token of the user
  update auth.password_token t set used_at = now() where t.user_id = v_token.user_id and t.used_at is null;
  insert into auth.user_credential (user_id, password_hash, updated_at)
  values (v_token.user_id, p_password_hash, now())
  on conflict on constraint user_credential_pkey
  do update set password_hash = excluded.password_hash, updated_at = excluded.updated_at;
  update auth.user_account u set status = 'active' where u.id = v_token.user_id and u.status = 'invited';
  update auth.refresh_session s set revoked_at = now(), revoke_reason = 'password_change'
   where s.user_id = v_token.user_id and s.revoked_at is null;
  return v_token.user_id;
end
$$;

create function auth.request_password_reset(p_email text, p_token_hash bytea)
  returns table (user_id uuid, email text, display_name text, locale text)
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
#variable_conflict use_column
declare
  u auth.user_account%rowtype;
begin
  -- the row lock serialises concurrent requests for the same account, so the quota cannot be raced
  select * into u from auth.user_account a where a.email = lower(btrim(p_email)) for update;
  if not found or u.status <> 'active' then
    return;
  end if;
  if (select count(*) from auth.password_token t
       where t.user_id = u.id and t.purpose = 'reset' and t.created_at > now() - interval '1 hour') >= 3 then
    return;
  end if;
  insert into auth.password_token (user_id, token_hash, purpose, expires_at)
  values (u.id, p_token_hash, 'reset', now() + interval '1 hour');
  return query select u.id, u.email, u.display_name, u.locale;
end
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Privileges: nothing on tables/sequences for the app (or PUBLIC); EXECUTE only on the API functions.
revoke all on all tables in schema auth from public, hrforce_app;
revoke all on all sequences in schema auth from public, hrforce_app;
revoke all on all functions in schema auth from public, hrforce_app;
grant execute on function
  auth.find_login(text),
  auth.record_login_event(text, uuid, inet, text, text),
  auth.login_failures(text, inet),
  auth.create_session(uuid, bytea, inet, text),
  auth.rotate_session(bytea, bytea, inet, text),
  auth.session_sid(bytea),
  auth.revoke_family(bytea, uuid, uuid),
  auth.me(uuid, uuid),
  auth.user_companies(uuid),
  auth.password_token_target(bytea),
  auth.consume_password_token(bytea, text),
  auth.request_password_reset(text, bytea)
to hrforce_app;
