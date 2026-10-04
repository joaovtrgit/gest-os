import Database from 'better-sqlite3';
import { config } from './config.js';

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// fold(): minúsculas e sem acentos, para busca que ignora maiúsculas e acentuação.
db.function('fold', { deterministic: true }, (s: unknown) =>
  typeof s === 'string' ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : '');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  job_title     TEXT    NOT NULL DEFAULT '',
  role          TEXT    NOT NULL CHECK (role IN ('gerente','vendedor')),
  status        TEXT    NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','bloqueado','desativado')),
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  details    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at);

-- Valores monetários sempre em centavos (inteiros). Datas em UTC, formato 'YYYY-MM-DD HH:MM:SS'.
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, document TEXT, phone TEXT, whatsapp TEXT,
  email TEXT, address TEXT, notes TEXT, created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS service_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  equipment TEXT NOT NULL, brand TEXT, model TEXT, serial_number TEXT,
  reported_issue TEXT NOT NULL, diagnosis TEXT, internal_notes TEXT,
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'recebida' CHECK (status IN
    ('recebida','em_analise','aguardando_aprovacao','aguardando_peca','em_manutencao','concluida','entregue','cancelada')),
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('servico','peca')), description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0), unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id), user_id INTEGER NOT NULL REFERENCES users(id),
  order_id INTEGER REFERENCES service_orders(id),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  payment_method TEXT, sold_at TEXT NOT NULL DEFAULT (datetime('now')), notes TEXT
);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'outros', description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0), unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE TABLE IF NOT EXISTS order_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_history ON order_history(order_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_document ON clients(document) WHERE document IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_client ON service_orders(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON service_orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id, sold_at);

-- Fonte única do faturamento (evita contar duas vezes):
--  • OS concluída/entregue entra pelo valor da própria OS, na data de conclusão;
--  • venda avulsa (sem OS) entra pelo valor da venda;
--  • venda vinculada a uma OS NÃO entra aqui — o valor já está na OS.
DROP VIEW IF EXISTS revenue_entries;
CREATE VIEW revenue_entries AS
  SELECT 'os' AS source, o.id AS ref_id, o.user_id AS user_id, o.completed_at AS at,
         COALESCE((SELECT SUM(quantity * unit_price_cents) FROM order_items WHERE order_id = o.id), 0) AS gross_cents,
         o.discount_cents AS discount_cents
    FROM service_orders o WHERE o.status IN ('concluida','entregue') AND o.completed_at IS NOT NULL
  UNION ALL
  SELECT 'venda', s.id, s.user_id, s.sold_at,
         COALESCE((SELECT SUM(quantity * unit_price_cents) FROM sale_items WHERE sale_id = s.id), 0), s.discount_cents
    FROM sales s WHERE s.order_id IS NULL;
`);

export interface UserRow {
  id: number; name: string; email: string; username: string; phone: string | null;
  job_title: string; role: 'gerente' | 'vendedor'; status: 'ativo' | 'bloqueado' | 'desativado';
  password_hash: string; created_at: string; last_login_at: string | null;
}

export function logActivity(userId: number | null, action: string, opts: { entity?: string; entityId?: number; details?: string; ip?: string } = {}) {
  db.prepare('INSERT INTO activity_log (user_id, action, entity, entity_id, details, ip) VALUES (?,?,?,?,?,?)')
    .run(userId, action, opts.entity ?? null, opts.entityId ?? null, opts.details ?? null, opts.ip ?? null);
}
