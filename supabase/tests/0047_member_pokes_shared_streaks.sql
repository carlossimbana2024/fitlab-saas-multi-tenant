-- Ejecutar después de 0047. Pruebas aisladas; se revierte todo.
begin;
create function pg_temp.expect_training_failure(statement text,expected text) returns void language plpgsql as $$
begin begin execute statement;exception when others then if position(expected in sqlerrm)>0 then return;end if;raise;end;raise exception 'EXPECTED_FAILURE: %',expected;end;$$;
do $$
declare g uuid:=gen_random_uuid();other_g uuid:=gen_random_uuid();a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();c uuid:=gen_random_uuid();ap uuid:=gen_random_uuid();bp uuid:=gen_random_uuid();cp uuid:=gen_random_uuid();op uuid:=gen_random_uuid();owner_id uuid:=gen_random_uuid();l uuid:=gen_random_uuid();p uuid:=gen_random_uuid();ma uuid;mb uuid;week date;result jsonb;today date;fixture_day date;
begin
 if has_table_privilege('authenticated','public.member_pokes','SELECT') or has_table_privilege('anon','public.member_shared_streaks','UPDATE') or has_function_privilege('authenticated','public.member_training_social_backend(uuid,uuid,uuid,text)','EXECUTE') or has_function_privilege('anon','public.member_shared_streak_progress_backend(uuid,uuid)','EXECUTE') then raise exception 'UNSAFE_TRAINING_ACCESS';end if;
 insert into auth.users(id,email) values(ap,ap||'@training.invalid'),(bp,bp||'@training.invalid'),(cp,cp||'@training.invalid'),(op,op||'@training.invalid');
 insert into public.profiles(id,full_name) values(ap,'Atleta A'),(bp,'Atleta B'),(cp,'Atleta C'),(op,'Owner');
 insert into public.gyms(id,name,slug) values(g,'Training gym','training-'||g),(other_g,'Other gym','training-'||other_g);
 insert into public.gym_locations(id,gym_id,name) values(l,g,'Principal');
 insert into public.gym_users(id,gym_id,profile_id,role,status,default_location_id) values(a,g,ap,'member','active',l),(b,g,bp,'member','active',l),(c,other_g,cp,'member','active',null);
 insert into public.gym_users(id,gym_id,profile_id,role,status,default_location_id) values(owner_id,g,op,'owner','active',l);
 insert into public.location_opening_hours(gym_id,location_id,weekday,opens_at,closes_at,day_mode) select g,l,n::smallint,'00:00'::time,'00:00'::time,'required'::public.calendar_day_mode from generate_series(1,7)n;
 insert into public.member_fitness_profiles(gym_id,member_user_id,weight_kg,height_cm,goal_type,training_frequency_per_week,show_in_community) values(g,a,80,180,'improve_fitness',1,true),(g,b,70,170,'improve_fitness',1,true);
 insert into public.member_friendships(gym_id,member_a,member_b,requested_by,status) values(g,least(a,b),greatest(a,b),a,'accepted');
 perform pg_temp.expect_training_failure(format('select public.member_training_social_backend(%L,%L,%L,%L)',g,a,b,'poke'),'TRAINING_PRIVACY_REQUIRED');
 perform public.member_training_social_backend(g,a,null,'allow');perform public.member_training_social_backend(g,b,null,'allow');
 perform pg_temp.expect_training_failure(format('select public.member_training_social_backend(%L,%L,%L,%L)',g,a,c,'poke'),'TRAINING_PRIVACY_REQUIRED');
 perform pg_temp.expect_training_failure(format('select public.member_training_social_backend(%L,%L,%L,%L)',g,a,a,'poke'),'TRAINING_ACTION_INVALID');
 perform pg_temp.expect_training_failure(format('select public.member_training_social_backend(%L,%L,%L,%L)',g,a,b,'invite'),'SHARED_STREAK_POKE_REQUIRED');
 perform public.member_training_social_backend(g,a,b,'poke');
 perform pg_temp.expect_training_failure(format('select public.member_training_social_backend(%L,%L,%L,%L)',g,a,b,'poke'),'POKE_COOLDOWN');
 if (select count(*) from public.loyalty_notifications where gym_id=g and title='Te dieron un toque 👊')<>1 then raise exception 'DUPLICATE_POKE';end if;
 perform public.member_training_social_backend(g,a,b,'invite');
 perform pg_temp.expect_training_failure(format('select public.member_training_social_backend(%L,%L,%L,%L)',g,b,a,'invite'),'SHARED_STREAK_EXISTS');
 perform pg_temp.expect_training_failure(format('select public.member_training_social_backend(%L,%L,%L,%L)',g,a,b,'accept'),'SHARED_STREAK_STATE_INVALID');
 perform public.member_training_social_backend(g,b,a,'accept');
 today:=(now() at time zone 'America/Guayaquil')::date;week:=date_trunc('week',today::timestamp)::date;
 if (select starts_on from public.member_shared_streaks where gym_id=g)<>week+7 then raise exception 'RETROACTIVE_START';end if;
 result:=public.member_shared_streak_progress_backend(g,a);if (result->0->>'currentWeeks')::integer<>0 then raise exception 'BUTTON_INCREASED_STREAK';end if;
 -- Historical fixture dates test the algorithm without changing the production clock.
 update public.member_shared_streaks set starts_on=week-14 where gym_id=g;
 insert into public.plans(id,gym_id,name,price,duration_unit,duration_value,attendance_mode) values(p,g,'Prueba',10,'months',1,'daily');
 select membership_id into ma from public.register_manual_membership_checkout(g,l,a,p,owner_id,'cash',null,null,null,false);
 select membership_id into mb from public.register_manual_membership_checkout(g,l,b,p,owner_id,'cash',null,null,null,false);
 insert into public.attendances(gym_id,location_id,member_user_id,membership_id,attendance_date,source,registered_by) values(g,l,a,ma,today,'staff',owner_id),(g,l,b,mb,today,'staff',owner_id);
 result:=public.member_shared_streak_progress_backend(g,a);if (result->0->>'currentWeeks')::integer<>1 or (result->0->>'bestWeeks')::integer<>1 then raise exception 'VALID_ATTENDANCE_OR_MISSING_WEEKS: %',result;end if;
 update public.attendances set status='voided',void_reason='Prueba de reversión',voided_at=now(),voided_by=owner_id where gym_id=g and member_user_id=b and attendance_date=today;
 result:=public.member_shared_streak_progress_backend(g,a);if (result->0->>'currentWeeks')::integer<>0 or (result->0->>'bestWeeks')::integer<>0 then raise exception 'VOIDED_ATTENDANCE_OR_BREAK: %',result;end if;
 update public.member_fitness_profiles set training_frequency_per_week=7 where member_user_id=a;
 if exists(select 1 from public.member_shared_streaks where gym_id=g and (target_a<>1 or target_b<>1)) then raise exception 'GOAL_CHANGED';end if;
 perform public.member_training_social_backend(g,b,null,'disable');
 result:=public.member_shared_streak_progress_backend(g,a);if (result->0->>'canContinue')::boolean or (result->0->>'friendVisits')::integer<>0 then raise exception 'PRIVACY_LEAK';end if;
 perform public.member_training_social_backend(g,a,b,'end');
 if jsonb_array_length(public.member_shared_streak_progress_backend(g,a))<>0 then raise exception 'END_FAILED';end if;
 perform pg_temp.expect_training_failure(format('select public.member_shared_streak_progress_backend(%L,%L)',other_g,a),'TRAINING_MEMBER_REQUIRED');
 if exists(select 1 from private.loyalty_deliveries d join public.loyalty_notifications n on n.id=d.notification_id where n.gym_id=g) then raise exception 'EXTERNAL_TRAINING_MESSAGE';end if;
end;$$;
select '0047 OK: consentimiento, aislamiento, cooldown, invitación, aceptación, metas fijas, asistencias reales, reversión y privacidad' as result;
rollback;
