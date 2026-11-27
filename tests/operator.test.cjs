const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { after, before, test } = require('node:test');
const { chromium } = require('playwright-core');

const sdkURL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const cssURL = 'https://cdn.tailwindcss.com';
const stateKey = 'primatek_local_v2';
const mockSDK = `
  async function request(method, table, args) {
    const response = await fetch('/test-api', {
      method: 'POST', body: JSON.stringify({ method, table, args })
    });
    return response.json();
  }
  class Query {
    constructor(table) { this.table = table; this.filters = {}; }
    select() { return this; }
    eq(key, value) { this.filters[key] = value; return this; }
    in(key, values) { this.filters[key] = values; return this; }
    order() { return this; }
    limit() { return this; }
    range() { return this; }
    insert(rows) { this.rows = rows; return this; }
    update(row) { this.updateRow = row; return this; }
    then(resolve, reject) {
      return request(this.rows ? 'insert' : this.updateRow ? 'update' : 'select',
        this.table, { filters: this.filters, rows: this.rows, update: this.updateRow }).then(resolve, reject);
    }
  }
  window.supabase = { createClient: () => ({
    from: table => new Query(table),
    rpc: (name, args) => request('rpc', name, args),
    channel() { return { on() { return this; }, subscribe() { return this; } }; }
  }) };
`;

let browser;
let server;
let url;
let database;

function fixture(pack = 'box') {
  return {
    batch: {
      id: 1, line_number: 6, status: 'open', batch_number: 'TEST', package_type: pack,
      opened_at: '2026-11-27T12:00:00Z', active_component: 'comp1',
      last_unit: pack === 'box' ? 359 : 0, last_comp1: pack === 'mix' ? 3 : 0,
      last_comp2: pack === 'mix' ? 5 : 0, last_finished: pack === 'mix' ? 2 : 0
    },
    reports: [], requests: [], applied: new Set(), loseResponse: false
  };
}

function handleRequest({ method, table, args }) {
  database.requests.push({ method, table, args });
  if (method === 'insert') {
    if (table === 'batches') {
      database.batch = { id: database.batch.id + 1, opened_at: '2026-11-27T16:00:00Z', ...args.rows[0] };
      return { data: [database.batch] };
    }
    database.reports.unshift(...args.rows);
    return {};
  }
  if (method === 'update') {
    Object.assign(database.batch, args.update);
    return {};
  }
  if (method === 'rpc') {
    const { p_operation_id: id, p_report: report, p_update: update } = args;
    if (!database.applied.has(id)) {
      database.applied.add(id);
      database.reports.unshift(report);
      if (update) Object.assign(database.batch, update);
      if (database.loseResponse) {
        database.loseResponse = false;
        return { error: { message: 'simulated lost response' } };
      }
    }
    return {};
  }
  if (table === 'batches' && database.failBatchRead) return { error: { message: 'connection unavailable' } };
  const rows = {
    batches: [database.batch], shift_reports: database.reports,
    shift_plans: database.plans || []
  }[table];
  return { data: rows.filter(row => Object.entries(args.filters).every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value)) };
}

before(async () => {
  server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    if (pathname === '/test-api') {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(handleRequest(JSON.parse(body))));
    } else if (pathname === '/mock-sdk.js' || pathname === '/mock-css.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(pathname === '/mock-sdk.js' ? mockSDK : '');
    } else if (['/', '/index.html', '/sw.js', '/docs/', '/docs/index.html', '/docs/sw.js'].includes(pathname)) {
      const file = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
      response.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript');
      const origin = 'http://' + request.headers.host;
      response.end(readFileSync('.' + file, 'utf8')
        .replaceAll(sdkURL, origin + '/mock-sdk.js')
        .replaceAll(cssURL + '/', origin + '/mock-css.js')
        .replaceAll(cssURL, origin + '/mock-css.js')
        .replaceAll('https://raw.githubusercontent.com/gurusveta/primatek/main/assets/', '/assets/'));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox']
  });
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function openApp(t, time, { legacy, path = '/docs/', pack = 'box' } = {}) {
  database = fixture(pack);
  const context = await browser.newContext({ timezoneId: 'Europe/Moscow' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(({ legacy, stateKey }) => {
    localStorage.setItem('primatek_pin_verified_v1', '1');
    if (legacy && !localStorage.getItem(stateKey)) localStorage.setItem(stateKey, JSON.stringify(legacy));
  }, { legacy, stateKey });
  await page.clock.install({ time: new Date(time) });
  await page.goto(url + path);
  await page.waitForFunction(() => typeof batchVerified !== 'undefined' && batchVerified && !refreshingWork);
  return { page, context };
}

async function accept(page, key) {
  await page.locator('#operatorName').fill('Тест Оператор');
  await page.selectOption('#handoverShift', key);
  await page.evaluate(() => selectHandoverStatus('В РАБОТЕ', document.querySelector('.hand-btn')));
  await page.evaluate(() => acceptHandover());
  assert.equal((await localState(page)).shiftAccepted, true);
}

function localState(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), stateKey);
}

