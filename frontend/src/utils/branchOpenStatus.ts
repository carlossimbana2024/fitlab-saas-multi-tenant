export type BranchOpenStatus = {
  isOpenNow: boolean;
  nextTransitionAt: string | null;
  nextState: 'open' | 'closed' | null;
  revalidateAt: string;
  validUntil: string;
  evaluatedAt: string;
  timezone: string;
};

export function statusDeadline(status: BranchOpenStatus) {
  return Math.min(...[status.nextTransitionAt, status.revalidateAt, status.validUntil]
    .filter((value): value is string => value !== null).map(Date.parse));
}

// One-shot scheduling only. A new server response installs the next timer.
export function watchBranchStatus(status: BranchOpenStatus | undefined, refresh: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRefresh = -Infinity;
  const revalidate = () => {
    if (Date.now() - lastRefresh < 1000) return; // focus + visibility are often paired
    lastRefresh = Date.now();
    if (timer !== undefined) clearTimeout(timer);
    refresh();
  };
  const deadline = status ? statusDeadline(status) : NaN;
  if (Number.isFinite(deadline)) timer = setTimeout(revalidate, Math.max(1000, deadline - Date.now()));
  const visible = () => { if (document.visibilityState === 'visible') revalidate(); };
  window.addEventListener('focus', revalidate);
  document.addEventListener('visibilitychange', visible);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    window.removeEventListener('focus', revalidate);
    document.removeEventListener('visibilitychange', visible);
  };
}
