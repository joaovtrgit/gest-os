import { Router, type Response } from 'express';
import { z } from 'zod';
import { db, logActivity } from '../db.js';
import { requireAuth, requireRole } from '../middlewares/auth.js';
import { clientDetail, findClient, hasLinks, listClients } from '../services/clientService.js';
import { digits, validDocument } from '../utils/document.js';

export const clientsRouter = Router();
clientsRouter.use(requireAuth);

const text = (max: number) => z.string().trim().max(max, `Máximo de ${max} caracteres.`).nullish().transform((v) => v || null);
const phone = z.string().nullish().transform((v) => (v && digits(v) ? digits(v) : null))
  .refine((v) => v === null || (v.length >= 10 && v.length <= 13), 'Telefone inválido. Informe DDD e número.');
const schema = z.object({
  name: z.string().trim().min(2, 'Informe o nome completo.').max(120, 'Máximo de 120 caracteres.'),
  document: z.string().nullish().transform((v) => (v && digits(v) ? digits(v) : null))
    .refine((v) => v === null || validDocument(v), 'CPF ou CNPJ inválido.'),
  phone, whatsapp: phone,
  email: z.string().trim().max(160).nullish().transform((v) => (v ? v.toLowerCase() : null))
    .refine((v) => v === null || /^\S+@\S+\.\S+$/.test(v), 'E-mail inválido.'),
  address: text(250), notes: text(1000),
});
const FIELDS = ['name', 'document', 'phone', 'whatsapp', 'email', 'address', 'notes'] as const;

function invalid(res: Response, err: z.ZodError) {
  const fields: Record<string, string> = {};
  for (const i of err.issues) fields[String(i.path[0])] ??= i.message;
  res.status(400).json({ message: 'Corrija os campos destacados.', fields });
}
const scope = (role: string, id: number) => (role === 'gerente' ? null : id);
const idParam = (v: string) => (/^\d+$/.test(v) ? Number(v) : 0);
const duplicate = (res: Response) => res.status(409).json({ message: 'Já existe um cliente com este CPF/CNPJ.', fields: { document: 'Já cadastrado.' } });

clientsRouter.get('/', (req, res) => {
  const q = z.object({ q: z.string().max(100).default(''), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).safeParse(req.query);
  if (!q.success) return void res.status(400).json({ message: 'Parâmetros inválidos.' });
  res.json(listClients(q.data.q, q.data.page, q.data.pageSize, scope(req.user!.role, req.user!.id)));
});

clientsRouter.get('/:id', (req, res) => {
  const c = findClient(idParam(req.params.id));
  if (!c) return void res.status(404).json({ message: 'Cliente não encontrado.' });
  res.json(clientDetail(c, scope(req.user!.role, req.user!.id)));
});

clientsRouter.post('/', (req, res) => {
  const p = schema.safeParse(req.body);
  if (!p.success) return void invalid(res, p.error);
  const d = p.data;
  try {
    const info = db.prepare('INSERT INTO clients (name, document, phone, whatsapp, email, address, notes, created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(d.name, d.document, d.phone, d.whatsapp, d.email, d.address, d.notes, req.user!.id);
    logActivity(req.user!.id, 'cliente_criado', { entity: 'clients', entityId: Number(info.lastInsertRowid), details: d.name, ip: req.ip });
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch (e) {
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return void duplicate(res);
    throw e;
  }
});

clientsRouter.patch('/:id', (req, res) => {
  const id = idParam(req.params.id), current = findClient(id);
  if (!current) return void res.status(404).json({ message: 'Cliente não encontrado.' });
  const p = schema.partial().safeParse(req.body);
  if (!p.success) return void invalid(res, p.error);
  const d = p.data;
  const user = req.user!;
  // O vendedor atualiza só dados de contato; nome e documento são do gerente.
  if (user.role === 'vendedor' && ((d.name !== undefined && d.name !== current.name) || (d.document !== undefined && d.document !== current.document)))
    return void res.status(403).json({ message: 'Somente o gerente pode alterar nome e documento.' });

  const changed = FIELDS.filter((f) => d[f] !== undefined && d[f] !== current[f]);
  if (!changed.length) return void res.json({ id });
  try {
    db.prepare(`UPDATE clients SET ${changed.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`)
      .run({ id, ...Object.fromEntries(changed.map((f) => [f, d[f]])) });
  } catch (e) {
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return void duplicate(res);
    throw e;
  }
  logActivity(user.id, 'cliente_editado', { entity: 'clients', entityId: id, details: `${current.name}: ${changed.join(', ')}`, ip: req.ip });
  res.json({ id });
});

clientsRouter.delete('/:id', requireRole('gerente'), (req, res) => {
  const id = idParam(req.params.id), current = findClient(id);
  if (!current) return void res.status(404).json({ message: 'Cliente não encontrado.' });
  if (hasLinks(id)) return void res.status(409).json({ message: 'Este cliente tem ordens ou vendas registradas e não pode ser excluído.' });
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  logActivity(req.user!.id, 'cliente_excluido', { entity: 'clients', entityId: id, details: current.name, ip: req.ip });
  res.json({ ok: true });
});
