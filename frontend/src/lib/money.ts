export function formatBaht(amount: number): string {
  return amount.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
