import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'at-os-'));
process.env.DATA_DIR = tmp; process.env.DB_PATH = path.join(tmp, 'test.db');
const { createApp } = await import('../app.js');
const { db } = await import('../db.js');
const { hashPassword } = await import('../utils/password.js');

let server: Server; let base = ''; let clientId = 0;
const ids: Record<string, number> = {}; const cookies: Record<string, string> = {};

before(async () => {
  const h = await hashPassword('senha1234');
  server = createApp().listen(0); base = `http://localhost:${(server.address() as any).port}`;
  for (const [u, role] of [['ger', 'gerente'], ['v1', 'vendedor'], ['v2', 'vendedor']]) {
    ids[u] = Number(db.prepare('INSERT INTO users (name,email,username,role,password_hash) VALUES (?,?,?,?,?)').run(u, `${u}@x.com`, u, role, h).lastInsertRowid);
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: u, password: 'senha1234' }) });
    cookies[u] = (r.headers.get('set-cookie') ?? '').split(';')[0];
  }
  clientId = Number(db.prepare("INSERT INTO clients (name) VALUES ('Maria Souza')").run().lastInsertRowid);
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const call = async (who: string, method: string, url: string, body?: unknown, prefix = '/api/orders') => {
  const r = await fetch(base + prefix + url, { method, headers: { 'Content-Type': 'application/json', cookie: cookies[who] ?? '' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as any };
};
const NEW = { clientId: 0, equipment: 'Notebook', brand: 'Dell', model: 'Inspiron', reportedIssue: 'Não liga' };
const item = (description: string, unitPriceCents: number, kind = 'servico', quantity = 1) => ({ kind, description, quantity, unitPriceCents });
let a = 0, b = 0;

test('criação: valida, vendedor vira responsável, só gerente escolhe outro', async () => {
  assert.equal((await call('v1', 'POST', '', { ...NEW, clientId })).status, 201 );
  assert.equal((await call('v1', 'POST', '', { ...NEW, clientId: 999 })).status, 400);
  assert.equal((await call('v1', 'POST', '', { ...NEW, clientId, reportedIssue: '' })).status, 400);
  assert.equal((await call('v1', 'POST', '', { ...NEW, clientId, responsibleId: ids.v2 })).status, 403);
  a = (await call('v1', 'GET', '')).body.items[0].id;
  b = (await call('ger', 'POST', '', { ...NEW, clientId, responsibleId: ids.v2 })).body.id;
  const d = (await call('ger', 'GET', `/${a}`)).body;
  assert.equal(d.responsible.id, ids.v1); assert.equal(d.status, 'recebida'); assert.equal(d.history[0].action, 'criada');
});
test('vendedor só vê/altera as próprias ordens', async () => {
  assert.equal((await call('v1', 'GET', `/${b}`)).status, 404);
  assert.equal((await call('v1', 'PATCH', `/${b}`, { diagnosis: 'x' })).status, 404);
  assert.equal((await call('v1', 'GET', '')).body.total, 1);
  assert.equal((await call('ger', 'GET', '')).body.total, 2);
  assert.equal((await call('v1', 'GET', '?responsibleId=' + ids.v2)).body.total, 1); // filtro de responsável ignorado
});
test('itens e total: serviços + peças − desconto; desconto não passa do subtotal', async () => {
  for (const i of [item('Limpeza preventiva', 20000), item('Recuperação de carcaça', 29900), item('Carregador', 12000, 'peca')])
    assert.equal((await call('v1', 'POST', `/${a}/items`, i)).status, 201);
  assert.equal((await call('v1', 'POST', `/${a}/items`, item('x', -5))).status, 400);
  assert.equal((await call('v1', 'PATCH', `/${a}`, { discountCents: 99_999_99 })).status, 400);
  assert.equal((await call('v1', 'PATCH', `/${a}`, { discountCents: 1900 })).status, 200);
  const t = (await call('v1', 'GET', `/${a}`)).body.totals;
  assert.deepEqual(t, { servicesCents: 49900, partsCents: 12000, subtotalCents: 61900, discountCents: 1900, totalCents: 60000 });
});
test('status: transições válidas, regras de conclusão e entrega', async () => {
  const st = (who: string, id: number, status: string) => call(who, 'POST', `/${id}/status`, { status });
  assert.equal((await st('v1', a, 'concluida')).status, 409);               // salto inválido
  assert.equal((await st('v1', a, 'em_analise')).status, 200);
  assert.equal((await st('v1', a, 'em_manutencao')).status, 200);
  assert.equal((await st('v2', b, 'em_analise')).status, 200);
  assert.equal((await st('v2', b, 'em_manutencao')).status, 200);
  assert.equal((await st('v2', b, 'concluida')).status, 409);                 // sem itens
  assert.equal((await st('v1', a, 'concluida')).status, 200);
  assert.equal((await st('v1', a, 'entregue')).status, 409);                // sem forma de pagamento
  assert.equal((await call('v1', 'PATCH', `/${a}`, { paymentMethod: 'pix' })).status, 403); // já concluída: travada p/ vendedor
  assert.equal((await call('ger', 'PATCH', `/${a}`, { paymentMethod: 'pix' })).status, 200);
  assert.equal((await st('v1', a, 'entregue')).status, 200);
  assert.equal((await st('v1', a, 'em_manutencao')).status, 409);           // reabrir é do gerente
});
test('vendedor não altera itens de ordem concluída; histórico registra tudo', async () => {
  assert.equal((await call('v1', 'POST', `/${a}/items`, item('Extra', 100))).status, 403);
  const d = (await call('ger', 'GET', `/${a}`)).body;
  assert.ok(d.history.length >= 9); assert.equal(d.history[0].details.includes('Entregue'), true); assert.equal(d.locked, false);
});
test('faturamento: ordem concluída entra no dashboard; reabrir tira', async () => {
  const rev = async () => (await call('ger', 'GET', '?period=hoje', undefined, '/api/dashboard')).body.kpis.revenueCents;
  assert.equal(await rev(), 60000);
  assert.equal((await call('v1', 'POST', `/${a}/status`, { status: 'concluida' })).status, 409);
  assert.equal((await call('ger', 'POST', `/${a}/status`, { status: 'concluida' })).status, 200);
  assert.equal((await call('ger', 'POST', `/${a}/status`, { status: 'em_manutencao' })).status, 200);
  assert.equal(await rev(), 0);
});
test('exclusão: só gerente; não exclui concluída nem com venda vinculada', async () => {
  assert.equal((await call('v1', 'DELETE', `/${a}`)).status, 403);
  await call('ger', 'POST', `/${a}/status`, { status: 'concluida' });
  assert.equal((await call('ger', 'DELETE', `/${a}`)).status, 409);
  assert.equal((await call('ger', 'DELETE', `/${b}`)).status, 200);
  assert.equal((await call('ger', 'GET', `/${b}`)).status, 404);
});
test('busca por número, cliente e status', async () => {
  assert.equal((await call('ger', 'GET', `?q=${a}`)).body.total, 1);
  assert.equal((await call('ger', 'GET', '?q=maria')).body.total, 1);
  assert.equal((await call('ger', 'GET', '?status=cancelada')).body.total, 0);
  assert.equal((await call('ger', 'GET', '?status=invalido')).status, 400);
});
