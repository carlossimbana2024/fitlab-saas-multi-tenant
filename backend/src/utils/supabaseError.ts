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
  INSUFFICIENT_STOCK: { status: 409, message: 'No hay inventario suficiente para completar la operación.' },
  PRODUCT_NOT_FOUND: { status: 404, message: 'El producto no existe o ya no está disponible.' },
  SALE_LOCATION_MUST_BE_ACTIVE_IN_SAME_GYM: { status: 409, message: 'La sucursal de la venta no está disponible.' },
  INVENTORY_LOCATION_MUST_BE_ACTIVE_IN_SAME_GYM: { status: 409, message: 'La sucursal del inventario no está disponible.' },
  SALE_MEMBER_MUST_BE_ACTIVE_IN_SAME_GYM: { status: 409, message: 'El miembro seleccionado no está activo.' },
  SALE_PRODUCTS_MUST_USE_ONE_CURRENCY: { status: 409, message: 'Los productos de una venta deben usar la misma moneda.' },
  SALE_TOTAL_MUST_BE_POSITIVE: { status: 400, message: 'El total de la venta debe ser mayor que cero.' },
  REVERSIBLE_SALE_NOT_FOUND: { status: 404, message: 'La venta no existe o ya fue revertida.' },
  SALE_CONFIRMED_PAYMENT_NOT_FOUND: { status: 409, message: 'La venta no tiene un pago confirmado.' },
  SALE_INVENTORY_LOCATION_MISMATCH: { status: 409, message: 'El inventario y la sucursal de la venta no coinciden.' },
  COMMERCE_PERMISSION_DENIED: { status: 403, message: 'No tienes permiso para esta operación.' },
  CLASS_PERMISSION_DENIED: { status: 403, message: 'No tienes permiso para esta operación de clases.' },
  CLASS_BOOKING_REQUIRES_ACTIVE_MEMBER: { status: 409, message: 'El miembro está suspendido, retirado o inactivo.' },
  CLASS_ACTIVE_MEMBERSHIP_COVERAGE_REQUIRED: { status: 409, message: 'El miembro no tendrá cobertura vigente en la fecha de la clase.' },
  CLASS_IS_NOT_AVAILABLE_FOR_BOOKING: { status: 409, message: 'La clase ya no está disponible para reservas.' },
  CLASS_SCHEDULE_NOT_CANCELLABLE: { status: 404, message: 'La clase no existe o ya no puede cancelarse.' },
  CLASS_SCHEDULE_HAS_PAID_BOOKINGS: { status: 409, message: 'Primero reembolsa las reservas pagadas antes de cancelar la clase.' },
  CLASS_CAPACITY_REACHED: { status: 409, message: 'La clase ya no tiene cupos disponibles.' },
  CLASS_REQUIRES_RECEPTION_PAYMENT: { status: 409, message: 'Esta actividad requiere pago y debe reservarse desde recepción.' },
  CLASS_DOES_NOT_REQUIRE_ADDITIONAL_PAYMENT: { status: 409, message: 'Esta actividad está incluida y no requiere un cobro adicional.' },
  CLASS_PAYMENT_METHOD_REQUIRED: { status: 400, message: 'Selecciona el método de pago.' },
  CLASS_BOOKING_ALREADY_EXISTS: { status: 409, message: 'El miembro ya tiene una reserva para esta clase.' },
  CLASS_BOOKING_CANCELLATION_WINDOW_CLOSED: { status: 409, message: 'Ya no puedes cancelar la reserva con menos de 2 horas de anticipación.' },
  CLASS_BOOKING_NOT_CANCELLABLE: { status: 404, message: 'La reserva no existe o ya no puede cancelarse.' },
  PAST_CLASS_BOOKING_CANNOT_BE_CANCELLED: { status: 409, message: 'Una clase iniciada ya no puede cancelarse.' },
  PAID_CLASS_CANCELLATION_REQUIRES_RECEPTION: { status: 409, message: 'Una reserva pagada debe cancelarse desde recepción.' },
  CLASS_ATTENDANCE_OUTSIDE_ALLOWED_WINDOW: { status: 409, message: 'La llegada solo puede validarse cerca del horario de la clase.' },
  CLASS_NO_SHOW_ONLY_AFTER_END: { status: 409, message: 'La inasistencia solo puede marcarse cuando la clase haya terminado.' },
  ONLY_ASSIGNED_INSTRUCTOR_CAN_MARK_ATTENDANCE: { status: 403, message: 'Solo el instructor asignado puede controlar esta clase.' },
  REVERSIBLE_CLASS_PAYMENT_NOT_FOUND: { status: 404, message: 'El pago de la clase no existe o ya fue reembolsado.' },
  PAID_CLASS_BOOKING_NOT_FOUND: { status: 404, message: 'La reserva pagada no existe.' },
  MEMBER_CAN_ONLY_JOIN_OWN_WAITLIST: { status: 403, message: 'Solo puedes unirte a la lista de espera con tu propia cuenta.' },
  CLASS_WAITLIST_NOT_NEEDED: { status: 409, message: 'Todavía hay cupos disponibles; puedes reservar directamente.' },
  CLASS_WAITLIST_PAYMENT_REQUIRED: { status: 409, message: 'Las actividades con pago adicional se reservan y pagan en recepción.' },
  CLASS_WAITLIST_NOT_FOUND: { status: 404, message: 'La entrada en la lista de espera no existe o ya no está activa.' },
};

export function fromSupabaseError(error: DatabaseError): AppError {
  const known = Object.entries(knownErrors).find(([code]) => error.message.includes(code));
  if (known) return new AppError(known[1].status, known[0], known[1].message);
  if (error.code === '23505') return new AppError(409, 'RESOURCE_ALREADY_EXISTS', 'El registro ya existe.');
  if (error.code === '42501') return new AppError(403, 'DATABASE_PERMISSION_DENIED', 'No tienes permiso para esta operación.');
  return new AppError(400, 'DATABASE_OPERATION_FAILED', 'La operación no pudo completarse.');
}
