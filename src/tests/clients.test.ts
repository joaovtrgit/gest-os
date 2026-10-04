import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'at-cli-'));
process.env.DATA_DIR = tmp; process.env.DB_PATH = path.join(tmp, 'test.db');
const { createApp } = await import('../app.js');
const { db } = await import('../db.js');
const { hashPassword } = await import('../utils/password.js');

let server: Server; let base = '';
const ids: Record<string, number> = {}; const cookies: Record<string, string> = {};
const CPF = '529.982.247-25', CNPJ = '11.222.333/0001-81';

before(async () => {
  const h = await hashPassword('senha1234');
  server = createApp().listen(0); base = `http://localhost:${(server.address() as any).port}`;
  for (const [u, role] of [['ger', 'gerente'], ['v1', 'vendedor'], ['v2', 'vendedor']]) {
    ids[u] = Number(db.prepare('INSERT INTO users (name,email,username,role,password_hash) VALUES (?,?,?,?,?)').run(u, `${u}@x.com`, u, role, h).lastInsertRowid);
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: u, password: 'senha1234' }) });
    cookies[u] = (r.headers.get('set-cookie') ?? '').split(';')[0];
  }
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const call = async (who: string, method: string, url: string, body?: unknown) => {
  const r = await fetch(base + '/api/clients' + url, { method, headers: { 'Content-Type': 'application/json', cookie: cookies[who] ?? '' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as any };
};
let joao = 0;

test('exige login', async () => assert.equal((await call('ninguem', 'GET', '')).status, 401));
test('cadastra com validação; documento normalizado e duplicado recusado', async () => {
  assert.equal((await call('v1', 'POST', '', { name: 'A' })).status, 400);
  const bad = await call('v1', 'POST', '', { name: 'João da Silva', document: '111.111.111-11' });
  assert.equal(bad.status, 400); assert.ok(bad.body.fields.document);
  const ok = await call('v1', 'POST', '', { name: 'João da Silva', document: CPF, phone: '(11) 98888-7777', email: 'JOAO@Email.com' });
  assert.equal(ok.status, 201); joao = ok.body.id;
  assert.equal((await call('v2', 'POST', '', { name: 'Outro', document: '52998224725' })).status, 409);
  assert.equal((await call('ger', 'POST', '', { name: 'Empresa Ltda', document: CNPJ })).status, 201);
  const d = (await call('ger', 'GET', `/${joao}`)).body.client;
  assert.equal(d.document, '52998224725'); assert.equal(d.phone, '11988887777'); assert.equal(d.email, 'joao@email.com');
});
test('busca por nome sem acento, parte do telefone e documento com máscara', async () => {
  assert.equal((await call('v1', 'GET', '?q=joao')).body.total, 1);
  assert.equal((await call('v1', 'GET', '?q=98888')).body.total, 1);
  assert.equal((await call('v1', 'GET', '?q=11.222.333')).body.total, 1);
  assert.equal((await call('v1', 'GET', '?q=zzz')).body.total, 0);
  assert.equal((await call('v1', 'GET', '?q=%25')).body.total, 0);          // % não vira curinga
  assert.equal((await call('v1', 'GET', '')).body.total, 2);
});
test('vendedor edita contato, mas não nome nem documento', async () => {
  assert.equal((await call('v2', 'PATCH', `/${joao}`, { phone: '11 3333-4444', notes: 'Prefere tarde' })).status, 200);
  assert.equal((await call('v2', 'PATCH', `/${joao}`, { name: 'Outro Nome' })).status, 403);
  assert.equal((await call('v2', 'PATCH', `/${joao}`, { document: CNPJ })).status, 403);
  assert.equal((await call('v2', 'PATCH', `/${joao}`, { name: 'João da Silva', document: CPF })).status, 200); // inalterados
  assert.equal((await call('ger', 'PATCH', `/${joao}`, { name: 'João S. Silva' })).status, 200);
  assert.equal((await call('ger', 'GET', `/${joao}`)).body.client.phone, '1133334444');
});
test('histórico: vendedor vê só as próprias ordens; gerente vê todas', async () => {
  const mk = (uid: number) => Number(db.prepare("INSERT INTO service_orders (client_id,user_id,equipment,reported_issue) VALUES (?,?, 'Notebook','Lento')").run(joao, uid).lastInsertRowid);
  const o1 = mk(ids.v1); mk(ids.v2);
  db.prepare("INSERT INTO order_items (order_id,kind,description,quantity,unit_price_cents) VALUES (?, 'servico','Limpeza',1,20000)").run(o1);
  assert.equal((await call('ger', 'GET', `/${joao}`)).body.orders.length, 2);
  const mine = (await call('v1', 'GET', `/${joao}`)).body;
  assert.equal(mine.orders.length, 1); assert.equal(mine.orders[0].totalCents, 20000);
  assert.equal((await call('v1', 'GET', '?q=joao')).body.items[0].ordersCount, 1);
});
test('exclusão: só gerente, e só sem vínculos', async () => {
  assert.equal((await call('v1', 'DELETE', `/${joao}`)).status, 403);
  assert.equal((await call('ger', 'DELETE', `/${joao}`)).status, 409);
  const empresa = (await call('ger', 'GET', '?q=empresa')).body.items[0].id;
  assert.equal((await call('ger', 'DELETE', `/${empresa}`)).status, 200);
  assert.equal((await call('ger', 'GET', `/${empresa}`)).status, 404);
});
