-- SOLO LECTURA. Ejecutar después de migración y prueba 0050.
-- El primer resultado debe ser 0. No muestra datos personales.
select count(*) as reservas_sin_condiciones
from public.class_bookings b
where not exists(select 1 from public.class_booking_terms t where t.booking_id=b.id);

-- Cuatro categorías históricas, separando situación operativa y pago real.
-- Las versiones nuevas capturadas al reservar se muestran aparte.
with current_terms as (
  select distinct on (booking_id) * from public.class_booking_terms
  order by booking_id,version desc
), classified as (
  select b.status as estado_reserva,
    case
      when t.source='reservation' then 'Nueva: capturada al reservar'
      when t.source='manual_resolution' then 'Resolución manual explícita'
      when t.evidence_state='verified' then '1. Histórica: condiciones verificadas'
      when t.evidence_state='partial' then '2. Histórica: incluida, moneda no demostrada'
      when p.status='confirmed' then '3. Histórica: condiciones desconocidas, pago confirmado'
      else '4. Histórica: condiciones desconocidas, sin pago confirmado'
    end as categoria,
    (b.status='reserved' and t.evidence_state='unknown'
      and p.status is distinct from 'confirmed') as cobro_requiere_resolucion
  from public.class_bookings b
  join current_terms t on t.booking_id=b.id and t.gym_id=b.gym_id
  left join public.member_payments p on p.id=t.payment_evidence_id
)
select categoria,estado_reserva,cobro_requiere_resolucion,count(*) as cantidad
from classified group by categoria,estado_reserva,cobro_requiere_resolucion
order by categoria,estado_reserva;

-- Deben ser false/false/true; acceso exclusivamente mediante backend autorizado.
select has_table_privilege('authenticated','public.class_booking_terms','SELECT') as miembro_acceso_directo,
  has_table_privilege('service_role','public.class_booking_terms','INSERT') as backend_insercion_directa,
  has_table_privilege('service_role','public.class_booking_terms','SELECT') as backend_lectura;
