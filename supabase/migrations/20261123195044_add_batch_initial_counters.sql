alter table public.batches
  add column if not exists initial_unit integer not null default 0,
  add column if not exists initial_comp1 integer not null default 0,
  add column if not exists initial_comp2 integer not null default 0,
  add column if not exists initial_finished integer not null default 0;
