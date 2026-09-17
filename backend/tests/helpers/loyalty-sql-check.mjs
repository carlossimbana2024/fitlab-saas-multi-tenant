// Isolated PostgreSQL smoke test. No network/database credentials and no production writes.
// node backend/tests/helpers/loyalty-sql-check.mjs <path-to-installed-pglite-package>
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
  for (const file of (await readdir(resolve(root, 'supabase/migrations'))).filter((f) => f.endsWith('.sql')).sort()) {
    try { await db.exec(await readFile(resolve(root, 'supabase/migrations', file), 'utf8')); }
    catch (error) { console.error('Migration failed:', file, error.message, error.where ?? '', error.position ?? ''); throw error; }
  }
  console.log('All migrations applied to isolated PostgreSQL.');
  // The pre-existing renewal regression expects an owner and a membership.
  await db.exec(`do $$ declare g uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); o uuid:=gen_random_uuid();
    a uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); begin
    insert into auth.users(id,email) values(a,a||'@isolated.invalid');
    insert into public.profiles(id,full_name) values(a,'Isolated test owner');
    insert into public.gyms(id,name,slug) values(g,'Isolated regression','isolated-'||g);
    insert into public.gym_locations(id,gym_id,name) values(l,g,'Principal');
    insert into public.gym_users(id,gym_id,profile_id,role,status,default_location_id) values(o,g,a,'owner','active',l);
    insert into public.gym_users(id,gym_id,role,status,account_mode,managed_full_name,joined_at) values(m,g,'member','active','managed','Regression member',now());
    insert into public.plans(id,gym_id,name,price,duration_unit,duration_value,attendance_mode) values(p,g,'Monthly',100,'months',1,'daily');
    perform public.register_manual_membership_checkout(g,l,m,p,o,'cash',null,null,null,false);
    end; $$;`);
  for (const file of ['0025_membership_renewal_receipts.sql', '0028_inventory_sales_backend.sql', '0032_static_attendance_qr.sql', '0039_loyalty_rewards.sql', '0041_loyalty_engagement.sql']) {
    console.log('Testing:', file);
    const result = await db.exec(await readFile(resolve(root, 'supabase/tests', file), 'utf8'));
    for (const statement of result) if (statement.rows?.length) console.log(statement.rows);
    console.log('OK:', file);
  }
} catch (error) {
  console.error(error.message, error.where ?? '', error.detail ?? '');
  process.exitCode = 1;
} finally { await db.close(); }
