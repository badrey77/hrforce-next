-- 0021: Branding settings (docs/contracts/branding.md).
--   company_branding       per company (created on the first write): app title, welcome title and message, footer in
--                          fr / ar / en, a brand colour code, the app logo and the company logo. A null field inherits
--                          the installation default, then the built-in value.
--   installation_branding  ONE row for the whole database (the sign-in page, and what a company that set nothing
--                          inherits): app title, sign-in message, footer, colour, app logo. Its company_id is the
--                          OWNING company — the only one whose settings.branding holders may edit it.
-- Also:
--   * permission settings.branding (new group `settings`), admin_rh_central only, in the two-step sign-in defaults and
--     appended once to every existing policy;
--   * public.branding_installation_default() / public.branding_installation_logo(sha256): the reads before a tenant is
--     known (SECURITY DEFINER, like attendance_pairing_lookup) — no company id, no bytes in the first, bytes only for
--     the exact stored digest in the second.
--
-- Privileges (hrforce_app): company_branding select / insert / update, no delete (a reset is nulls);
-- installation_branding select and a column-level update that leaves out `singleton` and `company_id`, no insert, no
-- delete — the app can neither create the row nor move ownership (operator CLI `branding:owner`, migrator role).
-- Audit: both tables have the row trigger; the logo bytes are masked (digest, type and size stay readable).
-- Colours are CODES; the hex values live only in the web's stylesheet.

-- ---------------------------------------------------------------------------------------------------------
-- Permission (group settings, 1010) and its system-role grant.
alter table public.permission drop constraint permission_group_ck;
alter table public.permission
  add constraint permission_group_ck check (group_code in ('organization', 'access', 'employee', 'leave', 'documents', 'attendance', 'sso', 'recruitment', 'settings', 'sensitive'));

insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('settings.branding', 'Personnaliser l''identité visuelle (titre, logos, couleur, messages)', 'تخصيص الهوية البصرية (العنوان، الشعارات، اللون، الرسائل)', 'Customise branding (title, logos, colour, messages)', 'settings', false, 1010);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, 'settings.branding'
  from public.role r
 where r.is_system and r.code = 'admin_rh_central'
on conflict (role_id, permission_code) do nothing;

-- What every user sees before and after sign-in is changed here: the second factor is required by default (new
-- policies: the function; existing ones: appended once).
create or replace function public.security_policy_default_permissions()
  returns text[]
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(p.code order by p.sort_order), '{}')
    from public.permission p
   where p.sensitive
      or p.code in ('access.grant', 'access.manage_roles', 'leave.configure', 'attendance.configure', 'sso.manage_apps', 'sso.assign', 'settings.branding')
$$;

update public.security_policy
   set mfa_required_permissions = array_append(mfa_required_permissions, 'settings.branding')
 where not ('settings.branding' = any (mfa_required_permissions));

