import { Router } from 'express';
import {
  cancelClassSchedule,
  cancelManagedClassBooking,
  cancelOwnClassBooking,
  createActivity,
  createClassSchedule,
  getClassReceipt,
  listActivities,
  markClassAttendance,
  refundClassBooking,
  reserveClassForMember,
  reserveClassForSelf,
  updateActivity,
} from '../controllers/activity.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const activityRouter = Router();
activityRouter.use(verifyJWT, tenantContext);
activityRouter.get('/', asyncHandler(listActivities));
activityRouter.post('/catalog', checkPermission('classes.manage'), asyncHandler(createActivity));
activityRouter.put('/catalog/:id', checkPermission('classes.manage'), asyncHandler(updateActivity));
activityRouter.post('/schedules', checkPermission('classes.manage'), asyncHandler(createClassSchedule));
activityRouter.patch('/schedules/:id/cancel', checkPermission('classes.manage'), asyncHandler(cancelClassSchedule));
activityRouter.post('/schedules/:id/bookings/self', asyncHandler(reserveClassForSelf));
activityRouter.post('/schedules/:id/bookings', checkPermission('classes.bookings_manage'), asyncHandler(reserveClassForMember));
activityRouter.patch('/bookings/:id/cancel-self', asyncHandler(cancelOwnClassBooking));
activityRouter.patch('/bookings/:id/cancel', checkPermission('classes.bookings_manage'), asyncHandler(cancelManagedClassBooking));
activityRouter.patch('/bookings/:id/attendance', checkPermission('classes.attendance_manage'), asyncHandler(markClassAttendance));
activityRouter.patch('/bookings/:id/refund', checkPermission('payments.void'), asyncHandler(refundClassBooking));
activityRouter.get('/bookings/:id/receipt', asyncHandler(getClassReceipt));
