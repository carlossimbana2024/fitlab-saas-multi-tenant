export type DashboardPaymentRow = {
  amount: number | string;
  currency: string;
  membership_id: string | null;
  sale_id: string | null;
  class_booking_id: string | null;
};

type IncomeSlice = { amount: number; count: number };
type IncomeCategories = {
  memberships: IncomeSlice;
  stockSales: IncomeSlice;
  activities: IncomeSlice;
  other: IncomeSlice;
};

export type DashboardCurrencyIncome = IncomeSlice & {
  currency: string;
  categories: IncomeCategories;
};

function emptySlice(): IncomeSlice {
  return { amount: 0, count: 0 };
}

function emptyCurrency(currency: string): DashboardCurrencyIncome {
  return {
    currency,
    amount: 0,
    count: 0,
    categories: {
      memberships: emptySlice(),
      stockSales: emptySlice(),
      activities: emptySlice(),
      other: emptySlice(),
    },
  };
}

function categoryFor(payment: DashboardPaymentRow): keyof IncomeCategories {
  if (payment.membership_id) return 'memberships';
  if (payment.sale_id) return 'stockSales';
  if (payment.class_booking_id) return 'activities';
  return 'other';
}

export function summarizeDashboardIncome(rows: DashboardPaymentRow[], fallbackCurrency: string): DashboardCurrencyIncome[] {
  const totals = new Map<string, DashboardCurrencyIncome>();
  for (const payment of rows) {
    const amount = Number(payment.amount);
    if (!Number.isFinite(amount)) continue;
    const summary = totals.get(payment.currency) ?? emptyCurrency(payment.currency);
    const category = summary.categories[categoryFor(payment)];
    summary.amount += amount;
    summary.count += 1;
    category.amount += amount;
    category.count += 1;
    totals.set(payment.currency, summary);
  }

  if (!totals.size) totals.set(fallbackCurrency, emptyCurrency(fallbackCurrency));
  return [...totals.values()]
    .map((summary) => ({
      ...summary,
      amount: Number(summary.amount.toFixed(2)),
      categories: Object.fromEntries(Object.entries(summary.categories).map(([key, value]) => [
        key,
        { ...value, amount: Number(value.amount.toFixed(2)) },
      ])) as IncomeCategories,
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}
