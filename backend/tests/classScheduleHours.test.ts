import { describe, it, expect } from 'vitest';
import { branchInstant, checkClassHours, type ClassCalendar } from '../../frontend/src/utils/classScheduleHours';
const calendar = (): ClassCalendar => ({ location:{timezone:'America/Guayaquil'}, hours:Array.from({length:7},(_,i)=>({weekday:i+1,day_mode:'required',opens_at:'06:00:00',closes_at:'22:00:00'})),exceptions:[] });
describe('branch scheduling hours',()=>{
 it('uses branch timezone rather than device timezone',()=>expect(new Date(branchInstant('2099-10-30T06:00','America/Guayaquil')).toISOString()).toBe('2099-10-30T11:00:00.000Z'));
 it('allows exact opening and ending at closing',()=>{
  expect(checkClassHours(calendar(),'2099-10-30T06:00',60).allowed).toBe(true);
  expect(checkClassHours(calendar(),'2099-10-30T21:00',60).allowed).toBe(true);
 });
 it('rejects beginning before opening and ending beyond closing',()=>{
  expect(checkClassHours(calendar(),'2099-10-30T05:59',60).allowed).toBe(false);
  expect(checkClassHours(calendar(),'2099-10-30T21:30',60).allowed).toBe(false);
 });
 it('reflects changed hours on the next validation',()=>{
  const c=calendar(); expect(checkClassHours(c,'2099-10-30T21:00',60).allowed).toBe(true);
  c.hours.forEach(h=>h.closes_at='20:00:00'); expect(checkClassHours(c,'2099-10-30T21:00',60).allowed).toBe(false);
 });
 it('uses calendar exceptions and fails closed without hours',()=>{
  const c=calendar(); c.exceptions=[{calendar_date:'2099-10-30',day_mode:'closed',opens_at:null,closes_at:null}];
  expect(checkClassHours(c,'2099-10-30T12:00',60).allowed).toBe(false);
  c.hours=[]; c.exceptions=[]; expect(checkClassHours(c,'2099-10-30T12:00',60).allowed).toBe(false);
 });
 it('allows overnight windows but clips them at an explicit next-day closure',()=>{
  const c=calendar(); c.hours.forEach(h=>{h.opens_at='20:00:00';h.closes_at='04:00:00';});
  expect(checkClassHours(c,'2099-10-30T23:30',90).allowed).toBe(true);
  expect(checkClassHours(c,'2099-10-31T02:00',60).allowed).toBe(true);
  c.exceptions=[{calendar_date:'2099-10-31',day_mode:'closed',opens_at:null,closes_at:null}];
  expect(checkClassHours(c,'2099-10-30T23:30',90).allowed).toBe(false);
 });
 it('rejects nonexistent and ambiguous DST input instead of changing the chosen time',()=>{
  expect(()=>branchInstant('2026-03-08T02:30','America/New_York')).toThrow();
  expect(()=>branchInstant('2026-11-01T01:30','America/New_York')).toThrow();
 });
});
