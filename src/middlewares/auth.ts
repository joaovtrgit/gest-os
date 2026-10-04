import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db, type UserRow } from '../db.js';

export type Role = UserRow['role'];
export interface AuthUser { id: number; name: string; email: string; role: Role; jobTitle: string }
declare module 'express-serve-static-core' { interface Request { user?: AuthUser } }

export const toAuthUser = (u: UserRow): AuthUser => ({ id: u.id, name: u.name, email: u.email, role: u.role, jobTitle: u.job_title });

// Autentica pelo cookie e recarrega o usuário no banco a cada requisição,
// para que bloqueio, desativação e troca de papel valham imediatamente.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[config.cookieName];
  if (!token) return void res.status(401).json({ message: 'Sessão expirada. Entre novamente.' });
  try {
    const { sub } = jwt.verify(token, config.jwtSecret) as { sub: string };
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(sub)) as UserRow | undefined;
    if (!row || row.status !== 'ativo') return void res.status(401).json({ message: 'Sessão expirada. Entre novamente.' });
    req.user = toAuthUser(row);
    next();
  } catch {
    res.status(401).json({ message: 'Sessão expirada. Entre novamente.' });
  }
}

export const requireRole = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || !roles.includes(req.user.role)) return void res.status(403).json({ message: 'Você não tem permissão para esta ação.' });
  next();
};
