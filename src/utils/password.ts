import bcrypt from 'bcryptjs';

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);
// Hash descartável: usado quando o usuário não existe, para o tempo de resposta não revelar isso.
export const DUMMY_HASH = bcrypt.hashSync('senha-inexistente', 12);
export const passwordProblem = (p: string): string | null =>
  p.length < 8 ? 'A senha precisa ter pelo menos 8 caracteres.' : null;
