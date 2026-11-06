import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { refreshMemberQueries, classConflictNeedsRefresh, type MemberChange } from '../../frontend/src/utils/memberQueryInvalidation';
const req = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { QueryClient, InfiniteQueryObserver } = req('@tanstack/react-query');
const context = { gymId: 'g', memberId: 'm' };
const clients: any[] = [];
const client = () => { const c = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});clients.push(c);return c; };
afterEach(() => clients.splice(0).forEach(c => c.clear()));
const keys = [
 ['my-progress','g','m','2026-11-05','America/Guayaquil'], ['my-fitness-profile'], ['member-social-profile','me'],
 ['member-community','g','m','all'], ['member-community','g','m','similar_goal'],
 ['member-community-rankings','g','m','2026-11'], ['member-community-rankings','g','m','2026-10'],
 ['my-attendances'], ['my-streak'], ['my-weekly-progress','day','zone','g'],
 ['my-activities','upcoming','day','zone','g'], ['my-activities','history','2026-10','zone','g'],
 ['member-friends',0,'all'], ['member-friendship','someone'], ['member-training-social'],
 ['loyalty-engagement','g','m'], ['my-membership-payments','m'], ['my-memberships','m'],
 ['branch-open-status','g','m','branch'], ['my-calendar','g','branch'], ['my-payments'], ['unrelated'],
 ['member-community','other-gym','other','all'], ['member-community-rankings','other-gym','other','2026-11'],
 ['my-progress','other-gym','other','day','zone'], ['my-activities','upcoming','day','zone','other-gym'],
 ['member-community','g','other-member','all'], ['loyalty-engagement','other-gym','other'],
];
const groups: Array<[MemberChange,string[]]> = [
 ['weight',['my-progress','member-social-profile','member-community','member-community-rankings']],
 ['fitness',['my-fitness-profile','my-progress','member-social-profile','member-community','member-community-rankings']],
 ['privacy',['my-fitness-profile','member-social-profile','member-community','member-community-rankings','member-friends','member-friendship','member-training-social']],
 ['identity',['member-social-profile','member-community','member-community-rankings']],
 ['social',['member-social-profile','member-community']], ['reaction',['member-social-profile','member-community']],
 ['attendance',['my-attendances','my-streak','my-weekly-progress','my-progress','member-social-profile','member-community','member-community-rankings','loyalty-engagement','member-training-social']],
 ['classes',['my-activities']], ['paymentRequest',['my-membership-payments']],
 ['friendPreference',['member-friends','member-friendship']], ['friendAction',['member-friends','member-friendship','member-training-social','loyalty-engagement']],
 ['trainingAction',['member-training-social','loyalty-engagement']], ['trainingPreference',['member-training-social']],
];
it.each(groups)('%s reconciles exactly its dependencies, not other tenants or unrelated resources',async(change,resources)=>{
 const c=client();keys.forEach(k=>c.setQueryData(k,{old:true}));
 await refreshMemberQueries(c,context,change);
 for(const key of keys){
   const excluded=key.includes('other-gym')||key.includes('other-member');
   const state=c.getQueryState(key);
   const touched=state.data===undefined||state.isInvalidated;
   expect(touched,JSON.stringify(key)).toBe(!excluded&&resources.includes(key[0]));
 }
});
it('missing tenant never falls back to global invalidation',async()=>{const c=client();c.setQueryData(['my-progress','g','m'],1);await refreshMemberQueries(c,{},'weight');expect(c.getQueryState(['my-progress','g','m']).isInvalidated).toBe(false);});
it('population change restarts cursor pages for each filter without mixing stale pages',async()=>{
 const c=client(),calls:any[]=[];let version=0;
 const observers=['all','similar_goal'].map(filter=>new InfiniteQueryObserver(c,{
   queryKey:['member-community','g','m',filter],initialPageParam:null,staleTime:Infinity,
   queryFn:async({pageParam}:any)=>{calls.push([filter,pageParam]);return {items:[`${filter}-${version}-${pageParam??'first'}`],nextCursor:pageParam?null:{version}};},
   getNextPageParam:(p:any)=>p.nextCursor??undefined,
 }));
 const stops=observers.map(o=>o.subscribe(()=>{}));
 await Promise.all(observers.map(o=>o.refetch()));await Promise.all(observers.map(o=>o.fetchNextPage()));
 expect(observers[0].getCurrentResult().data.pages).toHaveLength(2);
 version=1;calls.length=0;await refreshMemberQueries(c,context,'privacy');
 expect(calls).toEqual(expect.arrayContaining([['all',null],['similar_goal',null]]));expect(calls).toHaveLength(2);
 for(const o of observers){expect(o.getCurrentResult().data.pages).toHaveLength(1);expect(JSON.stringify(o.getCurrentResult().data)).not.toContain('-0-');}
 await observers[0].fetchNextPage();expect(calls.at(-1)).toEqual(['all',{version:1}]);stops.forEach(stop=>stop());
});
it('reaction reuses infinite queries and recalculates following cursors from backend',async()=>{
 const c=client();let reacted=false;const calls:any[]=[];
 const o=new InfiniteQueryObserver(c,{queryKey:['member-community','g','m','all'],initialPageParam:null,staleTime:Infinity,
   queryFn:async({pageParam}:any)=>{calls.push(pageParam);return {items:[{love:reacted?1:0}],nextCursor:pageParam?null:{fresh:reacted}};},getNextPageParam:(p:any)=>p.nextCursor??undefined});
 const stop=o.subscribe(()=>{});await o.refetch();await o.fetchNextPage();calls.length=0;reacted=true;
 await refreshMemberQueries(c,context,'reaction');expect(calls).toEqual([null,{fresh:true}]);
 expect(o.getCurrentResult().data.pages.every((p:any)=>p.items[0].love===1)).toBe(true);stop();
});
it('a late next-page response cannot repopulate a reset Community',async()=>{
 const c=client();let version=0,release!:()=>void;
 const o=new InfiniteQueryObserver(c,{queryKey:['member-community','g','m','all'],initialPageParam:null,staleTime:Infinity,
   queryFn:async({pageParam}:any)=>{
     if(pageParam){await new Promise<void>(r=>{release=r;});return {items:['OLD LATE PAGE'],nextCursor:null};}
     return {items:[`fresh-${version}`],nextCursor:{version}};
   },getNextPageParam:(p:any)=>p.nextCursor??undefined});
 const stop=o.subscribe(()=>{});await o.refetch();const pending=o.fetchNextPage();
 version=1;await refreshMemberQueries(c,context,'fitness');release();await pending;
 expect(o.getCurrentResult().data.pages).toHaveLength(1);
 expect(o.getCurrentResult().data.pages[0].items).toEqual(['fresh-1']);stop();
});
it.each(['CLASS_CAPACITY_REACHED','CLASS_WAITLIST_OFFER_EXPIRED','CLASS_WAITLIST_PRIORITY_REQUIRED'])('reconciles known conflict %s without claiming success',code=>expect(classConflictNeedsRefresh({response:{status:409,data:{error:{code}}}})).toBe(true));
it.each([undefined,new Error('network'),{response:{status:500}},{response:{status:403}},{response:{status:409,data:{error:{code:'OTHER'}}}}])('ordinary mutation failures do not trigger reconciliation %#',error=>expect(classConflictNeedsRefresh(error)).toBe(false));
