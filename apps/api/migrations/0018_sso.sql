-- 0018: SSO — HRForce as an OpenID Connect provider (docs/contracts/sso.md, ADR 007).
--   sso_client            a connected app (confidential client) of ONE company: global client_id, name, status, the
--                         client secret ENCRYPTED by the API (AES-256-GCM, subkey of OIDC_KEY, AAD = client_id; the
--                         database never sees the key), exact redirect / post-logout URIs, the authentication method
--   sso_app_role          a role of that app (code immutable), managed in HRForce
--   sso_role_assignment   a role given to a user of the company (whole company, no validity period); nobody assigns
--                         a role to themselves (check)
--   schema oidc           the provider's own state, GLOBAL (before any tenant is known) and keyed by hashed ids:
--     oidc.model_store          sessions, interactions, grants, codes, access tokens: sha-256(id) → payload (the id
--                               itself is never stored, so a dump or backup holds no bearer value)
--     oidc.signing_key          the RS256 signing keys, private JWK ENCRYPTED by the API (AAD = kid)
--     oidc.client_auth_failure  failed client authentications at the token endpoint (IP throttle source)
-- Also:
--   * permissions sso.read / sso.manage_apps / sso.assign (group sso) for admin_rh_central and admin_acces, the two
--     writing ones in the two-step sign-in defaults and every existing policy;
--   * auth.refresh_session.amr (how the session signed in: {pwd} or {pwd,otp,mfa}); auth.create_session takes it,
--     auth.rotate_session copies it;
--   * auth.sso_session(sid, user): is the HRForce session behind an access token still live (its whole family), when
--     did it sign in, how, and the account status — the check of POST /api/sso/interactions/:uid/complete;
--   * public.sso_client_by_client_id(client_id): the provider's client lookup before any tenant is known (SECURITY
--     DEFINER, active clients only), like attendance_pairing_lookup;
--   * the worker's daily oidc.cleanup privileges.
--
-- Audit: the three tenant tables have the row trigger; sso_client.secret_enc is masked. The oidc schema is not audited
-- (operational, high churn, no business data; sign-ins are audited as `sso.sign_in` events by the API).

-- ---------------------------------------------------------------------------------------------------------
-- Permissions (group sso, 810–830) and their system-role grants.
alter table public.permission drop constraint permission_group_ck;
alter table public.permission
  add constraint permission_group_ck check (group_code in ('organization', 'access', 'employee', 'leave', 'documents', 'attendance', 'sso', 'sensitive'));

insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('sso.read', 'Consulter les applications connectées', 'الاطلاع على التطبيقات المرتبطة', 'View connected apps', 'sso', false, 810),
  ('sso.manage_apps', 'Gérer les applications connectées (inscription, secrets, rôles)', 'تسيير التطبيقات المرتبطة (التسجيل، الرموز السرية، الأدوار)', 'Manage connected apps (registration, secrets, roles)', 'sso', false, 820),
  ('sso.assign', 'Attribuer les rôles d''application', 'إسناد أدوار التطبيقات', 'Assign app roles', 'sso', false, 830);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, p.code
  from public.role r
  join (values
          ('admin_rh_central', 'sso.read'), ('admin_rh_central', 'sso.manage_apps'), ('admin_rh_central', 'sso.assign'),
          ('admin_acces', 'sso.read'), ('admin_acces', 'sso.manage_apps'), ('admin_acces', 'sso.assign')
       ) as p (role_code, code) on p.role_code = r.code
 where r.is_system
on conflict (role_id, permission_code) do nothing;

-- Registering an app hands out a credential and assigning app roles is access management: both need the second factor
-- by default (new policies: the function; existing ones: appended once).
create or replace function public.security_policy_default_permissions()
  returns text[]
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(p.code order by p.sort_order), '{}')
    from public.permission p
   where p.sensitive or p.code in ('access.grant', 'access.manage_roles', 'leave.configure', 'attendance.configure', 'sso.manage_apps', 'sso.assign')
$$;

update public.security_policy
   set mfa_required_permissions = array_append(mfa_required_permissions, 'sso.manage_apps')
 where not ('sso.manage_apps' = any (mfa_required_permissions));
update public.security_policy
   set mfa_required_permissions = array_append(mfa_required_permissions, 'sso.assign')
 where not ('sso.assign' = any (mfa_required_permissions));

