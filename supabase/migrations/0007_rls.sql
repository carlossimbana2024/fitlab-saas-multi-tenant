begin;

create or replace function private.current_gym_user_id()
returns uuid language sql stable security definer set search_path = pg_catalog, public as $$
  select gu.id from public.gym_users gu
  where gu.profile_id = (select auth.uid()) and gu.status = 'active' limit 1
$$;

create or replace function private.current_gym_id()
returns uuid language sql stable security definer set search_path = pg_catalog, public as $$
  select gu.gym_id from public.gym_users gu
  where gu.profile_id = (select auth.uid()) and gu.status = 'active' limit 1
$$;

create or replace function private.current_gym_role()
returns public.gym_role language sql stable security definer set search_path = pg_catalog, public as $$
  select gu.role from public.gym_users gu
  where gu.profile_id = (select auth.uid()) and gu.status = 'active' limit 1
$$;

create or replace function private.is_owner()
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce((select private.current_gym_role()) = 'owner', false)
$$;

create or replace function private.has_permission(requested_permission text)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select (select private.is_owner()) or exists (
    select 1 from public.staff_permissions sp
    where sp.staff_user_id = (select private.current_gym_user_id())
      and sp.gym_id = (select private.current_gym_id())
      and sp.permission_key = requested_permission
      and sp.access_mode = 'allowed'
  )
$$;

create or replace function private.gym_status_unchanged(target_gym_id uuid, proposed_status public.gym_status)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.gyms g where g.id = target_gym_id and g.status = proposed_status)
$$;

create or replace function private.member_booking_update_allowed(
  booking_id uuid,
  proposed_schedule_id uuid,
  proposed_member_id uuid,
  proposed_payment_id uuid,
  proposed_status public.class_booking_status
)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (
    select 1 from public.class_bookings cb
    where cb.id = booking_id
      and cb.member_user_id = (select private.current_gym_user_id())
      and cb.class_schedule_id = proposed_schedule_id
      and cb.member_user_id = proposed_member_id
      and cb.payment_id is not distinct from proposed_payment_id
      and proposed_status in ('reserved', 'cancelled')
  )
$$;

revoke all on function private.current_gym_user_id() from public;
revoke all on function private.current_gym_id() from public;
revoke all on function private.current_gym_role() from public;
revoke all on function private.is_owner() from public;
revoke all on function private.has_permission(text) from public;
revoke all on function private.gym_status_unchanged(uuid, public.gym_status) from public;
revoke all on function private.member_booking_update_allowed(uuid, uuid, uuid, uuid, public.class_booking_status) from public;
grant execute on function private.current_gym_user_id() to authenticated;
grant execute on function private.current_gym_id() to authenticated;
grant execute on function private.current_gym_role() to authenticated;
grant execute on function private.is_owner() to authenticated;
grant execute on function private.has_permission(text) to authenticated;
grant execute on function private.gym_status_unchanged(uuid, public.gym_status) to authenticated;
grant execute on function private.member_booking_update_allowed(uuid, uuid, uuid, uuid, public.class_booking_status) to authenticated;

-- Privilegios mínimos de tabla. RLS decide además qué filas son accesibles.
revoke all on all tables in schema public from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, update on public.gyms to authenticated;
grant select, insert, update on public.gym_locations, public.gym_invitations to authenticated;
grant select, update on public.gym_users to authenticated;
grant select on public.permission_catalog to authenticated;
grant select, insert, update on public.staff_permissions to authenticated;
grant select, insert, update on public.location_opening_hours, public.location_calendar_exceptions to authenticated;
grant select, insert, update on public.plans, public.memberships to authenticated;
grant select on public.membership_periods to authenticated;
grant select, insert, update on public.member_payments to authenticated;
grant select, insert, update on public.extra_classes, public.class_schedules, public.class_bookings to authenticated;
grant select, insert, update on public.attendances to authenticated;
grant select on public.user_streaks, public.weekly_attendance_progress, public.streak_events to authenticated;
grant select, insert, update on public.products, public.sales to authenticated;
grant select, insert on public.sale_items, public.inventory_movements to authenticated;
grant select, insert, update on public.work_shifts to authenticated;
grant select on public.saas_plans, public.gym_subscriptions, public.saas_payment_transactions, public.audit_logs to authenticated;
grant select on public.product_stock_levels to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Perfil e identidad.
create policy profiles_select on public.profiles for select to authenticated using (
  id = (select auth.uid()) or exists (
    select 1 from public.gym_users target
    where target.profile_id = profiles.id and target.gym_id = (select private.current_gym_id())
      and (
        (target.role = 'member' and (select private.has_permission('members.view')))
        or (target.role = 'staff' and (select private.has_permission('staff.manage')))
        or (target.role = 'owner' and (select private.is_owner()))
      )
  )
);
create policy profiles_update_self on public.profiles for update to authenticated
using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy gyms_select_own on public.gyms for select to authenticated
using (id = (select private.current_gym_id()));
create policy gyms_update_settings on public.gyms for update to authenticated
using (id = (select private.current_gym_id()) and (select private.has_permission('settings.manage')))
with check (
  id = (select private.current_gym_id())
  and (select private.has_permission('settings.manage'))
  and (select private.gym_status_unchanged(id, status))
);

