import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { authRouter } from './routes/auth.js';
import { clientsRouter } from './routes/clients.js';
import { ordersRouter } from './routes/orders.js';
import { dashboardRouter } from './routes/dashboard.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    ...helmet.contentSecurityPolicy.getDefaultDirectives(),
    'style-src': ["'self'", 'https:', "'unsafe-inline'"], 'font-src': ["'self'", 'https:', 'data:'],
  } } }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api/auth', authRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/clients', clientsRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api', (_req, res) => res.status(404).json({ message: 'Rota não encontrada.' }));

  // Em produção o próprio servidor entrega o frontend compilado.
  const dist = path.resolve(process.cwd(), '../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ message: 'Erro interno. Tente novamente.' });
  });
  return app;
}
