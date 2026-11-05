// LOCAL ONLY: ephemeral PostgreSQL, no connection URL or remote credentials.
// node backend/tests/helpers/portal-timezone-sql-check.mjs <PGlite package directory>
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const packagePath = process.argv[2];
if (!packagePath) throw new Error('Pass an installed PGlite directory.');
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
  // 0052 is intentionally omitted: pg_cron is not available in this embedded DB.
  for (const file of (await readdir(resolve(root, 'supabase/migrations'))).filter(f => f.endsWith('.sql') && f < '0057' && !f.startsWith('0052')).sort()) {
    await db.exec(await readFile(resolve(root, 'supabase/migrations', file), 'utf8'));
  }
  for (const result of await db.exec(await readFile(resolve(root, 'supabase/tests/0053_class_schedule_opening_hours.sql'), 'utf8'))) {
    if (result.rows?.length) console.log(result.rows);
  }
  const policy = await db.query('select offers_enabled from private.class_waitlist_policy where singleton');
  for (const result of await db.exec(await readFile(resolve(root, 'supabase/tests/0056_branch_open_status.sql'), 'utf8'))) {
    if (result.rows?.length) console.log(result.rows);
  }
  if (policy.rows[0]?.offers_enabled !== false) throw new Error('Offers must remain disabled.');
  for (const result of await db.exec(await readFile(resolve(root, 'supabase/tests/0056_branch_open_status_ecuador_local.sql'), 'utf8'))) {
    if (result.rows?.length) console.log(result.rows);
  }
  console.log('FIT-MEMBER-013: 0053 regression OK; local offers disabled. No remote access.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await db.close(); }
