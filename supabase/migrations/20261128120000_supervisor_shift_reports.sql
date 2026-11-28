create table public.supervisor_shift_reports (
 shift_key text primary key check (shift_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[|](ДЕНЬ|НОЧЬ)$'),
 supervisor text not null check (supervisor in ('Шарапов','Токин','Крылова')),
 accepted_at timestamptz not null default now(),
 closed_at timestamptz,
 revisions jsonb not null default '[]'::jsonb check (jsonb_typeof(revisions) = 'array')
);
alter table public.supervisor_shift_reports enable row level security;
revoke all on public.supervisor_shift_reports from public, anon, authenticated;
grant select on public.supervisor_shift_reports to anon, authenticated;
grant insert (shift_key, supervisor) on public.supervisor_shift_reports to anon, authenticated;
grant update (closed_at, revisions) on public.supervisor_shift_reports to anon, authenticated;
create policy shift_report_read on public.supervisor_shift_reports for select to anon, authenticated using (true);
create policy shift_report_accept on public.supervisor_shift_reports for insert to anon, authenticated with check (closed_at is null and revisions = '[]'::jsonb);
create policy shift_report_save on public.supervisor_shift_reports for update to anon, authenticated using (true) with check (true);