-- ---------------------------------------------------------------------------------------------------------
-- Identity: how a session signed in (the `amr` of the ID token), and the live-session check of the SSO handoff.
alter table auth.refresh_session add column amr text[] not null default '{pwd}';
alter table auth.refresh_session add constraint refresh_session_amr_ck check (cardinality(amr) between 1 and 3 and amr <@ array['pwd', 'otp', 'mfa']);

-- Same as 0007 plus p_amr (stored on the family's first row; rotate_session copies it). The old 4-argument signature
-- is dropped: with a defaulted 5th argument a 4-argument call would be ambiguous.
drop function auth.create_session(uuid, bytea, inet, text);
create function auth.create_session(p_user_id uuid, p_token_hash bytea, p_ip inet, p_user_agent text, p_amr text[] default '{pwd}')
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
  insert into auth.refresh_session (family_id, user_id, company_id, token_hash, expires_at, ip, user_agent, amr)
  values (gen_random_uuid(), p_user_id, v_company, p_token_hash, now() + interval '12 hours', p_ip, left(p_user_agent, 512),
          coalesce(p_amr, '{pwd}'))
  returning id into v_id;
  return query select v_id, v_company, now() + interval '12 hours', now() + interval '7 days';
end
$$;

-- 0007's rotation, unchanged except that the new row keeps the family's amr.
create or replace function auth.rotate_session(p_old_hash bytea, p_new_hash bytea, p_ip inet, p_user_agent text)
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
  insert into auth.refresh_session (family_id, user_id, company_id, token_hash, expires_at, ip, user_agent, amr)
  values (r.family_id, r.user_id, r.company_id, p_new_hash, v_expires, p_ip, left(p_user_agent, 512), r.amr)
  returning id into v_id;
  return query select 'ok'::text, v_id, r.user_id, r.company_id, v_expires, v_absolute;
end
$$;

-- The SSO handoff's session check (docs/contracts/sso.md › complete, step 3). An access token is stateless, so the
-- handoff asks whether the refresh session `p_sid` of `p_user_id` is still LIVE: the row's idle expiry and the family's
-- 7-day absolute limit are not reached, and NO row of its family is revoked (a logout, a detected reuse, an MFA reset
-- or a password setup revoke the whole family, so a revoked family is dead even when the token's own row was never
-- revoked). auth_time = the family's first row (the login instant); amr = how it signed in. No row for an unknown sid.
create function auth.sso_session(p_sid uuid, p_user_id uuid)
  returns table (live boolean, auth_time timestamptz, amr text[], account_status text)
  language sql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
  select s.expires_at > now() and f.first_at + interval '7 days' > now() and not f.any_revoked,
         f.first_at, s.amr, u.status
    from auth.refresh_session s
    join auth.user_account u on u.id = s.user_id
    cross join lateral (select min(x.created_at) as first_at, bool_or(x.revoked_at is not null) as any_revoked
                          from auth.refresh_session x
                         where x.family_id = s.family_id) f
   where s.id = p_sid and s.user_id = p_user_id
$$;

revoke all on function auth.create_session(uuid, bytea, inet, text, text[]), auth.rotate_session(bytea, bytea, inet, text),
  auth.sso_session(uuid, uuid) from public, hrforce_worker;
grant execute on function auth.create_session(uuid, bytea, inet, text, text[]), auth.rotate_session(bytea, bytea, inet, text),
  auth.sso_session(uuid, uuid) to hrforce_app;

-- ---------------------------------------------------------------------------------------------------------
create table public.sso_client (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  client_id text not null,
  name text not null,
  name_ar text,
  status text not null default 'active',
  -- AES-256-GCM: 12-byte nonce ‖ ciphertext ‖ 16-byte tag (the key never reaches the database)
  secret_enc bytea not null,
  credential_set_at timestamptz not null default now(),
  client_auth_method text not null default 'client_secret_basic',
  redirect_uris text[] not null,
  post_logout_redirect_uris text[] not null default '{}',
  -- null: created by a seed
  created_by uuid,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_by uuid,
  disabled_reason text,
  -- global: the provider looks clients up before any tenant is known
  constraint sso_client_client_id_uk unique (client_id),
  constraint sso_client_company_id_id_uk unique (company_id, id),
  constraint sso_client_client_id_ck check (client_id ~ '^[a-z][a-z0-9-]{2,39}$'),
  constraint sso_client_name_ck check (name = btrim(name) and char_length(name) between 1 and 80),
  constraint sso_client_name_ar_ck check (name_ar is null or (name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 80)),
  constraint sso_client_status_ck check (status in ('active', 'disabled')),
  constraint sso_client_secret_len_ck check (octet_length(secret_enc) > 28),
  constraint sso_client_auth_method_ck check (client_auth_method in ('client_secret_basic', 'client_secret_post')),
  constraint sso_client_redirect_uris_ck check (cardinality(redirect_uris) between 1 and 10 and array_position(redirect_uris, null) is null),
  constraint sso_client_post_logout_uris_ck check (cardinality(post_logout_redirect_uris) <= 10 and array_position(post_logout_redirect_uris, null) is null),
  constraint sso_client_disabled_ck check (
    (status = 'disabled') = (disabled_at is not null and disabled_by is not null and disabled_reason is not null)
    and (status = 'disabled' or (disabled_at is null and disabled_by is null and disabled_reason is null))
  ),
  constraint sso_client_reason_ck check (disabled_reason is null or (disabled_reason = btrim(disabled_reason) and char_length(disabled_reason) between 3 and 500))
);

create index sso_client_company_idx on public.sso_client (company_id, name);

alter table public.sso_client enable row level security;
alter table public.sso_client force row level security;
create policy sso_client_tenant_isolation on public.sso_client
  using (company_id = current_setting('app.company_id', true)::uuid);

-- The client id is what the apps are configured with: immutable, like the row's identity and creation.
create function public.sso_client_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.client_id is distinct from old.client_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'sso_client %: id, company, client_id and creation are immutable', old.id
      using errcode = 'check_violation', constraint = 'sso_client_immutable';
  end if;
  return new;
end
$$;

create trigger sso_client_guard_tg
  before update on public.sso_client
  for each row execute function public.sso_client_guard();

-- The provider's client lookup (docs/contracts/sso.md › Data): by the global client_id, before any tenant is known,
-- through this SECURITY DEFINER function owned by the migrator (pinned search_path). ACTIVE clients only: a disabled
-- client is unknown to the provider (invalid_client, error page).
create function public.sso_client_by_client_id(p_client_id text)
  returns table (id uuid, company_id uuid, client_id text, name text, name_ar text, secret_enc bytea, client_auth_method text,
                 redirect_uris text[], post_logout_redirect_uris text[])
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
as $$
  select c.id, c.company_id, c.client_id, c.name, c.name_ar, c.secret_enc, c.client_auth_method, c.redirect_uris,
         c.post_logout_redirect_uris
    from public.sso_client c
   where c.client_id = p_client_id and c.status = 'active'
$$;

-- ---------------------------------------------------------------------------------------------------------
create table public.sso_app_role (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  sso_client_id uuid not null,
  code text not null,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  created_at timestamptz not null default now(),
  constraint sso_app_role_company_id_id_uk unique (company_id, id),
  constraint sso_app_role_client_code_uk unique (sso_client_id, code),
  constraint sso_app_role_client_fk foreign key (company_id, sso_client_id) references public.sso_client (company_id, id),
  constraint sso_app_role_code_ck check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint sso_app_role_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 80
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 80
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 80
  )
);