create policy gym_locations_select on public.gym_locations for select to authenticated
using (gym_id = (select private.current_gym_id()));
create policy gym_locations_insert on public.gym_locations for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('settings.manage')));
create policy gym_locations_update on public.gym_locations for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.has_permission('settings.manage')))
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('settings.manage')));

create policy gym_users_select on public.gym_users for select to authenticated using (
  profile_id = (select auth.uid())
  or (gym_id = (select private.current_gym_id()) and (
    (role = 'member' and (select private.has_permission('members.view')))
    or (role = 'staff' and (select private.has_permission('staff.manage')))
    or (role = 'owner' and (select private.is_owner()))
  ))
);
create policy gym_users_update_owner on public.gym_users for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.is_owner()))
with check (gym_id = (select private.current_gym_id()) and (select private.is_owner()));

create policy invitations_select on public.gym_invitations for select to authenticated using (
  gym_id = (select private.current_gym_id()) and (
    (intended_role = 'member' and (select private.has_permission('members.manage')))
    or (intended_role = 'staff' and (select private.has_permission('staff.manage')))
    or (intended_role = 'owner' and (select private.is_owner()))
  )
);
create policy invitations_insert on public.gym_invitations for insert to authenticated with check (
  gym_id = (select private.current_gym_id()) and (
    (intended_role = 'member' and (select private.has_permission('members.manage')))
    or (intended_role = 'staff' and (select private.has_permission('staff.manage')))
    or (intended_role = 'owner' and (select private.is_owner()))
  )
);
create policy invitations_update on public.gym_invitations for update to authenticated
using (
  gym_id = (select private.current_gym_id()) and (
    (intended_role = 'member' and (select private.has_permission('members.manage')))
    or (intended_role = 'staff' and (select private.has_permission('staff.manage')))
    or (intended_role = 'owner' and (select private.is_owner()))
  )
)
with check (
  gym_id = (select private.current_gym_id()) and (
    (intended_role = 'member' and (select private.has_permission('members.manage')))
    or (intended_role = 'staff' and (select private.has_permission('staff.manage')))
    or (intended_role = 'owner' and (select private.is_owner()))
  )
);

-- Permisos y calendario.
create policy permission_catalog_read on public.permission_catalog for select to authenticated using (true);
create policy staff_permissions_read on public.staff_permissions for select to authenticated
using (gym_id = (select private.current_gym_id()) and (staff_user_id = (select private.current_gym_user_id()) or (select private.is_owner())));
create policy staff_permissions_insert on public.staff_permissions for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and (select private.is_owner()));
create policy staff_permissions_update on public.staff_permissions for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.is_owner()))
with check (gym_id = (select private.current_gym_id()) and (select private.is_owner()));

create policy opening_hours_select on public.location_opening_hours for select to authenticated
using (gym_id = (select private.current_gym_id()));
create policy opening_hours_insert on public.location_opening_hours for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('calendar.manage')));
create policy opening_hours_update on public.location_opening_hours for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.has_permission('calendar.manage')))
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('calendar.manage')));
create policy calendar_exceptions_select on public.location_calendar_exceptions for select to authenticated
using (gym_id = (select private.current_gym_id()));
create policy calendar_exceptions_insert on public.location_calendar_exceptions for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('calendar.manage')));
create policy calendar_exceptions_update on public.location_calendar_exceptions for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.has_permission('calendar.manage')))
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('calendar.manage')));

