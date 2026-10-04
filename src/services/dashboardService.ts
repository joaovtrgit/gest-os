import { config } from '../config.js';
import { db } from '../db.js';
import { lastMonths, previousPeriod, sqlTime, type Period } from '../utils/period.js';

const OPEN = "('recebida','em_analise','aguardando_aprovacao','aguardando_peca','em_manutencao')";
const IN_PROGRESS = "('em_analise','aguardando_peca','em_manutencao')";
const DONE = "('concluida','entregue')";
const tz = `${config.tzOffsetHours} hours`;
const one = <T>(sql: string, params: object): T => db.prepare(sql).get(params) as T;
const iso = (s: string) => s.replace(' ', 'T') + 'Z';

function kpis(p: Period, uid: number | null) {
  const a = { s: sqlTime(p.start), e: sqlTime(p.end), uid };
  const rev = one<{ net: number; gross: number; n: number }>(
    `SELECT COALESCE(SUM(gross_cents - discount_cents),0) net, COALESCE(SUM(gross_cents),0) gross, COUNT(*) n
       FROM revenue_entries WHERE at >= @s AND at < @e AND (@uid IS NULL OR user_id = @uid)`, a);
  const count = (where: string) =>
    one<{ n: number }>(`SELECT COUNT(*) n FROM service_orders WHERE ${where} AND (@uid IS NULL OR user_id = @uid)`, a).n;
  return {
    revenueCents: rev.net,
    salesCount: one<{ n: number }>(`SELECT COUNT(*) n FROM sales WHERE sold_at >= @s AND sold_at < @e AND (@uid IS NULL OR user_id = @uid)`, a).n,
    openOrders: count(`status IN ${OPEN}`),
    awaitingApproval: count(`status = 'aguardando_aprovacao'`),
    inProgress: count(`status IN ${IN_PROGRESS}`),
    completedOrders: count(`status IN ${DONE} AND completed_at >= @s AND completed_at < @e`),
    servicesDone: one<{ n: number }>(
      `SELECT COALESCE(SUM(i.quantity),0) n FROM order_items i JOIN service_orders o ON o.id = i.order_id
        WHERE i.kind = 'servico' AND o.status IN ${DONE} AND o.completed_at >= @s AND o.completed_at < @e
          AND (@uid IS NULL OR o.user_id = @uid)`, a).n,
    averageTicketCents: rev.n ? Math.round(rev.net / rev.n) : 0,
  };
}

function daily(p: Period) {
  const rows = db.prepare(
    `SELECT date(at, @tz) d, SUM(gross_cents - discount_cents) v FROM revenue_entries WHERE at >= @s AND at < @e GROUP BY d`
  ).all({ tz, s: sqlTime(p.start), e: sqlTime(p.end) }) as { d: string; v: number }[];
  const map = new Map(rows.map((r) => [r.d, r.v]));
  return p.days.map((date) => ({ date, valueCents: map.get(date) ?? 0 }));
}

export function sellerDashboard(userId: number, p: Period) {
  return { scope: 'vendedor' as const, kpis: kpis(p, userId) };
}

export function managerDashboard(p: Period) {
  const a = { s: sqlTime(p.start), e: sqlTime(p.end) };
  const months = lastMonths(6);
  const monthRows = db.prepare(
    `SELECT strftime('%Y-%m', sold_at, @tz) m, COUNT(*) n,
            SUM(COALESCE((SELECT SUM(quantity * unit_price_cents) FROM sale_items WHERE sale_id = sales.id),0) - discount_cents) v
       FROM sales WHERE sold_at >= @from GROUP BY m`
  ).all({ tz, from: `${months[0]}-01 00:00:00` }) as { m: string; n: number; v: number }[];
  const byMonth = new Map(monthRows.map((r) => [r.m, r]));

  return {
    scope: 'gerente' as const,
    kpis: kpis(p, null),
    revenueByDay: daily(p),
    previousRevenueByDay: daily(previousPeriod(p)),
    salesByMonth: months.map((m) => ({ month: m, count: byMonth.get(m)?.n ?? 0, valueCents: byMonth.get(m)?.v ?? 0 })),
    revenueBySeller: db.prepare(
      `SELECT u.id, u.name, SUM(r.gross_cents - r.discount_cents) AS valueCents, COUNT(*) AS count
         FROM revenue_entries r JOIN users u ON u.id = r.user_id
        WHERE r.at >= @s AND r.at < @e GROUP BY u.id ORDER BY valueCents DESC`).all(a),
    ordersByStatus: db.prepare(`SELECT status, COUNT(*) AS count FROM service_orders GROUP BY status`).all(),
    recentActivity: (db.prepare(
      `SELECT a.id, a.action, a.created_at AS at, u.name AS userName FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.action NOT IN ('login_falhou','login_recusado') ORDER BY a.id DESC LIMIT 10`).all() as any[])
      .map((r) => ({ ...r, at: iso(r.at) })),
  };
}
