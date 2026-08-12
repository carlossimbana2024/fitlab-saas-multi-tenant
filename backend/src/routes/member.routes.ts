import { Router } from 'express';
import { createManagedMember, getMember, inviteMember, listMembers, revokeInvitation, updateMyProfile } from '../controllers/member.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { databaseRateLimit } from '../middlewares/rateLimit.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const memberRouter = Router();
memberRouter.use(verifyJWT, tenantContext);
memberRouter.get('/', checkPermission('members.view'), asyncHandler(listMembers));
memberRouter.post('/invite', databaseRateLimit({
  bucket: 'members.invite', maximumHits: 20, windowSeconds: 3600,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
}), checkPermission('members.manage'), asyncHandler(inviteMember));
memberRouter.post('/managed', databaseRateLimit({
  bucket: 'members.managed_create', maximumHits: 60, windowSeconds: 3600,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
}), checkPermission('members.manage'), asyncHandler(createManagedMember));
memberRouter.delete('/invitations/:id', checkPermission('members.manage'), asyncHandler(revokeInvitation));
memberRouter.put('/me/profile', asyncHandler(updateMyProfile));
memberRouter.get('/:id', checkPermission('members.view'), asyncHandler(getMember));