test('early night handover survives offline cold reload at 23:41 and keeps box, dust and defects', async t => {
  const { page, context } = await openApp(t, '2026-11-27T19:30:00+03:00');
  const key = '2026-11-27|НОЧЬ';
  await page.evaluate(() => setPrimatekLanguage('uz'));
  await page.waitForFunction(() => document.getElementById('handoverShift').options[1].textContent.startsWith('TUN'));
  await page.evaluate(() => setPrimatekLanguage('tg'));
  await page.waitForFunction(() => document.getElementById('handoverShift').options[1].textContent.startsWith('ШАБ'));
  await page.evaluate(() => setPrimatekLanguage('ru'));
  await accept(page, key);
  await page.locator('#boxUnitInput').fill('362');
  await page.evaluate(() => {
    document.getElementById('dustInput').value = '3.5';
    addDust();
    document.getElementById('defStart').value = '361';
    document.getElementById('defEnd').value = '361';
    addDefect();
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });

  await page.clock.setSystemTime(new Date('2026-11-27T23:41:00+03:00'));
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.locator('#boxUnitInput').inputValue(), '362');
  assert.equal(await page.locator('#badgeDust').innerText(), '3.5 кг');
  assert.equal(await page.locator('#badgeDefect').innerText(), '20 кг');
  assert.equal((await localState(page)).shiftKey, key);
  assert.equal(await page.locator('#handoverSection').evaluate(node => node.classList.contains('hidden')), true);
  await page.evaluate(() => sendCheckpoint());
  assert.equal(database.reports.length, 1);

  await context.setOffline(false);
  await page.waitForFunction(() => batchVerified && !refreshingWork);
  await page.evaluate(() => sendCheckpoint());
  assert.equal(database.reports[0].shift_key, key);
  assert.equal(database.reports[0].delta_boxes_kg, 60);
  assert.equal(database.reports[0].total_good_kg, 40);
  assert.equal(database.reports[0].dust_kg, 3.5);
  assert.equal(database.batch.last_unit, 362);
  const state = await localState(page);
  assert.deepEqual(state.dust, []);
  assert.deepEqual(state.defects, []);
  assert.deepEqual(state.unitDrafts, {});
});

test('early day handover retains three separate mix drafts across 08:00', async t => {
  const { page, context } = await openApp(t, '2026-11-28T07:45:00+03:00', { pack: 'mix', path: '/' });
  const key = '2026-11-28|ДЕНЬ';
  await accept(page, key);
  await context.setOffline(true);
  await page.locator('#mixUnitInput').fill('5');
  await page.evaluate(() => setComponent('comp2'));
  await page.locator('#mixUnitInput').fill('8');
  await page.evaluate(() => setComponent('finished'));
  await page.locator('#mixUnitInput').fill('6');
  await page.clock.setSystemTime(new Date('2026-11-28T08:10:00+03:00'));
  await context.setOffline(false);
  await page.waitForFunction(() => batchVerified && !refreshingWork);
  await page.reload();
  await page.waitForFunction(() => batchVerified && !refreshingWork);
  assert.equal(await page.locator('#mixUnitInput').inputValue(), '6');
  assert.equal(await page.evaluate(() => myKgForDisplay()), 180);

  await page.evaluate(() => openClosePartyModal());
  assert.equal(await page.locator('#closeComp1').inputValue(), '5');
  assert.equal(await page.locator('#closeComp2').inputValue(), '8');
  await page.locator('#closeFinished').fill('7');
  await page.reload();
  await page.waitForFunction(() => batchVerified && !refreshingWork);
  await page.evaluate(() => openClosePartyModal());
  assert.equal(await page.locator('#closeFinished').inputValue(), '7');
  await page.evaluate(() => closeBatch());
  assert.equal(database.reports[0].event_type, 'PARTY_CLOSE');
  assert.equal(database.reports[0].delta_comp1_kg, 40);
  assert.equal(database.reports[0].delta_comp2_kg, 60);
  assert.equal(database.reports[0].delta_finished_kg, 100);
  assert.equal(database.batch.status, 'closed');
  assert.equal((await localState(page)).shiftAccepted, true);
});

