import { useEffect, useState } from 'react';

import { civilDate, DEFAULT_TIMEZONE, nextMidnight } from './portalTime';

export const portalDate = (timestamp = Date.now(), timezone = DEFAULT_TIMEZONE) => civilDate(timestamp, timezone);

export function watchPortalDate(onDate: (date: string) => void, timezone = DEFAULT_TIMEZONE, branchTimezone?: string) {
  let timer: ReturnType<typeof setTimeout>;
  let previous: string | undefined;
  const resync = () => {
    clearTimeout(timer);
    const now = Date.now();
    const today = portalDate(now, timezone);
    const fingerprint = today + (branchTimezone ? portalDate(now, branchTimezone) : '');
    if (fingerprint !== previous) {
      previous = fingerprint;
      onDate(today);
    }
    const boundary = Math.min(nextMidnight(now, timezone), branchTimezone ? nextMidnight(now, branchTimezone) : Infinity);
    timer = setTimeout(resync, Math.max(1, boundary - Date.now()));
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') resync();
  };
  resync();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', resync);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', resync);
  };
}

export function useCurrentPortalDate(timezone = DEFAULT_TIMEZONE, tenantId?: string, branchTimezone?: string) {
  const [state, setState] = useState(() => ({ timezone, tenantId, today: portalDate(Date.now(), timezone) }));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    return watchPortalDate(today => setState({ timezone, tenantId, today }), timezone, branchTimezone);
  }, [timezone, tenantId, branchTimezone]);
  // Never render the previous tenant's civil date while the effect is restarting.
  return state.timezone === timezone && state.tenantId === tenantId ? state.today : portalDate(Date.now(), timezone);
}
