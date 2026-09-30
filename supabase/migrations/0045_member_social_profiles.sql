begin;
set local lock_timeout='5s';
create table public.member_social_profiles (
 gym_id uuid not null references public.gyms(id) on delete cascade,
 member_user_id uuid primary key references public.gym_users(id) on delete cascade,
 bio text not null default '' check(char_length(bio)<=160),
 gallery_paths text[] not null default array[null,null,null]::text[] check(cardinality(gallery_paths)=3),
 show_gallery boolean not null default false,
 show_badges boolean not null default false,
 updated_at timestamptz not null default now()
);
alter table public.member_social_profiles enable row level security;
revoke all on public.member_social_profiles from public,anon,authenticated;
grant select,insert,update,delete on public.member_social_profiles to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('member-gallery','member-gallery',false,5242880,array['image/jpeg','image/png','image/webp']);

create function public.update_member_social_profile_backend(g uuid,actor uuid,input jsonb)
returns public.member_social_profiles language plpgsql security definer set search_path=pg_catalog,public as $$
declare result public.member_social_profiles; member_record public.gym_users; photo text; slot integer;
begin
 select * into member_record from public.gym_users where id=actor and gym_id=g and role='member' and status='active' and account_mode='portal' for update;
 if member_record.id is null then raise exception 'SOCIAL_MEMBER_REQUIRED' using errcode='42501'; end if;
 insert into public.member_social_profiles(gym_id,member_user_id) values(g,actor) on conflict(member_user_id) do nothing;
 select * into result from public.member_social_profiles where gym_id=g and member_user_id=actor for update;
 if input ? 'bio' then result.bio:=trim(input->>'bio'); end if;
 if input ? 'showGallery' then result.show_gallery:=(input->>'showGallery')::boolean; end if;
 if input ? 'showBadges' then result.show_badges:=(input->>'showBadges')::boolean; end if;
 if input ? 'slot' then
  slot:=(input->>'slot')::integer;
  if slot not between 0 and 2 then raise exception 'SOCIAL_SLOT_INVALID'; end if;
  photo:=input->>'path';
  if photo is not null and (
    photo !~ ('^'||g::text||'/'||actor::text||'/[0-9a-f-]{36}\.(jpg|png|webp)$') or
    not exists(select 1 from storage.objects where bucket_id='member-gallery' and name=photo)
  ) then raise exception 'SOCIAL_PHOTO_INVALID' using errcode='42501'; end if;
  result.gallery_paths[slot+1]:=photo;
 end if;
 update public.member_social_profiles set bio=result.bio,gallery_paths=result.gallery_paths,
 show_gallery=result.show_gallery,show_badges=result.show_badges,updated_at=now()
 where gym_id=g and member_user_id=actor returning * into result;
 return result;
end; $$;
revoke all on function public.update_member_social_profile_backend(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.update_member_social_profile_backend(uuid,uuid,jsonb) to service_role;
commit;
