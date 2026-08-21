import { Router } from 'express';
import { getOwnerReport, listOwnerAudit } from '../controllers/ownerControl.controller.js';
import { requireOwner } from '../middlewares/requireOwner.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const ownerControlRouter = Router();

ownerControlRouter.use(verifyJWT, tenantContext, requireOwner);
ownerControlRouter.get('/report', asyncHandler(getOwnerReport));
ownerControlRouter.get('/audit', asyncHandler(listOwnerAudit));
