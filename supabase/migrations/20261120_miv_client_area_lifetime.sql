-- MIV: keep customer reports and planner available without a 30-day expiration.
-- This migration is intentionally additive: it preserves reports, answers, keys and purchase records.

begin;

-- Stop the previous 30-day cleanup job. Keep pg_cron installed for future scheduled work.
do $miv$
declare
  cleanup_job_id bigint;
begin
  select jobid
    into cleanup_job_id
    from cron.job
   where jobname = 'miv-expired-report-data-cleanup'
   limit 1;

  if cleanup_job_id is not null then
    perform cron.unschedule(cleanup_job_id);
  end if;
end
$miv$;

-- Remove the obsolete expiry timestamp from reports that are still stored.
-- No report, questionnaire answer, purchase, key or planner item is deleted.
update public.miv_access_keys
   set access_expires_at = null
 where report_json is not null
   and access_expires_at is not null;

comment on column public.miv_access_keys.access_expires_at is
  'Deprecated compatibility column. MIV report and planner access has no automatic expiration.';

commit;
