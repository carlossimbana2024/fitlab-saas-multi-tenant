import axios from 'axios';
import { installSessionRecovery } from './sessionRecovery';
import { installAdminPinElevation } from './adminPinElevation';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

export const sessionRecovery = installSessionRecovery(api);
export const registerAdminPinElevationHandler = installAdminPinElevation(api, sessionRecovery);

export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) return error.response?.data?.error?.message ?? 'No se pudo completar la solicitud.';
  if (error instanceof Error && error.message) return error.message;
  return 'Ocurrió un error inesperado.';
}
