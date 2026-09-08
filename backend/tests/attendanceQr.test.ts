import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAttendanceQr, hashAttendanceQr } from '../src/security/attendanceQr.js';
import { qrAttendanceSchema } from '../src/validators/attendance.validator.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({ supabaseAdmin: { rpc } }));
import { manageAttendanceQr, previewQrAttendance, registerQrAttendance } from '../src/controllers/attendanceQr.controller.js';

const gym = '11111111-1111-4111-8111-111111111111';
const member = '22222222-2222-4222-8222-222222222222';
function request(body: unknown, role = 'member') {
  return { body, tenant: { gymId: gym, gymUserId: member, role } } as Request;
}
function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}

describe('QR estático de asistencia', () => {
  beforeEach(() => rpc.mockReset());
  it('genera secretos impredecibles y almacena solo su hash', () => {
    const first = createAttendanceQr(); const second = createAttendanceQr();
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash).toBe(hashAttendanceQr(first.token));
    expect(first.token).not.toBe(second.token);
  });
  it('rechaza el antiguo botón sin QR y la suplantación de sucursal o membresía', () => {
    const { token } = createAttendanceQr();
    for (const body of [{}, { token: 'incorrecto' }, { token, locationId: gym }, { token, membershipId: member }, { token, memberUserId: member }]) {
      expect(qrAttendanceSchema.safeParse(body).success).toBe(false);
    }
  });
  it('deniega el registro a empleados y la gestión a miembros', async () => {
    const { token } = createAttendanceQr();
    await expect(registerQrAttendance(request({ token }, 'staff'), response())).rejects.toMatchObject({ statusCode: 403 });
    await expect(manageAttendanceQr(request({ locationId: gym, action: 'generate' }), response())).rejects.toMatchObject({ statusCode: 403 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('la vista previa usa únicamente identidad autenticada y hash', async () => {
    const { token, hash } = createAttendanceQr();
    rpc.mockResolvedValue({ data: { already_registered: false }, error: null });
    await previewQrAttendance(request({ token }), response());
    expect(rpc).toHaveBeenCalledExactlyOnceWith('preview_attendance_qr_backend', {
      target_gym_id: gym, target_member_id: member, supplied_token_hash: hash,
    });
  });
  it('entrega el secreto una sola vez al owner y envía solamente su hash a SQL', async () => {
    rpc.mockResolvedValue({ data: { id: gym, location_name: 'Principal' }, error: null });
    const res = response();
    await manageAttendanceQr(request({ locationId: gym, action: 'generate' }, 'owner'), res);
    const parameters = rpc.mock.calls[0]?.[1] as Record<string, string>;
    expect(parameters.supplied_token_hash).toMatch(/^[0-9a-f]{64}$/);
    const payload = res.json.mock.calls[0]?.[0] as { token: string; code: { id: string } };
    expect(payload.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parameters.supplied_token_hash).toBe(hashAttendanceQr(payload.token));
    expect(JSON.stringify(parameters)).not.toContain(payload.token);
  });
  it.each([false, true])('devuelve el resultado idempotente (ya registrado: %s)', async (already) => {
    const data = { already_registered: already, attendance: { id: gym } };
    rpc.mockResolvedValue({ data, error: null });
    const res = response();
    await registerQrAttendance(request({ token: createAttendanceQr().token }), res);
    expect(res.status).toHaveBeenCalledWith(already ? 200 : 201);
    expect(res.json).toHaveBeenCalledWith(data);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
  it('traduce QR revocado y horario cerrado sin mostrar detalles SQL', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'ATTENDANCE_QR_INVALID', code: 'P0001' } });
    await expect(registerQrAttendance(request({ token: createAttendanceQr().token }), response())).rejects.toMatchObject({ code: 'ATTENDANCE_QR_INVALID', statusCode: 409 });
    rpc.mockResolvedValue({ data: null, error: { message: 'ATTENDANCE_LOCATION_IS_CLOSED', code: '23514' } });
    await expect(registerQrAttendance(request({ token: createAttendanceQr().token }), response())).rejects.toMatchObject({ code: 'ATTENDANCE_LOCATION_IS_CLOSED', statusCode: 409 });
  });
});
