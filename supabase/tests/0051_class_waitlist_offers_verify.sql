-- SOLO LECTURA. Después de 0051 y 0052; no procesa colas de gimnasios reales.
-- Durante el checkpoint inicial se espera: offers_enabled=false, 00:30:00.
select offers_enabled,offer_window from private.class_waitlist_policy where singleton;

-- Un único trabajo INACTIVO con frecuencia configurada de un minuto.
select jobid,jobname,schedule,active from cron.job where jobname='fitlab-class-waitlist-offers';
-- Debe estar vacío para un trabajo nuevo: no debe ejecutarse antes de activarlo.
select status,start_time,end_time,return_message from cron.job_run_details
where jobid in (select jobid from cron.job where jobname='fitlab-class-waitlist-offers')
order by start_time desc limit 5;

-- Los tres contadores deben ser 0. Una rebaja de capacidad/deactivación se
-- reconcilia en el siguiente proceso o acceso; aquí no se modifica nada.
select
  (select count(*) from public.class_waitlist_offers where status='accepting') as aceptaciones_incompletas,
  (select count(*) from (
    select class_schedule_id,member_user_id from public.class_waitlists
    where status in ('waiting','offered') group by class_schedule_id,member_user_id having count(*)>1
  ) duplicates) as entradas_activas_duplicadas,
  (select count(*) from public.class_waitlist_offers o join public.class_schedules s on s.id=o.class_schedule_id
    where o.status='offered' and o.expires_at>=s.starts_at) as ofertas_hasta_despues_del_inicio;

select count(*) as sesiones_con_error_de_procesamiento from private.class_waitlist_runs where last_error is not null;
select has_function_privilege('authenticated','public.accept_class_waitlist_offer_backend(uuid,uuid,uuid)','EXECUTE') as ejecucion_directa_miembro,
  has_table_privilege('authenticated','public.class_waitlist_offers','SELECT') as lectura_directa_miembro,
  has_table_privilege('service_role','public.class_waitlist_offers','UPDATE') as escritura_directa_backend;
-- Los tres permisos anteriores deben ser false: las mutaciones usan RPC.
