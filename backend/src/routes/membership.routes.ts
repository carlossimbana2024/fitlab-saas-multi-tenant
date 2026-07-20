import { Router } from 'express';
import { listMemberships, manualCheckout } from '../controllers/membership.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const membershipRouter = Router();
membershipRouter.use(verifyJWT, tenantContext);
membershipRouter.get('/', asyncHandler(listMemberships));
membershipRouter.post('/manual-checkout', checkPermission('payments.register'), asyncHandler(manualCheckout));
