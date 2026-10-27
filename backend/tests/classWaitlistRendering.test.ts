import { describe, expect, it, vi } from 'vitest';
import { React, MemoryRouter, renderToStaticMarkup, pageComponents, ClassWaitlistOffer, waitlistHelpers } from './helpers/class-economics-render.js';

const { ClassCard, ClassSummary } = pageComponents('MemberPortalPage.tsx', 'function classReferenceIssue', 'function ProgressView', ['ClassCard', 'ClassSummary']);
const { Roster } = pageComponents('ActivitiesPage.tsx', 'function Roster', undefined, ['Roster']);
const clock = '2026-10-26T12:00:00Z';
const entry = { id: 'queue-id', position: 3, status: 'offered', state: 'offered', offer_id: 'offer-id', expires_at: '2026-10-26T12:30:00Z' };
const schedule = () => ({ id: 's', status: 'scheduled', starts_at: '2026-10-27T18:00:00Z', ends_at: '2026-10-27T19:00:00Z', available: 1, occupied: 8, offeredCount: 1, capacity: 10,
  activity: { name: 'Boxeo', is_active: true, billing_mode: 'included', price: 0, currency: 'USD' }, location: { name: 'Centro', is_active: true }, myWaitlist: null });
const render = (Component: any, props: any) => renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Component, props)));
const card = (extra: any = {}, props: any = {}) => render(ClassCard, { schedule: { ...schedule(), ...extra }, membership: { id: 'membership' }, serverTime: clock, ...props });
function findNode(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props?.children)) {
    const found = findNode(child, predicate); if (found) return found;
  }
  return null;
}

describe('FIT-MEMBER-005 component states', () => {
  it('offers a direct reservation when there is real unheld availability', () => {
    expect(card()).toContain('Reservar</button>');
    expect(card()).not.toContain('Unirme a lista');
  });
  it.each(['included', 'additional_fee'])('full %s class offers waitlist, not a disabled reservation', billing_mode => {
    const html = card({ available: 0, activity: { ...schedule().activity, billing_mode, price: 5 } });
    expect(html).toContain('Clase llena'); expect(html).toContain('Unirme a lista de espera');
    expect(html).toContain('ni congela el precio'); expect(html).not.toContain('Reservar · pagar');
  });
  it('shows the exact backend position and leave action without inventing position 1', () => {
    const html = card({ myWaitlist: { ...entry, status: 'waiting', state: 'waiting', position: 7, offer_id: null }, available: 0 });
    expect(html).toContain('Espera #7'); expect(html).toContain('Salir de lista'); expect(html).not.toContain('Aceptar cupo');
  });
  it('explains the disabled rollout without pretending an automatic offer is running', () => {
    expect(card({ myWaitlist: { ...entry, status: 'waiting' } }, { offersEnabled: false })).toContain('aún no está habilitada');
  });
  it('active offer exposes accept/reject and a server-time-derived countdown', () => {
    const html = card({ myWaitlist: entry, available: 0 });
    expect(html).toContain('Se liberó un cupo'); expect(html).toContain('Aceptar cupo'); expect(html).toContain('Rechazar');
    expect(html).toContain('30:00'); expect(html).not.toContain('Reserva confirmada'); expect(html).not.toContain('Salir de lista');
  });
  it('accept/reject callbacks use the explicit offer flow, never direct reservation', () => {
    const onAcceptOffer = vi.fn(); const onLeaveWaitlist = vi.fn(); const onReserve = vi.fn();
    const tree = ClassCard({ schedule: { ...schedule(), myWaitlist: entry }, serverTime: clock, onAcceptOffer, onLeaveWaitlist, onReserve });
    const offer = findNode(tree, node => node.type === ClassWaitlistOffer);
    expect(offer).toBeTruthy(); offer.props.onAccept(); offer.props.onReject();
    expect(onAcceptOffer).toHaveBeenCalledWith('offer-id'); expect(onLeaveWaitlist).toHaveBeenCalledOnce(); expect(onReserve).not.toHaveBeenCalled();
  });
  it('join and leave callbacks remain separate from booking an offered seat', () => {
    const onJoinWaitlist = vi.fn(); const onLeaveWaitlist = vi.fn();
    const full = ClassCard({ schedule: { ...schedule(), available: 0 }, membership: { id: 'm' }, serverTime: clock, onJoinWaitlist });
    findNode(full, node => node.type === 'button' && node.props.onClick === onJoinWaitlist).props.onClick();
    const waiting = ClassCard({ schedule: { ...schedule(), myWaitlist: { ...entry, status: 'waiting', offer_id: null } }, serverTime: clock, onLeaveWaitlist });
    findNode(waiting, node => node.type === 'button' && node.props.onClick === onLeaveWaitlist).props.onClick();
    expect(onJoinWaitlist).toHaveBeenCalledOnce(); expect(onLeaveWaitlist).toHaveBeenCalledOnce();
  });
  it('a locally elapsed offer asks the server instead of claiming an authoritative expiration', () => {
    const html = card({ myWaitlist: { ...entry, expires_at: '2026-10-26T11:59:00Z' }, available: 0 });
    expect(html).toContain('Verificando disponibilidad'); expect(html).toContain('Aceptar cupo'); expect(html).not.toContain('Oferta expirada');
  });
  it('does not invent a deadline when server time is absent', () => {
    expect(card({ myWaitlist: entry }, { serverTime: undefined })).toContain('Consulta la vigencia al aceptar');
  });
  it('expiration/rejection returned as no active entry restores current server options', () => {
    expect(card({ myWaitlist: null, available: 0 })).toContain('Unirme a lista de espera');
    expect(card({ myWaitlist: null, available: 1 })).toContain('Reservar</button>');
    expect(card({ myWaitlist: null })).not.toContain('Aceptar cupo');
  });
  it.each(['activity', 'location'])('inactive %s never offers reserve, join or acceptance', field => {
    const s: any = schedule(); s[field].is_active = false;
    const html = card({ ...s, myWaitlist: entry });
    expect(html).toContain('no disponible'); expect(html).not.toContain('Aceptar cupo'); expect(html).not.toContain('Unirme a lista');
  });
  it('started classes are explicitly unavailable', () => {
    const html = card({ starts_at: '2026-10-26T11:00:00Z', myWaitlist: entry });
    expect(html).toContain('La clase ya inició'); expect(html).not.toContain('Aceptar cupo');
  });
  it('pending actions block repeated acceptance and rejection', () => {
    const html = render(ClassWaitlistOffer, { entry, serverTime: clock, busy: true });
    expect(html.match(/disabled=""/g)).toHaveLength(2); expect(html).toContain('Procesando');
  });
  it('disabling the engine blocks accept but does not prevent voluntary rejection', () => {
    const html = render(ClassWaitlistOffer, { entry, serverTime: clock, disabled: true });
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });
  it('home communicates current position or active offer without claiming a booking', () => {
    expect(render(ClassSummary, { schedule: { ...schedule(), myWaitlist: entry } })).toContain('abre Clases para responder');
    expect(render(ClassSummary, { schedule: { ...schedule(), myWaitlist: { ...entry, status: 'waiting' } } })).toContain('posición #3');
  });
  it('reception distinguishes occupying bookings, held offers and real free seats', () => {
    const html = render(Roster, { schedule: schedule(), bookings: [], canBook: true });
    expect(html).toContain('8'); expect(html).toContain('reservados/asistieron'); expect(html).toContain('cupos ofrecidos temporalmente');
  });
});

