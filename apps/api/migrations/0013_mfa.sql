-- 0013: two-step sign-in — TOTP (RFC 6238) + single-use recovery codes — and the company security policy
-- (docs/contracts/mfa.md, ADR 004).
--
-- New auth tables (same rule as 0007: NO privilege for hrforce_app or PUBLIC; reachable only through the SECURITY
-- DEFINER functions below, owned by the migrator, `search_path = pg_catalog, auth`, EXECUTE granted one by one):
--   auth.user_mfa           one row per user with a second factor: the TOTP secret ENCRYPTED by the API
--                           (AES-256-GCM, key AUTH_MFA_KEY, which the database never sees; nonce ‖ ciphertext ‖ tag,
--                           the user id as additional data), status pending → active, last_used_step (replay guard)
--   auth.mfa_recovery_code  sha-256 of each normalized recovery code of the user's current set; used_at = spent
--   auth.mfa_challenge      the second step of one login (id = `mfa` claim of the hrf_mfa cookie): 5 minutes,
--                           at most 5 failures, consumed once
-- New tenant table public.security_policy (RLS + FORCE, audited): mfa_enforced (default true) and
-- mfa_required_permissions (default: every `sensitive` permission + access.grant, access.manage_roles,
-- leave.configure). A company without a row is treated as having the defaults (enforced); a row is inserted below for
-- every existing company.
--
-- What each function exposes (the app never reads an auth table; secret_enc leaves the database ONLY for the user
-- the call is bound to — the owner of a live login challenge, or the transaction's own app.user_id):
--
-- Login (/api/auth/*, no request transaction; the caller has just verified the password):
--   auth.mfa_begin_challenge(user_id)            → (challenge_id, company_id, expires_at) iff the user is ACTIVE, has
--                                                   MFA ACTIVE and a membership; else no row (= log in without MFA).
--                                                   Exposes nothing about the factor itself.
--   auth.mfa_challenge_open(challenge_id, user_id) → (email, secret_enc, last_used_step) for a LIVE challenge
--                                                   (unconsumed, unexpired, < 5 failures) OF THAT USER, whose account
--                                                   and MFA are active; else no row. The only login-time read of a
--                                                   secret: it needs the challenge id, which only the signed hrf_mfa
--                                                   cookie of a correct password carries.
--   auth.mfa_challenge_fail(challenge_id, user_id) → failures after +1 (5 = dead), null when not live
--   auth.mfa_challenge_complete(challenge_id, user_id, step, recovery_hash)
--                                                → (outcome, recovery_codes_left). Under a row lock on the challenge:
--                                                   step given: last_used_step := step iff step > last_used_step, else
--                                                   'replay'; recovery_hash given: marks that unused code used, else
--                                                   'invalid'; then consumes the challenge → 'ok'. Dead → 'expired'.
-- Signed in (request transaction; every function first checks p_user_id = current_setting('app.user_id') and
-- raises insufficient_privilege otherwise — a user only ever touches their own factor):
--   auth.mfa_status(user_id)                     → (status none|pending|active, enabled_at, recovery_codes_left)
--   auth.mfa_enroll_start(user_id, secret_enc)   → true: pending secret stored (replaces a pending one);
--                                                   false: MFA already active (nothing changed)
--   auth.mfa_own_secret(user_id)                 → (status, secret_enc, last_used_step) of the caller's own factor, to
--                                                   check a code on confirm / regenerate / disable
--   auth.mfa_enroll_confirm(user_id, step, hashes[10]) → pending → active, last_used_step = step, recovery set
--                                                   replaced; false if not pending
--   auth.mfa_replace_recovery_codes(user_id, step, hashes[10]) → new recovery set iff active and step >
--                                                   last_used_step (replay guard); false otherwise
--   auth.mfa_disable(user_id, step)              → removes the factor + codes iff active and step > last_used_step
-- Administration (request transaction, access.grant checked by the API):
--   auth.mfa_reset(user_id)                      → (email, display_name, locale, had_mfa) of a member of the CURRENT
--                                                   tenant (app.company_id) who is not the caller (app.user_id; raises
--                                                   otherwise); removes their factor and codes, kills their open
--                                                   challenges and revokes every refresh session (reason mfa_reset).
--                                                   No row for a non-member.
-- Changed: auth.login_failures counts 'mfa_failed' like 'bad_credentials' (per-e-mail lock and per-IP throttle);
-- login_event.outcome gains 'mfa_failed'; refresh_session.revoke_reason gains 'mfa_reset'.
--
-- Trust note (docs/HANDOFF.md open question 3): these checks bind every call to the app's own session settings; a
-- compromised hrforce_app role can still set them. The TOTP secrets are useless without AUTH_MFA_KEY (API env only).

-- ---------------------------------------------------------------------------------------------------------
alter table auth.login_event drop constraint login_event_outcome_ck;
alter table auth.login_event add constraint login_event_outcome_ck
  check (outcome in ('success', 'bad_credentials', 'locked', 'disabled', 'throttled_ip', 'mfa_failed'));

alter table auth.refresh_session drop constraint refresh_session_revoke_reason_ck;
alter table auth.refresh_session add constraint refresh_session_revoke_reason_ck
  check (revoke_reason in ('logout', 'reuse', 'expired', 'password_change', 'account_inactive', 'mfa_reset'));

create table auth.user_mfa (
  user_id uuid primary key references auth.user_account (id) on delete cascade,
  -- AES-256-GCM: 12-byte nonce ‖ ciphertext of the 20-byte secret ‖ 16-byte tag
  secret_enc bytea not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  enabled_at timestamptz,
  last_used_step bigint,
  constraint user_mfa_secret_enc_ck check (octet_length(secret_enc) = 48),
  constraint user_mfa_status_ck check (status in ('pending', 'active')),
  constraint user_mfa_enabled_ck check ((status = 'active') = (enabled_at is not null))
);

create table auth.mfa_recovery_code (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.user_mfa (user_id) on delete cascade,
  code_hash bytea not null,
  used_at timestamptz,
  constraint mfa_recovery_code_hash_ck check (octet_length(code_hash) = 32),
  constraint mfa_recovery_code_user_hash_uk unique (user_id, code_hash)
);

create table auth.mfa_challenge (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.user_account (id) on delete cascade,
  company_id uuid not null references public.company (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  failures int not null default 0,
  consumed_at timestamptz,
  constraint mfa_challenge_failures_ck check (failures between 0 and 5)
);
create index mfa_challenge_user_idx on auth.mfa_challenge (user_id, created_at);

-- ---------------------------------------------------------------------------------------------------------
-- Failed attempts: an MFA failure counts like a wrong password (docs/contracts/mfa.md › Login flow).
create or replace function auth.login_failures(p_email text, p_ip inet)
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
                              and e.outcome in ('bad_credentials', 'mfa_failed')
                              and e.at > now() - interval '30 minutes'
                            order by e.at desc limit 50) x), '{}'),
         coalesce((select array_agg(y.at order by y.at desc)
                     from (select e.at from auth.login_event e
                            where p_ip is not null and e.ip = p_ip
                              and e.outcome in ('bad_credentials', 'locked', 'mfa_failed')
                              and e.at > now() - interval '15 minutes'
                            order by e.at desc limit 30) y), '{}')
$$;

-- Internal (not granted): the signed-in functions act for the transaction's own user only.
create function auth.mfa_assert_caller(p_user_id uuid) returns void
  language plpgsql
  stable
  set search_path = pg_catalog
as $$
begin
  if p_user_id is null or p_user_id is distinct from nullif(current_setting('app.user_id', true), '')::uuid then
    raise exception 'auth: % is not the current user', p_user_id using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Login
create function auth.mfa_begin_challenge(p_user_id uuid)
  returns table (challenge_id uuid, company_id uuid, expires_at timestamptz)
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
#variable_conflict use_column
declare
  v_company uuid;
  v_id uuid;
  v_expires timestamptz := now() + interval '5 minutes';
begin
  if not exists (select 1
                   from auth.user_mfa m
                   join auth.user_account u on u.id = m.user_id
                  where m.user_id = p_user_id and m.status = 'active' and u.status = 'active') then
    return;
  end if;
  -- same company as auth.create_session: the default membership, else the lowest company code
  select m.company_id into v_company
    from auth.user_company m
    join public.company c on c.id = m.company_id
   where m.user_id = p_user_id
   order by m.is_default desc, c.code
   limit 1;
  if v_company is null then
    return;
  end if;
  -- housekeeping: the user's finished challenges older than a day
  delete from auth.mfa_challenge c
   where c.user_id = p_user_id and c.created_at < now() - interval '1 day';
  insert into auth.mfa_challenge (user_id, company_id, expires_at)
  values (p_user_id, v_company, v_expires)
  returning id into v_id;
  return query select v_id, v_company, v_expires;
end
$$;

create function auth.mfa_challenge_open(p_challenge_id uuid, p_user_id uuid)
  returns table (email text, secret_enc bytea, last_used_step bigint)
  language sql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
  select u.email, m.secret_enc, m.last_used_step
    from auth.mfa_challenge c
    join auth.user_account u on u.id = c.user_id
    join auth.user_mfa m on m.user_id = c.user_id
   where c.id = p_challenge_id and c.user_id = p_user_id
     and c.consumed_at is null and c.expires_at > now() and c.failures < 5
     and u.status = 'active' and m.status = 'active'
$$;

create function auth.mfa_challenge_fail(p_challenge_id uuid, p_user_id uuid)
  returns int
  language sql
  security definer
  set search_path = pg_catalog, auth
as $$
  update auth.mfa_challenge c set failures = c.failures + 1
   where c.id = p_challenge_id and c.user_id = p_user_id
     and c.consumed_at is null and c.expires_at > now() and c.failures < 5
  returning c.failures
$$;

create function auth.mfa_challenge_complete(p_challenge_id uuid, p_user_id uuid, p_step bigint, p_recovery_hash bytea)
  returns table (outcome text, recovery_codes_left int)
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
#variable_conflict use_column
declare
  c auth.mfa_challenge%rowtype;
  v_left int;
begin
  if (p_step is null) = (p_recovery_hash is null) then
    raise exception 'auth.mfa_challenge_complete: exactly one of step and recovery_hash' using errcode = 'invalid_parameter_value';
  end if;
  select * into c from auth.mfa_challenge x where x.id = p_challenge_id and x.user_id = p_user_id for update;
  if not found or c.consumed_at is not null or c.expires_at <= now() or c.failures >= 5
     or not exists (select 1 from auth.user_mfa m join auth.user_account u on u.id = m.user_id
                     where m.user_id = p_user_id and m.status = 'active' and u.status = 'active') then
    return query select 'expired'::text, null::int;
    return;
  end if;
  if p_step is not null then
    update auth.user_mfa m set last_used_step = p_step
     where m.user_id = p_user_id and (m.last_used_step is null or m.last_used_step < p_step);
    if not found then
      return query select 'replay'::text, null::int;
      return;
    end if;
  else
    -- (user_id, code_hash) is unique; a concurrent use of the same code waits on the row lock, then finds it used
    update auth.mfa_recovery_code r set used_at = now()
     where r.user_id = p_user_id and r.code_hash = p_recovery_hash and r.used_at is null;
    if not found then
      return query select 'invalid'::text, null::int;
      return;
    end if;
  end if;
  update auth.mfa_challenge x set consumed_at = now() where x.id = c.id;
  select count(*)::int into v_left from auth.mfa_recovery_code r where r.user_id = p_user_id and r.used_at is null;
  return query select 'ok'::text, v_left;
end
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Signed in: the caller's own factor
create function auth.mfa_status(p_user_id uuid)
  returns table (status text, enabled_at timestamptz, recovery_codes_left int)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
#variable_conflict use_column
begin
  perform auth.mfa_assert_caller(p_user_id);
  return query
    select coalesce(m.status, 'none'), m.enabled_at,
           case when m.status = 'active'
                then (select count(*)::int from auth.mfa_recovery_code r where r.user_id = m.user_id and r.used_at is null)
           end
      from (select 1) one
      left join auth.user_mfa m on m.user_id = p_user_id;
end
$$;

create function auth.mfa_enroll_start(p_user_id uuid, p_secret_enc bytea)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
begin
  perform auth.mfa_assert_caller(p_user_id);
  insert into auth.user_mfa as m (user_id, secret_enc) values (p_user_id, p_secret_enc)
  on conflict (user_id) do update
    set secret_enc = excluded.secret_enc, created_at = now(), last_used_step = null
    where m.status = 'pending';
  return found;
end
$$;

create function auth.mfa_own_secret(p_user_id uuid)
  returns table (status text, secret_enc bytea, last_used_step bigint)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
#variable_conflict use_column
begin
  perform auth.mfa_assert_caller(p_user_id);
  return query select m.status, m.secret_enc, m.last_used_step from auth.user_mfa m where m.user_id = p_user_id;
end
$$;

-- Internal (not granted): replaces the user's recovery set with exactly 10 new hashes.
create function auth.mfa_store_recovery_codes(p_user_id uuid, p_code_hashes bytea[])
  returns void
  language plpgsql
  set search_path = pg_catalog, auth
as $$
begin
  if coalesce(cardinality(p_code_hashes), 0) <> 10 then
    raise exception 'auth: a recovery set has exactly 10 codes' using errcode = 'invalid_parameter_value';
  end if;
  delete from auth.mfa_recovery_code r where r.user_id = p_user_id;
  insert into auth.mfa_recovery_code (user_id, code_hash) select p_user_id, h from unnest(p_code_hashes) as h;
end
$$;

create function auth.mfa_enroll_confirm(p_user_id uuid, p_step bigint, p_code_hashes bytea[])
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
begin
  perform auth.mfa_assert_caller(p_user_id);
  update auth.user_mfa m set status = 'active', enabled_at = now(), last_used_step = p_step
   where m.user_id = p_user_id and m.status = 'pending';
  if not found then
    return false;
  end if;
  perform auth.mfa_store_recovery_codes(p_user_id, p_code_hashes);
  return true;
end
$$;

create function auth.mfa_replace_recovery_codes(p_user_id uuid, p_step bigint, p_code_hashes bytea[])
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
begin
  perform auth.mfa_assert_caller(p_user_id);
  update auth.user_mfa m set last_used_step = p_step
   where m.user_id = p_user_id and m.status = 'active' and (m.last_used_step is null or m.last_used_step < p_step);
  if not found then
    return false;
  end if;
  perform auth.mfa_store_recovery_codes(p_user_id, p_code_hashes);
  return true;
end
$$;

create function auth.mfa_disable(p_user_id uuid, p_step bigint)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
begin
  perform auth.mfa_assert_caller(p_user_id);
  delete from auth.user_mfa m
   where m.user_id = p_user_id and m.status = 'active' and (m.last_used_step is null or m.last_used_step < p_step);
  if not found then
    return false;
  end if;
  update auth.mfa_challenge c set consumed_at = now() where c.user_id = p_user_id and c.consumed_at is null;
  return true;
end
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Administration
create function auth.mfa_reset(p_user_id uuid)
  returns table (email text, display_name text, locale text, had_mfa boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
#variable_conflict use_column
declare
  v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_company uuid := nullif(current_setting('app.company_id', true), '')::uuid;
  v_had boolean;
begin
  if p_user_id is null or v_actor is null or v_company is null or p_user_id = v_actor then
    raise exception 'auth.mfa_reset: refused for %', p_user_id using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from auth.user_company m where m.user_id = p_user_id and m.company_id = v_company) then
    return;
  end if;
  delete from auth.user_mfa m where m.user_id = p_user_id;
  v_had := found;
  update auth.mfa_challenge c set consumed_at = now() where c.user_id = p_user_id and c.consumed_at is null;
  update auth.refresh_session s set revoked_at = now(), revoke_reason = 'mfa_reset'
   where s.user_id = p_user_id and s.revoked_at is null;
  return query select u.email, u.display_name, u.locale, v_had from auth.user_account u where u.id = p_user_id;
end
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Privileges: nothing on the new tables for the app (or PUBLIC); EXECUTE only on the API functions.
revoke all on table auth.user_mfa, auth.mfa_recovery_code, auth.mfa_challenge from public, hrforce_app, hrforce_worker;
revoke all on function
  auth.mfa_assert_caller(uuid),
  auth.mfa_store_recovery_codes(uuid, bytea[]),
  auth.mfa_begin_challenge(uuid),
  auth.mfa_challenge_open(uuid, uuid),
  auth.mfa_challenge_fail(uuid, uuid),
  auth.mfa_challenge_complete(uuid, uuid, bigint, bytea),
  auth.mfa_status(uuid),
  auth.mfa_enroll_start(uuid, bytea),
  auth.mfa_own_secret(uuid),
  auth.mfa_enroll_confirm(uuid, bigint, bytea[]),
  auth.mfa_replace_recovery_codes(uuid, bigint, bytea[]),
  auth.mfa_disable(uuid, bigint),
  auth.mfa_reset(uuid)
from public, hrforce_app, hrforce_worker;
grant execute on function
  auth.mfa_begin_challenge(uuid),
  auth.mfa_challenge_open(uuid, uuid),
  auth.mfa_challenge_fail(uuid, uuid),
  auth.mfa_challenge_complete(uuid, uuid, bigint, bytea),
  auth.mfa_status(uuid),
  auth.mfa_enroll_start(uuid, bytea),
  auth.mfa_own_secret(uuid),
  auth.mfa_enroll_confirm(uuid, bigint, bytea[]),
  auth.mfa_replace_recovery_codes(uuid, bigint, bytea[]),
  auth.mfa_disable(uuid, bigint),
  auth.mfa_reset(uuid)
to hrforce_app;

-- ---------------------------------------------------------------------------------------------------------
-- Company security policy (tenant table, audited). The default permission list is computed from the catalogue at
-- insert time: every `sensitive` permission + access.grant, access.manage_roles, leave.configure.
create function public.security_policy_default_permissions()
  returns text[]
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(p.code order by p.sort_order), '{}')
    from public.permission p
   where p.sensitive or p.code in ('access.grant', 'access.manage_roles', 'leave.configure')
$$;

create table public.security_policy (
  company_id uuid primary key references public.company (id),
  mfa_enforced boolean not null default true,
  mfa_required_permissions text[] not null default public.security_policy_default_permissions(),
  updated_at timestamptz not null default now(),
  constraint security_policy_permissions_ck check (array_position(mfa_required_permissions, null) is null)
);

alter table public.security_policy enable row level security;
alter table public.security_policy force row level security;
create policy security_policy_tenant_isolation on public.security_policy
  using (company_id = current_setting('app.company_id', true)::uuid);

create trigger audit_capture_tg after insert or update or delete on public.security_policy
  for each row execute function audit.capture('company_id');

-- one policy per company, changed in place: never deleted by the app
revoke delete on table public.security_policy from hrforce_app;

-- Existing companies get the defaults (enforced). seed:dev turns enforcement off for the DEMO company.
insert into public.security_policy (company_id) select c.id from public.company c on conflict do nothing;
