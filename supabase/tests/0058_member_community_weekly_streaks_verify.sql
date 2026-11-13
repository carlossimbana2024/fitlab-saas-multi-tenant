-- PRODUCTION SAFE: read-only transaction, no fixtures, writes, or migration DDL.
-- Run in the SQL Editor as the project SQL administrator. The result exposes
-- signatures, checks and counts only; no member/gym IDs or personal metrics.
begin transaction read only;
set local statement_timeout = '15s';

with expected_functions(signature, body_md5) as (
  values
    ('public.get_member_personal_streaks_backend(uuid,uuid)', 'fac498c6cfc17bfd14177c9fafc58629'),
    ('public.list_member_community_weekly_page_backend(uuid,uuid,text,integer,jsonb)', 'ca792ef13c32a634ace06d6b4c7025b1'),
    ('public.get_member_community_rankings_backend(uuid,uuid,date)', '4354288d587c48528ce6c691c5785ab5')
), catalog_checks as materialized (
  -- Compare normalized bodies against 0057, 0058 and the unmodified 0054
  -- monthly ranking (civil-date islands, Top 3, unchanged tie-break).
  select e.signature, p.oid is not null as exists_in_db,
    md5(btrim(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g'))) = e.body_md5 as body_matches,
    p.prosecdef and p.provolatile = 's' and exists (
      select 1 from unnest(p.proconfig) as setting(value)
      where regexp_replace(value, '[[:space:]]+', '', 'g') = 'search_path=pg_catalog,public'
    ) as secure_definition,
    has_function_privilege('anon', p.oid, 'execute') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
    has_function_privilege('service_role', p.oid, 'execute') as service_role_execute
  from expected_functions e
  left join pg_proc p on p.oid = to_regprocedure(e.signature)
), eligible_viewers as materialized (
  select u.gym_id, u.id,
    coalesce(f.show_in_community and f.show_streak, false) as shares_streak
  from public.gym_users u join public.profiles p on p.id = u.profile_id
  left join public.member_fitness_profiles f on f.gym_id = u.gym_id and f.member_user_id = u.id
  where u.role = 'member' and u.status = 'active' and u.account_mode = 'portal'
), sample_viewer as materialized (
  -- Prefer a gym with a usable sample and a viewer other than its sharer.
  select gym_id, id from (
    select gym_id, id, count(*) filter (where shares_streak) over (partition by gym_id)
      - shares_streak::integer as sharing_peers
    from eligible_viewers
  ) candidates order by sharing_peers desc, gym_id, id limit 1
), canonical as materialized (
  select u.id, p.full_name as name,
    case when f.show_streak then public.get_member_personal_streaks_backend(v.gym_id, u.id) end as streak
  from sample_viewer v
  join public.gym_users u on u.gym_id = v.gym_id and u.id <> v.id
  join public.profiles p on p.id = u.profile_id
  join public.member_fitness_profiles f on f.gym_id = u.gym_id and f.member_user_id = u.id
  where u.role = 'member' and u.status = 'active' and u.account_mode = 'portal' and f.show_in_community
), first_pages as materialized (
  select v.gym_id, v.id, filters.name as filter_name,
    public.list_member_community_weekly_page_backend(v.gym_id, v.id, filters.name, 3, null) as page
  from sample_viewer v cross join (values ('longest_streak'), ('all')) filters(name)
), pages as materialized (
  select filter_name, 1 as page_number, page from first_pages
  union all
  select filter_name, 2, public.list_member_community_weekly_page_backend(gym_id, id, filter_name, 3, page->'nextCursor')
  from first_pages
  where filter_name = 'longest_streak' and page->>'hasMore' = 'true'
), rows_seen as materialized (
  select pages.filter_name, pages.page_number, i.n, i.item, (i.item->>'id')::uuid as id
  from pages cross join lateral jsonb_array_elements(page->'items') with ordinality as i(item, n)
), expected_weekly as (
  select id, name, coalesce((streak->>'weeklyBestStreak')::integer, -1) as score
  from canonical order by score desc, name collate "C", id limit 6
), expected_all as (
  select id, name from canonical order by name collate "C", id limit 3
), waitlist as (
  select offers_enabled, offer_window::text as offer_window,
    offer_window = interval '30 minutes' as offer_window_matches_baseline
  from private.class_waitlist_policy where singleton
), waitlist_cron as (
  select count(*) as jobs_found, count(*) filter (where active) as active_jobs,
    count(*) = 1 and bool_and(not active) as cron_inactive
  from cron.job where jobname = 'fitlab-class-waitlist-offers'
)
select
  (select jsonb_agg(to_jsonb(c) order by signature) from catalog_checks c) as rpc_checks,
  (select count(*) from sample_viewer) as viewers_sampled,
  (select count(*) from canonical) as eligible_peers,
  (select count(*) from rows_seen where item->'weeklyStreak' <> 'null'::jsonb) as shared_weekly_rows_checked,
  (select count(*) from pages where filter_name = 'longest_streak') as weekly_pages_checked,
  case when exists (select 1 from canonical) then
    array(select id from rows_seen where filter_name = 'longest_streak' order by page_number, n) =
    array(select id from expected_weekly order by score desc, name collate "C", id)
  end as weekly_order_and_cursor_ok,
  case when exists (select 1 from canonical) then
    array(select id from rows_seen where filter_name = 'all' order by n) =
    array(select id from expected_all order by name collate "C", id)
  end as all_filter_order_ok,
  (select count(*) - count(distinct id) from rows_seen where filter_name = 'longest_streak') as weekly_duplicate_rows,
  (select count(*) from rows_seen r left join canonical c using (id)
    where c.id is null
       or r.item ?| array['currentStreak','longestStreak','dailyStreak','dailyCurrentStreak','dailyBestStreak']
       or r.item->'weeklyStreak' is distinct from
         case when c.streak is null then 'null'::jsonb
           else jsonb_build_object('current', c.streak->'weeklyCurrentStreak',
             'best', c.streak->'weeklyBestStreak', 'status', c.streak->'weeklyStatus') end
  ) as privacy_or_canonical_mismatches,
  (select to_jsonb(w) from waitlist w) as waitlist_policy,
  (select to_jsonb(j) from waitlist_cron j) as waitlist_cron;

rollback;
