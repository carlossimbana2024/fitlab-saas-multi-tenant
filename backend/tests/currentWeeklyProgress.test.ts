import { describe, expect, it } from 'vitest';
import { selectCurrentWeeklyProgress as select } from '../../frontend/src/utils/currentWeeklyProgress';
const membership = { id:'B',status:'active',attendance_mode_snapshot:'weekly',weekly_target_snapshot:4,membership_periods:[{starts_on:'2026-11-02',ends_on:'2026-12-01',status:'active'}] };
const row = {id:'row',membership_id:'B',week_starts_on:'2026-11-02',week_ends_on:'2026-11-08',target_attendances:4,completed_attendances:2,goal_met:false,is_grace_week:false};
describe('FIT-MEMBER-009',()=>{
 it('uses current partial progress',()=>expect(select([row],membership,'2026-11-03')).toEqual(row));
 it('does not use previous completed week',()=>expect(select([{...row,week_starts_on:'2026-10-26',week_ends_on:'2026-11-01',completed_attendances:3,target_attendances:3,goal_met:true}],membership,'2026-11-03')).toMatchObject({completed_attendances:0,target_attendances:4,goal_met:false}));
 it('rejects another membership even in current week',()=>expect(select([{...row,membership_id:'A'}],membership,'2026-11-03')?.completed_attendances).toBe(0));
 it('does not depend on ordering',()=>expect(select([{...row,membership_id:'A'},row],membership,'2026-11-03')).toEqual(row));
 it('same-contract renewal retains SQL weekly progress',()=>expect(select([row],{...membership,membership_periods:[...membership.membership_periods,{starts_on:'2026-11-05',ends_on:'2026-12-05',status:'active'}]},'2026-11-06')).toEqual(row));
 it('new contract for same plan does not inherit progress',()=>expect(select([row],{...membership,id:'C'},'2026-11-03')?.completed_attendances).toBe(0));
 it('validates end date',()=>expect(select([{...row,week_ends_on:'2026-11-07'}],membership,'2026-11-03')?.completed_attendances).toBe(0));
 it('zero without inserting data',()=>expect(select([],membership,'2026-11-03')).toMatchObject({completed_attendances:0,target_attendances:4,goal_met:false}));
 it('no applicable coverage yields no target',()=>expect(select([],membership,'2026-12-02')).toBeUndefined());
 it('Sunday stays in same week; Monday starts next',()=>{expect(select([row],membership,'2026-11-08')).toEqual(row);expect(select([row],membership,'2026-11-09')?.completed_attendances).toBe(0);});
});
