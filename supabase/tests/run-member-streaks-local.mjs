// Local, in-memory PostgreSQL only. No URLs, credentials, or network clients.
// Usage: node supabase/tests/run-member-streaks-local.mjs <absolute pglite module>
// Contract harness, NOT a replacement for a full-schema migration regression.
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const communityOnly=process.argv.includes('--community-only');
const fullSchema=communityOnly||process.argv.includes('--full-schema');
const { pgcrypto }=await import(new URL('./contrib/pgcrypto.js',pathToFileURL(resolve(process.argv[2]))).href);
const db = new PGlite({extensions:{pgcrypto}});
try {
  if (fullSchema) {
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create schema auth;create schema storage;create schema extensions;
      create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    `);
    for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()) {
      if(file.startsWith('0052_')) {console.log('0052 pg_cron omitted in local WASM; no scheduler modified/tested');continue;}
      console.log('Local migration',file);
      await db.exec(await readFile(`supabase/migrations/${file}`,'utf8'));
    }
  } else {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema private;
    create table gyms(id uuid primary key,timezone text);
    create table gym_users(id uuid primary key,gym_id uuid,role text,status text,account_mode text);
    create table memberships(id uuid primary key,gym_id uuid,member_user_id uuid,status text,
      attendance_mode_snapshot text,weekly_target_snapshot integer,cancelled_at timestamptz);
    create table membership_periods(id uuid primary key,gym_id uuid,membership_id uuid,
      starts_on date,ends_on date,status text,payment_id uuid);
    create table member_payments(id uuid primary key,gym_id uuid,status text);
    create table audit_logs(gym_id uuid,entity_id uuid,entity_type text,action text,before_data jsonb,after_data jsonb);
    create table weekly_attendance_progress(gym_id uuid,membership_id uuid,target_attendances integer);
    create table attendances(gym_id uuid,member_user_id uuid,membership_id uuid,
      attendance_date date,status text,counts_toward_streak boolean);
  `);
  const base = await readFile('supabase/migrations/0054_member_aggregates_pagination.sql','utf8');
  await db.exec(base.slice(base.indexOf('create or replace function private.require_member_aggregate_reader'),base.indexOf('create or replace function public.get_member_attendance_summary_backend')));
  await db.exec(await readFile('supabase/migrations/0057_member_personal_streaks.sql','utf8'));
  }
  await db.exec("set fitlab.isolated_aggregate_test='true'");
  if(fullSchema&&!communityOnly) {
    await db.exec('begin read only');
    await db.exec(await readFile('supabase/tests/0057_member_streaks_preflight.sql','utf8'));
    await db.exec('rollback');
    console.log('0057 preflight accepted in READ ONLY transaction');
  }
  for (const file of communityOnly?['0058_member_community_weekly_streaks.sql']:fullSchema?['0057_member_personal_streaks.sql','0057_member_streak_full_schema.sql','0054_member_aggregates_pagination.sql','0056_branch_open_status.sql','0056_branch_open_status_ecuador_local.sql']:['0057_member_personal_streaks.sql','0057_member_streak_evidence.sql']) {
    const results = await db.exec(await readFile(`supabase/tests/${file}`,'utf8'));
    for (const result of results) if (result.rows.length) console.log(JSON.stringify(result.rows));
  }
} catch (error) {
  console.error(error.message, error.code, error.position, error.where);
  process.exitCode=1;
} finally { await db.close(); }
