import axios, { type InternalAxiosRequestConfig } from 'axios';

type ElevationHandler = (permission: string) => Promise<string>;
type RetriableConfig = InternalAxiosRequestConfig & {
  _retried?: boolean;
  _elevationRetried?: boolean;
};

let elevationHandler: ElevationHandler | null = null;

export function registerAdminPinElevationHandler(handler: ElevationHandler) {
  elevationHandler = handler;
  return () => { if (elevationHandler === handler) elevationHandler = null; };
}

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.response.use(undefined, async (error) => {
  const original = error.config as RetriableConfig;
  if (error.response?.status === 401 && !original?._retried && !original?.url?.includes('/auth/')) {
    original._retried = true;
    await api.post('/auth/refresh');
    return api(original);
  }
  const permission = error.response?.data?.error?.details?.permission;
  if (
    error.response?.status === 403
    && error.response?.data?.error?.code === 'REQUIRES_ADMIN_PIN'
    && typeof permission === 'string'
    && elevationHandler
    && !original?._elevationRetried
  ) {
    original._elevationRetried = true;
    const token = await elevationHandler(permission);
    original.headers = original.headers ?? {};
    if ('set' in original.headers && typeof original.headers.set === 'function') {
      original.headers.set('x-admin-elevation-token', token);
    } else {
      (original.headers as Record<string, string>)['x-admin-elevation-token'] = token;
    }
    return api(original);
  }
  return Promise.reject(error);
});

export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) return error.response?.data?.error?.message ?? 'No se pudo completar la solicitud.';
  if (error instanceof Error && error.message) return error.message;
  return 'Ocurrió un error inesperado.';
}
