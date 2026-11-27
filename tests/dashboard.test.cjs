const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

for (const file of ['dashboard.html', 'docs/dashboard.html']) {
  test(file + ' uses the assigned period and preserves the timestamp fallback', () => {
    const html = readFileSync(file, 'utf8');
    const start = html.indexOf('function inReportPeriod(');
    const end = html.indexOf('function renderTopSummary(', start);
    const inReportPeriod = runInNewContext(html.slice(start, end) + '\ninReportPeriod');
    const night = {
      start: new Date('2026-11-27T20:00:00+03:00'), end: new Date('2026-11-28T08:00:00+03:00'),
      planDate: '2026-11-27', shiftName: 'НОЧЬ'
    };
    assert.equal(inReportPeriod({
      created_at: '2026-11-27T19:45:00+03:00', shift_key: '2026-11-27|НОЧЬ'
    }, night), true);
    assert.equal(inReportPeriod({
      created_at: '2026-11-27T23:41:00+03:00', shift_key: '2026-11-27|ДЕНЬ'
    }, night), false);
    assert.equal(inReportPeriod({ created_at: '2026-11-27T23:41:00+03:00' }, night), true);
    assert.equal(inReportPeriod({ created_at: '2026-11-28T08:00:00+03:00' }, night), false);
  });
}
