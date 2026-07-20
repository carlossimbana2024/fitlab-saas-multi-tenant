import { AppError } from '../errors/AppError.js';

type DatabaseError = { code?: string; message: string; details?: string | null };

const knownErrors: Record<string, { status: number; message: string }> = {
  ATTENDANCE_DATE_MUST_BE_TODAY_IN_GYM_TIMEZONE: { status: 400, message: 'La asistencia debe registrarse hoy.' },
  ATTENDANCE_REQUIRES_ACTIVE_MEMBERSHIP_COVERAGE: { status: 409, message: 'El miembro no tiene cobertura activa.' },
  ATTENDANCE_LOCATION_IS_CLOSED: { status: 409, message: 'La sucursal está cerrada.' },
  ATTENDANCE_OUTSIDE_OPENING_HOURS: { status: 409, message: 'La sucursal está fuera de su horario de atención.' },
};

export function fromSupabaseError(error: DatabaseError): AppError {
  const known = Object.entries(knownErrors).find(([code]) => error.message.includes(code));
  if (known) return new AppError(known[1].status, known[0], known[1].message);
  if (error.code === '23505') return new AppError(409, 'RESOURCE_ALREADY_EXISTS', 'El registro ya existe.');
  if (error.code === '42501') return new AppError(403, 'DATABASE_PERMISSION_DENIED', 'No tienes permiso para esta operación.');
  return new AppError(400, 'DATABASE_OPERATION_FAILED', 'La operación no pudo completarse.');
}
