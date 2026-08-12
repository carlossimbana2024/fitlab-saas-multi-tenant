import { Router } from 'express';
import { createElevation, setAdminPin } from '../controllers/permission.controller.js';
import { databaseRateLimit } from '../middlewares/rateLimit.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const permissionRouter = Router();
permissionRouter.use(verifyJWT, tenantContext);
permissionRouter.post('/elevate', databaseRateLimit({
  bucket: 'security.admin_pin_elevate', maximumHits: 5, windowSeconds: 900,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
}), asyncHandler(createElevation));
permissionRouter.put('/admin-pin', databaseRateLimit({
  bucket: 'security.admin_pin_update', maximumHits: 5, windowSeconds: 3600,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
}), asyncHandler(setAdminPin));
