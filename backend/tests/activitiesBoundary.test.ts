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
    expect(memberPortal).toContain('Reserva y paga en recepción');
    expect(memberPortal).toContain("/bookings/self");
    expect(memberPortal).not.toContain("/attendances/extra-class");
  });

  it('limita al coach a las clases que tiene asignadas', () => {
    const controller = source('backend/src/controllers/activity.controller.ts');
    expect(controller).toContain("classAccess.attendance && !classAccess.manage && !classAccess.bookings");
    expect(controller).toContain(".eq('instructor_user_id', request.tenant!.gymUserId)");
    expect(controller).toContain('classAccess.bookings ? people.filter');
  });
});
