import { Router } from 'express';
import { listAttendances, listStreaks, listWeeklyProgress, registerQrAttendance, registerStaffAttendance, voidAttendance } from '../controllers/attendance.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { databaseRateLimit } from '../middlewares/rateLimit.js';

export const attendanceRouter = Router();
attendanceRouter.use(verifyJWT, tenantContext);
attendanceRouter.get('/', asyncHandler(listAttendances));
attendanceRouter.get('/streaks', asyncHandler(listStreaks));
attendanceRouter.get('/weekly-progress', asyncHandler(listWeeklyProgress));
attendanceRouter.post('/qr', databaseRateLimit({
  bucket: 'attendance.qr', maximumHits: 10, windowSeconds: 60,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
}), asyncHandler(registerQrAttendance));
attendanceRouter.post('/staff', databaseRateLimit({
  bucket: 'attendance.staff', maximumHits: 60, windowSeconds: 60,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
}), checkPermission('attendance.register'), asyncHandler(registerStaffAttendance));
attendanceRouter.patch('/:id/void', checkPermission('attendance.void'), asyncHandler(voidAttendance));
