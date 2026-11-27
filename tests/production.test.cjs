const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { after, before, test } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');

const firstBatch = 'e69122f6-9bb2-4d68-8b76-621c364bccee';
const deniedBatch = 'e69122f6-9bb2-4d68-8b76-621c364bcced';
const thirdBatch = 'e69122f6-9bb2-4d68-8b76-621c364bccec';

let db;
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create table batches (
      id uuid primary key default gen_random_uuid(), line_number integer not null, status text not null default 'open',
      package_type text not null default 'box', last_unit integer not null default 0, last_comp1 integer not null default 0,
      last_comp2 integer not null default 0, last_finished integer not null default 0, active_component text not null default 'comp1',
      closed_by text, closed_at timestamptz, last_box_weight numeric, dust_kg numeric
    );
    create table shift_reports (
      id bigint generated always as identity primary key, created_at timestamptz default now(),
      line_number integer, operator_name text, event_type text, line_status text,
      batch_id uuid, batch_number text, product_code text, ral_color text,
      package_type text, shift_key text, delta_comp1_kg numeric, delta_comp2_kg numeric,
      delta_finished_kg numeric, delta_boxes_kg numeric, comp1_to integer, comp2_to integer,
      finished_to integer, unit_from integer, unit_to integer, total_good_kg numeric check (total_good_kg >= 0),
      chips_kg numeric, defect_kg numeric, defect_boxes integer, dust_kg numeric, plan_kg numeric
    );
    grant select, update on batches to anon;
    grant select, insert on shift_reports to anon;
    alter table batches enable row level security;
    alter table shift_reports enable row level security;
    create policy read_batch on batches for select to anon using (true);
    create policy update_batch on batches for update to anon using (line_number in (6, 8)) with check (line_number in (6, 8));
    create policy read_reports on shift_reports for select to anon using (true);
    create policy insert_reports on shift_reports for insert to anon with check (line_number in (6, 8));
    create unique index one_open_batch_per_line on batches (line_number) where status = 'open';
    insert into batches (id, line_number, status, package_type, last_unit) values
      ('${firstBatch}', 6, 'open', 'box', 359), ('${deniedBatch}', 7, 'open', 'box', 359), ('${thirdBatch}', 8, 'open', 'box', 359);
  `);
  await db.exec(readFileSync('supabase/migrations/20261127162603_persist_operator_shift_operations.sql', 'utf8'));
  await db.exec('set role anon');
});
after(() => db?.close());

const counters = { last_unit: 359, last_comp1: 0, last_comp2: 0, last_finished: 0 };
const baseReport = {
  batch_id: firstBatch, line_number: 6, operator_name: 'ТЕСТ', package_type: 'box',
  shift_key: '2026-11-27|НОЧЬ', event_type: 'PRODUCTION', total_good_kg: 20
};

function record(id, report, expected = counters, changes = { last_unit: 360 }) {
  return db.query('select public.record_operator_production($1, $2, $3, $4)', [id, report, expected, changes]);
}

test('transaction rolls back batch counter when the journal insertion fails', async () => {
  await assert.rejects(record(randomUUID(), { ...baseReport, total_good_kg: -1 }), { code: '23514' });
  assert.equal((await db.query('select last_unit from batches where id = $1', [firstBatch])).rows[0].last_unit, 359);
  assert.equal((await db.query('select id from shift_reports')).rows.length, 0);
});

test('retry is idempotent, conflicts are rejected, shift close keeps the party open', async () => {
  const session = randomUUID();
  const report = { ...baseReport, operator_session_id: session };
  const operation = randomUUID();
  await record(operation, report);
  await record(operation, report);
  assert.equal((await db.query('select id from shift_reports')).rows.length, 1);
  await assert.rejects(record(randomUUID(), report), { message: 'primatek_batch_changed' });

  const end = randomUUID();
  const close = { ...report, event_type: 'SHIFT_CLOSE' };
  await record(end, close, { ...counters, last_unit: 360 }, { last_unit: 361 });
  await record(end, close, { ...counters, last_unit: 360 }, { last_unit: 361 });
  await assert.rejects(record(randomUUID(), close), { message: 'primatek_session_closed' });
  assert.deepEqual((await db.query('select status, last_unit from batches where id = $1', [firstBatch])).rows,
    [{ status: 'open', last_unit: 361 }]);
  assert.equal((await db.query('select id from shift_reports')).rows.length, 2);
});

test('pack closure is independent and respects existing row policies', async () => {
  await assert.rejects(record(randomUUID(), { ...baseReport, batch_id: deniedBatch, line_number: 7 }),
    { message: 'primatek_batch_changed' });
  assert.equal((await db.query('select last_unit from batches where id = $1', [deniedBatch])).rows[0].last_unit, 359);
  const session = randomUUID();
  const report = { ...baseReport, batch_id: thirdBatch, line_number: 8, operator_session_id: session };
  await record(randomUUID(), { ...report, event_type: 'PARTY_CLOSE', dust_kg: 2 }, counters,
    { last_unit: 360, last_box_weight: 18 });
  assert.equal((await db.query('select status from batches where id = $1', [thirdBatch])).rows[0].status, 'closed');
  await record(randomUUID(), { ...report, batch_id: null, event_type: 'SHIFT_CLOSE' }, null, null);
  assert.equal((await db.query('select id from shift_reports where operator_session_id = $1', [session])).rows.length, 2);
});
