-- MIV: persistent 30-day report access, planner state and optional research consent.
-- Additive migration: does not delete or rename existing columns or rows.
-- Run once in Supabase SQL Editor before deploying the matching application branch.

begin;

alter table if exists public.miv_access_keys
  add column if not exists report_json jsonb,
  add column if not exists questionnaire_json jsonb,
  add column if not exists form_answers_json jsonb,
  add column if not exists planner_progress jsonb not null default '{"completed":[]}'::jsonb,
  add column if not exists generated_at timestamptz,
  add column if not exists access_expires_at timestamptz,
  add column if not exists privacy_acknowledged_at timestamptz,
  add column if not exists privacy_notice_version text,
  add column if not exists research_consent boolean not null default false,
  add column if not exists research_consent_at timestamptz,
  add column if not exists research_consent_revoked_at timestamptz,
  add column if not exists research_snapshot_id uuid;

create index if not exists miv_access_keys_access_expires_at_idx
  on public.miv_access_keys (access_expires_at)
  where access_expires_at is not null;

create table if not exists public.miv_research_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  month_bucket date not null,
  operating_format text,
  customer_age_band text,
  posting_frequency text,
  stories_frequency text,
  appearance_preference text,
  conversion_goal text,
  weekly_time_budget text,
  score_clareza smallint check (score_clareza between 0 and 100),
  score_credibilidade smallint check (score_credibilidade between 0 and 100),
  score_conteudo smallint check (score_conteudo between 0 and 100),
  score_conversao smallint check (score_conversao between 0 and 100),
  score_consistencia smallint check (score_consistencia between 0 and 100)
);

create index if not exists miv_research_snapshots_month_bucket_idx
  on public.miv_research_snapshots (month_bucket);

-- Daily cleanup of individually identifiable report material after the 30-day service window.
-- The purchase/access record remains for refunds, support and withdrawal of optional research consent.
-- The separate opted-in research snapshot is not touched by this job.
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

select cron.schedule(
  'miv-expired-report-data-cleanup',
  '0 3 * * *',
  $miv_cleanup$
    update public.miv_access_keys
       set report_json = null,
           questionnaire_json = null,
           form_answers_json = null,
           planner_progress = '{"completed":[]}'::jsonb
     where access_expires_at is not null
       and access_expires_at <= now()
       and (
         report_json is not null
         or questionnaire_json is not null
         or form_answers_json is not null
       );
  $miv_cleanup$
);

-- The application uses the Supabase service role on the server.
-- The public browser client receives no direct read/write access to these tables.
alter table public.miv_access_keys enable row level security;
alter table public.miv_research_snapshots enable row level security;

revoke all on table public.miv_access_keys from anon, authenticated;
revoke all on table public.miv_research_snapshots from anon, authenticated;
grant all on table public.miv_access_keys to service_role;
grant all on table public.miv_research_snapshots to service_role;

comment on column public.miv_access_keys.report_json is
  'Complete MIV report, stored server-side for returning access during the 30-day follow-up period.';
comment on column public.miv_access_keys.questionnaire_json is
  'Questionnaire text answers retained for service delivery and customer support under the privacy notice.';
comment on column public.miv_access_keys.form_answers_json is
  'Structured form answers needed to re-render the saved report.';
comment on column public.miv_access_keys.access_expires_at is
  'End of customer access to the saved report and planner; pg_cron clears individual report and questionnaire payloads after expiry.';
comment on column public.miv_access_keys.research_consent is
  'Optional permission for use of the separate, de-identified categorical research snapshot.';
comment on table public.miv_research_snapshots is
  'Optional research dataset. Excludes names, email addresses, Instagram handles, locations, free-text answers, screenshots and access keys. The internal row id is linked only to support consent withdrawal.';

commit;
