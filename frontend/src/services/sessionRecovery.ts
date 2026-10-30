import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

type Config = InternalAxiosRequestConfig & { _sessionRetry?: boolean; _sessionVersion?: number; _sessionEpoch?: number };
const path = (url = '') => new URL(url, 'https://fitlab.invalid').pathname.replace(/^\/api(?=\/)/, '').replace(/\/$/, '');
const accessFailure = (error: any) => error.response?.status === 401 && ['AUTH_REQUIRED', 'INVALID_SESSION'].includes(error.response?.data?.error?.code);
export const isSessionExpired = (error: unknown) => axios.isAxiosError(error) && error.response?.status === 401
  && ['AUTH_REQUIRED', 'INVALID_SESSION', 'REFRESH_TOKEN_REQUIRED', 'INVALID_REFRESH_TOKEN'].includes(error.response?.data?.error?.code);

/** Cookies remain HTTP-only. Versioning also handles delayed 401s from before a successful refresh. */
export function installSessionRecovery(client: AxiosInstance) {
  let flight: Promise<void> | null = null;
  let version = 0;
  let epoch = 0;
  let expired = false;
  let changingSession = false;
  const listeners = new Set<() => void>();
  const expire = () => {
    if (expired) return;
    expired = true;
    epoch++;
    listeners.forEach(listener => listener());
  };
  const assertCurrent = (config: Config) => {
    if (config._sessionEpoch !== epoch) throw new axios.CanceledError('Session changed');
  };
  client.interceptors.request.use(config => {
    const original = config as Config;
    if (changingSession && !['/auth/login', '/auth/logout'].includes(path(original.url))) {
      throw new axios.CanceledError('Session transition');
    }
    original._sessionEpoch ??= epoch;
    assertCurrent(original);
    original._sessionVersion = version;
    return config;
  });
  client.interceptors.response.use(response => {
    assertCurrent(response.config as Config);
    return response;
  }, async error => {
    const original = error.config as Config | undefined;
    if (!original) throw error;
    assertCurrent(original);
    const endpoint = path(original.url);
    if (endpoint === '/auth/refresh') {
      if (isSessionExpired(error)) expire();
      throw error;
    }
    const eligible = endpoint === '/auth/me' || !endpoint.startsWith('/auth/');
    if (!eligible || !accessFailure(error)) throw error;
    if (original._sessionRetry || expired) { expire(); throw error; }
    original._sessionRetry = true;
    if (original._sessionVersion === version) {
      flight ??= client.post('/auth/refresh').then(() => { version++; }).finally(() => { flight = null; });
      await flight;
    }
    assertCurrent(original);
    return client(original);
  });
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // Serialize login/logout after any cookie-writing refresh. Invalidate stale responses first.
    async boundary() {
      changingSession = true; epoch++; expired = false;
      await flight?.catch(() => undefined);
      return () => { changingSession = false; };
    },
  };
}