-- Planes, membresías y pagos.
create policy plans_select on public.plans for select to authenticated using (
  gym_id = (select private.current_gym_id()) and (is_active or (select private.has_permission('members.manage')))
);
create policy plans_insert on public.plans for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('members.manage')));
create policy plans_update on public.plans for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.has_permission('members.manage')))
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('members.manage')));

create policy memberships_select on public.memberships for select to authenticated using (
  gym_id = (select private.current_gym_id())
  and (member_user_id = (select private.current_gym_user_id()) or (select private.has_permission('members.view')))
);
create policy memberships_insert on public.memberships for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('members.manage')));
create policy memberships_update on public.memberships for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.has_permission('members.manage')))
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('members.manage')));
create policy membership_periods_select on public.membership_periods for select to authenticated using (
  gym_id = (select private.current_gym_id()) and exists (
    select 1 from public.memberships m where m.id = membership_periods.membership_id
      and (m.member_user_id = (select private.current_gym_user_id()) or (select private.has_permission('members.view')))
  )
);
create policy member_payments_select on public.member_payments for select to authenticated using (
  gym_id = (select private.current_gym_id())
  and (member_user_id = (select private.current_gym_user_id()) or (select private.has_permission('finances.view')))
);
create policy member_payments_insert on public.member_payments for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('payments.register')));
create policy member_payments_update on public.member_payments for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.has_permission('payments.void')))
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('payments.void')));

-- Clases y reservas.
create policy extra_classes_select on public.extra_classes for select to authenticated
using (gym_id = (select private.current_gym_id()) and (is_active or (select private.has_permission('classes.manage'))));
create policy extra_classes_insert on public.extra_classes for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('classes.manage')));
create policy extra_classes_update on public.extra_classes for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.has_permission('classes.manage')))
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('classes.manage')));
create policy class_schedules_select on public.class_schedules for select to authenticated
using (gym_id = (select private.current_gym_id()));
create policy class_schedules_insert on public.class_schedules for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('classes.manage')));
create policy class_schedules_update on public.class_schedules for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.has_permission('classes.manage')))
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('classes.manage')));
create policy class_bookings_select on public.class_bookings for select to authenticated
using (gym_id = (select private.current_gym_id()) and (member_user_id = (select private.current_gym_user_id()) or (select private.has_permission('classes.bookings_manage'))));
create policy class_bookings_insert on public.class_bookings for insert to authenticated with check (
  gym_id = (select private.current_gym_id()) and (
    (member_user_id = (select private.current_gym_user_id()) and status = 'reserved')
    or (select private.has_permission('classes.bookings_manage'))
  )
);
create policy class_bookings_update on public.class_bookings for update to authenticated
using (gym_id = (select private.current_gym_id()) and (member_user_id = (select private.current_gym_user_id()) or (select private.has_permission('classes.bookings_manage'))))
with check (
  gym_id = (select private.current_gym_id()) and (
    (select private.has_permission('classes.bookings_manage'))
    or (select private.member_booking_update_allowed(id, class_schedule_id, member_user_id, payment_id, status))
  )
);

-- Asistencias y rachas.
create policy attendances_select on public.attendances for select to authenticated
using (gym_id = (select private.current_gym_id()) and (member_user_id = (select private.current_gym_user_id()) or (select private.has_permission('members.view'))));
create policy attendances_insert_staff on public.attendances for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and source = 'staff' and (select private.has_permission('attendance.register')));
create policy attendances_insert_qr on public.attendances for insert to authenticated
with check (
  gym_id = (select private.current_gym_id()) and source = 'qr'
  and member_user_id = (select private.current_gym_user_id())
  and registered_by = (select private.current_gym_user_id())
);
create policy attendances_update on public.attendances for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.has_permission('attendance.void')))
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('attendance.void')));
create policy streaks_select on public.user_streaks for select to authenticated
using (gym_id = (select private.current_gym_id()) and (member_user_id = (select private.current_gym_user_id()) or (select private.has_permission('members.view'))));
create policy weekly_progress_select on public.weekly_attendance_progress for select to authenticated
using (gym_id = (select private.current_gym_id()) and (member_user_id = (select private.current_gym_user_id()) or (select private.has_permission('members.view'))));
create policy streak_events_select on public.streak_events for select to authenticated
using (gym_id = (select private.current_gym_id()) and (member_user_id = (select private.current_gym_user_id()) or (select private.has_permission('members.view'))));

