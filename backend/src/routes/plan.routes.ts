import { Router } from 'express';
import { createPlan, listPlans } from '../controllers/plan.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const planRouter = Router();
planRouter.use(verifyJWT, tenantContext);
planRouter.get('/', asyncHandler(listPlans));
planRouter.post('/', checkPermission('members.manage'), asyncHandler(createPlan));
