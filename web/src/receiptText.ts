const maxMinor = 100_000_000_000;

export function parseReceiptText(text: string) {
  const items: { title: string; amount: number }[] = [];
  let tax = 0;
  let tip = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(.+?)\s+[\s$€£]*((?:\d{1,3}(?:[., ]\d{3})+|\d+)[.,]\d{2})$/);
    if (!match) continue;
    const title = match[1].trim();
    const amount = Number(match[2].replace(/\D/g, ""));
    if (/[-−]$/.test(title) || !/[\p{L}]/u.test(title) || !Number.isSafeInteger(amount) || amount <= 0 || amount > maxMinor) continue;
    if (/\b(tax|vat|iva)\b/i.test(title)) tax += amount;
    else if (/\b(tip|gratuity|propina)\b/i.test(title)) tip += amount;
    else if (!/\b(subtotal|total|balance|change|tender|cash|credit|debit|card|discount|payment|refund|paid|suggested|efectivo|tarjeta|vuelto|descuento)\b/i.test(title) && items.length < 50)
      items.push({ title: title.slice(0, 100), amount });
  }
  return { items, tax, tip };
}

export const minorInput = (amount: number) =>
  amount ? `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}` : "";
