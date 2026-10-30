import { AppError } from '../errors/AppError.js';

/** Transport errors and upstream outages must not masquerade as expired credentials. */
export function checkAuthAvailability(error: unknown) {
  if (!error) return;
  const status = (error as { status?: number }).status;
  if (!status || status === 429 || status >= 500) {
    throw new AppError(503, 'AUTH_SERVICE_UNAVAILABLE', 'No se pudo comprobar la sesión. Intenta nuevamente en unos momentos.');
  }
}

export async function authCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { checkAuthAvailability(error); throw error; }
}
