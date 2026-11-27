alter table public.shift_reports
  add column if not exists operator_session_id uuid,
  add column if not exists operation_id uuid;

create unique index if not exists shift_reports_operation_id
  on public.shift_reports (operation_id) where operation_id is not null;

create index if not exists shift_reports_operator_session_history
  on public.shift_reports (operator_session_id, created_at desc, id desc)
  where operator_session_id is not null;

create unique index if not exists shift_reports_operator_session_close
  on public.shift_reports (operator_session_id)
  where operator_session_id is not null and event_type = 'SHIFT_CLOSE';

create or replace function public.record_operator_production(
  p_operation_id uuid,
  p_report jsonb,
  p_expected jsonb,
  p_update jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  report public.shift_reports;
  expected public.batches;
  changes public.batches;
  closes_party boolean;
begin
  report := pg_catalog.jsonb_populate_record(null::public.shift_reports, p_report);
  closes_party := report.event_type = 'PARTY_CLOSE';

  if p_operation_id is null or report.event_type is null
    or report.event_type not in ('PRODUCTION', 'PARTY_CLOSE', 'SHIFT_CLOSE')
    or (report.batch_id is null and report.event_type <> 'SHIFT_CLOSE') then
    raise exception 'primatek_invalid_production';
  end if;

  -- A retry waits for the original transaction before checking its outcome.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operation_id::text, 0));
  if exists (select 1 from public.shift_reports where operation_id = p_operation_id) then
    return;
  end if;

  if report.operator_session_id is not null then
    -- Keep two clients from committing separate closures for the same session.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(report.operator_session_id::text, 1));
    if exists (
      select 1 from public.shift_reports
      where operator_session_id = report.operator_session_id and event_type = 'SHIFT_CLOSE'
    ) then
      raise exception 'primatek_session_closed';
    end if;
  end if;

  if report.batch_id is not null then
    expected := pg_catalog.jsonb_populate_record(null::public.batches, p_expected);
    changes := pg_catalog.jsonb_populate_record(null::public.batches, p_update);

    -- The counter predicates are rechecked if a concurrent update holds the row lock.
    update public.batches b set
      last_unit = coalesce(changes.last_unit, b.last_unit),
      last_comp1 = coalesce(changes.last_comp1, b.last_comp1),
      last_comp2 = coalesce(changes.last_comp2, b.last_comp2),
      last_finished = coalesce(changes.last_finished, b.last_finished),
      active_component = coalesce(changes.active_component, b.active_component),
      status = case when closes_party then 'closed' else b.status end,
      closed_by = case when closes_party then report.operator_name else b.closed_by end,
      closed_at = case when closes_party then pg_catalog.now() else b.closed_at end,
      last_box_weight = case when closes_party then changes.last_box_weight else b.last_box_weight end,
      dust_kg = case when closes_party then report.dust_kg else b.dust_kg end
    where b.id = report.batch_id and b.line_number = report.line_number
      and b.status = 'open' and b.package_type = report.package_type
      and coalesce(b.last_unit, 0) = expected.last_unit
      and coalesce(b.last_comp1, 0) = expected.last_comp1
      and coalesce(b.last_comp2, 0) = expected.last_comp2
      and coalesce(b.last_finished, 0) = expected.last_finished
      and coalesce(changes.last_unit, expected.last_unit) >= expected.last_unit
      and coalesce(changes.last_comp1, expected.last_comp1) >= expected.last_comp1
      and coalesce(changes.last_comp2, expected.last_comp2) >= expected.last_comp2
      and coalesce(changes.last_finished, expected.last_finished) >= expected.last_finished;

    if not found then
      raise exception 'primatek_batch_changed';
    end if;
  end if;

  insert into public.shift_reports (
    operation_id, operator_session_id, line_number, operator_name, event_type, line_status,
    batch_id, batch_number, product_code, ral_color, package_type, shift_key,
    delta_comp1_kg, delta_comp2_kg, delta_finished_kg, delta_boxes_kg,
    comp1_to, comp2_to, finished_to, unit_from, unit_to, total_good_kg,
    chips_kg, defect_kg, defect_boxes, dust_kg, plan_kg
  ) values (
    p_operation_id, report.operator_session_id, report.line_number, report.operator_name, report.event_type, report.line_status,
    report.batch_id, report.batch_number, report.product_code, report.ral_color, report.package_type, report.shift_key,
    report.delta_comp1_kg, report.delta_comp2_kg, report.delta_finished_kg, report.delta_boxes_kg,
    report.comp1_to, report.comp2_to, report.finished_to, report.unit_from, report.unit_to, report.total_good_kg,
    report.chips_kg, report.defect_kg, report.defect_boxes, report.dust_kg, report.plan_kg
  );
end;
$$;

revoke execute on function public.record_operator_production(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.record_operator_production(uuid, jsonb, jsonb, jsonb) to anon, authenticated;
