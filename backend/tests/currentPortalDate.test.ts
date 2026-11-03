import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchPortalDate } from '../../frontend/src/utils/currentPortalDate';

const dateAt = (value: string) => vi.setSystemTime(new Date(value));
let tab: EventTarget & { visibilityState: string };
let browser: EventTarget;
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  tab = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  browser = new EventTarget();
  vi.stubGlobal('document', tab);
  vi.stubGlobal('window', browser);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('FIT-MEMBER-012 portal calendar rollover', () => {
  it.each([
    ['2026-10-14', '2026-10-15'],
    ['2026-05-31', '2026-06-01'],
    ['2026-12-31', '2027-01-01'],
  ])('publishes %s then %s at local midnight, and schedules the next midnight', (before, after) => {
    dateAt(`${after}T04:59:59Z`);
    const publish = vi.fn();
    const interval = vi.spyOn(globalThis, 'setInterval');
    stop = watchPortalDate(publish);
    vi.advanceTimersByTime(999);
    expect(publish.mock.calls).toEqual([[before]]);
    vi.advanceTimersByTime(1);
    expect(publish.mock.calls).toEqual([[before], [after]]);
    vi.advanceTimersByTime(86_400_000 - 1);
    expect(publish).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(interval).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(['visibilitychange', 'focus'])('recovers a delayed timer on %s without duplicate updates', event => {
    dateAt('2026-06-01T04:59:59Z');
    const publish = vi.fn();
    stop = watchPortalDate(publish);
    dateAt('2026-06-03T14:00:00Z');
    const target = event === 'focus' ? browser : tab;
    expect(publish.mock.calls).toEqual([['2026-05-31']]);
    if (event === 'visibilitychange') {
      tab.visibilityState = 'hidden';
      target.dispatchEvent(new Event(event));
      expect(publish).toHaveBeenCalledTimes(1);
      tab.visibilityState = 'visible';
    }
    target.dispatchEvent(new Event(event));
    target.dispatchEvent(new Event(event));
    expect(publish.mock.calls).toEqual([['2026-05-31'], ['2026-06-03']]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('removes both listeners and clears the timer on cleanup', () => {
    dateAt('2026-06-01T04:59:59Z');
    const publish = vi.fn();
    const tabRemove = vi.spyOn(tab, 'removeEventListener');
    const browserRemove = vi.spyOn(browser, 'removeEventListener');
    stop = watchPortalDate(publish);
    stop();
    stop = undefined;
    expect(vi.getTimerCount()).toBe(0);
    expect(tabRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(browserRemove).toHaveBeenCalledWith('focus', expect.any(Function));
    vi.advanceTimersByTime(5_000);
    tab.dispatchEvent(new Event('visibilitychange'));
    browser.dispatchEvent(new Event('focus'));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
