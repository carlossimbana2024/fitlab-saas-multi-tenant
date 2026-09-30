-- Ejecutar después de 0045. Fixtures aisladas, sin cambios persistentes.
begin;
do $$
declare g uuid:=gen_random_uuid();other_g uuid:=gen_random_uuid();p uuid:=gen_random_uuid();m uuid:=gen_random_uuid();
 result public.member_social_profiles; photo text; failed boolean;
begin
 if has_table_privilege('authenticated','public.member_social_profiles','SELECT') or has_table_privilege('anon','public.member_social_profiles','UPDATE') then raise exception 'DIRECT_SOCIAL_ACCESS'; end if;
 if has_function_privilege('authenticated','public.update_member_social_profile_backend(uuid,uuid,jsonb)','EXECUTE') or has_function_privilege('anon','public.update_member_social_profile_backend(uuid,uuid,jsonb)','EXECUTE') then raise exception 'DIRECT_SOCIAL_RPC'; end if;
 if (select public from storage.buckets where id='member-gallery') then raise exception 'PUBLIC_GALLERY'; end if;
 insert into auth.users(id,email) values(p,p||'@social.invalid');
 insert into public.profiles(id,full_name) values(p,'Miembro social');
 insert into public.gyms(id,name,slug) values(g,'Social gym','social-'||g),(other_g,'Other gym','social-'||other_g);
 insert into public.gym_users(id,gym_id,profile_id,role,status) values(m,g,p,'member','active');
 result:=public.update_member_social_profile_backend(g,m,'{"bio":"Mi mejor versión 💪"}');
 if result.bio<>'Mi mejor versión 💪' or result.show_gallery or result.show_badges or cardinality(result.gallery_paths)<>3 then raise exception 'SOCIAL_DEFAULTS'; end if;
 failed:=false;begin perform public.update_member_social_profile_backend(other_g,m,'{"bio":"forged"}');exception when others then failed:=position('SOCIAL_MEMBER_REQUIRED' in sqlerrm)>0;end;if not failed then raise exception 'CROSS_GYM_WRITE';end if;
 failed:=false;begin perform public.update_member_social_profile_backend(g,m,jsonb_build_object('bio',repeat('X',161)));exception when check_violation then failed:=true;end;if not failed then raise exception 'BIO_LIMIT';end if;
 failed:=false;begin perform public.update_member_social_profile_backend(g,m,'{"slot":3,"path":null}');exception when others then failed:=position('SOCIAL_SLOT_INVALID' in sqlerrm)>0;end;if not failed then raise exception 'FOURTH_PHOTO';end if;
 photo:=g::text||'/'||m::text||'/'||gen_random_uuid()::text||'.webp';
 failed:=false;begin perform public.update_member_social_profile_backend(g,m,jsonb_build_object('slot',0,'path',photo));exception when others then failed:=position('SOCIAL_PHOTO_INVALID' in sqlerrm)>0;end;if not failed then raise exception 'MISSING_PHOTO_ACCEPTED';end if;
 insert into storage.objects(bucket_id,name) values('member-gallery',photo);
 result:=public.update_member_social_profile_backend(g,m,jsonb_build_object('slot',0,'path',photo));
 if result.gallery_paths[1]<>photo then raise exception 'PHOTO_NOT_SAVED';end if;
 failed:=false;begin perform public.update_member_social_profile_backend(g,m,jsonb_build_object('slot',1,'path',replace(photo,g::text,other_g::text)));exception when others then failed:=position('SOCIAL_PHOTO_INVALID' in sqlerrm)>0;end;if not failed then raise exception 'FOREIGN_PHOTO_ACCEPTED';end if;
 result:=public.update_member_social_profile_backend(g,m,'{"showGallery":true,"showBadges":true}');
 if not result.show_gallery or not result.show_badges or result.gallery_paths[1]<>photo then raise exception 'PRIVACY_OR_PARTIAL_UPDATE';end if;
 result:=public.update_member_social_profile_backend(g,m,'{"slot":0,"path":null}');
 if result.gallery_paths[1] is not null then raise exception 'DELETE_FAILED';end if;
 update public.gym_users set status='suspended' where id=m;
 failed:=false;begin perform public.update_member_social_profile_backend(g,m,'{"bio":"denied"}');exception when others then failed:=position('SOCIAL_MEMBER_REQUIRED' in sqlerrm)>0;end;if not failed then raise exception 'SUSPENDED_WRITE';end if;
end;$$;
select '0045 OK: privacidad por defecto, aislamiento, propiedad, límite de bio, tres fotos y reemplazo/eliminación' as result;
rollback;
