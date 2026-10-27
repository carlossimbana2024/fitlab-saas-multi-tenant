-- Apply after 0051. Native SQL job: no HTTP endpoint, browser or new secret.
begin;
set local lock_timeout = '5s';
create extension if not exists pg_cron with schema pg_catalog;
-- Register and deactivate in ONE transaction: the scheduler never observes an
-- active intermediate job. Require alter_job support; otherwise roll back.
do $$
declare job_id bigint;
begin
  if exists(select 1 from cron.job where jobname='fitlab-class-waitlist-offers' and username<>current_user) then
    raise exception 'WAITLIST_CRON_OWNER_MISMATCH';
  end if;
  job_id:=cron.schedule('fitlab-class-waitlist-offers','* * * * *',
    'set statement_timeout = ''50s''; select public.process_class_waitlists_backend(100);');
  perform cron.alter_job(job_id,active:=false);
  if (select count(*) from cron.job where jobname='fitlab-class-waitlist-offers')<>1
    or exists(select 1 from cron.job where jobid=job_id and active) then
    raise exception 'WAITLIST_CRON_REGISTRATION_INVALID';
  end if;
end; $$;
commit;
