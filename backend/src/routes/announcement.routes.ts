import { Router } from 'express';
import { archiveAnnouncement, listAnnouncements, publishAnnouncement } from '../controllers/announcement.controller.js';
import { requireOwner } from '../middlewares/requireOwner.js';
import { tenantContext } from '../middlewares/tenantContext.js';
import { verifyJWT } from '../middlewares/verifyJWT.js';
import { databaseRateLimit } from '../middlewares/rateLimit.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const announcementRouter = Router();
announcementRouter.use(verifyJWT, tenantContext);
announcementRouter.get('/', asyncHandler(listAnnouncements));
announcementRouter.use(requireOwner);
const writeLimit = databaseRateLimit({ bucket: 'announcements.write', maximumHits: 20, windowSeconds: 60, subject: (request) => `${request.tenant!.gymId}:${request.tenant!.gymUserId}` });
announcementRouter.post('/', writeLimit, asyncHandler(publishAnnouncement));
announcementRouter.patch('/:id/archive', writeLimit, asyncHandler(archiveAnnouncement));
