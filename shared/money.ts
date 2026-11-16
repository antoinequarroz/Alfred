/** « CHF 50.00 » : montant en centimes, à la suisse (point décimal, deux décimales). */
export function formatAmount(cents: number, currency: string): string {
  return `${currency.toUpperCase()} ${(cents / 100).toFixed(2)}`;
}
