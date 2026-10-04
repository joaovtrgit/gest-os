import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { db, logActivity } from '../db.js';
import { requireAuth, requireRole } from '../middlewares/auth.js';
import { PAYMENT_METHODS, STATUSES, STATUS_LABEL, LOCKED_FOR_SELLER, addHistory, allowedNext, findOrder, listOrders, numberOf, orderDetail, totals, type OrderRow, type Status } from '../services/orderService.js';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

class Fail extends Error { constructor(public status: number, message: string, public fields?: Record<string, string>) { super(message); } }
const h = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response, next: NextFunction) => {
  try { fn(req, res); } catch (e) {
    if (e instanceof Fail) return void res.status(e.status).json({ message: e.message, fields: e.fields });
    if (e instanceof z.ZodError) {
      const fields: Record<string, string> = {};
      for (const i of e.issues) fields[String(i.path[0])] ??= i.message;
      return void res.status(400).json({ message: 'Corrija os campos destacados.', fields });
    }
    next(e);
  }
};

const text = (max: number) => z.string().trim().max(max, `Máximo de ${max} caracteres.`).nullish().transform((v) => v || null);
const cents = z.number({ invalid_type_error: 'Valor inválido.' }).int('Valor inválido.').min(0, 'O valor não pode ser negativo.').max(100_000_000_00, 'Valor muito alto.');
const orderFields = {
  equipment: z.string().trim().min(2, 'Informe o equipamento.').max(80),
  brand: text(60), model: text(60), serialNumber: text(60),
  reportedIssue: z.string().trim().min(3, 'Descreva o problema relatado.').max(1000, 'Máximo de 1000 caracteres.'),
  diagnosis: text(2000), internalNotes: text(2000),
  paymentMethod: z.enum(PAYMENT_METHODS).nullish().transform((v) => v ?? null),
  discountCents: cents, responsibleId: z.number().int().positive(),
};
const createSchema = z.object({ clientId: z.number().int().positive('Escolha o cliente.'), ...orderFields, paymentMethod: orderFields.paymentMethod.optional(), discountCents: z.undefined().optional(), responsibleId: orderFields.responsibleId.optional() });
const updateSchema = z.object(orderFields).partial();
const itemSchema = z.object({
  kind: z.enum(['servico', 'peca'], { errorMap: () => ({ message: 'Escolha serviço ou peça.' }) }),
  description: z.string().trim().min(2, 'Descreva o item.').max(160),
  quantity: z.number().int('Quantidade inválida.').min(1, 'Mínimo 1.').max(9999),
  unitPriceCents: cents,
});

const id = (v: string) => (/^\d+$/.test(v) ? Number(v) : 0);
const activeUser = (uid: number) => db.prepare("SELECT id, name FROM users WHERE id = ? AND status = 'ativo'").get(uid) as { id: number; name: string } | undefined;

// Carrega a ordem respeitando o dono: o vendedor nunca "enxerga" ordens de outros (404).
function load(req: Request): OrderRow {
  const o = findOrder(id(req.params.id));
  if (!o || (req.user!.role === 'vendedor' && o.user_id !== req.user!.id)) throw new Fail(404, 'Ordem de serviço não encontrada.');
  return o;
}
function mustModify(req: Request, o: OrderRow) {
  if (req.user!.role === 'vendedor' && LOCKED_FOR_SELLER.has(o.status))
    throw new Fail(403, 'Esta ordem já foi concluída ou encerrada. Peça ao gerente para alterá-la.');
}
function checkDiscount(orderId: number, discount: number) {
  if (discount > totals(orderId, 0).subtotalCents) throw new Fail(400, 'O desconto não pode ser maior que o subtotal.', { discountCents: 'Maior que o subtotal.' });
}

ordersRouter.get('/responsibles', requireRole('gerente'), h((_req, res) => {
  res.json(db.prepare("SELECT id, name FROM users WHERE status = 'ativo' ORDER BY name").all());
}));

ordersRouter.get('/', h((req, res) => {
  const q = z.object({
    q: z.string().max(100).default(''), status: z.enum(STATUSES).optional(), responsibleId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }).parse(req.query);
  const mgr = req.user!.role === 'gerente';
  res.json(listOrders({ ...q, responsibleId: mgr ? q.responsibleId : undefined, uid: mgr ? null : req.user!.id }));
}));

