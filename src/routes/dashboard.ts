import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/auth.js';
import { managerDashboard, sellerDashboard } from '../services/dashboardService.js';
import { resolvePeriod } from '../utils/period.js';

export const dashboardRouter = Router();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)));
const query = z.object({
  period: z.enum(['hoje', '7dias', 'mes', 'mes_anterior', 'custom']).default('mes'),
  from: day.optional(), to: day.optional(),
}).refine((q) => q.period !== 'custom' || (q.from && q.to && q.from <= q.to && Date.parse(q.to) - Date.parse(q.from) <= 365 * 864e5),
  { message: 'Informe um período personalizado válido (até 1 ano).' });

dashboardRouter.get('/', requireAuth, (req, res) => {
  const user = req.user!;
  if (user.role === 'vendedor') // o vendedor só vê o próprio mês; filtros não se aplicam
    return void res.json(sellerDashboard(user.id, resolvePeriod('mes')));
  const q = query.safeParse(req.query);
  if (!q.success) return void res.status(400).json({ message: q.error.issues[0].message });
  const period = resolvePeriod(q.data.period, new Date(), q.data.from, q.data.to);
  res.json({ ...managerDashboard(period), range: { from: period.days[0], to: period.days[period.days.length - 1] } });
});
