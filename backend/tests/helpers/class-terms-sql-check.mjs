// Isolated PostgreSQL smoke test. No network/database credentials and no production writes.
// node backend/tests/helpers/class-terms-sql-check.mjs <path-to-installed-pglite-package>
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const packagePath = process.argv[2];
if (!packagePath) throw new Error('Pass an external installation of @electric-sql/pglite.');
const { PGlite } = await import(pathToFileURL(resolve(packagePath, 'dist/index.js')).href);
const { pgcrypto } = await import(pathToFileURL(resolve(packagePath, 'dist/contrib/pgcrypto.js')).href);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const db = new PGlite({ extensions: { pgcrypto } });
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
    create table storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
    grant usage on schema public,auth to anon,authenticated,service_role;
  `);

  const migrationPath = resolve(root, 'supabase/migrations/0050_class_booking_economic_versions.sql');
  const testSql = await readFile(resolve(root, 'supabase/tests/0050_class_booking_economic_versions.sql'), 'utf8');
  for (const file of (await readdir(resolve(root, 'supabase/migrations'))).filter(f=>f.endsWith('.sql') && f<'0050').sort()) {
    await db.exec(await readFile(resolve(root,'supabase/migrations',file),'utf8'));
  }
  // Build genuine pre-migration rows using the old RPCs. Never run this setup remotely.
  await db.exec(testSql.split('-- NEW TERMS TESTS')[0] + 'commit;');
  await db.exec(`
    create temporary table legacy_expected(booking_id uuid, state text, amount numeric, payment_id uuid);
    do $$
    declare f jsonb; g uuid; s uuid; a uuid; o uuid; m uuid[]; b public.class_bookings; p record;
    begin
      select data into f from terms_fixture;
      g:=(f->>'gym')::uuid; s:=(f->>'session')::uuid; a:=(f->>'activity')::uuid; o:=(f->>'owner')::uuid;
      select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
      b:=public.reserve_member_class_backend(g,s,m[1],m[1]);
      insert into legacy_expected values(b.id,'verified',5,null);
      b:=public.reserve_member_class_backend(g,s,m[2],m[2]);
      delete from public.audit_logs where entity_id=b.id;
      update public.extra_classes set price=8 where id=a;
      select * into p from public.reserve_paid_class_backend(g,s,m[2],o,'cash',null,null,false);
      insert into legacy_expected values(b.id,'unknown',null,p.payment_id);
      select * into p from public.reserve_paid_class_backend(g,s,m[1],o,'cash',null,null,false);
      update legacy_expected set payment_id=p.payment_id where state='verified';
      b:=public.reserve_member_class_backend(g,s,m[3],m[3]);
      delete from public.audit_logs where entity_id=b.id;
      insert into legacy_expected values(b.id,'unknown',null,null);
      update public.extra_classes set billing_mode='included',price=0 where id=a;
      b:=public.reserve_included_class_backend(g,s,m[4],o,false);
      insert into legacy_expected values(b.id,'partial',0,null);
      b:=public.reserve_member_class_backend(g,s,m[5],m[5]);
      insert into public.audit_logs(gym_id,entity_type,entity_id,action,after_data,created_at)
        select gym_id,entity_type,entity_id,action,after_data,created_at from public.audit_logs where entity_id=b.id;
      insert into legacy_expected values(b.id,'unknown',null,null);
      b:=public.reserve_member_class_backend(g,s,m[6],m[6]);
      delete from public.audit_logs where entity_id=b.id;
      insert into public.audit_logs(gym_id,entity_type,entity_id,action,after_data)
        values(g,'class_booking',b.id,'class.unpaid_booking_created',jsonb_build_object('schedule_id',s,'member_user_id',m[6],'billing_mode','additional_fee','amount','bad','currency','USD'));
      insert into legacy_expected values(b.id,'unknown',null,null);
      b:=public.reserve_member_class_backend(g,s,m[7],m[7]);
      delete from public.audit_logs where entity_id=b.id;
      perform public.cancel_class_booking_backend(g,b.id,m[7],'Legacy history',false);
      insert into legacy_expected values(b.id,'unknown',null,null);
      update public.extra_classes set billing_mode='additional_fee',price=99 where id=a;
    end; $$;
    create temporary table original_bookings as select to_jsonb(b) row from public.class_bookings b;
    create temporary table original_payments as select to_jsonb(p) row from public.member_payments p;
  `);
  const migration = await readFile(migrationPath,'utf8');
  await db.exec(migration);
  await db.exec(migration); // Repeat execution must not duplicate/reinterpret snapshots.
  await db.exec(`
    do $$ declare item record; b public.class_bookings; f jsonb; statement text;
    begin
      if (select count(*) from public.class_booking_terms)<>(select count(*) from legacy_expected) then raise exception 'BACKFILL_NOT_IDEMPOTENT'; end if;
      if exists(select 1 from legacy_expected e join public.class_booking_terms t on t.booking_id=e.booking_id
        where t.evidence_state is distinct from e.state or t.agreed_amount is distinct from e.amount
          or t.payment_evidence_id is distinct from e.payment_id or t.source='reservation') then raise exception 'LEGACY_CLASSIFICATION_WRONG'; end if;
      if exists(select row from original_bookings except select to_jsonb(cb) from public.class_bookings cb)
        or exists(select row from original_payments except select to_jsonb(p) from public.member_payments p) then raise exception 'OLD_RECORDS_CHANGED'; end if;
      if not exists(select 1 from legacy_expected e join public.member_payments p on p.id=e.payment_id where e.state='unknown' and p.amount=8 and p.currency='USD' and p.status='confirmed') then raise exception 'PAID_HISTORY_LOST'; end if;
      select data into f from terms_fixture;
      for item in select * from legacy_expected where state='unknown' and payment_id is null loop
        select * into b from public.class_bookings where id=item.booking_id;
        if b.status<>'reserved' then continue; end if;
        statement:=format('select public.reserve_paid_class_backend(%L,%L,%L,%L,''cash'',null,null,false)',b.gym_id,b.class_schedule_id,b.member_user_id,(f->>'owner')::uuid);
        perform pg_temp.expect_terms_error(statement,'CLASS_TERMS_RESOLUTION_REQUIRED');
        statement:=format('insert into public.member_payments(gym_id,location_id,member_user_id,class_booking_id,amount,currency,payment_method,status,registered_by) values(%L,%L,%L,%L,99,''EUR'',''cash'',''confirmed'',%L)',b.gym_id,(f->>'location')::uuid,b.member_user_id,b.id,(f->>'owner')::uuid);
        perform pg_temp.expect_terms_error(statement,'CLASS_TERMS_RESOLUTION_REQUIRED');
      end loop;
    end; $$;
  `);
  console.log('OK: legacy reconstruction, ambiguous/absent evidence, payment versus quote, pending-charge block, preservation and idempotence.');
  for (const file of ['0048_member_privacy_partial_updates.sql','0049_class_inactive_reference_guards.sql','0050_class_booking_economic_versions.sql','0050_class_booking_economic_versions_verify.sql']) {
    const path=resolve(root,'supabase/tests',file);
    try { for(const result of await db.exec(await readFile(path,'utf8'))) if(result.rows?.length) console.log(result.rows); }
    catch(error) { console.error('Failed:',file); throw error; }
  }
} catch(error) {
  console.error(error.message,error.where ?? '',error.detail ?? '');
  process.exitCode=1;
} finally { await db.close(); }

