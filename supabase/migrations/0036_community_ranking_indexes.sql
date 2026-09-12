begin;
set local lock_timeout = '5s';

-- Los rankings se reconstruyen desde los eventos originales. Estos índices
-- mantienen rápidas las consultas mensuales sin duplicar ni congelar datos.
create index if not exists attendances_community_ranking_idx
  on public.attendances(gym_id, attendance_date, member_user_id)
  where status = 'valid';

create index if not exists member_weight_entries_community_ranking_idx
  on public.member_weight_entries(gym_id, measured_on, member_user_id);

commit;
