import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';

type IncomeSlice = { amount: number; count: number };
type CurrencyIncome = IncomeSlice & {
  currency: string;
  categories: Record<'memberships' | 'stockSales' | 'activities' | 'other', IncomeSlice>;
};
type DashboardIncomeSummary = { month: string; currencies: CurrencyIncome[] };

export async function getDashboardIncome(gymId: string): Promise<DashboardIncomeSummary> {
  const { data, error } = await supabaseAdmin.rpc('get_owner_dashboard_income_backend', { target_gym_id: gymId });
  if (error) throw fromSupabaseError(error);
  if (data === null) throw new AppError(404, 'GYM_NOT_FOUND', 'El gimnasio no está disponible.');
  return data as DashboardIncomeSummary;
}
