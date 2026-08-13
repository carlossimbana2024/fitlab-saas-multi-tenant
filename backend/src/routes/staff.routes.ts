import { Router } from 'express';
import { inviteStaff, listStaff, reinstateStaff, removeStaff, revokeStaffInvitation, updateStaffPermissions, updateStaffStatus } from '../controllers/staff.controller.js';
import { databaseRateLimit } from '../middlewares/rateLimit.js';
import { requireOwner } from '../middlewares/requireOwner.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const staffRouter = Router();
staffRouter.use(verifyJWT, tenantContext, requireOwner);
staffRouter.get('/', asyncHandler(listStaff));
staffRouter.post('/invite', databaseRateLimit({
  bucket: 'staff.invite', maximumHits: 20, windowSeconds: 3600,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
}), asyncHandler(inviteStaff));
staffRouter.put('/:id/permissions', asyncHandler(updateStaffPermissions));
staffRouter.patch('/:id/status', asyncHandler(updateStaffStatus));
staffRouter.post('/:id/reinstate', asyncHandler(reinstateStaff));
staffRouter.delete('/invitations/:id', asyncHandler(revokeStaffInvitation));
staffRouter.delete('/:id', asyncHandler(removeStaff));
