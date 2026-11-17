/**
 * A run's or a task's model cost: "$4.20"; "≥ $4.20" when `known` is false (a
 * call could not be priced, so the figure is a lower bound); "<$0.01" for a
 * known non-zero cost under a cent; `null` when there is no cost to show.
 */
export function formatCost(usd: number | null | undefined, known = true): string | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;
  // A known cost under a cent; an unknown one stays a lower bound ("≥ $0.00").
  if (known && usd > 0 && usd < 0.01) return '<$0.01';
  const amount = `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return known ? amount : `≥ ${amount}`;
}
