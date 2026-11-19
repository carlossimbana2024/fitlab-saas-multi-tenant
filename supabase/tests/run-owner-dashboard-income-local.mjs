// Runs real concurrent PostgreSQL sessions in a new, throwaway loopback cluster.
// Usage: node supabase/tests/run-owner-dashboard-income-local.mjs <postgres-bin-dir> <pg-module>
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

assert.equal(process.argv.length, 4, 'Specify a local PostgreSQL bin directory and pg module entrypoint');
const bin = resolve(process.argv[2]);
const { default: { Client } } = await import(pathToFileURL(resolve(process.argv[3])).href);
const exe = name => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PG/i.test(name)));
const local = await mkdtemp(join(tmpdir(), 'fitlab-owner003-db-'));
const data = join(local, 'data');
const probe = createServer();
await new Promise((ok, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', ok); });
const port = String(probe.address().port);
await new Promise((ok, fail) => probe.close(error => error ? fail(error) : ok()));
const options = { env: environment, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 };
const exec = (program, args) => promisify(execFile)(exe(program), args, options);
const connect = async (database = 'postgres') => {
  const client = new Client({
    host: '127.0.0.1', port: Number(port), user: 'fitlab_test', database,
    ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 15000,
  });
  await client.connect();
  return client;
};
let admin;
const sql = command => admin.query(command);
const file = async (path, client = admin) => client.query(await readFile(path, 'utf8'));
const value = async (client, query) => Object.values((await client.query(query)).rows[0])[0];
const root = 'supabase/';
const suffix = '0059_owner_dashboard_income_snapshot.sql';
const gym = "md5('owner003-concurrency')::uuid";
const instant = "timestamptz '2027-01-15 12:00Z'";
const later = "timestamptz '2027-01-16 12:00Z'";
const special = "md5('owner003-special')::uuid";
const gate = 59003;
const income = "public.get_owner_dashboard_income_backend";
const amount = result => result.currencies[0].amount;
let startAttempted = false;

async function checkPrivileges(client) {
  const { rows: [verify] } = await file(root + 'tests/0059_owner_dashboard_income_snapshot_verify.sql', client);
  assert.deepEqual(Object.values(verify), [true, true, true, true, true, true, false, false, true, true]);
}

async function checkRepositorySchema() {
  await sql('create database fitlab_owner003_schema');
  const full = await connect('fitlab_owner003_schema');
  try {
    await full.query(`
      create schema auth; create schema storage; create schema extensions;
      create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
      alter default privileges in schema public grant select on tables to service_role;
    `);
    for (const migration of (await readdir(root + 'migrations')).filter(name => name.endsWith('.sql')).sort()) {
      if (migration.startsWith('0052_')) continue; // No pg_cron in this local server.
      try { await file(root + 'migrations/' + migration, full); }
      catch (error) { throw Error(`Local schema migration failed: ${migration}: ${error.message}`, { cause: error }); }
    }
    await checkPrivileges(full);
    await full.query('set role service_role');
    assert.equal(await value(full, `select ${income}(${gym})`), null);
    console.log('0059 OK: applied and invoked on the repository schema (local auth/storage stubs; no pg_cron).');
  } finally {
    await full.end();
  }
}

// A reader starts one statement and acquires its MVCC snapshot before waiting on
// the writer's test gate. Then the writer commits and the reader proceeds.
async function crossSnapshot(write, before, after, legacy) {
  const page = offset => value(admin, `select coalesce(sum(amount),0) from (
    select amount from public.member_payments where gym_id=${gym} and status='confirmed'
    order by paid_at desc,id desc limit 1000 offset ${offset}) p`);
  const firstPage = Number(await page(0));
  const writer = await connect();
  let readerClient;
  let readerOutcome;
  try {
    await writer.query('begin');
    await writer.query('select pg_advisory_xact_lock($1)', [gate]);
    readerClient = await connect();
    await readerClient.query('set role service_role');
    const reader = value(readerClient, `with gate as materialized (select pg_advisory_xact_lock(${gate}), ${gym} as gym_id)
      select ${income}(gate.gym_id, ${instant}) from gate`);
    // Observe the actual wait; do not rely on a fixed sleep to order sessions.
    readerOutcome = reader.then(value => ({ value }), error => ({ error }));
    const expires = Date.now() + 10000;
    let waiting = false;
    while (Date.now() < expires && !waiting) {
      waiting = await value(admin, `select exists (select from pg_locks where locktype='advisory'
        and classid=0 and objid=${gate} and not granted)`);
      if (!waiting) await delay(40);
    }
    assert.ok(waiting, 'reader did not start and block on the gate');
    await writer.query(write);
    await writer.query('commit');
    const outcome = await readerOutcome;
    if ('error' in outcome) throw outcome.error;
    assert.equal(amount(outcome.value), before);
    assert.equal(amount(await value(readerClient, `select ${income}(${gym}, ${instant})`)), after);
    assert.equal(firstPage + Number(await page(1000)), legacy);
    assert.notEqual(legacy, before);
    assert.notEqual(legacy, after);
    console.log(`MVCC: concurrent reader=${before}; next reader=${after}; old pages=${legacy}`);
  } finally {
    await writer.end();
    await readerOutcome;
    if (readerClient) await readerClient.end();
  }
}

try {
  await exec('initdb', ['-D', data, '-U', 'fitlab_test', '--auth=trust', '--encoding=UTF8', '--locale=C']);
  startAttempted = true;
  await exec('pg_ctl', ['-D', data, '-l', join(local, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
  admin = await connect();
  // The aggregate fixture schema matches the fields this RPC reads. It permits
  // legacy mixed currencies/refs independently of current write workflows.
  await sql(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create type payment_status as enum ('pending','confirmed','voided','refunded','failed');
    create table public.gyms(id uuid primary key, timezone text not null, currency text not null);
    create table public.member_payments(
      id uuid primary key default gen_random_uuid(), gym_id uuid not null references public.gyms,
      location_id uuid not null, paid_at timestamptz not null, status payment_status not null,
      currency text not null, amount numeric(12,2) not null check (amount > 0),
      membership_id uuid, sale_id uuid, class_booking_id uuid);
    create index member_payments_gym_paid_idx on public.member_payments(gym_id, paid_at desc);
    alter table public.member_payments enable row level security;
    grant usage on schema public to service_role;
    grant select on public.gyms, public.member_payments to service_role;
  `);
  await file(root + 'migrations/' + suffix);
  await checkPrivileges(admin);
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(sql(`set role ${role}; select ${income}(${gym})`), /permission denied for function/);
  }
  await sql("set fitlab.owner003_local = 'on'");
  const results = await file(root + 'tests/' + suffix);
  console.log(results.at(-1).rows[0].result);
  await sql(`insert into public.gyms values (${gym},'America/Guayaquil','USD');
    insert into public.member_payments(gym_id,location_id,paid_at,status,currency,amount)
    select ${gym}, ${gym}, ${instant}, 'confirmed','USD',1 from generate_series(1,1000)`);
  const insert = `insert into public.member_payments(id,gym_id,location_id,paid_at,status,currency,amount)
    values (${special},${gym},${gym},${later},'confirmed','USD',15)`;
  await crossSnapshot(insert, 1000, 1015, 1001);
  for (const status of ['voided', 'refunded']) {
    await crossSnapshot(`update public.member_payments set status='${status}' where id=${special}`, 1015, 1000, 1014);
    if (status === 'voided') await sql(`update public.member_payments set status='confirmed' where id=${special}`);
  }
  console.log('0059 OK: insertion, void and refund with concurrent PostgreSQL sessions.');
  await checkRepositorySchema();
} finally {
  if (admin) await admin.end();
  if (startAttempted) {
    await exec('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  }
  console.log('Stopped local test cluster. Temporary files:', local);
}
