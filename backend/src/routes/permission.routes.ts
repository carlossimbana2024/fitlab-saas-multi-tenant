import { Router } from 'express';
import { createElevation } from '../controllers/permission.controller.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const permissionRouter = Router();
permissionRouter.use(verifyJWT, tenantContext);
permissionRouter.post('/elevate', asyncHandler(createElevation));