-- ---------------------------------------------------------------------------------------------------------
create table public.company_branding (
  company_id uuid primary key references public.company (id),
  app_title_fr text,
  app_title_ar text,
  app_title_en text,
  welcome_title_fr text,
  welcome_title_ar text,
  welcome_title_en text,
  welcome_message_fr text,
  welcome_message_ar text,
  welcome_message_en text,
  footer_fr text,
  footer_ar text,
  footer_en text,
  -- a palette code; null = the installation's colour
  color text,
  app_logo bytea,
  app_logo_mime text,
  app_logo_sha256 bytea,
  app_logo_width integer,
  app_logo_height integer,
  company_logo bytea,
  company_logo_mime text,
  company_logo_sha256 bytea,
  company_logo_width integer,
  company_logo_height integer,
  updated_at timestamptz not null default now(),
  -- auth.user_account id, without FK (hrforce_app has no privilege on auth.*), like role_grant.user_id
  updated_by uuid,
  -- lengths in characters (code points); never an empty string; French as soon as a field has any language
  constraint company_branding_app_title_ck check (
    (app_title_fr is null or (app_title_fr <> '' and char_length(app_title_fr) <= 40))
    and (app_title_ar is null or (app_title_ar <> '' and char_length(app_title_ar) <= 40))
    and (app_title_en is null or (app_title_en <> '' and char_length(app_title_en) <= 40))
    and (app_title_fr is not null or (app_title_ar is null and app_title_en is null))
  ),
  constraint company_branding_welcome_title_ck check (
    (welcome_title_fr is null or (welcome_title_fr <> '' and char_length(welcome_title_fr) <= 80))
    and (welcome_title_ar is null or (welcome_title_ar <> '' and char_length(welcome_title_ar) <= 80))
    and (welcome_title_en is null or (welcome_title_en <> '' and char_length(welcome_title_en) <= 80))
    and (welcome_title_fr is not null or (welcome_title_ar is null and welcome_title_en is null))
  ),
  constraint company_branding_welcome_message_ck check (
    (welcome_message_fr is null or (welcome_message_fr <> '' and char_length(welcome_message_fr) <= 500))
    and (welcome_message_ar is null or (welcome_message_ar <> '' and char_length(welcome_message_ar) <= 500))
    and (welcome_message_en is null or (welcome_message_en <> '' and char_length(welcome_message_en) <= 500))
    and (welcome_message_fr is not null or (welcome_message_ar is null and welcome_message_en is null))
  ),
  constraint company_branding_footer_ck check (
    (footer_fr is null or (footer_fr <> '' and char_length(footer_fr) <= 200))
    and (footer_ar is null or (footer_ar <> '' and char_length(footer_ar) <= 200))
    and (footer_en is null or (footer_en <> '' and char_length(footer_en) <= 200))
    and (footer_fr is not null or (footer_ar is null and footer_en is null))
  ),
  constraint company_branding_color_ck check (
    color is null or color in ('blue', 'navy', 'azure', 'teal', 'green', 'olive', 'brown', 'plum', 'indigo', 'slate')
  ),
  -- a logo: PNG or JPEG (type and pixel size read from the header by the API), at most 256 KB, 4 000 px per side and
  -- 16 megapixels, with its SHA-256; the five columns are set together
  constraint company_branding_app_logo_ck check (
    (app_logo is null and app_logo_mime is null and app_logo_sha256 is null and app_logo_width is null and app_logo_height is null)
    or (app_logo is not null and octet_length(app_logo) between 1 and 262144
        and app_logo_mime is not null and app_logo_mime in ('image/png', 'image/jpeg')
        and app_logo_sha256 is not null and octet_length(app_logo_sha256) = 32
        and app_logo_width is not null and app_logo_width between 1 and 4000
        and app_logo_height is not null and app_logo_height between 1 and 4000
        and app_logo_width::bigint * app_logo_height <= 16000000)
  ),
  constraint company_branding_company_logo_ck check (
    (company_logo is null and company_logo_mime is null and company_logo_sha256 is null and company_logo_width is null and company_logo_height is null)
    or (company_logo is not null and octet_length(company_logo) between 1 and 262144
        and company_logo_mime is not null and company_logo_mime in ('image/png', 'image/jpeg')
        and company_logo_sha256 is not null and octet_length(company_logo_sha256) = 32
        and company_logo_width is not null and company_logo_width between 1 and 4000
        and company_logo_height is not null and company_logo_height between 1 and 4000
        and company_logo_width::bigint * company_logo_height <= 16000000)
  )
);

alter table public.company_branding enable row level security;
alter table public.company_branding force row level security;
create policy company_branding_tenant_isolation on public.company_branding
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- At most one row in the database: the primary key is a boolean that can only be true.
create table public.installation_branding (
  singleton boolean primary key default true,
  -- the OWNING company
  company_id uuid not null references public.company (id),
  app_title_fr text,
  app_title_ar text,
  app_title_en text,
  sign_in_message_fr text,
  sign_in_message_ar text,
  sign_in_message_en text,
  footer_fr text,
  footer_ar text,
  footer_en text,
  color text not null default 'blue',
  app_logo bytea,
  app_logo_mime text,
  app_logo_sha256 bytea,
  app_logo_width integer,
  app_logo_height integer,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint installation_branding_singleton_ck check (singleton),
  constraint installation_branding_company_uk unique (company_id),
  constraint installation_branding_app_title_ck check (
    (app_title_fr is null or (app_title_fr <> '' and char_length(app_title_fr) <= 40))
    and (app_title_ar is null or (app_title_ar <> '' and char_length(app_title_ar) <= 40))
    and (app_title_en is null or (app_title_en <> '' and char_length(app_title_en) <= 40))
    and (app_title_fr is not null or (app_title_ar is null and app_title_en is null))
  ),
  constraint installation_branding_sign_in_message_ck check (
    (sign_in_message_fr is null or (sign_in_message_fr <> '' and char_length(sign_in_message_fr) <= 500))
    and (sign_in_message_ar is null or (sign_in_message_ar <> '' and char_length(sign_in_message_ar) <= 500))
    and (sign_in_message_en is null or (sign_in_message_en <> '' and char_length(sign_in_message_en) <= 500))
    and (sign_in_message_fr is not null or (sign_in_message_ar is null and sign_in_message_en is null))
  ),
  constraint installation_branding_footer_ck check (
    (footer_fr is null or (footer_fr <> '' and char_length(footer_fr) <= 200))
    and (footer_ar is null or (footer_ar <> '' and char_length(footer_ar) <= 200))
    and (footer_en is null or (footer_en <> '' and char_length(footer_en) <= 200))
    and (footer_fr is not null or (footer_ar is null and footer_en is null))
  ),
  constraint installation_branding_color_ck check (
    color in ('blue', 'navy', 'azure', 'teal', 'green', 'olive', 'brown', 'plum', 'indigo', 'slate')
  ),
  constraint installation_branding_app_logo_ck check (
    (app_logo is null and app_logo_mime is null and app_logo_sha256 is null and app_logo_width is null and app_logo_height is null)
    or (app_logo is not null and octet_length(app_logo) between 1 and 262144
        and app_logo_mime is not null and app_logo_mime in ('image/png', 'image/jpeg')
        and app_logo_sha256 is not null and octet_length(app_logo_sha256) = 32
        and app_logo_width is not null and app_logo_width between 1 and 4000
        and app_logo_height is not null and app_logo_height between 1 and 4000
        and app_logo_width::bigint * app_logo_height <= 16000000)
  )
);

