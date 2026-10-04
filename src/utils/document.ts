export const digits = (s: string) => s.replace(/\D/g, '');

function cpfOk(d: string) {
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (const i of [9, 10]) {
    let sum = 0;
    for (let j = 0; j < i; j++) sum += Number(d[j]) * (i + 1 - j);
    if (((sum * 10) % 11) % 10 !== Number(d[i])) return false;
  }
  return true;
}
function cnpjOk(d: string) {
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((acc, wi, i) => acc + Number(d[i]) * wi, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}
export const validDocument = (d: string) => cpfOk(d) || cnpjOk(d);
