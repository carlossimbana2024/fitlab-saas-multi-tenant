-- Después de 0046. Todo se revierte, sin notificaciones externas.
begin;
create function pg_temp.expect_friend_failure(statement text,expected text) returns void language plpgsql as $$
begin begin execute statement;exception when others then if position(expected in sqlerrm)>0 then return;end if;raise;end;raise exception 'EXPECTED_FAILURE: %',expected;end;$$;
do $$
declare g uuid:=gen_random_uuid();other_g uuid:=gen_random_uuid();a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();c uuid:=gen_random_uuid();foreign_member uuid:=gen_random_uuid();
 ap uuid:=gen_random_uuid();bp uuid:=gen_random_uuid();cp uuid:=gen_random_uuid();fp uuid:=gen_random_uuid();r public.member_friendships;notification_count integer;
begin
 if has_table_privilege('anon','public.member_friendships','SELECT') or has_table_privilege('authenticated','public.member_friend_preferences','UPDATE') or has_function_privilege('authenticated','public.change_member_friendship_backend(uuid,uuid,uuid,text)','EXECUTE') then raise exception 'UNSAFE_FRIEND_ACCESS';end if;
 insert into auth.users(id,email) values(ap,ap||'@friends.invalid'),(bp,bp||'@friends.invalid'),(cp,cp||'@friends.invalid'),(fp,fp||'@friends.invalid');
 insert into public.profiles(id,full_name) values(ap,'Atleta A'),(bp,'Atleta B'),(cp,'Atleta C'),(fp,'Other gym');
 insert into public.gyms(id,name,slug) values(g,'Friend gym','friends-'||g),(other_g,'Other gym','friends-'||other_g);
 insert into public.gym_users(id,gym_id,profile_id,role,status) values(a,g,ap,'member','active'),(b,g,bp,'member','active'),(c,g,cp,'member','active'),(foreign_member,other_g,fp,'member','active');
 insert into public.member_fitness_profiles(gym_id,member_user_id,weight_kg,height_cm,goal_type,show_in_community) values(g,a,80,180,'improve_fitness',true),(g,b,70,170,'improve_fitness',true),(g,c,75,175,'improve_fitness',true);
 perform pg_temp.expect_friend_failure(format('select public.change_member_friendship_backend(%L,%L,%L,%L)',g,a,a,'request'),'FRIEND_SELF_NOT_ALLOWED');
 perform pg_temp.expect_friend_failure(format('select public.change_member_friendship_backend(%L,%L,%L,%L)',g,a,b,'request'),'FRIEND_PRIVACY_REQUIRED');
 perform public.set_member_friend_preferences_backend(g,a,true);perform public.set_member_friend_preferences_backend(g,b,true);perform public.set_member_friend_preferences_backend(g,c,true);
 perform pg_temp.expect_friend_failure(format('select public.change_member_friendship_backend(%L,%L,%L,%L)',g,a,foreign_member,'request'),'FRIEND_PRIVACY_REQUIRED');
 r:=public.change_member_friendship_backend(g,a,b,'request');
 perform public.change_member_friendship_backend(g,a,b,'request');
 if (select count(*) from public.member_friendships where gym_id=g)<>1 or (select count(*) from public.loyalty_notifications where gym_id=g and kind='friendship_request')<>1 then raise exception 'DUPLICATE_REQUEST';end if;
 perform pg_temp.expect_friend_failure(format('select public.change_member_friendship_backend(%L,%L,%L,%L)',g,b,a,'request'),'FRIEND_INCOMING_PENDING');
 perform pg_temp.expect_friend_failure(format('select public.change_member_friendship_backend(%L,%L,%L,%L)',g,a,b,'accept'),'FRIEND_STATE_INVALID');
 perform pg_temp.expect_friend_failure(format('select public.change_member_friendship_backend(%L,%L,%L,%L)',g,c,b,'accept'),'FRIEND_STATE_INVALID');
 r:=public.change_member_friendship_backend(g,b,a,'accept');if r.status<>'accepted' then raise exception 'ACCEPT_FAILED';end if;
 if (select count(*) from public.loyalty_notifications where gym_id=g and member_user_id=a and kind='friendship_accepted')<>1 then raise exception 'ACCEPT_NOTIFICATION';end if;
 perform pg_temp.expect_friend_failure(format('select public.change_member_friendship_backend(%L,%L,%L,%L)',g,b,a,'accept'),'FRIEND_STATE_INVALID');
 perform public.change_member_friendship_backend(g,a,b,'remove');
 perform pg_temp.expect_friend_failure(format('select public.change_member_friendship_backend(%L,%L,%L,%L)',g,a,b,'request'),'FRIEND_REQUEST_COOLDOWN');
 update public.member_friendships set updated_at=now()-interval '25 hours' where id=r.id;
 perform public.change_member_friendship_backend(g,b,a,'request');perform public.change_member_friendship_backend(g,a,b,'reject');
 if (select count(*) from public.member_friendships where gym_id=g)<>1 then raise exception 'REVERSE_DUPLICATE';end if;
 perform public.change_member_friendship_backend(g,a,c,'request');
 perform pg_temp.expect_friend_failure(format('select public.change_member_friendship_backend(%L,%L,%L,%L)',g,c,a,'cancel'),'FRIEND_STATE_INVALID');
 perform public.change_member_friendship_backend(g,a,c,'cancel');
 perform public.set_member_friend_preferences_backend(g,b,false);
 update public.member_friendships set updated_at=now()-interval '25 hours' where member_a=least(a,b) and member_b=greatest(a,b);
 perform pg_temp.expect_friend_failure(format('select public.change_member_friendship_backend(%L,%L,%L,%L)',g,a,b,'request'),'FRIEND_PRIVACY_REQUIRED');
 perform public.set_member_friend_preferences_backend(g,b,true);update public.member_fitness_profiles set show_in_community=false where member_user_id=b;
 perform pg_temp.expect_friend_failure(format('select public.change_member_friendship_backend(%L,%L,%L,%L)',g,a,b,'request'),'FRIEND_PRIVACY_REQUIRED');
 update public.gym_users set status='suspended' where id=a;
 perform pg_temp.expect_friend_failure(format('select public.set_member_friend_preferences_backend(%L,%L,true)',g,a),'FRIEND_MEMBER_REQUIRED');
 if exists(select 1 from private.loyalty_deliveries d join public.loyalty_notifications n on n.id=d.notification_id where n.gym_id=g) then raise exception 'EXTERNAL_FRIEND_MESSAGE';end if;
end;$$;
select '0046 OK: privacidad, aislamiento, solicitudes únicas, aceptación autorizada, rechazo, cancelación, eliminación, cooldown y avisos internos' as result;
rollback;
