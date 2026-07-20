import { Router } from 'express';
import { getCalendar, saveException, saveSchedule } from '../controllers/calendar.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const calendarRouter = Router();
calendarRouter.use(verifyJWT, tenantContext);
calendarRouter.get('/', asyncHandler(getCalendar));
calendarRouter.put('/schedule', checkPermission('calendar.manage'), asyncHandler(saveSchedule));
calendarRouter.post('/exceptions', checkPermission('calendar.manage'), asyncHandler(saveException));
