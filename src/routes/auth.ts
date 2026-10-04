import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { db, logActivity, type UserRow } from '../db.js';
import { requireAuth, toAuthUser } from '../middlewares/auth.js';
import { clearFailures, registerFailure, tooManyAttempts } from '../utils/rateLimit.js';
import { DUMMY_HASH, verifyPassword } from '../utils/password.js';

export const authRouter = Router();

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
  remember: z.boolean().optional().default(false),
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ message: 'Informe seu e-mail ou usuário e a senha.' });
  const { identifier, password, remember } = parsed.data;

  const key = `${req.ip}|${identifier.toLowerCase()}`;
  const wait = tooManyAttempts(key);
  if (wait) return void res.status(429).json({ message: `Muitas tentativas. Tente novamente em ${Math.ceil(wait / 60)} min.` });

  const row = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(identifier, identifier) as UserRow | undefined;
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);

  if (!row || !ok) {
    registerFailure(key);
    logActivity(row?.id ?? null, 'login_falhou', { details: row ? undefined : `identificador: ${identifier.slice(0, 60)}`, ip: req.ip });
    return void res.status(401).json({ message: 'E-mail, usuário ou senha incorretos.' });
  }
  if (row.status !== 'ativo') {
    logActivity(row.id, 'login_recusado', { details: row.status, ip: req.ip });
    return void res.status(403).json({ message: 'Esta conta está bloqueada ou desativada. Fale com o gerente.' });
  }

  clearFailures(key);
  const ttl = remember ? config.sessionLong : config.sessionShort;
  const token = jwt.sign({ sub: String(row.id) }, config.jwtSecret, { expiresIn: ttl });
  res.cookie(config.cookieName, token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/',
    ...(remember ? { maxAge: ttl * 1000 } : {}), // sem maxAge = cookie de sessão
  });
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  logActivity(row.id, 'login', { ip: req.ip });
  res.json({ user: toAuthUser(row) });
});

authRouter.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

authRouter.post('/logout', requireAuth, (req, res) => {
  logActivity(req.user!.id, 'logout', { ip: req.ip });
  res.clearCookie(config.cookieName, { path: '/' });
  res.json({ ok: true });
});
