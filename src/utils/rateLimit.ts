// Limitador simples em memória: bloqueia após N falhas na janela. Suficiente para uma instância única.
const hits = new Map<string, { count: number; resetAt: number }>();

export function tooManyAttempts(key: string, max = 5): number {
  const h = hits.get(key);
  if (!h || h.resetAt < Date.now()) return 0;
  return h.count >= max ? Math.ceil((h.resetAt - Date.now()) / 1000) : 0;
}
export function registerFailure(key: string, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.resetAt < now) hits.set(key, { count: 1, resetAt: now + windowMs });
  else h.count += 1;
}
export const clearFailures = (key: string) => hits.delete(key);
