import readline from 'node:readline';
import { db } from '../db.js';
import { hashPassword, passwordProblem } from '../utils/password.js';

// Cria o primeiro gerente. Só funciona com o banco sem usuários; os demais são criados pelo sistema.
// Uso interativo: npm run setup:gerente   |   Automação: SETUP_NAME, SETUP_EMAIL, SETUP_USERNAME, SETUP_PASSWORD
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
(rl as any)._writeToOutput = (s: string) => { if (!muted || s.includes('\n') || s.includes('\r')) (rl as any).output.write(s); };

const ask = (q: string, hidden = false) => new Promise<string>((resolve) => {
  rl.question(q, (a) => { muted = false; if (hidden) console.log(); resolve(a.trim()); });
  muted = hidden;
});

const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
if (count > 0) { console.error('Já existem usuários cadastrados. Novos acessos são criados pelo gerente no sistema.'); process.exit(1); }

const name = process.env.SETUP_NAME ?? await ask('Nome completo: ');
const email = (process.env.SETUP_EMAIL ?? await ask('E-mail: ')).toLowerCase();
const username = (process.env.SETUP_USERNAME ?? await ask('Usuário (login): ')).toLowerCase();
const password = process.env.SETUP_PASSWORD ?? await ask('Senha (mín. 8 caracteres): ', true);
rl.close();

const problem = !name ? 'Informe o nome.' : !/^\S+@\S+\.\S+$/.test(email) ? 'E-mail inválido.' : !/^[a-z0-9._-]{3,30}$/.test(username) ? 'Usuário: 3 a 30 letras, números, ponto, hífen ou _.' : passwordProblem(password);
if (problem) { console.error(problem); process.exit(1); }

const info = db.prepare("INSERT INTO users (name, email, username, job_title, role, password_hash) VALUES (?,?,?,?,?,?)")
  .run(name, email, username, 'Gerente', 'gerente', await hashPassword(password));
db.prepare("INSERT INTO activity_log (user_id, action, entity, entity_id) VALUES (?,?,?,?)").run(info.lastInsertRowid, 'usuario_criado', 'users', info.lastInsertRowid);
console.log(`Gerente "${name}" criado. Entre com ${email} ou ${username}.`);
