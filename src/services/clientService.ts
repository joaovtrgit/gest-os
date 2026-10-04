import { db } from '../db.js';
import { isoUtc } from '../utils/period.js';

export interface ClientRow {
  id: number; name: string; document: string | null; phone: string | null; whatsapp: string | null;
  email: string | null; address: string | null; notes: string | null; created_at: string;
}
const present = (c: ClientRow) => ({
  id: c.id, name: c.name, document: c.document, phone: c.phone, whatsapp: c.whatsapp,
  email: c.email, address: c.address, notes: c.notes, createdAt: isoUtc(c.created_at),
});

const ITEMS_TOTAL = '(SELECT COALESCE(SUM(quantity * unit_price_cents),0) FROM %T WHERE %K = %ID)';
const orderTotal = `(${ITEMS_TOTAL.replace('%T', 'order_items').replace('%K', 'order_id').replace('%ID', 'o.id')} - o.discount_cents)`;
const saleTotal = `(${ITEMS_TOTAL.replace('%T', 'sale_items').replace('%K', 'sale_id').replace('%ID', 's.id')} - s.discount_cents)`;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

// uid = null → gerente (vê tudo); número → vendedor (as contagens consideram só as ordens dele).
export function listClients(q: string, page: number, pageSize: number, uid: number | null) {
  const text = q.trim(), d = text.replace(/\D/g, '');
  const where: string[] = [], p: Record<string, unknown> = { uid };
  if (text) {
    p.like = `%${escapeLike(text)}%`;
    where.push("fold(c.name) LIKE fold(@like) ESCAPE '\\'", "fold(c.email) LIKE fold(@like) ESCAPE '\\'");
    if (d.length >= 3) { p.dl = `%${d}%`; where.push('c.document LIKE @dl', 'c.phone LIKE @dl', 'c.whatsapp LIKE @dl'); }
  }
  const cond = where.length ? `WHERE ${where.join(' OR ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) n FROM clients c ${cond}`).get(p) as { n: number }).n;
  const rows = db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM service_orders o WHERE o.client_id = c.id AND (@uid IS NULL OR o.user_id = @uid)) AS orders_count
       FROM clients c ${cond} ORDER BY fold(c.name), c.id LIMIT @limit OFFSET @offset`
  ).all({ ...p, limit: pageSize, offset: (page - 1) * pageSize }) as (ClientRow & { orders_count: number })[];
  return { items: rows.map((r) => ({ ...present(r), ordersCount: r.orders_count })), total, page, pageSize };
}

export const findClient = (id: number) => db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow | undefined;

export function clientDetail(c: ClientRow, uid: number | null) {
  const orders = db.prepare(
    `SELECT o.id, o.opened_at, o.completed_at, o.equipment, o.brand, o.model, o.serial_number, o.status, o.reported_issue,
            u.name AS responsible, ${orderTotal} AS total_cents
       FROM service_orders o JOIN users u ON u.id = o.user_id
      WHERE o.client_id = @id AND (@uid IS NULL OR o.user_id = @uid) ORDER BY o.id DESC`).all({ id: c.id, uid }) as any[];
  const itemsStmt = db.prepare('SELECT kind, description, quantity, unit_price_cents FROM order_items WHERE order_id = ? ORDER BY id');
  const sales = db.prepare(
    `SELECT s.id, s.sold_at, s.order_id, u.name AS seller, ${saleTotal} AS total_cents
       FROM sales s JOIN users u ON u.id = s.user_id
      WHERE s.client_id = @id AND (@uid IS NULL OR s.user_id = @uid) ORDER BY s.id DESC`).all({ id: c.id, uid }) as any[];
  return {
    client: present(c),
    orders: orders.map((o) => ({
      id: o.id, openedAt: isoUtc(o.opened_at), completedAt: o.completed_at ? isoUtc(o.completed_at) : null,
      equipment: o.equipment, brand: o.brand, model: o.model, serialNumber: o.serial_number, status: o.status,
      reportedIssue: o.reported_issue, responsible: o.responsible, totalCents: o.total_cents,
      items: (itemsStmt.all(o.id) as any[]).map((i) => ({ kind: i.kind, description: i.description, quantity: i.quantity, unitPriceCents: i.unit_price_cents })),
    })),
    sales: sales.map((s) => ({ id: s.id, soldAt: isoUtc(s.sold_at), orderId: s.order_id, seller: s.seller, totalCents: s.total_cents })),
  };
}

export const hasLinks = (id: number) =>
  Boolean(db.prepare('SELECT 1 FROM service_orders WHERE client_id = ? UNION ALL SELECT 1 FROM sales WHERE client_id = ? LIMIT 1').get(id, id));
