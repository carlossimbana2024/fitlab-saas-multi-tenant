// LOCAL ONLY: creates an ephemeral PostgreSQL database; never accepts a connection URL.
// node backend/tests/helpers/member-weight-goal-sql-check.mjs <installed @electric-sql/pglite directory>
import { readFile, readdir } from 'node:fs/promises';
import { deepStrictEqual } from 'node:assert';
import ts from 'typescript';
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
  const migration = await readFile(resolve(root,'supabase/migrations/0055_member_weight_goal_metric.sql'),'utf8');
  const snapshots = async () => JSON.stringify((await db.query("select oid,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in ('get_member_community_rankings_backend','get_member_attendance_summary_backend') order by oid")).rows);
  const unchanged = await snapshots();
  await db.exec(migration);
  await db.exec(migration);
  if (await snapshots() !== unchanged) throw new Error('Ranking/attendance RPC unexpectedly rewritten.');
  console.log('0055 applied twice; existing ranking/attendance RPC unchanged.');
  // Execute the real backend function against the real SQL helper, not a copied formula.
  const source = await readFile(resolve(root,'backend/src/services/memberWeightGoal.service.ts'),'utf8');
  const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const { weightGoalMetric } = await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
  let parityCases=0;
  for(const goal of ['lose_weight','gain_weight','build_muscle','maintain_weight','general_wellness']) {
    const points=[[80,90,85],[70,60,65],[85,85,85],[85,85,95],[85,85,86.2],[85,85,84.2],
      [80,null,85],[80,90,null],[null,90,85],[80,90,NaN],[80,90,Infinity],[85,85,-1]];
    for(let i=0;i<60;i++)points.push([20+(i*791%48000)/100,20+(i*1237%48000)/100,20+(i*2777%48000)/100].map(n=>Number(n.toFixed(2))));
    for(const [target,baseline,current] of points) {
      const values=[goal,target,baseline,current].map(v=>typeof v==='number'&&!Number.isFinite(v)?String(v):v);
      const {rows}=await db.query('select private.member_weight_goal_metric($1::text,$2::numeric,$3::numeric,$4::numeric) metric',values);
      deepStrictEqual(weightGoalMetric(goal,target,baseline,current),rows[0].metric);
      parityCases++;
    }
  }
  console.log(parityCases+' backend/SQL canonical parity cases passed.');
  for (const result of await db.exec(await readFile(resolve(root,'supabase/tests/0055_member_weight_goal_metric.sql'),'utf8')))
    if(result.rows?.length) console.log(result.rows);
  const verify=(await readFile(resolve(root,'supabase/tests/0055_member_weight_goal_verify.sql'),'utf8')).split('-- Run this last query')[0];
  for(const result of await db.exec(verify+'rollback;')) if(result.rows?.length) console.log(result.rows);
} catch(e) { console.error(e.message); process.exitCode=1; }
finally { await db.close(); }


