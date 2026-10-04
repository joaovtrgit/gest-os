import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Segredo do JWT: usa a variável de ambiente ou gera um e guarda em data/ (fora do git).
function loadSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(dataDir, '.jwt-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  isProd: process.env.NODE_ENV === 'production',
  dbPath: process.env.DB_PATH ?? path.join(dataDir, 'app.db'),
  jwtSecret: loadSecret(),
  cookieName: 'at_session',
  sessionShort: 12 * 60 * 60,        // 12 h
  tzOffsetHours: Number(process.env.TZ_OFFSET_HOURS ?? -3), // Brasília (sem horário de verão)
  sessionLong: 30 * 24 * 60 * 60,    // 30 dias ("manter conectado")
};
