// Mock the SQL result, not production logic: the real aggregation/FIFO/expiry
// is exercised separately by supabase/tests/0051_class_waitlist_offers.sql.
export function activityStateFixture(tables: Record<string, any[]>, args: any) {
  const serverTime = new Date().toISOString();
  return {
    server_time: serverTime, offers_enabled: false,
    sessions: (tables.class_schedules ?? [])
      .filter(s => s.gym_id === args.target_gym_id && args.target_schedule_ids.includes(s.id))
      .map(s => {
        const activity = tables.extra_classes?.find(a => a.id === s.extra_class_id && a.gym_id === args.target_gym_id);
        const capacity = s.capacity_override ?? activity?.capacity ?? 0;
        const occupied = (tables.class_bookings ?? []).filter(b => b.gym_id === args.target_gym_id
          && b.class_schedule_id === s.id && ['reserved', 'attended'].includes(b.status)).length;
        const offers = (tables.class_waitlist_offers ?? []).filter(o => o.gym_id === args.target_gym_id
          && o.class_schedule_id === s.id && o.status === 'offered' && Date.parse(o.expires_at) > Date.parse(serverTime));
        const ordered = (tables.class_waitlists ?? []).filter(w => w.gym_id === args.target_gym_id
          && w.class_schedule_id === s.id && ['waiting', 'offered'].includes(w.status))
          .sort((a, b) => (a.joined_at ?? '').localeCompare(b.joined_at ?? '') || a.id.localeCompare(b.id));
        const queue = ordered.map((w, index) => {
          const offer = offers.find(o => o.waitlist_id === w.id);
          return { id: w.id, member_user_id: w.member_user_id, status: w.status, state: w.status,
            position: index + 1, joined_at: w.joined_at ?? '2026-10-01T00:00:00Z',
            offer_id: offer?.id ?? null, offered_at: offer?.offered_at ?? null, expires_at: offer?.expires_at ?? null };
        });
        const actor = tables.gym_users?.find(u => u.id === args.target_actor_gym_user_id);
        const visible = actor?.role === 'owner' || args.target_actor_gym_user_id === 'owner'
          ? queue : queue.filter(w => w.member_user_id === args.target_actor_gym_user_id);
        return { class_schedule_id: s.id, capacity, occupied, offered_count: offers.length,
          available: Math.max(0, capacity - occupied - offers.length), waitlist: visible,
          myWaitlist: queue.find(w => w.member_user_id === args.target_actor_gym_user_id) ?? null };
      }),
  };
}
