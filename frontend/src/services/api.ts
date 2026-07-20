import axios from 'axios';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.response.use(undefined, async (error) => {
  const original = error.config as (typeof error.config & { _retried?: boolean });
  if (error.response?.status === 401 && !original?._retried && !original?.url?.includes('/auth/')) {
    original._retried = true;
    await api.post('/auth/refresh');
    return api(original);
  }
  return Promise.reject(error);
});

export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) return error.response?.data?.error?.message ?? 'No se pudo completar la solicitud.';
  return 'Ocurrió un error inesperado.';
}
