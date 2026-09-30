import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { membershipPaymentSettingsSchema, prepareMembershipPaymentSchema, reviewMembershipPaymentSchema, submitMembershipPaymentSchema } from '../src/validators/membershipPaymentRequest.validator.js';
import { gymWhatsAppNumber, membershipWhatsAppMessage } from '../../frontend/src/utils/membershipPayments.js';

const mock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } }));
vi.mock('../src/config/supabase.js', () => ({ supabaseAdmin: mock }));
import { getMembershipPaymentProof, prepareMembershipPayment, reviewMembershipPayment, submitMembershipPayment } from '../src/controllers/membershipPaymentRequest.controller.js';

const member = '00000000-0000-4000-8000-000000000001';
const gym = '00000000-0000-4000-8000-000000000002';
const id = '00000000-0000-4000-8000-000000000003';
const request = (body: object = {}, role = 'member') => ({ body, params: { id }, tenant: { gymId: gym, gymUserId: member, role }, permissionContext: { usedPinElevation: false } }) as unknown as Request;
const response = () => ({ json: vi.fn(), setHeader: vi.fn() }) as unknown as Response;

describe('solicitudes de pago de membresía', () => {
  beforeEach(() => vi.clearAllMocks());
  it('exige confirmación bancaria al aprobar y motivo para cada decisión', () => {
    expect(reviewMembershipPaymentSchema.safeParse({ decision: 'approved', reason: 'Verificado' }).success).toBe(false);
    expect(reviewMembershipPaymentSchema.safeParse({ decision: 'approved', reason: 'Verificado', bankVerified: true }).success).toBe(true);
    expect(reviewMembershipPaymentSchema.safeParse({ decision: 'revision_requested', reason: 'X' }).success).toBe(false);
  });
  it('rechaza IDs, precios y rutas inyectados fuera del contrato de entrada', () => {
    expect(prepareMembershipPaymentSchema.safeParse({ planId: id, channel: 'whatsapp', memberId: id }).success).toBe(false);
    expect(submitMembershipPaymentSchema.safeParse({ amount: 30, paidOn: '2026-09-29', method: 'bank_transfer', channel: 'fitlab', proofPath: 'other-gym/file' }).success).toBe(false);
    expect(submitMembershipPaymentSchema.safeParse({ amount: 30.123, paidOn: '2026-09-29', method: 'bank_transfer', channel: 'fitlab' }).success).toBe(false);
    expect(membershipPaymentSettingsSchema.safeParse({ enabled: true, instructions: '', methods: ['bank_transfer'] }).success).toBe(false);
    expect(membershipPaymentSettingsSchema.safeParse({ enabled: true, instructions: 'Banco', methods: ['bank_transfer', 'bank_transfer'] }).success).toBe(false);
  });
  it('un miembro solo puede obtener el archivo de su propio gimnasio y cuenta', async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
    mock.from.mockReturnValue(query);
    await expect(getMembershipPaymentProof(request(), response())).rejects.toMatchObject({ statusCode: 404 });
    expect(query.eq).toHaveBeenCalledWith('gym_id', gym);
    expect(query.eq).toHaveBeenCalledWith('member_user_id', member);
    expect(mock.storage.from).not.toHaveBeenCalled();
  });
  it('el rol owner no puede utilizar la preparación de pagos del miembro', async () => {
    await expect(prepareMembershipPayment(request({}, 'owner'), response())).rejects.toMatchObject({ statusCode: 403 });
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it('un archivo renombrado como PDF nunca se presenta a la aprobación', async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: { proof_path: 'scoped/path', status: 'draft' }, error: null }) };
    mock.from.mockReturnValue(query);
    mock.storage.from.mockReturnValue({ download: vi.fn().mockResolvedValue({ data: new Blob(['<script>falso</script>'], { type: 'application/pdf' }), error: null }) });
    await expect(submitMembershipPayment(request({ amount: 30, paidOn: '2026-09-29', method: 'bank_transfer', channel: 'fitlab' }), response())).rejects.toMatchObject({ code: 'INVALID_PROOF' });
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it('la revisión obtiene gimnasio, actor y elevación del contexto autenticado', async () => {
    mock.rpc.mockResolvedValue({ data: {}, error: null });
    await reviewMembershipPayment(request({ decision: 'approved', reason: 'Verificado', bankVerified: true }, 'owner'), response());
    expect(mock.rpc).toHaveBeenCalledWith('review_membership_payment_request_backend', expect.objectContaining({ g: gym, actor: member, r: id, elevated: false }));
  });
  it('WhatsApp utiliza un número válido y recuerda adjuntar el comprobante', () => {
    expect(gymWhatsAppNumber('099 123 4567')).toBe('593991234567');
    expect(gymWhatsAppNumber('+593 99 123 4567')).toBe('593991234567');
    expect(gymWhatsAppNumber('javascript:alert(1)')).toBeNull();
    const message = membershipWhatsAppMessage('María', member, { id, plan_snapshot: { name: 'Mensual' }, amount: 30, currency: 'USD', paid_on: '2026-09-29' } as never);
    expect(message).toContain('María'); expect(message).toContain(id); expect(message).toContain('2026-09-29');
  });
});