test('legacy session keeps its original key across the boundary and SHIFT_CLOSE leaves the party open', async t => {
  const legacy = {
    line: 6, operator: 'ТЕСТ', shiftAccepted: true, shiftKey: '2026-11-27|ДЕНЬ',
    lineStatus: 'В РАБОТЕ', defects: [{ from: 360, to: 360, count: 1, kg: 20 }], dust: [2]
  };
  const { page } = await openApp(t, '2026-11-27T23:41:00+03:00', { legacy });
  assert.equal((await localState(page)).shiftAccepted, true);
  assert.equal(await page.locator('#badgeDust').innerText(), '2.0 кг');
  await page.locator('#boxUnitInput').fill('361');

  database.loseResponse = true;
  await page.evaluate(() => submitFinalShift());
  const awaiting = await localState(page);
  assert.equal(awaiting.shiftAccepted, true);
  assert.equal(awaiting.pendingProduction.report.shift_key, legacy.shiftKey);
  assert.deepEqual(awaiting.dust, [2]);

  await page.reload();
  await page.waitForFunction(key => !JSON.parse(localStorage.getItem(key)).shiftAccepted, stateKey);
  assert.equal(database.reports.length, 1);
  assert.equal(database.reports[0].event_type, 'SHIFT_CLOSE');
  assert.equal(database.reports[0].shift_key, legacy.shiftKey);
  assert.equal(database.batch.status, 'open');
  assert.equal(database.batch.last_unit, 361);
  const ids = database.requests.filter(request => request.method === 'rpc').map(request => request.args.p_operation_id);
  assert.deepEqual(ids, [awaiting.pendingProduction.id, awaiting.pendingProduction.id]);
});

test('when another device replaces the party, the previous draft is kept apart from its successor', async t => {
  const { page } = await openApp(t, '2026-11-27T19:30:00+03:00');
  await accept(page, '2026-11-27|НОЧЬ');
  await page.locator('#boxUnitInput').fill('362');
  await page.evaluate(() => {
    document.getElementById('dustInput').value = '3';
    addDust();
  });
  database.batch = { ...database.batch, id: 2, batch_number: 'NEW', last_unit: 1 };
  await page.evaluate(() => refreshWorkSession());
  const state = await localState(page);
  assert.equal(state.detachedDrafts[0].numbers.unit, 362);
  assert.deepEqual(state.detachedDrafts[0].dust, [3]);
  assert.equal(await page.locator('#boxUnitInput').inputValue(), '1');
  await page.locator('#boxUnitInput').fill('2');
  await page.evaluate(() => sendCheckpoint());
  assert.equal(database.reports[0].batch_id, 2);
  assert.equal(database.reports[0].delta_boxes_kg, 20);
  assert.equal(database.reports[0].dust_kg, 0);
});


test('a failed party read while the browser is online keeps the cached party and its draft', async t => {
  const { page } = await openApp(t, '2026-11-27T19:30:00+03:00');
  await accept(page, '2026-11-27|НОЧЬ');
  await page.locator('#boxUnitInput').fill('361');
  database.failBatchRead = true;
  await page.reload();
  await page.waitForFunction(() => typeof refreshingWork !== 'undefined' && !refreshingWork && !batchVerified);
  assert.equal(await page.locator('#boxUnitInput').inputValue(), '361');
  assert.equal((await localState(page)).shiftAccepted, true);
  await page.evaluate(() => sendCheckpoint());
  assert.equal(database.reports.length, 1);
  database.failBatchRead = false;
  await page.evaluate(() => refreshWorkSession());
  await page.evaluate(() => sendCheckpoint());
  assert.equal(database.reports[0].unit_to, 361);
});