alter table public.installation_branding enable row level security;
alter table public.installation_branding force row level security;
-- only a session of the owning company sees the row: "is my company the owner?" = the row is visible
create policy installation_branding_tenant_isolation on public.installation_branding
  using (company_id = current_setting('app.company_id', true)::uuid);

-- the logos' bytes are not diffed in the audit trail (their SHA-256, type and size are)
insert into audit.masked_column (table_name, column_name) values
  ('company_branding', 'app_logo'),
  ('company_branding', 'company_logo'),
  ('installation_branding', 'app_logo')
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------
-- Reads before a tenant is known (GET /api/branding/default and its logo; the inherited level of every company):
-- SECURITY DEFINER functions owned by the migrator, pinned search_path. The first returns no company id, no bytes and
-- no user; the second returns the bytes only for the exact stored digest.
create function public.branding_installation_default()
  returns table (
    app_title_fr text, app_title_ar text, app_title_en text,
    sign_in_message_fr text, sign_in_message_ar text, sign_in_message_en text,
    footer_fr text, footer_ar text, footer_en text,
    color text, app_logo_mime text, app_logo_sha256 bytea, app_logo_width integer, app_logo_height integer
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
as $$
  select b.app_title_fr, b.app_title_ar, b.app_title_en,
         b.sign_in_message_fr, b.sign_in_message_ar, b.sign_in_message_en,
         b.footer_fr, b.footer_ar, b.footer_en,
         b.color, b.app_logo_mime, b.app_logo_sha256, b.app_logo_width, b.app_logo_height
    from public.installation_branding b
$$;

create function public.branding_installation_logo(p_sha256 bytea)
  returns table (bytes bytea, mime text)
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
as $$
  select b.app_logo, b.app_logo_mime
    from public.installation_branding b
   where b.app_logo_sha256 is not null and b.app_logo_sha256 = p_sha256
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Privileges.
revoke delete on table public.company_branding from hrforce_app;
revoke insert, update, delete on table public.installation_branding from hrforce_app;
grant update (app_title_fr, app_title_ar, app_title_en, sign_in_message_fr, sign_in_message_ar, sign_in_message_en,
              footer_fr, footer_ar, footer_en, color, app_logo, app_logo_mime, app_logo_sha256, app_logo_width, app_logo_height,
              updated_at, updated_by)
  on table public.installation_branding to hrforce_app;
revoke all on function public.branding_installation_default(), public.branding_installation_logo(bytea) from public;
grant execute on function public.branding_installation_default(), public.branding_installation_logo(bytea) to hrforce_app;

-- ---------------------------------------------------------------------------------------------------------
-- Audit (guard:db audit-per-write).
create trigger audit_capture_tg after insert or update or delete on public.company_branding
  for each row execute function audit.capture('company_id');
create trigger audit_capture_tg after insert or update or delete on public.installation_branding
  for each row execute function audit.capture('company_id');

-- ---------------------------------------------------------------------------------------------------------
-- The owning company of an existing installation: the oldest company (no row on an empty database; the first company
-- created by bootstrap / seed:dev then owns it — seedBrandingDefaults).
insert into public.installation_branding (company_id)
select c.id from public.company c order by c.created_at, c.code limit 1;
