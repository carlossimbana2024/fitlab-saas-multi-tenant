import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { AppError } from './errors/AppError.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { authRouter } from './routes/auth.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { permissionRouter } from './routes/permission.routes.js';
import { attendanceRouter } from './routes/attendance.routes.js';
import { memberRouter } from './routes/member.routes.js';
import { membershipRouter } from './routes/membership.routes.js';
import { paymentRouter } from './routes/payment.routes.js';
import { planRouter } from './routes/plan.routes.js';
import { calendarRouter } from './routes/calendar.routes.js';
import { cronRouter } from './routes/cron.routes.js';
import { settingsRouter } from './routes/settings.routes.js';
import { billingRouter, stripeWebhookRouter } from './routes/billing.routes.js';
import { chatRouter } from './routes/chat.routes.js';
import { staffRouter } from './routes/staff.routes.js';
import { ownerControlRouter } from './routes/ownerControl.routes.js';

export const app = express();

// Vercel resuelve los tipos condicionales ESM/CJS de Helmet de forma distinta
// al compilador local. La exportación predeterminada sigue siendo la fábrica
// de middleware en tiempo de ejecución.
const createHelmetMiddleware = helmet as unknown as () => express.RequestHandler;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(createHelmetMiddleware());
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || env.frontendOrigins.includes(origin)) return callback(null, true);
    return callback(new AppError(403, 'CORS_ORIGIN_DENIED', 'Origen no autorizado.'));
  },
}));
// Stripe necesita el cuerpo binario exacto para verificar la firma.
app.use('/api/webhooks/stripe', stripeWebhookRouter);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(env.COOKIE_SECRET));

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/permissions', permissionRouter);
app.use('/api/attendances', attendanceRouter);
app.use('/api/members', memberRouter);
app.use('/api/plans', planRouter);
app.use('/api/memberships', membershipRouter);
app.use('/api/member-payments', paymentRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/cron', cronRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/chat', chatRouter);
app.use('/api/staff', staffRouter);
app.use('/api/owner-control', ownerControlRouter);

app.use(notFoundHandler);
app.use(errorHandler);

// Vercel detecta este export como la entrada de la función Express.
// El servidor local continúa iniciándose desde src/server.ts.
export default app;
