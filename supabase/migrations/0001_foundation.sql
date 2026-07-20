begin;

create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.gym_status as enum ('trial', 'active', 'past_due', 'suspended', 'cancelled');
create type public.gym_role as enum ('owner', 'staff', 'member');
create type public.gym_user_status as enum ('invited', 'active', 'suspended', 'inactive');
create type public.invitation_status as enum ('pending', 'accepted', 'expired', 'revoked');
create type public.permission_access_mode as enum ('allowed', 'requires_pin', 'denied');
create type public.calendar_day_mode as enum ('required', 'bonus', 'closed');
create type public.duration_unit as enum ('days', 'weeks', 'months');
create type public.attendance_mode as enum ('daily', 'weekly');
create type public.membership_status as enum ('pending', 'active', 'expired', 'cancelled', 'paused');
create type public.member_payment_method as enum ('cash', 'bank_transfer', 'external_card', 'external_deuna', 'other');
create type public.payment_status as enum ('pending', 'confirmed', 'voided', 'refunded', 'failed');
create type public.attendance_source as enum ('qr', 'staff', 'extra_class', 'system');
create type public.attendance_status as enum ('valid', 'voided');
create type public.streak_status as enum ('active', 'frozen', 'reset');
create type public.class_schedule_status as enum ('scheduled', 'cancelled', 'completed');
create type public.class_booking_status as enum ('reserved', 'attended', 'cancelled', 'no_show');
create type public.sale_status as enum ('draft', 'completed', 'voided', 'refunded');
create type public.inventory_movement_type as enum ('purchase', 'sale', 'return', 'adjustment', 'loss');
create type public.work_shift_status as enum ('open', 'closed', 'reviewed');
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'cancelled', 'suspended');

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated;

commit;