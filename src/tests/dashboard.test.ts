import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'at-dash-'));
process.env.DATA_DIR = tmp; process.env.DB_PATH = path.join(tmp, 'test.db');
const { createApp } = await import('../app.js');
const { db } = await import('../db.js');
const { hashPassword } = await import('../utils/password.js');
const { sqlTime } = await import('../utils/period.js');

let server: Server; let base = '';
const now = sqlTime(new Date());
const ids: Record<string, number> = {};

before(async () => {
  const h = await hashPassword('senha1234');
  for (const [u, role] of [['ger', 'gerente'], ['v1', 'vendedor'], ['v2', 'vendedor']])
    ids[u] = Number(db.prepare('INSERT INTO users (name,email,username,role,password_hash) VALUES (?,?,?,?,?)').run(u, `${u}@x.com`, u, role, h).lastInsertRowid);
  const client = Number(db.prepare("INSERT INTO clients (name) VALUES ('Cliente')").run().lastInsertRowid);
  const order = (uid: number, status: string, price: number, discount = 0) => {
    const id = Number(db.prepare('INSERT INTO service_orders (client_id,user_id,equipment,reported_issue,status,completed_at,discount_cents) VALUES (?,?,?,?,?,?,?)')
      .run(client, uid, 'Notebook', 'Não liga', status, ['concluida', 'entregue'].includes(status) ? now : null, discount).lastInsertRowid);
    db.prepare("INSERT INTO order_items (order_id,kind,description,quantity,unit_price_cents) VALUES (?, 'servico','Limpeza',1,?)").run(id, price);
    return id;
  };
  const done = order(ids.v1, 'concluida', 20000, 2000);       // líquido 18000
  order(ids.v1, 'em_manutencao', 5000); order(ids.v2, 'aguardando_aprovacao', 7000);
  order(ids.v2, 'entregue', 10000);                            // líquido 10000
  const sale = (uid: number, orderId: number | null, price: number) => {
    const id = Number(db.prepare('INSERT INTO sales (user_id,order_id) VALUES (?,?)').run(uid, orderId).lastInsertRowid);
    db.prepare("INSERT INTO sale_items (sale_id,description,quantity,unit_price_cents) VALUES (?, 'Carregador',1,?)").run(id, price);
  };
  sale(ids.v1, null, 12000);        // avulsa: entra
  sale(ids.v1, done, 12000);        // vinculada à OS: NÃO entra no faturamento
  server = createApp().listen(0); base = `http://localhost:${(server.address() as any).port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const get = async (user: string, qs = '') => {
  const l = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: user, password: 'senha1234' }) });
  const cookie = (l.headers.get('set-cookie') ?? '').split(';')[0];
  const r = await fetch(base + '/api/dashboard' + qs, { headers: { cookie } });
  return { status: r.status, body: (await r.json()) as any };
};

test('exige login', async () => assert.equal((await fetch(base + '/api/dashboard')).status, 401));
test('gerente: faturamento sem contar a venda vinculada à OS duas vezes', async () => {
  const { body } = await get('ger', '?period=hoje');
  assert.equal(body.kpis.revenueCents, 18000 + 10000 + 12000);
  assert.equal(body.kpis.salesCount, 2);                 // as duas vendas existem como vendas
  assert.equal(body.kpis.averageTicketCents, Math.round(40000 / 3));
  assert.equal(body.kpis.openOrders, 2); assert.equal(body.kpis.awaitingApproval, 1);
  assert.equal(body.kpis.inProgress, 1); assert.equal(body.kpis.completedOrders, 2);
  assert.equal(body.revenueByDay.reduce((s: number, d: any) => s + d.valueCents, 0), 40000);
  assert.equal(body.revenueBySeller.length, 2);
});
test('vendedor vê só os próprios números e nenhum dado administrativo', async () => {
  const { body } = await get('v1', '?period=mes_anterior'); // filtro é ignorado
  assert.equal(body.kpis.revenueCents, 18000 + 12000);
  assert.equal(body.kpis.openOrders, 1);
  for (const k of ['revenueBySeller', 'recentActivity', 'revenueByDay', 'ordersByStatus']) assert.equal(body[k], undefined);
});
test('mês anterior vem zerado; período inválido → 400', async () => {
  assert.equal((await get('ger', '?period=mes_anterior')).body.kpis.revenueCents, 0);
  assert.equal((await get('ger', '?period=custom&from=2026-02-01&to=2026-01-01')).status, 400);
  assert.equal((await get('ger', '?period=custom')).status, 400);
});
