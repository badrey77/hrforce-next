-- 0004: btree_gist, needed for the org_unit_version exclusion constraint (org_unit_id WITH =, valid WITH &&).
-- btree_gist is a TRUSTED extension (PG13+): the migrator, as database owner (CREATE on the database), can
-- install it without superuser. Available on PG16 and PG18 alike.
create extension if not exists btree_gist with schema public;
