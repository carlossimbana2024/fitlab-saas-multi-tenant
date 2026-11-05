-- LOCAL ONLY. Mutating fixtures; never run in production, even with ROLLBACK.
begin;
create function pg_temp.assert_ecuador(g uuid,m uuid,l uuid,wall timestamp,expected boolean,next_wall timestamp default null,next_state text default null)
returns void language plpgsql as $$
declare t timestamptz:=wall at time zone 'America/Guayaquil'; old_state boolean; result jsonb;
begin
 old_state:=private.class_interval_within_opening_hours(g,l,t,t+interval '1 microsecond');
 result:=public.get_member_branch_open_status_backend(g,m,l,t);
 if old_state is distinct from expected or (result->>'isOpenNow')::boolean is distinct from old_state then
   raise exception 'ECUADOR_STATE_MISMATCH wall=%, expected=%, 0053=%, 0056=%',wall,expected,old_state,result;
 end if;
 if next_wall is not null and ((result->>'nextTransitionAt')::timestamptz is distinct from (next_wall at time zone 'America/Guayaquil')
   or result->>'nextState' is distinct from next_state) then raise exception 'ECUADOR_TRANSITION_MISMATCH wall=%, response=%',wall,result; end if;
end;$$;
do $$
declare g uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); r record;
begin
 insert into public.gyms(id,name,slug) values(g,'Ecuador test','ecuador-'||g);
 insert into public.gym_locations(id,gym_id,name,timezone) values(l,g,'Ecuador','America/Guayaquil');
 insert into auth.users(id,email) values(p,p||'@ecuador.invalid');
 insert into public.profiles(id,full_name) values(p,'Ecuador member');
 insert into public.gym_users(id,gym_id,profile_id,role,status,account_mode) values(m,g,p,'member','active','portal');
 insert into public.location_opening_hours(gym_id,location_id,weekday,day_mode,opens_at,closes_at)
 select g,l,n,'required','08:00','22:00' from generate_series(1,7) n;
 for r in select * from (values ('07:59',false),('08:00',true),('21:59',true),('22:00',false)) v(h,s) loop
   perform pg_temp.assert_ecuador(g,m,l,('2026-11-06 '||r.h)::timestamp,r.s);
 end loop;
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-06 07:00',false,'2026-11-06 08:00','open');
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-06 15:00',true,'2026-11-06 22:00','closed');
 update public.location_opening_hours set day_mode='closed',opens_at=null,closes_at=null where location_id=l;
 update public.location_opening_hours set day_mode='required',opens_at='20:00',closes_at='02:00' where location_id=l and weekday=5;
 for r in select * from (values ('2026-11-06 19:59',false),('2026-11-06 20:00',true),('2026-11-06 23:59',true),
   ('2026-11-07 00:00',true),('2026-11-07 01:59',true),('2026-11-07 02:00',false),('2026-11-07 01:00',true)) v(h,s) loop
   perform pg_temp.assert_ecuador(g,m,l,r.h::timestamp,r.s);
 end loop;
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-06 23:00',true,'2026-11-07 02:00','closed');
 insert into public.location_calendar_exceptions(gym_id,location_id,calendar_date,day_mode,created_by)
 values(g,l,'2026-11-07','closed',m);
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-07 01:00',false);
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-06 23:00',true,'2026-11-07 00:00','closed');
 update public.location_calendar_exceptions set day_mode='bonus',opens_at='10:00',closes_at='12:00' where location_id=l;
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-07 01:00',false,'2026-11-07 10:00','open');
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-07 10:00',true,'2026-11-07 12:00','closed');
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-07 12:00',false);
 delete from public.location_calendar_exceptions where location_id=l;
 update public.location_opening_hours set closes_at='20:00' where location_id=l and weekday=5;
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-06 19:59',false,'2026-11-06 20:00','open');
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-06 20:00',true,'2026-11-07 20:00','closed');
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-07 19:59',true,'2026-11-07 20:00','closed');
 perform pg_temp.assert_ecuador(g,m,l,'2026-11-07 20:00',false);
end;$$;
select 'ECUADOR OK: 23 direct 0053/0056 state comparisons; 9 exact transitions; no differences' result;
rollback;
