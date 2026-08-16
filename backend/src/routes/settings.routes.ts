import { Router } from 'express';
import { getSettings, updateGymSettings, updateLocationSettings, updateReceiptBranding } from '../controllers/settings.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const settingsRouter = Router();
settingsRouter.use(verifyJWT, tenantContext);
settingsRouter.get('/', asyncHandler(getSettings));
settingsRouter.put('/gym', checkPermission('settings.manage'), asyncHandler(updateGymSettings));
settingsRouter.put('/receipt-branding', checkPermission('settings.manage'), asyncHandler(updateReceiptBranding));
settingsRouter.put('/locations/:id', checkPermission('settings.manage'), asyncHandler(updateLocationSettings));