alter table public.sso_app_role enable row level security;
alter table public.sso_app_role force row level security;
create policy sso_app_role_tenant_isolation on public.sso_app_role
  using (company_id = current_setting('app.company_id', true)::uuid);

-- The code travels in the ID tokens (`roles`): immutable, like the role's app.
create function public.sso_app_role_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.sso_client_id is distinct from old.sso_client_id
     or new.code is distinct from old.code or new.created_at is distinct from old.created_at then
    raise exception 'sso_app_role %: id, company, app, code and creation are immutable', old.id
      using errcode = 'check_violation', constraint = 'sso_app_role_immutable';
  end if;
  return new;
end
$$;

create trigger sso_app_role_guard_tg
  before update on public.sso_app_role
  for each row execute function public.sso_app_role_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.sso_role_assignment (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  sso_app_role_id uuid not null,
  -- no FK: hrforce_app has no privilege on auth.* (like role_grant.user_id); membership is checked by the API
  user_id uuid not null,
  -- null: created by a seed
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  constraint sso_role_assignment_role_user_uk unique (sso_app_role_id, user_id),
  constraint sso_role_assignment_role_fk foreign key (company_id, sso_app_role_id) references public.sso_app_role (company_id, id) on delete restrict,
  -- separation of duties (as user_employment): nobody assigns an app role to themselves
  constraint sso_role_assignment_not_self_ck check (assigned_by is null or assigned_by <> user_id)
);

create index sso_role_assignment_user_idx on public.sso_role_assignment (company_id, user_id);

alter table public.sso_role_assignment enable row level security;
alter table public.sso_role_assignment force row level security;
create policy sso_role_assignment_tenant_isolation on public.sso_role_assignment
  using (company_id = current_setting('app.company_id', true)::uuid);

