import axios, { type AxiosInstance, type GenericAbortSignal, type InternalAxiosRequestConfig } from 'axios';

export type AdminPinGrant = { token: string; expiresAt: string };
type ElevationHandler = (permission: string, signals: readonly GenericAbortSignal[]) => Promise<AdminPinGrant>;
type RetriableConfig = InternalAxiosRequestConfig & { _pinScope?: number; _elevationRetried?: boolean };
const terminalFailures = new WeakSet<object>();

export function adminPinCancelled(message = 'La autorización por PIN fue cancelada.') {
  return new axios.CanceledError(message);
}

export function isAdminPinFailure(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && terminalFailures.has(error)) return true;
  if (!axios.isAxiosError(error)) return false;
  const code = error.response?.data?.error?.code;
  return code === 'REQUIRES_ADMIN_PIN' || code === 'INVALID_ADMIN_ELEVATION'
    || (error.config as RetriableConfig | undefined)?._elevationRetried === true;
}

export function installAdminPinElevation(client: AxiosInstance, session: { readonly signal: AbortSignal }) {
  let nextScope = 0;
  let scope: { id: number; run: ElevationHandler } | null = null;

  client.interceptors.request.use(config => {
    const original = config as RetriableConfig;
    original._pinScope ??= scope?.id ?? 0;
    if (original._elevationRetried && original._pinScope !== scope?.id) throw adminPinCancelled();
    return config;
  });

  client.interceptors.response.use(undefined, async (error) => {
    const original = error?.config as RetriableConfig | undefined;
    const permission = error?.response?.data?.error?.details?.permission;
    if (
      error?.response?.status !== 403
      || error.response?.data?.error?.code !== 'REQUIRES_ADMIN_PIN'
      || typeof permission !== 'string'
      || !original
      || original._elevationRetried
    ) throw error;

    const activeScope = scope;
    const signals = original.signal ? [session.signal, original.signal] : [session.signal];
    try {
      if (!activeScope || original._pinScope !== activeScope.id || signals.some(signal => signal.aborted)) {
        throw original._pinScope ? adminPinCancelled() : error;
      }
      const grant = await activeScope.run(permission, signals);
      if (scope !== activeScope || signals.some(signal => signal.aborted)) throw adminPinCancelled();
      const expiration = Date.parse(grant?.expiresAt);
      if (typeof grant?.token !== 'string' || !grant.token || !Number.isFinite(expiration) || expiration <= Date.now()) {
        throw new Error('La autorización temporal es inválida o expiró.');
      }
      original._elevationRetried = true;
      original.headers.set('x-admin-elevation-token', grant.token);
      return await client(original);
    } catch (cause) {
      if (typeof cause === 'object' && cause !== null) terminalFailures.add(cause);
      throw cause;
    }
  });

  return (run: ElevationHandler) => {
    const registered = { id: ++nextScope, run };
    scope = registered;
    return () => { if (scope === registered) scope = null; };
  };
}