ordersRouter.get('/:id', h((req, res) => res.json(orderDetail(load(req), req.user!.role))));

ordersRouter.post('/', h((req, res) => {
  const d = createSchema.parse(req.body), user = req.user!;
  if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(d.clientId)) throw new Fail(400, 'Cliente não encontrado.', { clientId: 'Escolha um cliente cadastrado.' });
  let owner = user.id;
  if (d.responsibleId && d.responsibleId !== user.id) {
    if (user.role !== 'gerente') throw new Fail(403, 'Somente o gerente define outro responsável.');
    if (!activeUser(d.responsibleId)) throw new Fail(400, 'Responsável inválido.', { responsibleId: 'Escolha um funcionário ativo.' });
    owner = d.responsibleId;
  }
  const orderId = db.transaction(() => {
    const info = db.prepare(`INSERT INTO service_orders (client_id,user_id,equipment,brand,model,serial_number,reported_issue,diagnosis,internal_notes,payment_method)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(d.clientId, owner, d.equipment, d.brand, d.model, d.serialNumber, d.reportedIssue, d.diagnosis, d.internalNotes, d.paymentMethod ?? null);
    const oid = Number(info.lastInsertRowid);
    addHistory(oid, user.id, 'criada', 'Ordem aberta com status Recebida.');
    return oid;
  })();
  logActivity(user.id, 'os_criada', { entity: 'service_orders', entityId: orderId, details: `OS #${numberOf(orderId)}`, ip: req.ip });
  res.status(201).json({ id: orderId });
}));

ordersRouter.patch('/:id', h((req, res) => {
  const o = load(req), user = req.user!;
  mustModify(req, o);
  const d = updateSchema.parse(req.body);
  if (d.responsibleId !== undefined && d.responsibleId !== o.user_id) {
    if (user.role !== 'gerente') throw new Fail(403, 'Somente o gerente troca o responsável.');
    if (!activeUser(d.responsibleId)) throw new Fail(400, 'Responsável inválido.', { responsibleId: 'Escolha um funcionário ativo.' });
  }
  if (d.discountCents !== undefined) checkDiscount(o.id, d.discountCents);
  const map: Record<string, [string, unknown, unknown]> = {
    equipment: ['equipment', d.equipment, o.equipment], brand: ['brand', d.brand, o.brand], model: ['model', d.model, o.model],
    serialNumber: ['serial_number', d.serialNumber, o.serial_number], reportedIssue: ['reported_issue', d.reportedIssue, o.reported_issue],
    diagnosis: ['diagnosis', d.diagnosis, o.diagnosis], internalNotes: ['internal_notes', d.internalNotes, o.internal_notes],
    paymentMethod: ['payment_method', d.paymentMethod, o.payment_method], discountCents: ['discount_cents', d.discountCents, o.discount_cents],
    responsibleId: ['user_id', d.responsibleId, o.user_id],
  };
  const changed = Object.entries(map).filter(([, [, next, cur]]) => next !== undefined && next !== cur);
  if (!changed.length) return void res.json({ id: o.id });
  const LABEL: Record<string, string> = { equipment: 'equipamento', brand: 'marca', model: 'modelo', serialNumber: 'nº de série', reportedIssue: 'problema relatado',
    diagnosis: 'diagnóstico', internalNotes: 'observações internas', paymentMethod: 'forma de pagamento', discountCents: 'desconto', responsibleId: 'responsável' };
  db.transaction(() => {
    db.prepare(`UPDATE service_orders SET ${changed.map(([, [col]]) => `${col} = ?`).join(', ')} WHERE id = ?`).run(...changed.map(([, [, next]]) => next), o.id);
    addHistory(o.id, user.id, 'editada', `Alterou: ${changed.map(([k]) => LABEL[k]).join(', ')}.`);
  })();
  logActivity(user.id, 'os_editada', { entity: 'service_orders', entityId: o.id, details: `OS #${numberOf(o.id)}`, ip: req.ip });
  res.json({ id: o.id });
}));

ordersRouter.post('/:id/status', h((req, res) => {
  const o = load(req), user = req.user!;
  const { status, note } = z.object({ status: z.enum(STATUSES), note: z.string().trim().max(500).optional() }).parse(req.body);
  if (!allowedNext(o.status, user.role).includes(status))
    throw new Fail(409, `Não é possível mudar de "${STATUS_LABEL[o.status]}" para "${STATUS_LABEL[status as Status]}".`);
  if (status === 'concluida' && !db.prepare('SELECT 1 FROM order_items WHERE order_id = ?').get(o.id))
    throw new Fail(409, 'Adicione ao menos um serviço ou peça antes de concluir a ordem.');
  if (status === 'entregue' && !o.payment_method) throw new Fail(409, 'Informe a forma de pagamento antes de marcar como entregue.');
  const completedAt = status === 'concluida' ? (o.completed_at ?? 'NOW') : status === 'entregue' ? o.completed_at : null;
  db.transaction(() => {
    db.prepare(`UPDATE service_orders SET status = ?, completed_at = ${completedAt === 'NOW' ? "datetime('now')" : '?'} WHERE id = ?`)
      .run(...(completedAt === 'NOW' ? [status, o.id] : [status, completedAt, o.id]));
    addHistory(o.id, user.id, 'status', `${STATUS_LABEL[o.status]} → ${STATUS_LABEL[status as Status]}${note ? ` — ${note}` : ''}`);
  })();
  logActivity(user.id, 'os_status', { entity: 'service_orders', entityId: o.id, details: `OS #${numberOf(o.id)}: ${STATUS_LABEL[status as Status]}`, ip: req.ip });
  res.json({ id: o.id });
}));

ordersRouter.post('/:id/items', h((req, res) => {
  const o = load(req); mustModify(req, o);
  const d = itemSchema.parse(req.body);
  db.transaction(() => {
    db.prepare('INSERT INTO order_items (order_id, kind, description, quantity, unit_price_cents) VALUES (?,?,?,?,?)').run(o.id, d.kind, d.description, d.quantity, d.unitPriceCents);
    addHistory(o.id, req.user!.id, 'item_adicionado', `${d.kind === 'servico' ? 'Serviço' : 'Peça'}: ${d.description}`);
  })();
  res.status(201).json({ id: o.id });
}));

ordersRouter.patch('/:id/items/:itemId', h((req, res) => {
  const o = load(req); mustModify(req, o);
  const d = itemSchema.parse(req.body);
  const item = db.prepare('SELECT id FROM order_items WHERE id = ? AND order_id = ?').get(id(req.params.itemId), o.id);
  if (!item) throw new Fail(404, 'Item não encontrado.');
  db.transaction(() => {
    db.prepare('UPDATE order_items SET kind=?, description=?, quantity=?, unit_price_cents=? WHERE id=?').run(d.kind, d.description, d.quantity, d.unitPriceCents, id(req.params.itemId));
    checkDiscount(o.id, o.discount_cents);
    addHistory(o.id, req.user!.id, 'item_editado', d.description);
  })();
  res.json({ id: o.id });
}));

ordersRouter.delete('/:id/items/:itemId', h((req, res) => {
  const o = load(req); mustModify(req, o);
  const item = db.prepare('SELECT description FROM order_items WHERE id = ? AND order_id = ?').get(id(req.params.itemId), o.id) as { description: string } | undefined;
  if (!item) throw new Fail(404, 'Item não encontrado.');
  db.transaction(() => {
    db.prepare('DELETE FROM order_items WHERE id = ?').run(id(req.params.itemId));
    checkDiscount(o.id, o.discount_cents);
    addHistory(o.id, req.user!.id, 'item_removido', item.description);
  })();
  res.json({ id: o.id });
}));

ordersRouter.delete('/:id', requireRole('gerente'), h((req, res) => {
  const o = load(req);
  if (o.status === 'concluida' || o.status === 'entregue') throw new Fail(409, 'Ordens concluídas ou entregues fazem parte do faturamento e não podem ser excluídas. Use o status Cancelada, se necessário.');
  if (db.prepare('SELECT 1 FROM sales WHERE order_id = ?').get(o.id)) throw new Fail(409, 'Existem vendas vinculadas a esta ordem. Cancele a ordem em vez de excluí-la.');
  db.prepare('DELETE FROM service_orders WHERE id = ?').run(o.id);
  logActivity(req.user!.id, 'os_excluida', { entity: 'service_orders', entityId: o.id, details: `OS #${numberOf(o.id)}`, ip: req.ip });
  res.json({ ok: true });
}));
