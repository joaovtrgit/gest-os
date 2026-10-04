import { db } from '../db.js';
import { isoUtc } from '../utils/period.js';
import type { Role } from '../middlewares/auth.js';

export const STATUSES = ['recebida', 'em_analise', 'aguardando_aprovacao', 'aguardando_peca', 'em_manutencao', 'concluida', 'entregue', 'cancelada'] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = {
  recebida: 'Recebida', em_analise: 'Em análise', aguardando_aprovacao: 'Aguardando aprovação', aguardando_peca: 'Aguardando peça',
  em_manutencao: 'Em manutenção', concluida: 'Concluída', entregue: 'Entregue', cancelada: 'Cancelada',
};
export const PAYMENT_METHODS = ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'transferencia', 'boleto', 'outro'] as const;

const NEXT: Record<Status, Status[]> = {
  recebida: ['em_analise', 'cancelada'],
  em_analise: ['aguardando_aprovacao', 'aguardando_peca', 'em_manutencao', 'cancelada'],
  aguardando_aprovacao: ['em_analise', 'aguardando_peca', 'em_manutencao', 'cancelada'],
  aguardando_peca: ['em_manutencao', 'cancelada'],
  em_manutencao: ['aguardando_peca', 'concluida', 'cancelada'],
  concluida: ['entregue'], entregue: [], cancelada: [],
};
// Reabrir uma ordem encerrada muda o faturamento; por isso só o gerente.
const MANAGER_ONLY: Partial<Record<Status, Status[]>> = { concluida: ['em_manutencao'], entregue: ['concluida'], cancelada: ['recebida'] };
export const allowedNext = (s: Status, role: Role): Status[] => [...NEXT[s], ...(role === 'gerente' ? MANAGER_ONLY[s] ?? [] : [])];
// Depois de concluída, só o gerente altera dados e valores da ordem.
export const LOCKED_FOR_SELLER = new Set<string>(['concluida', 'entregue', 'cancelada']);

export interface OrderRow {
  id: number; client_id: number; user_id: number; opened_at: string; equipment: string; brand: string | null; model: string | null;
  serial_number: string | null; reported_issue: string; diagnosis: string | null; internal_notes: string | null;
  discount_cents: number; payment_method: string | null; status: Status; completed_at: string | null;
}
export const findOrder = (id: number) => db.prepare('SELECT * FROM service_orders WHERE id = ?').get(id) as OrderRow | undefined;
export const numberOf = (id: number) => String(id).padStart(4, '0');

export function addHistory(orderId: number, userId: number, action: string, details?: string) {
  db.prepare('INSERT INTO order_history (order_id, user_id, action, details) VALUES (?,?,?,?)').run(orderId, userId, action, details ?? null);
}

export function totals(orderId: number, discountCents: number) {
  const r = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN kind='servico' THEN quantity*unit_price_cents END),0) s,
            COALESCE(SUM(CASE WHEN kind='peca' THEN quantity*unit_price_cents END),0) p FROM order_items WHERE order_id = ?`).get(orderId) as { s: number; p: number };
  return { servicesCents: r.s, partsCents: r.p, subtotalCents: r.s + r.p, discountCents, totalCents: r.s + r.p - discountCents };
}

const TOTAL = `(SELECT COALESCE(SUM(quantity*unit_price_cents),0) FROM order_items WHERE order_id = o.id) - o.discount_cents`;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

export function listOrders(f: { q: string; status?: string; responsibleId?: number; uid: number | null; page: number; pageSize: number }) {
  const w: string[] = ['(@uid IS NULL OR o.user_id = @uid)'], p: Record<string, unknown> = { uid: f.uid };
  if (f.status) { w.push('o.status = @status'); p.status = f.status; }
  if (f.responsibleId) { w.push('o.user_id = @rid'); p.rid = f.responsibleId; }
  const q = f.q.trim();
  if (q) {
    p.like = `%${escapeLike(q)}%`;
    const t = ["fold(c.name) LIKE fold(@like) ESCAPE '\\'", "fold(o.equipment) LIKE fold(@like) ESCAPE '\\'", "fold(o.brand) LIKE fold(@like) ESCAPE '\\'",
      "fold(o.model) LIKE fold(@like) ESCAPE '\\'", "fold(o.serial_number) LIKE fold(@like) ESCAPE '\\'"];
    if (/^#?\d{1,9}$/.test(q)) { p.num = Number(q.replace('#', '')); t.push('o.id = @num'); }
    w.push(`(${t.join(' OR ')})`);
  }
  const from = `FROM service_orders o JOIN clients c ON c.id = o.client_id JOIN users u ON u.id = o.user_id WHERE ${w.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) n ${from}`).get(p) as { n: number }).n;
  const rows = db.prepare(
    `SELECT o.id, o.opened_at, o.equipment, o.brand, o.model, o.status, c.id client_id, c.name client_name, u.name responsible, ${TOTAL} total_cents
       ${from} ORDER BY o.id DESC LIMIT @limit OFFSET @offset`).all({ ...p, limit: f.pageSize, offset: (f.page - 1) * f.pageSize }) as any[];
  return {
    total, page: f.page, pageSize: f.pageSize,
    items: rows.map((r) => ({ id: r.id, number: numberOf(r.id), openedAt: isoUtc(r.opened_at), equipment: r.equipment, brand: r.brand, model: r.model,
      status: r.status, clientId: r.client_id, clientName: r.client_name, responsible: r.responsible, totalCents: r.total_cents })),
  };
}

export function orderDetail(o: OrderRow, role: Role) {
  const client = db.prepare('SELECT id, name, document, phone, whatsapp, email FROM clients WHERE id = ?').get(o.client_id) as any;
  const responsible = db.prepare('SELECT id, name FROM users WHERE id = ?').get(o.user_id) as { id: number; name: string };
  const items = (db.prepare('SELECT id, kind, description, quantity, unit_price_cents FROM order_items WHERE order_id = ? ORDER BY id').all(o.id) as any[])
    .map((i) => ({ id: i.id, kind: i.kind, description: i.description, quantity: i.quantity, unitPriceCents: i.unit_price_cents }));
  const history = (db.prepare(
    `SELECT h.id, h.action, h.details, h.created_at, u.name userName FROM order_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.order_id = ? ORDER BY h.id DESC`).all(o.id) as any[])
    .map((h) => ({ id: h.id, action: h.action, details: h.details, userName: h.userName, at: isoUtc(h.created_at) }));
  const linkedSales = (db.prepare('SELECT id FROM sales WHERE order_id = ?').all(o.id) as { id: number }[]).map((s) => s.id);
  return {
    id: o.id, number: numberOf(o.id), status: o.status, openedAt: isoUtc(o.opened_at), completedAt: o.completed_at ? isoUtc(o.completed_at) : null,
    equipment: o.equipment, brand: o.brand, model: o.model, serialNumber: o.serial_number, reportedIssue: o.reported_issue, diagnosis: o.diagnosis,
    internalNotes: o.internal_notes, paymentMethod: o.payment_method, client, responsible, items, history, linkedSales,
    totals: totals(o.id, o.discount_cents), allowedNext: allowedNext(o.status, role),
    locked: role !== 'gerente' && LOCKED_FOR_SELLER.has(o.status),
  };
}
