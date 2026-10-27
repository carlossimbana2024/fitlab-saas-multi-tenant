// Isolated PostgreSQL smoke test. No network/database credentials and no production writes.
// node backend/tests/helpers/class-waitlist-sql-check.mjs <path-to-installed-pglite-package>
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


  for (const file of (await readdir(resolve(root,'supabase/migrations'))).filter(f=>f.endsWith('.sql')&&f<'0051').sort()) {
    try { await db.exec(await readFile(resolve(root,'supabase/migrations',file),'utf8')); }
    catch(error) { console.error('Migration:',file); throw error; }
  }
  const fixture = (await readFile(resolve(root,'supabase/tests/0050_class_booking_economic_versions.sql'),'utf8')).split('-- NEW TERMS TESTS')[0];
  await db.exec(fixture+'commit;');
  await db.exec(`
    create temporary table legacy_queue(data jsonb);
    do $$ declare f jsonb;g uuid;s uuid;a uuid;m uuid[];b public.class_bookings;w record;old_offer uuid;
    begin
      select data into f from terms_fixture;g:=(f->>'gym')::uuid;s:=(f->>'session')::uuid;a:=(f->>'activity')::uuid;
      select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
      update public.extra_classes set capacity=1,billing_mode='included',price=0 where id=a;
      b:=public.reserve_member_class_backend(g,s,m[1],m[1]);
      select * into w from public.join_class_waitlist_backend(g,s,m[2],m[2]);
      insert into public.class_waitlists(gym_id,class_schedule_id,member_user_id,status,offered_at)
        values(g,s,m[3],'offered',clock_timestamp()-interval '2 hours') returning id into old_offer;
      insert into legacy_queue values(jsonb_build_object('waiting',w.waitlist_id,'offered',old_offer,
        'offered_at',(select offered_at from public.class_waitlists where id=old_offer)));
    end;$$;
    create temporary table before_queue_migration as select 'booking' kind,to_jsonb(b) data from public.class_bookings b
      union all select 'payment',to_jsonb(p) from public.member_payments p
      union all select 'terms',to_jsonb(t) from public.class_booking_terms t;
  `);
  await db.exec(await readFile(resolve(root,'supabase/migrations/0051_class_waitlist_offers.sql'),'utf8'));
  await db.exec(`do $$ declare f jsonb;begin
    if exists(select kind,data from before_queue_migration except
      (select 'booking',to_jsonb(b) from public.class_bookings b union all select 'payment',to_jsonb(p) from public.member_payments p
       union all select 'terms',to_jsonb(t) from public.class_booking_terms t)) then raise exception 'MIGRATION_CHANGED_ECONOMIC_HISTORY';end if;
    select data into f from legacy_queue;
    if not exists(select 1 from public.class_waitlists where id=(f->>'waiting')::uuid and status='waiting')
      or not exists(select 1 from public.class_waitlists where id=(f->>'offered')::uuid and state='expired'
        and outcome='legacy_expired' and offered_at=(f->>'offered_at')::timestamptz) then raise exception 'LEGACY_QUEUE_HANDLING_WRONG';end if;
    if (select offers_enabled from private.class_waitlist_policy) then raise exception 'ROLLOUT_ENABLED_TOO_EARLY';end if;
    end;$$;
    create temporary table after_queue_migration as select to_jsonb(w) data from public.class_waitlists w;
  `);
  await db.exec(await readFile(resolve(root,'supabase/migrations/0051_class_waitlist_offers.sql'),'utf8'));
  await db.exec(`do $$begin if exists(select data from after_queue_migration except select to_jsonb(w) from public.class_waitlists w)
    then raise exception 'MIGRATION_NOT_IDEMPOTENT';end if;end;$$;`);
  console.log('0051: applied twice; legacy queue, economic history and disabled rollout preserved.');
  // Execute the real global worker only in this isolated database, never from
  // the production-safe SQL smoke test (which must not process other gyms).
  await db.exec(`begin;
    update private.class_waitlist_policy set offers_enabled=true,offer_window=interval '20 milliseconds';
    do $$ declare f jsonb;g uuid;s uuid;m uuid;b uuid;result jsonb;begin
      select data into f from terms_fixture;g:=(f->>'gym')::uuid;s:=(f->>'session')::uuid;
      m:=(f#>>'{members,0}')::uuid;select id into b from public.class_bookings where class_schedule_id=s and member_user_id=m;
      perform public.cancel_class_booking_backend(g,b,m,'Worker expiry test',false);
      perform pg_sleep(0.04);
      update private.class_waitlist_policy set offer_window=interval '30 minutes';
      result:=public.process_class_waitlists_backend(100);
      if (result->>'failures')::integer<>0 or (result->>'processed')::integer<1
        or not exists(select 1 from public.class_waitlist_offers where class_schedule_id=s and status='expired') then
        raise exception 'GLOBAL_WORKER_FAILED: %',result;end if;
    end;$$;rollback;`);
  console.log('Real batch worker: expiry processed without browser calls.');
  for (const file of ['0048_member_privacy_partial_updates.sql','0049_class_inactive_reference_guards.sql','0050_class_booking_economic_versions.sql','0051_class_waitlist_offers.sql']) {
    console.log('Testing:',file);
    const sql=(await readFile(resolve(root,'supabase/tests',file),'utf8'))
      .replace('begin;','begin; update private.class_waitlist_policy set offers_enabled=true where singleton;');
    for (const statement of await db.exec(sql)) {
      if(statement.rows?.length) console.log(statement.rows);
    }
  }
  // Fault injection is LOCAL ONLY. Never add global enabled-worker tests to
  // the production-safe SQL smoke test.
  await db.exec((await readFile(resolve(root,'supabase/tests/0051_class_waitlist_offers.sql'),'utf8')).split('-- A: FIFO')[0]);
  await db.exec(`
    create temporary table failed_queue(session_id uuid);
    create function pg_temp.fail_offer_insert() returns trigger language plpgsql as $$begin
      if exists(select 1 from failed_queue where session_id=new.class_schedule_id) then
        raise exception 'PRIVATE_FIXTURE_MESSAGE_MUST_NOT_BE_LOGGED' using errcode='23514';end if;
      return new;end;$$;
    create trigger test_waitlist_fault after insert on public.class_waitlist_offers
      for each row execute function pg_temp.fail_offer_insert();
    do $$declare f jsonb;g uuid;s uuid;m uuid[];b public.class_bookings;i integer;bad uuid;good uuid;result jsonb;begin
      update private.class_waitlist_policy set offers_enabled=false;
      for i in 1..2 loop
        f:=pg_temp.waitlist_fixture();g:=(f->>'gym')::uuid;s:=(f->>'session')::uuid;
        select array_agg(value::uuid) into m from jsonb_array_elements_text(f->'members');
        b:=public.reserve_member_class_backend(g,s,m[1],m[1]);
        perform public.join_class_waitlist_backend(g,s,m[2],m[2]);
        perform public.cancel_class_booking_backend(g,b.id,m[1],'Fault fixture',false);
        if i=1 then bad:=s;insert into failed_queue values(s);else good:=s;end if;
      end loop;
      update private.class_waitlist_policy set offers_enabled=true;
      result:=public.process_class_waitlists_backend(500);
      if result->>'failures'<>'1'
        or exists(select 1 from public.class_waitlist_offers where class_schedule_id=bad)
        or not exists(select 1 from public.class_waitlists where class_schedule_id=bad and status='waiting')
        or not exists(select 1 from private.class_waitlist_runs where class_schedule_id=bad and last_error='23514')
        or not exists(select 1 from public.class_waitlist_offers where class_schedule_id=good and status='offered') then
        raise exception 'WORKER_PARTIAL_FAILURE_NOT_ISOLATED: %',result;end if;
      delete from failed_queue;
      result:=public.process_class_waitlists_backend(500);
      if result->>'failures'<>'0' or not exists(select 1 from public.class_waitlist_offers where class_schedule_id=bad and status='offered')
        or exists(select 1 from private.class_waitlist_runs where class_schedule_id=bad and last_error is not null) then
        raise exception 'WORKER_RECOVERY_FAILED';end if;
      begin
        update public.class_waitlist_offers set status='accepting' where class_schedule_id=good and status='offered';
        set constraints all immediate;
        raise exception 'ACCEPTING_WAS_ALLOWED_TO_COMMIT';
      exception when others then
        if sqlerrm<>'CLASS_WAITLIST_ACCEPTANCE_INCOMPLETE' then raise;end if;
      end;
      if exists(select 1 from public.class_waitlist_offers where status='accepting') then raise exception 'LEAKED_ACCEPTING';end if;
    end;$$;
    rollback;
  `);
  console.log('Fault injection: atomic rollback, other queue progresses, sanitized error, recovery, no accepting leakage.');
  // PGlite cannot run pg_cron. Validate registration/idempotence with a local
  // stub only; real scheduling must be checked in Supabase after applying 0052.
  await db.exec(`create schema cron;
    create table cron.job(jobid bigint generated always as identity,jobname text unique,schedule text,command text,active boolean default true,username text default current_user);
    create table cron.job_run_details(jobid bigint,status text,start_time timestamptz,end_time timestamptz,return_message text);
    create function cron.schedule(text,text,text) returns bigint language sql as $$
      insert into cron.job(jobname,schedule,command) values($1,$2,$3)
      on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command,active=true returning jobid;$$;
    create function cron.alter_job(job_id bigint, active boolean) returns void language sql as $$
      update cron.job set active=$2 where jobid=$1;$$;
    select cron.schedule('unrelated-fitlab-job','0 1 * * *','select 1');`);
  const cronSql=(await readFile(resolve(root,'supabase/migrations/0052_class_waitlist_cron.sql'),'utf8'))
    .replace('create extension if not exists pg_cron with schema pg_catalog;','');
  await db.exec(cronSql); await db.exec(cronSql);
  await db.exec(`do $$begin if (select count(*) from cron.job where jobname='fitlab-class-waitlist-offers' and schedule='* * * * *' and not active)<>1
    or not exists(select 1 from cron.job where jobname='unrelated-fitlab-job' and active and command='select 1' and schedule='0 1 * * *')
    then raise exception 'CRON_REGISTRATION_INVALID';end if;end;$$;`);
  console.log('0052: inactive, idempotent, unrelated job untouched (stub); actual pg_cron requires Supabase.');
  await db.exec(await readFile(resolve(root,'supabase/tests/0051_class_waitlist_offers_verify.sql'),'utf8'));
} catch(error) {
  console.error(error.message,error.where??'',error.detail??'');
  process.exitCode=1;
} finally { await db.close(); }
