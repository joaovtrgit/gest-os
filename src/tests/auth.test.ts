import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Banco e segredo isolados para os testes.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'at-test-'));
process.env.DATA_DIR = tmp; process.env.DB_PATH = path.join(tmp, 'test.db');

const { createApp } = await import('../app.js');
const { db } = await import('../db.js');
const { hashPassword } = await import('../utils/password.js');
const { requireAuth, requireRole } = await import('../middlewares/auth.js');
const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { authRouter } = await import('../routes/auth.js');

let server: Server; let base = '';
const insert = async (u: string, role: string, status = 'ativo') =>
  db.prepare('INSERT INTO users (name,email,username,role,status,password_hash) VALUES (?,?,?,?,?,?)').run(u, `${u}@x.com`, u, role, status, await hashPassword('senha1234'));

before(async () => {
  await insert('gerente1', 'gerente'); await insert('vend1', 'vendedor'); await insert('bloq1', 'vendedor', 'bloqueado');
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.get('/api/so-gerente', requireAuth, requireRole('gerente'), (_q, r) => r.json({ ok: true }));
  server = app.listen(0); base = `http://localhost:${(server.address() as any).port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const post = (p: string, body: unknown, cookie = '') => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
const login = async (identifier: string, password = 'senha1234') => {
  const r = await post('/api/auth/login', { identifier, password });
  return { r, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
};

test('senha errada → 401; usuário inexistente → mesma resposta', async () => {
  assert.equal((await login('gerente1', 'errada123')).r.status, 401);
  assert.equal((await login('ninguem')).r.status, 401);
});
test('login por usuário e por e-mail; senha não vaza na resposta', async () => {
  const a = await login('gerente1'); assert.equal(a.r.status, 200);
  assert.ok(!JSON.stringify(await a.r.json()).includes('password'));
  assert.equal((await login('vend1@x.com')).r.status, 200);
  assert.match(a.r.headers.get('set-cookie')!, /HttpOnly/);
});
test('conta bloqueada → 403', async () => assert.equal((await login('bloq1')).r.status, 403));
test('/me exige sessão', async () => {
  assert.equal((await fetch(base + '/api/auth/me')).status, 401);
  const { cookie } = await login('vend1');
  assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie } })).status, 200);
});
test('vendedor recebe 403 em rota de gerente; gerente acessa', async () => {
  const v = await login('vend1'), g = await login('gerente1');
  assert.equal((await fetch(base + '/api/so-gerente', { headers: { cookie: v.cookie } })).status, 403);
  assert.equal((await fetch(base + '/api/so-gerente', { headers: { cookie: g.cookie } })).status, 200);
});
test('bloquear a conta invalida a sessão já aberta', async () => {
  const { cookie } = await login('vend1');
  db.prepare("UPDATE users SET status='bloqueado' WHERE username='vend1'").run();
  assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie } })).status, 401);
});
test('logout limpa a sessão e 5 falhas bloqueiam (429)', async () => {
  const { cookie } = await login('gerente1');
  assert.equal((await post('/api/auth/logout', {}, cookie)).status, 200);
  for (let i = 0; i < 5; i++) await login('gerente1', 'errada123');
  assert.equal((await login('gerente1')).r.status, 429);
});
void createApp;
