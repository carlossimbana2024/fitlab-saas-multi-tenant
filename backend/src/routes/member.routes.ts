import { Router } from 'express';
import { getMember, inviteMember, listMembers, updateMyProfile } from '../controllers/member.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const memberRouter = Router();
memberRouter.use(verifyJWT, tenantContext);
memberRouter.get('/', checkPermission('members.view'), asyncHandler(listMembers));
memberRouter.post('/invite', checkPermission('members.manage'), asyncHandler(inviteMember));
memberRouter.put('/me/profile', asyncHandler(updateMyProfile));
memberRouter.get('/:id', checkPermission('members.view'), asyncHandler(getMember));
