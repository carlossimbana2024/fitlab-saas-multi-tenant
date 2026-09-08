import { Router } from 'express';
import { getReceptionOverview, listAttendances, listStreaks, listWeeklyProgress, registerStaffAttendance, voidAttendance } from '../controllers/attendance.controller.js';
import { listAttendanceQr, manageAttendanceQr, previewQrAttendance, registerQrAttendance } from '../controllers/attendanceQr.controller.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { databaseRateLimit, requestNetworkKey } from '../middlewares/rateLimit.js';

export const attendanceRouter = Router();
attendanceRouter.use(verifyJWT, tenantContext);
attendanceRouter.get('/reception', checkPermission('members.view'), asyncHandler(getReceptionOverview));
attendanceRouter.get('/', asyncHandler(listAttendances));
attendanceRouter.get('/streaks', asyncHandler(listStreaks));
attendanceRouter.get('/weekly-progress', asyncHandler(listWeeklyProgress));
const qrMemberLimit = databaseRateLimit({
  bucket: 'attendance.qr', maximumHits: 10, windowSeconds: 60,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
});
// Margen para numerosos miembros en el Wi-Fi compartido del gimnasio.
const qrNetworkLimit = databaseRateLimit({ bucket: 'attendance.qr.network', maximumHits: 300, windowSeconds: 60, subject: requestNetworkKey });
attendanceRouter.get('/qr/codes', asyncHandler(listAttendanceQr));
attendanceRouter.post('/qr/codes', databaseRateLimit({
  bucket: 'attendance.qr.manage', maximumHits: 10, windowSeconds: 60,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
}), asyncHandler(manageAttendanceQr));
attendanceRouter.post('/qr/preview', qrNetworkLimit, qrMemberLimit, asyncHandler(previewQrAttendance));
attendanceRouter.post('/qr/check-in', qrNetworkLimit, qrMemberLimit, asyncHandler(registerQrAttendance));
attendanceRouter.post('/qr', qrNetworkLimit, qrMemberLimit, asyncHandler(registerQrAttendance));
attendanceRouter.post('/staff', databaseRateLimit({
  bucket: 'attendance.staff', maximumHits: 60, windowSeconds: 60,
  subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}`,
}), checkPermission('attendance.register'), asyncHandler(registerStaffAttendance));
attendanceRouter.patch('/:id/void', checkPermission('attendance.void'), asyncHandler(voidAttendance));