-- An assignment is given or removed, never edited.
create function public.sso_role_assignment_guard() returns trigger
  language plpgsql
as $$
begin
  raise exception 'sso_role_assignment %: an assignment is removed and given again, never changed', old.id
    using errcode = 'check_violation', constraint = 'sso_role_assignment_immutable';
end
$$;

create trigger sso_role_assignment_guard_tg
  before update on public.sso_role_assignment
  for each row execute function public.sso_role_assignment_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Audit (guard:db audit-per-write): row triggers on the three tenant tables; the encrypted secret is masked.
create trigger audit_capture_tg after insert or update or delete on public.sso_client
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.sso_app_role
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.sso_role_assignment
  for each row execute function audit.capture();

insert into audit.masked_column (table_name, column_name) values ('sso_client', 'secret_enc');

-- ---------------------------------------------------------------------------------------------------------
-- The provider's state (global; tools/guardrails/company-id-exempt.json). Reachable by hrforce_app (the provider in
-- the API) and, for the daily cleanup, by hrforce_worker. Nothing for PUBLIC.
create schema oidc;
revoke all on schema oidc from public;
grant usage on schema oidc to hrforce_app, hrforce_worker;

create table oidc.model_store (
  -- Session, Interaction, Grant, AuthorizationCode, AccessToken (library model names)
  model text not null,
  -- sha-256 of the model's id (the id is a bearer value: a code, an access token, a session id)
  id_hash bytea not null,
  -- the model's payload WITHOUT any top-level field equal to the id (their names in __idFields)
  payload jsonb not null,
  grant_id text,
  -- sha-256 of payload.uid (Session.findByUid)
  uid_hash bytea,
  expires_at timestamptz,
  consumed_at timestamptz,
  constraint model_store_pk primary key (model, id_hash),
  constraint model_store_id_hash_ck check (octet_length(id_hash) = 32),
  constraint model_store_uid_hash_ck check (uid_hash is null or octet_length(uid_hash) = 32)
);
create index model_store_grant_idx on oidc.model_store (grant_id) where grant_id is not null;
create index model_store_uid_idx on oidc.model_store (model, uid_hash) where uid_hash is not null;
create index model_store_expires_idx on oidc.model_store (expires_at);

create table oidc.signing_key (
  kid text primary key,
  alg text not null default 'RS256',
  status text not null,
  -- AES-256-GCM of the private JWK (JSON), AAD = kid
  jwk_enc bytea not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  constraint signing_key_alg_ck check (alg = 'RS256'),
  constraint signing_key_status_ck check (status in ('next', 'current', 'retired')),
  constraint signing_key_kid_ck check (kid ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint signing_key_retired_ck check ((status = 'retired') = (retired_at is not null))
);
-- at most one current key and at most one next key
create unique index signing_key_one_current_uk on oidc.signing_key (status) where status = 'current';
create unique index signing_key_one_next_uk on oidc.signing_key (status) where status = 'next';

create table oidc.client_auth_failure (
  id bigserial primary key,
  at timestamptz not null default now(),
  ip inet,
  client_id text not null,
  constraint client_auth_failure_client_id_ck check (char_length(client_id) <= 64)
);
create index client_auth_failure_ip_at_idx on oidc.client_auth_failure (ip, at);

-- ---------------------------------------------------------------------------------------------------------
-- Privileges.
-- hrforce_app (0001's default privileges cover the public tables): no DELETE on sso_client (disable instead); the
-- lookups; the provider state; the first signing key only (rotation runs as the migrator, CLI oidc:keys).
-- hrforce_worker: SELECT on the public tables by 0012's default privileges; the cleanup of the provider state.
revoke delete on table public.sso_client from hrforce_app;
revoke all on function public.sso_client_guard(), public.sso_app_role_guard(), public.sso_role_assignment_guard() from public;
revoke all on function public.sso_client_by_client_id(text) from public, hrforce_worker;
grant execute on function public.sso_client_by_client_id(text) to hrforce_app;

revoke all on all tables in schema oidc from public;
revoke all on all sequences in schema oidc from public;
grant select, insert, update, delete on table oidc.model_store to hrforce_app;
grant select, insert on table oidc.signing_key to hrforce_app;
grant select, insert on table oidc.client_auth_failure to hrforce_app;
grant usage on sequence oidc.client_auth_failure_id_seq to hrforce_app;
grant select, delete on table oidc.model_store, oidc.client_auth_failure to hrforce_worker;
