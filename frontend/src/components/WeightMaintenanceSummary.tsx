export type WeightMaintenance = { currentWeightKg: number; targetWeightKg: number; differenceKg: number };

// Presentation only: use the signed difference returned by the backend/SQL.
export function WeightMaintenanceSummary({ value }: { value: WeightMaintenance }) {
  const format = (n: number) => new Intl.NumberFormat('es', { maximumFractionDigits: 2 }).format(n);
  const difference = value.differenceKg;
  return <span className="weight-maintenance-summary">
    <span>Actual: {format(value.currentWeightKg)} kg · Objetivo: {format(value.targetWeightKg)} kg</span>
    {' · '}<strong>{difference === 0 ? 'En tu peso objetivo' : `${format(Math.abs(difference))} kg por ${difference > 0 ? 'encima' : 'debajo'} del objetivo`}</strong>
  </span>;
}
