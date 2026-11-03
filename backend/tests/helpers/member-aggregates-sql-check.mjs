// LOCAL ONLY: creates an ephemeral PostgreSQL database; never accepts a connection URL.
// node backend/tests/helpers/member-aggregates-sql-check.mjs <installed @electric-sql/pglite directory>
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const packagePath = process.argv[2];
if (!packagePath) throw new Error('Pass an external PGlite package directory.');
const { PGlite } = await import(pathToFileURL(resolve(packagePath, 'dist/index.js')).href);
const { pgcrypto } = await import(pathToFileURL(resolve(packagePath, 'dist/contrib/pgcrypto.js')).href);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const db = new PGlite({ extensions: { pgcrypto } });
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create table storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
    grant usage on schema public,auth to anon,authenticated,service_role;`);
  for (const file of (await readdir(resolve(root,'supabase/migrations'))).filter(f=>f.endsWith('.sql')&&f<'0055'&&!f.startsWith('0052')).sort()) {
    try { await db.exec(await readFile(resolve(root,'supabase/migrations',file),'utf8')); }
    catch(e) { throw new Error(`Migration ${file}: ${e.message}`); }
  }
  await db.exec(await readFile(resolve(root,'supabase/migrations/0054_member_aggregates_pagination.sql'),'utf8'));
  console.log('0054 applied twice. 0052 skipped: pg_cron unavailable in PGlite.');
  await db.exec("set fitlab.isolated_aggregate_test='true';");
  for (const file of ['0048_member_privacy_partial_updates.sql','0054_member_aggregates_pagination.sql']) {
    const start=performance.now();
    const results=await db.exec(await readFile(resolve(root,'supabase/tests',file),'utf8'));
    for(const result of results) if(result.rows?.length) console.log(result.rows);
    console.log(file,Math.round(performance.now()-start)+'ms');
  }
  const verify=(await readFile(resolve(root,'supabase/tests/0054_member_aggregates_verify.sql'),'utf8')).split('-- Run this last query')[0];
  for(const result of await db.exec(verify+'rollback;')) if(result.rows?.length) console.log(result.rows);
} catch(e) { console.error(e.message); process.exitCode=1; }
finally { await db.close(); }