for (const [time, oldKey, nextKey] of [
  ['2026-11-26T19:50:00+03:00', '2026-11-26|ДЕНЬ', '2026-11-26|НОЧЬ'],
  ['2026-11-27T07:50:00+03:00', '2026-11-26|НОЧЬ', '2026-11-27|ДЕНЬ']
]) {
  test('early handover uses the selected period for plan and fact: ' + nextKey, async t => {
    const { page } = await openApp(t, time);
    const work = { line_number: 6, event_type: 'PRODUCTION', batch_id: 1, operator_name: 'ДРУГОЙ ОПЕРАТОР' };
    database.reports = [
      { ...work, shift_key: oldKey, total_good_kg: 160 },
      { ...work, shift_key: oldKey, total_good_kg: 20 },
      { ...work, shift_key: nextKey, total_good_kg: 40 }
    ];
    const [plan_date, shift] = nextKey.split('|');
    database.plans = [{ plan_date, shift, line_number: 6, plan_kg: 200 }];
    await accept(page, nextKey);
    await page.waitForFunction(() => document.getElementById('linePlanPercent').innerText === '20%');
    assert.equal(await page.locator('#linePlanFact').innerText(), '40 кг');
    assert.equal(await page.locator('#statDonePlan').innerText(), '0 кг');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('linePlanFact').innerText === '40 кг');
    assert.equal(await page.locator('#statDonePlan').innerText(), '0 кг');
  });
}

test('day line fact retains genuine 180 kg while the new operator starts at zero', async t => {
  const { page } = await openApp(t, '2026-11-26T19:50:00+03:00');
  const shift_key = '2026-11-26|ДЕНЬ';
  database.reports = [
    { line_number: 6, event_type: 'PARTY_CLOSE', shift_key, total_good_kg: 160 },
    { line_number: 6, event_type: 'PRODUCTION', shift_key, total_good_kg: 20 }
  ];
  await accept(page, shift_key);
  await page.waitForFunction(() => document.getElementById('linePlanFact').innerText === '180 кг');
  assert.equal(await page.locator('#statDonePlan').innerText(), '0 кг');
  assert.equal(await page.locator('#linePlanPercent').innerText(), '—');
});

test('total personal production spans two parties and mixing breakdown excludes somebody else’s output', async t => {
  const { page } = await openApp(t, '2026-11-27T19:30:00+03:00', { pack: 'mix' });
  await accept(page, '2026-11-27|НОЧЬ');
  await page.locator('#mixUnitInput').fill('5');
  await page.evaluate(() => { openClosePartyModal(); });
  await page.evaluate(() => closeBatch());
  assert.equal(await page.locator('#statDonePlan').innerText(), '40 кг');

  await page.evaluate(() => {
    openNewBatchModal();
    setNewBatchPack('mix', document.querySelector('.new-pack-btn'));
    document.getElementById('newBatchNum').value = 'SECOND';
    document.getElementById('newProductCode').value = 'TEST';
    document.getElementById('newRal').value = '9005';
  });
  await page.evaluate(() => confirmOpenBatch());
  assert.equal(await page.locator('#statDonePlan').innerText(), '40 кг');
  assert.match(await page.locator('#mixTotals').innerText(), /ИТОГО:.*0 кг.*вы: 0 кг/s);

  await page.locator('#mixUnitInput').fill('2');
  await page.evaluate(() => sendCheckpoint());
  const session = (await localState(page)).sessionId;
  const batch = database.batch;
  database.reports.unshift({
    line_number: 6, event_type: 'PRODUCTION', operator_name: 'ДРУГОЙ ОПЕРАТОР', shift_key: '2026-11-27|НОЧЬ',
    operator_session_id: session + '-other', batch_id: batch.id, total_good_kg: 60, delta_comp1_kg: 60
  });
  batch.last_comp1 = 5;
  await page.reload();
  await page.waitForFunction(() => batchVerified && !refreshingWork);
  assert.equal(await page.locator('#statDonePlan').innerText(), '80 кг');
  assert.match(await page.locator('#mixTotals').innerText(), /ИТОГО:.*100 кг.*вы: 40 кг/s);
  assert.equal(await page.locator('#linePlanFact').innerText(), '140 кг');
});
