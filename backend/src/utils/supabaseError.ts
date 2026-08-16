import { AppError } from '../errors/AppError.js';

type DatabaseError = { code?: string; message: string; details?: string | null };

const knownErrors: Record<string, { status: number; message: string }> = {
  ATTENDANCE_DATE_MUST_BE_TODAY_IN_GYM_TIMEZONE: { status: 400, message: 'La asistencia debe registrarse hoy.' },
  ATTENDANCE_REQUIRES_ACTIVE_MEMBERSHIP_COVERAGE: { status: 409, message: 'El miembro no tiene cobertura activa.' },
  ACTIVE_MEMBERSHIP_PERIOD_REQUIRED: { status: 409, message: 'El miembro no tiene cobertura vigente para hoy.' },
  ATTENDANCE_REQUIRES_ACTIVE_MEMBER: { status: 409, message: 'El miembro está suspendido, retirado o todavía no está activo.' },
  ATTENDANCE_MEMBERSHIP_MISMATCH: { status: 409, message: 'La membresía seleccionada no pertenece al miembro.' },
  ATTENDANCE_LOCATION_MISMATCH: { status: 409, message: 'La sucursal seleccionada no está disponible.' },
  ATTENDANCE_CAN_ONLY_BE_VOIDED_SAME_DAY: { status: 409, message: 'Solo puedes anular una asistencia el mismo día.' },
  ATTENDANCE_LOCATION_IS_CLOSED: { status: 409, message: 'La sucursal está cerrada.' },
  ATTENDANCE_OUTSIDE_OPENING_HOURS: { status: 409, message: 'La sucursal está fuera de su horario de atención.' },
  ACTIVE_MEMBERSHIP_REQUIRES_RENEWAL: { status: 409, message: 'Este miembro ya tiene una membresía. Usa la opción Renovar.' },
  INVALID_MEMBERSHIP_FOR_RENEWAL: { status: 409, message: 'La membresía seleccionada ya no puede renovarse.' },
  CANCELLABLE_MEMBERSHIP_NOT_FOUND: { status: 404, message: 'La membresía no existe o ya fue cancelada.' },
  REVERSIBLE_PAYMENT_NOT_FOUND: { status: 404, message: 'El pago no existe o ya fue anulado o reembolsado.' },
  EXTERNAL_REFERENCE_REQUIRED_FOR_PAYMENT_METHOD: { status: 400, message: 'Este método de pago requiere una referencia.' },
  FINANCIAL_PERMISSION_DENIED: { status: 403, message: 'No tienes permiso para realizar esta operación financiera.' },
};

export function fromSupabaseError(error: DatabaseError): AppError {
  const known = Object.entries(knownErrors).find(([code]) => error.message.includes(code));
  if (known) return new AppError(known[1].status, known[0], known[1].message);
  if (error.code === '23505') return new AppError(409, 'RESOURCE_ALREADY_EXISTS', 'El registro ya existe.');
  if (error.code === '42501') return new AppError(403, 'DATABASE_PERMISSION_DENIED', 'No tienes permiso para esta operación.');
  return new AppError(400, 'DATABASE_OPERATION_FAILED', 'La operación no pudo completarse.');
}
