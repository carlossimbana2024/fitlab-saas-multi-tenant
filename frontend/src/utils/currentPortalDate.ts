import { useEffect, useState } from 'react';

// Preserve the portal calendar's existing convention. The attendance summary
// still supplies its own gym-local date; reconciling those clocks is FIT-MEMBER-013.
const portalDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' });
const hourMs = 3_600_000;

export const portalDate = (timestamp = Date.now()) => portalDateFormatter.format(timestamp);

function nextDayBoundary(now: number, today: string) {
  // Find the first instant with a different calendar date, independent of the
  // browser's local timezone. In the portal's zone the next midnight is within 26h.
  let lo = now;
  let hi = now + 26 * hourMs;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (portalDate(mid) === today) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function watchPortalDate(onDate: (date: string) => void) {
  let timer: ReturnType<typeof setTimeout>;
  let previous: string | undefined;
  const resync = () => {
    clearTimeout(timer);
    const now = Date.now();
    const today = portalDate(now);
    if (today !== previous) {
      previous = today;
      onDate(today);
    }
    timer = setTimeout(resync, Math.max(1, nextDayBoundary(now, today) - Date.now()));
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

export function useCurrentPortalDate() {
  const [today, setToday] = useState(() => portalDate());
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    return watchPortalDate(setToday);
  }, []);
  return today;
}