-- Catálogo, ventas e inventario.
create policy products_select on public.products for select to authenticated using (
  gym_id = (select private.current_gym_id()) and (is_active or (select private.has_permission('products.manage')))
);
create policy products_insert on public.products for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('products.manage')));
create policy products_update on public.products for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.has_permission('products.manage')))
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('products.manage')));

create policy sales_select on public.sales for select to authenticated using (
  gym_id = (select private.current_gym_id()) and (
    (select private.has_permission('finances.view'))
    or (seller_user_id = (select private.current_gym_user_id()) and (select private.has_permission('sales.register')))
    or member_user_id = (select private.current_gym_user_id())
  )
);
create policy sales_insert on public.sales for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and seller_user_id = (select private.current_gym_user_id()) and (select private.has_permission('sales.register')));
create policy sales_update on public.sales for update to authenticated
using (gym_id = (select private.current_gym_id()) and ((seller_user_id = (select private.current_gym_user_id()) and (select private.has_permission('sales.register'))) or (select private.has_permission('sales.void'))))
with check (gym_id = (select private.current_gym_id()) and ((status <> 'voided' and status <> 'refunded' and seller_user_id = (select private.current_gym_user_id()) and (select private.has_permission('sales.register'))) or (status in ('voided', 'refunded') and (select private.has_permission('sales.void')))));
create policy sale_items_select on public.sale_items for select to authenticated using (
  gym_id = (select private.current_gym_id()) and exists (
    select 1 from public.sales s where s.id = sale_items.sale_id and (
      (select private.has_permission('finances.view'))
      or (s.seller_user_id = (select private.current_gym_user_id()) and (select private.has_permission('sales.register')))
      or s.member_user_id = (select private.current_gym_user_id())
    )
  )
);
create policy sale_items_insert on public.sale_items for insert to authenticated
with check (
  gym_id = (select private.current_gym_id()) and (select private.has_permission('sales.register'))
  and exists (
    select 1 from public.sales s
    where s.id = sale_items.sale_id and s.gym_id = sale_items.gym_id
      and s.seller_user_id = (select private.current_gym_user_id()) and s.status = 'draft'
  )
);
create policy inventory_movements_select on public.inventory_movements for select to authenticated
using (gym_id = (select private.current_gym_id()) and (
  (select private.has_permission('products.manage')) or (select private.has_permission('inventory.adjust'))
  or (select private.has_permission('sales.register')) or (select private.has_permission('reports.view'))
));
create policy inventory_movements_insert on public.inventory_movements for insert to authenticated
with check (
  gym_id = (select private.current_gym_id())
  and performed_by = (select private.current_gym_user_id())
  and (select private.has_permission('inventory.adjust'))
);

-- Turnos.
create policy work_shifts_select on public.work_shifts for select to authenticated
using (gym_id = (select private.current_gym_id()) and (staff_user_id = (select private.current_gym_user_id()) or (select private.has_permission('shifts.manage'))));
create policy work_shifts_insert_self on public.work_shifts for insert to authenticated
with check (gym_id = (select private.current_gym_id()) and staff_user_id = (select private.current_gym_user_id()) and status = 'open' and reviewed_by is null);
create policy work_shifts_update_self on public.work_shifts for update to authenticated
using (gym_id = (select private.current_gym_id()) and staff_user_id = (select private.current_gym_user_id()))
with check (gym_id = (select private.current_gym_id()) and staff_user_id = (select private.current_gym_user_id()) and status in ('open', 'closed') and reviewed_by is null);
create policy work_shifts_update_manager on public.work_shifts for update to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.has_permission('shifts.manage')))
with check (gym_id = (select private.current_gym_id()) and (select private.has_permission('shifts.manage')));

-- Facturación SaaS y auditoría: lectura del owner; escritura solo backend/webhooks.
create policy saas_plans_read on public.saas_plans for select to authenticated using (is_active = true);
create policy gym_subscriptions_owner_read on public.gym_subscriptions for select to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.is_owner()));
create policy saas_transactions_owner_read on public.saas_payment_transactions for select to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.is_owner()));
create policy audit_logs_owner_read on public.audit_logs for select to authenticated
using (gym_id = (select private.current_gym_id()) and (select private.is_owner()));

commit;
