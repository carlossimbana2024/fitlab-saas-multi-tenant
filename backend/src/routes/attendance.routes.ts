import { Router } from 'express';
import { listAttendances, listStreaks, listWeeklyProgress, registerQrAttendance, registerStaffAttendance, voidAttendance } from '../controllers/attendance.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const attendanceRouter = Router();
attendanceRouter.use(verifyJWT, tenantContext);
attendanceRouter.get('/', asyncHandler(listAttendances));
attendanceRouter.get('/streaks', asyncHandler(listStreaks));
attendanceRouter.get('/weekly-progress', asyncHandler(listWeeklyProgress));
attendanceRouter.post('/qr', asyncHandler(registerQrAttendance));
attendanceRouter.post('/staff', checkPermission('attendance.register'), asyncHandler(registerStaffAttendance));
attendanceRouter.patch('/:id/void', checkPermission('attendance.void'), asyncHandler(voidAttendance));