describe('waitlist clock and query refresh contract', () => {
  it('reports the actual server outcome if a rejection races expiry or acceptance', () => {
    expect(waitlistHelpers.waitlistExitNotice('rejected')).toContain('Rechazaste');
    expect(waitlistHelpers.waitlistExitNotice('expired')).toContain('según el servidor');
    expect(waitlistHelpers.waitlistExitNotice('accepted')).toContain('ya fue aceptada');
    expect(waitlistHelpers.waitlistExitNotice('cancelled')).toContain('cerrada');
    expect(waitlistHelpers.waitlistExitNotice(undefined)).not.toContain('Rechazaste');
  });
  it('uses server timestamp plus monotonic elapsed, not the phone wall clock', () => {
    expect(waitlistHelpers.offerRemainingSeconds(entry.expires_at, clock, 61_000)).toBe(1739);
    expect(waitlistHelpers.offerRemainingSeconds(entry.expires_at, clock, 3_600_000)).toBe(0);
    expect(waitlistHelpers.offerRemainingSeconds(entry.expires_at, undefined)).toBeNull();
  });
  it('never polls without a queue, uses moderate intervals for waiting/offered states', () => {
    expect(waitlistHelpers.classWaitlistPollInterval([])).toBe(false);
    expect(waitlistHelpers.classWaitlistPollInterval([{ myWaitlist: { status: 'waiting' } }])).toBe(60_000);
    expect(waitlistHelpers.classWaitlistPollInterval([{ myWaitlist: entry }])).toBe(30_000);
  });
  it('invalidates Home, Classes/history, reception availability and summary', async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    await waitlistHelpers.refreshClassQueries({ invalidateQueries });
    expect(invalidateQueries.mock.calls.map(([options]) => options.queryKey)).toEqual([['my-activities'], ['activities'], ['activity-summary']]);
  });
});
