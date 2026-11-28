create table public.line_pace_measurements (
  id uuid primary key,
  line_number integer not null check (line_number in (1, 5, 6, 7, 8, 13, 14, 15)),
  shift_key text not null check (shift_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[|](ДЕНЬ|НОЧЬ)$'),
  batch_id text not null check (length(batch_id) between 1 and 100),
  production_stage text not null check (production_stage in ('unit', 'comp1', 'comp2', 'finished')),
  measured_at timestamptz not null,
  elapsed_ms integer not null check (elapsed_ms > 0)
);
create index line_pace_latest_idx
  on public.line_pace_measurements (shift_key, line_number, measured_at desc);
alter table public.line_pace_measurements enable row level security;
revoke all on public.line_pace_measurements from public, anon, authenticated;
grant select, insert on public.line_pace_measurements to anon, authenticated;
create policy line_pace_read on public.line_pace_measurements
  for select to anon, authenticated using (true);
create policy line_pace_insert on public.line_pace_measurements
  for insert to anon, authenticated
  with check (measured_at <= now() + interval '5 minutes');
