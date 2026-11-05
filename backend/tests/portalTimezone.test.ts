import { afterEach, describe, expect, it, vi } from 'vitest';
import { civilDate, nextMidnight, monthInstants, formatBranchInstant, gymTimezone } from '../../frontend/src/utils/portalTime';
import { selectCurrentWeeklyProgress } from '../../frontend/src/utils/currentWeeklyProgress';
import { watchPortalDate } from '../../frontend/src/utils/currentPortalDate';
import { dateInTimezone } from '../src/utils/gymDate.js';
import { React, MemoryRouter, renderToStaticMarkup, pageComponents } from './helpers/class-economics-render.js';
const { ClassCard } = pageComponents('MemberPortalPage.tsx', 'function classReferenceIssue', 'function ProgressView', ['ClassCard']);

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('FIT-MEMBER-013 explicit civil contexts',()=>{
  it.each(['America/New_York','Europe/Madrid'])('real class card preserves branch date/time in %s', timezone=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    const starts_at='2026-07-02T03:30:00Z';
    const schedule={id:'s',status:'scheduled',starts_at,ends_at:'2026-07-02T04:30:00Z',available:1,capacity:1,
      activity:{name:'Boxeo',billing_mode:'included'},location:{name:'Sucursal',timezone}};
    const html=renderToStaticMarkup(React.createElement(MemoryRouter,null,React.createElement(ClassCard,{schedule,membership:{id:'m'}})));
    expect(html).toContain(formatBranchInstant(starts_at,timezone,{weekday:'long',hour:'2-digit',minute:'2-digit'}));
    expect(html).toContain(timezone);
    expect(html).toContain('Reservar');
  });
  it.each(['Europe/Madrid','America/Guayaquil','UTC'])('ignores device zone %s',browser=>{
    const old=process.env.TZ;
    process.env.TZ=browser;
    try {
      const now=Date.parse('2027-01-01T00:30:00Z');
      expect(civilDate(now,'America/Guayaquil')).toBe('2026-12-31');
      expect(civilDate(now,'Europe/Madrid')).toBe('2027-01-01');
      expect(dateInTimezone('Europe/Madrid',new Date(now))).toBe('2027-01-01');
      expect(formatBranchInstant('2026-07-02T03:30:00Z','America/New_York',{day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})).toContain('23:30');
      expect(civilDate(Date.parse('2026-07-02T03:30:00Z'),'America/New_York')).toBe('2026-07-01');
    } finally {if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
  });
  it.each([
    ['2026-03-08T05:00:00Z','America/New_York','2026-03-09T04:00:00.000Z',23],
    ['2026-11-01T04:00:00Z','America/New_York','2026-11-02T05:00:00.000Z',25],
    ['2026-05-31T22:00:00Z','Europe/Madrid','2026-06-01T22:00:00.000Z',24],
  ])('next midnight respects DST %s', (now,tz,expected,hours)=>{
    const end=nextMidnight(Date.parse(now),tz);
    expect(new Date(end).toISOString()).toBe(expected);
    expect(end-Date.parse(now)).toBe(Number(hours)*3600000);
  });
  it('month filters use gym civil boundaries, not UTC month boundaries',()=>{
    expect(monthInstants('2026-03','America/New_York')).toEqual({from:'2026-03-01T05:00:00.000Z',to:'2026-04-01T03:59:59.999Z'});
    expect(monthInstants('2026-12','Europe/Madrid')).toEqual({from:'2026-11-30T23:00:00.000Z',to:'2026-12-31T22:59:59.999Z'});
  });
  it('keeps gym week on Sunday despite a Monday browser/branch date',()=>{
    const membership={id:'m',status:'active',attendance_mode_snapshot:'weekly',weekly_target_snapshot:3,membership_periods:[{status:'active',starts_on:'2026-01-01',ends_on:'2026-12-31'}]};
    const now=Date.parse('2026-06-01T00:30:00Z');
    expect(selectCurrentWeeklyProgress([],membership,civilDate(now,'America/Guayaquil'))?.week_starts_on).toBe('2026-05-25');
    expect(selectCurrentWeeklyProgress([],membership,civilDate(now,'Europe/Madrid'))?.week_starts_on).toBe('2026-06-01');
  });
  it('branch midnight refreshes its presentation without changing gym date, with one timer',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-07-01T03:59:59Z'));
    const tab=Object.assign(new EventTarget(),{visibilityState:'visible'});
    vi.stubGlobal('document',tab);vi.stubGlobal('window',new EventTarget());
    const publish=vi.fn(),stop=watchPortalDate(publish,'America/Guayaquil','America/New_York');
    vi.advanceTimersByTime(1000);
    expect(publish.mock.calls).toEqual([['2026-06-30'],['2026-06-30']]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3600000);
    expect(publish).toHaveBeenLastCalledWith('2026-07-01');
    stop();expect(vi.getTimerCount()).toBe(0);
  });
  it('only gym metadata has the historical fallback; missing branch zone is explicit',()=>{
    expect(gymTimezone(null)).toBe('America/Guayaquil');
    expect(gymTimezone('Europe/Madrid')).toBe('Europe/Madrid');
    expect(formatBranchInstant('2026-07-01T00:00:00Z',undefined,{})).toContain('no disponible');
  });
});
