import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attendanceTokenFromHash, isAttendanceQrToken, parseAttendanceQr, scannerCameraError } from '../../frontend/src/utils/attendanceQr';

const origin = 'https://fitlab.example';
const token = 'A'.repeat(43);
const poster = `${origin}/check-in#token=${token}`;

describe('Escáner interno: solo códigos de asistencia de sitios autorizados', () => {
  it('reconoce el mismo cartel y fragmento usados por la cámara externa', () => {
    expect(parseAttendanceQr(poster, origin)).toBe(token);
    expect(attendanceTokenFromHash(`#token=${token}`)).toBe(token);
    expect(isAttendanceQrToken(token)).toBe(true);
  });
  it.each([
    token, '/check-in#token=' + token, 'javascript:alert(1)', 'data:text/html,test',
    `https://evil.example/check-in#token=${token}`, `https://fitlab.example.evil.example/check-in#token=${token}`,
    `https://fitlab.example@evil.example/check-in#token=${token}`, `https://evil:password@fitlab.example/check-in#token=${token}`,
    `${origin}/login#token=${token}`, `${origin}/check-in?token=${token}`, `${origin}/check-in?locationId=another#token=${token}`,
    `${poster}&token=${token}`, `${poster}&memberId=another`, `${origin}/check-in#token=short`,
    `${origin}/check-in#token=${'A'.repeat(44)}`, `${origin}/check-in#token=${'A'.repeat(42)}+`,
    `${origin}/check-in#token=${'%41'.repeat(43)}`, ` ${poster}`, `${poster}\n`, `${origin}/che\tck-in#token=${token}`,
    `http://fitlab.example/check-in#token=${token}`, `https://fitlab.example:8443/check-in#token=${token}`, 'x'.repeat(3000),
  ])('rechaza contenido, destino o parámetros inesperados (%#)', value => {
    expect(parseAttendanceQr(value, origin)).toBeNull();
  });
  it('los dominios anteriores requieren autorización explícita y exacta por HTTPS', () => {
    const previous = `https://previous.example/check-in#token=${token}`;
    expect(parseAttendanceQr(previous, origin)).toBeNull();
    expect(parseAttendanceQr(previous, origin, ['https://previous.example'])).toBe(token);
    for (const entry of ['*', 'https://*.example', 'https://previous.example/other', 'http://previous.example', 'https://user:password@previous.example']) {
      expect(parseAttendanceQr(previous, origin, [entry])).toBeNull();
    }
  });
  it('permite únicamente el origen local actual durante las pruebas HTTP', () => {
    expect(parseAttendanceQr(`http://localhost:5173/check-in#token=${token}`, 'http://localhost:5173')).toBe(token);
    expect(parseAttendanceQr(`http://localhost:5174/check-in#token=${token}`, 'http://localhost:5173')).toBeNull();
    expect(parseAttendanceQr(`http://192.168.1.5/check-in#token=${token}`, 'http://192.168.1.5')).toBeNull();
  });
  it('no refleja detalles del dispositivo ni mensajes de error arbitrarios', () => {
    expect(scannerCameraError({ name: 'NotAllowedError' })).toContain('permiso');
    expect(scannerCameraError({ name: 'NotFoundError' })).toContain('No se encontró');
    expect(scannerCameraError({ name: 'NotReadableError' })).toContain('otras aplicaciones');
    expect(scannerCameraError(new Error('sensitive detail'))).not.toContain('sensitive detail');
  });
  it('reutiliza el registro autoritativo de sucursal, fecha y origen QR sin escogerlos en el cliente', () => {
    const root = join(import.meta.dirname, '..', '..');
    const sql = readFileSync(join(root, 'supabase/migrations/0032_static_attendance_qr.sql'), 'utf8');
    const page = readFileSync(join(root, 'frontend/src/pages/CheckInPage.tsx'), 'utf8');
    expect(sql).toContain("(context->>'location_id')::uuid");
    expect(sql).toContain("(context->>'today')::date, 'qr', target_member_id");
    expect(sql).toContain('supplied_token_hash and q.gym_id = target_gym_id');
    expect(page).toContain("api.post<CheckIn>('/attendances/qr/check-in', { token })");
    expect(page).toContain("networkMode: 'always'");
    expect(page).toContain("'my-progress'");
    expect(page).not.toContain('default_location_id');
    expect(page).not.toContain('locationId:');
  });
});
