import { config } from '../config.js';

export type PeriodKey = 'hoje' | '7dias' | 'mes' | 'mes_anterior' | 'custom';
export interface Period { start: Date; end: Date; days: string[] }

const H = 3600_000, DAY = 24 * H, OFF = config.tzOffsetHours;
export const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
export const localDate = (d: Date) => new Date(d.getTime() + OFF * H).toISOString().slice(0, 10);
// Meia-noite local do dia (y, m, d) expressa em UTC.
const dayStart = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d) - OFF * H);

export function listDays(start: Date, end: Date): string[] {
  const out: string[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY) out.push(localDate(new Date(t)));
  return out;
}

export function resolvePeriod(key: PeriodKey, now = new Date(), from?: string, to?: string): Period {
  const l = new Date(now.getTime() + OFF * H);
  const y = l.getUTCFullYear(), m = l.getUTCMonth(), d = l.getUTCDate();
  let start: Date, end: Date;
  if (key === 'hoje') { start = dayStart(y, m, d); end = dayStart(y, m, d + 1); }
  else if (key === '7dias') { start = dayStart(y, m, d - 6); end = dayStart(y, m, d + 1); }
  else if (key === 'mes') { start = dayStart(y, m, 1); end = dayStart(y, m, d + 1); }
  else if (key === 'mes_anterior') { start = dayStart(y, m - 1, 1); end = dayStart(y, m, 1); }
  else {
    const [fy, fm, fd] = from!.split('-').map(Number), [ty, tm, td] = to!.split('-').map(Number);
    start = dayStart(fy, fm - 1, fd); end = dayStart(ty, tm - 1, td + 1);
  }
  return { start, end, days: listDays(start, end) };
}

export const previousPeriod = (p: Period): Period => {
  const len = p.end.getTime() - p.start.getTime();
  const start = new Date(p.start.getTime() - len);
  return { start, end: p.start, days: listDays(start, p.start) };
};

// Últimos n meses (inclui o atual) como 'YYYY-MM', do mais antigo ao mais recente.
export function lastMonths(n: number, now = new Date()): string[] {
  const l = new Date(now.getTime() + OFF * H);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth() - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

export const isoUtc = (s: string) => s.replace(' ', 'T') + 'Z';
