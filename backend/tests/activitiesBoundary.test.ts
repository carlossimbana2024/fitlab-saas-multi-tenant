import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('actividades, reservas y control del instructor', () => {
  it('mantiene todas las escrituras detrás de RPC backend-only', () => {
    const migration = source('supabase/migrations/0030_extra_activities_bookings_payments.sql');
    const controller = source('backend/src/controllers/activity.controller.ts');
    for (const functionName of [
      'create_extra_class_backend',
      'update_extra_class_backend',
      'create_class_schedule_backend',
      'cancel_class_schedule_backend',
      'reserve_included_class_backend',
      'reserve_paid_class_backend',
      'cancel_class_booking_backend',
      'mark_class_booking_attendance_backend',
      'refund_class_booking_backend',
    ]) {
      expect(migration, functionName).toContain(`revoke all on function public.${functionName}`);
      expect(migration, functionName).toContain(`grant execute on function public.${functionName}`);
      expect(controller, functionName).toContain(`rpc('${functionName}'`);
    }
  });

  it('separa QR general, asistencia de clase y cobros adicionales', () => {
    const migration = source('supabase/migrations/0030_extra_activities_bookings_payments.sql');
    const routes = source('backend/src/routes/activity.routes.ts');
    const memberPortal = source('frontend/src/pages/MemberPortalPage.tsx');
    expect(migration).toContain("'classes.attendance_manage'");
    expect(migration).toContain("billing_mode = 'additional_fee'");
    expect(migration).toContain('class_booking_id');
    expect(migration).toContain('CLASS_SCHEDULE_HAS_PAID_BOOKINGS');
    expect(routes).toContain("activityRouter.patch('/bookings/:id/attendance'");
    expect(memberPortal).toContain('Reservar · pagar en recepción');
    expect(memberPortal).toContain("/bookings/self");
    expect(memberPortal).not.toContain("/attendances/extra-class");
    expect(memberPortal).toContain("section !== 'profile' && section !== 'classes'");
  });

  it('limita al coach a las clases que tiene asignadas', () => {
    const controller = source('backend/src/controllers/activity.controller.ts');
    expect(controller).toContain("classAccess.attendance && !classAccess.manage && !classAccess.bookings");
    expect(controller).toContain(".eq('instructor_user_id', request.tenant!.gymUserId)");
    expect(controller).toContain('classAccess.bookings ? people.filter');
  });

  it('aplica ventana de cancelación, lista de espera y resumen mensual', () => {
    const migration = source('supabase/migrations/0031_class_booking_policy_waitlist.sql');
    const controller = source('backend/src/controllers/activity.controller.ts');
    const routes = source('backend/src/routes/activity.routes.ts');
    const portal = source('frontend/src/pages/MemberPortalPage.tsx');
    expect(migration).toContain("interval '2 hours'");
    expect(migration).toContain('class_waitlists');
    expect(migration).toContain('join_class_waitlist_backend');
    expect(migration).toContain('leave_class_waitlist_backend');
    expect(migration).toContain("class.waitlist_joined");
    expect(controller).toContain("rpc('join_class_waitlist_backend'");
    expect(controller).toContain("rpc('leave_class_waitlist_backend'");
    expect(routes).toContain("activityRouter.get('/summary'");
    expect(routes).toContain("activityRouter.post('/schedules/:id/waitlist/self'");
    expect(routes).toContain("activityRouter.patch('/waitlist/:id/cancel-self'");
    expect(portal).toContain('Unirme a lista de espera');
    expect(portal).toContain('Salir de lista');
  });

  it('permite reservar actividades adicionales sin confundir reserva, pago y asistencia', () => {
    const migration = source('supabase/migrations/0042_member_paid_class_reservations.sql');
    const controller = source('backend/src/controllers/activity.controller.ts');
    const portal = source('frontend/src/pages/MemberPortalPage.tsx');
    const activities = source('frontend/src/pages/ActivitiesPage.tsx');
    expect(migration).toContain('reserve_member_class_backend');
    expect(migration).toContain("'class.unpaid_booking_created'");
    expect(migration).toContain("existing_booking.status = 'reserved'");
    expect(migration).toContain('existing_booking.payment_id is null');
    expect(migration).toContain('MEMBER_CAN_ONLY_BOOK_SELF');
    expect(migration).toContain('grant execute on function public.reserve_member_class_backend');
    expect(migration).toContain('to service_role');
    expect(controller).toContain("rpc('reserve_member_class_backend'");
    expect(controller).toContain('payment_state');
    expect(portal).toContain('Pago pendiente en recepción');
    expect(portal).toContain('No se realizará ningún cobro en FitLab.');
    expect(activities).toContain('Registrar pago');
    expect(activities).toContain('Reserva, pago y asistencia se muestran por separado.');
  });
});
