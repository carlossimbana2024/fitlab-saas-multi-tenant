import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({ supabaseAdmin: { from } }));
vi.mock('../src/services/audit.service.js', () => ({ writeAuditLog: vi.fn() }));
import { archiveAnnouncement, listAnnouncements, publishAnnouncement } from '../src/controllers/announcement.controller.js';

const gymId = '00000000-0000-4000-8000-000000000001';
const branchId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';
const announcementId = '00000000-0000-4000-8000-000000000004';
const request = (role: string, defaultLocationId: string | null = branchId) => ({
  tenant: { gymId, gymUserId: userId, role, defaultLocationId }, body: { body: 'Aviso de prueba', locationId: null }, params: { id: announcementId },
}) as unknown as Request;
const response = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() }) as unknown as Response;

function query(data: unknown) {
  const result = { data, error: null };
  const builder = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result), single: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  return builder;
}

beforeEach(() => from.mockReset());

describe('aislamiento de avisos generales', () => {
  it('filtra los avisos del miembro por gimnasio y sucursal asignada', async () => {
    const announcements = query([]);
    from.mockReturnValue(announcements);
    await listAnnouncements(request('member'), response());
    expect(from).toHaveBeenCalledTimes(1);
    expect(announcements.eq).toHaveBeenCalledWith('gym_id', gymId);
    expect(announcements.eq).toHaveBeenCalledWith('status', 'published');
    expect(announcements.or).toHaveBeenCalledWith(`location_id.is.null,location_id.eq.${branchId}`);
  });

  it('solo entrega avisos generales al miembro sin sucursal asignada', async () => {
    const announcements = query([]);
    from.mockReturnValue(announcements);
    await listAnnouncements(request('member', null), response());
    expect(announcements.is).toHaveBeenCalledWith('location_id', null);
  });

  it('rechaza personal y miembros cuando intentan publicar', async () => {
    await expect(listAnnouncements(request('staff'), response())).rejects.toMatchObject({ statusCode: 403 });
    await expect(publishAnnouncement(request('member'), response())).rejects.toMatchObject({ statusCode: 403 });
    expect(from).not.toHaveBeenCalled();
  });

  it('no publica en una sucursal que no pertenece al gimnasio', async () => {
    const locations = query(null);
    from.mockReturnValue(locations);
    const owner = request('owner');
    owner.body.locationId = branchId;
    await expect(publishAnnouncement(owner, response())).rejects.toMatchObject({ statusCode: 404 });
    expect(locations.eq).toHaveBeenCalledWith('gym_id', gymId);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('limita el retiro del aviso al gimnasio del owner', async () => {
    const announcements = query(null);
    from.mockReturnValue(announcements);
    await expect(archiveAnnouncement(request('owner'), response())).rejects.toMatchObject({ statusCode: 404 });
    expect(announcements.eq).toHaveBeenCalledWith('id', announcementId);
    expect(announcements.eq).toHaveBeenCalledWith('gym_id', gymId);
  });
});
