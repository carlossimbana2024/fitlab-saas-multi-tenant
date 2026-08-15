import { Router } from 'express';
import { convertMemberToPortal, createManagedMember, getMember, inviteMember, listMembers, reinstateMember, retireMember, revokeInvitation, updateMember, updateMemberStatus, updateMyProfile } from '../controllers/member.controller.js';
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
memberRouter.put('/:id', checkPermission('members.manage'), asyncHandler(updateMember));
memberRouter.patch('/:id/status', checkPermission('members.manage'), asyncHandler(updateMemberStatus));
memberRouter.delete('/:id', checkPermission('members.manage'), asyncHandler(retireMember));
memberRouter.post('/:id/reinstate', checkPermission('members.manage'), asyncHandler(reinstateMember));
memberRouter.post('/:id/convert-to-portal', databaseRateLimit({
  bucket: 'members.convert_to_portal', maximumHits: 10, windowSeconds: 3600,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
}), checkPermission('members.manage'), asyncHandler(convertMemberToPortal));
memberRouter.get('/:id', checkPermission('members.view'), asyncHandler(getMember));
