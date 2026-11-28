function groupDashboardRows(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

const dashboardDialog = document.getElementById('dashboardDialog');
const dashboardPanel = document.getElementById('dashboardPanel');
const productionEvents = ['PRODUCTION', 'PARTY_CLOSE', 'SHIFT_CLOSE'];
const kgText = value => Number(value).toLocaleString('ru-RU') + ' кг';
const shiftKey = period => period.planDate + '|' + period.shiftName;
const currentKey = () => shiftKey(getCurrentShiftInfo());
const clockText = value => new Date(value).toLocaleTimeString('ru-RU', {timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
const dateText = value => new Date(value).toLocaleString('ru-RU', {timeZone:'Europe/Moscow'});
const dateAt = offset => {
  const today = new Date(new Date().toLocaleDateString('sv-SE', {timeZone:'Europe/Moscow'}) + 'T00:00:00+03:00');
  today.setUTCDate(today.getUTCDate() + offset);
  return today.toLocaleDateString('sv-SE', {timeZone:'Europe/Moscow'});
};
const controlsForLines = () => '<option value="">Все линии</option>' + PRIMATEK_LINES.map(line => '<option>' + line + '</option>').join('');

function periodKeyForEvent(row) {
  if (row.shift_key) return row.shift_key;
  const instant = new Date(row.created_at);
  const hour = Number(instant.toLocaleTimeString('en-GB',{timeZone:'Europe/Moscow',hour:'2-digit',hourCycle:'h23'}));
  if (hour < 8) instant.setUTCDate(instant.getUTCDate()-1);
  return instant.toLocaleDateString('sv-SE',{timeZone:'Europe/Moscow'}) + '|' + (hour >= 8 && hour < 20 ? 'ДЕНЬ' : 'НОЧЬ');
}

function reportingRange(from, to) {
  if (!from || !to || from > to) throw Error('Укажите корректный период.');
  const start = new Date(from + 'T08:00:00+03:00');
  const end = new Date(to + 'T08:00:00+03:00');
  end.setUTCDate(end.getUTCDate()+1);
  return {start: start.toISOString(), end: end.toISOString(), from, to};
}

async function readPages(query, sort) {
  const rows = [];
  for (let offset = 0;; offset += 500) {
    const {data, error} = await query().order(sort).range(offset,offset+499).abortSignal(AbortSignal.timeout(15000));
    if (error) throw error;
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

function rangeReports(range, line) {
  return readPages(() => {
    const q = client.from('shift_reports').select('*').in('line_number',line ? [line] : PRIMATEK_LINES)
      .or('and(shift_key.gte.' + range.from + '|ДЕНЬ,shift_key.lte.' + range.to +
        '|НОЧЬ),and(shift_key.is.null,created_at.gte.' + range.start + ',created_at.lt.' + range.end + ')');
    return q;
  },'id');
}

function switchDashboard(view, line) {
  for (const name of ['live','analytics','archive']) {
    document.getElementById('view-' + name).hidden = name !== view;
    document.getElementById('nav-' + name).setAttribute('aria-pressed', String(name === view));
  }
  if (view === 'archive') {
    if (line) document.getElementById('historyLine').value = line;
    searchHistory();
  }
  if (view === 'analytics') openAnalytics();
}

function showPanel(title, html) {
  document.getElementById('dashboardPanelTitle').textContent = title;
  dashboardPanel.innerHTML = html;
  if (!dashboardDialog.open) dashboardDialog.showModal();
}

function showLineDetails(line) {
  const card = document.querySelector('[data-line="' + line + '"]');
  const party = card.querySelector('.line-party-details');
  showPanel('Линия №' + line, card.querySelector('.status-badge').outerHTML + card.querySelector('.line-details').outerHTML +
    Array.from(card.querySelectorAll('.line-output-box'), box => box.outerHTML).join('') +
    (party ? party.outerHTML.replace('<details ', '<details open ') : '') +
    '<div class="board-actions"><button onclick="openAnalytics(' + line + ')">Аналитика</button><button onclick="openLineHistory(' + line + ')">История</button></div>');
}

function openLineHistory(line) {
  if (dashboardDialog.open) dashboardDialog.close();
  switchDashboard('archive',line);
}

function openShiftPlan() {
  const period = getCurrentShiftInfo();
  showPanel('План смены · ' + shiftKey(period).replace('|',' · '),
    '<form id="shiftPlanForm" class="board-stack"><div class="plan-grid">' +
    [0,...PRIMATEK_LINES].map(line => '<label>' + (line ? 'Линия №'+line : 'Общий план цеха') +
      '<input type="number" min="0" step="1" name="' + line + '" placeholder="кг" value="' +
      (Number(rawPlans.find(row => row.line_number === line)?.plan_kg) || '') + '"></label>').join('') +
    '</div><p class="board-muted">План в килограммах. Пустое поле снимает план.</p><button type="submit">Сохранить</button><p role="status"></p></form>');
  const form = document.getElementById('shiftPlanForm');
  const baseline = rawPlans.slice();
  form.onsubmit = async event => {
    event.preventDefault();
    const status = form.querySelector('[role=status]');
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      if (shiftKey(period) !== currentKey()) throw Error('Смена уже изменилась. Откройте план заново.');
      const records = [...new FormData(form)].filter(([line,value]) =>
        Number(value) !== Number(baseline.find(row => Number(row.line_number) === Number(line))?.plan_kg || 0))
        .map(([line,value]) => ({plan_date:period.planDate,shift:period.shiftName,line_number:Number(line),plan_kg:Number(value)}));
      if (records.length) {
        const {error} = await client.from('shift_plans').upsert(records,{onConflict:'plan_date,shift,line_number'});
        if (error) throw error;
      }
      dashboardDialog.close();
      if (dashboardRequest) await dashboardRequest;
      await loadDashboardData();
    } catch (error) {
      console.error(error);
      status.textContent = 'План не сохранён. Проверьте соединение или откройте окно заново.';
    } finally {button.disabled = false;}
  };
}

function rangeInputs(from,to,prefix) {
  return '<label>С даты<input required type="date" id="'+prefix+'From" value="'+from+'"></label>' +
    '<label>По дату<input required type="date" id="'+prefix+'To" value="'+to+'"></label>';
}

const historyForm = document.getElementById('historyForm');
historyForm.insertAdjacentHTML('afterbegin',rangeInputs(dateAt(-6),dateAt(0),'history'));
document.getElementById('historyLine').innerHTML = controlsForLines();
historyForm.onsubmit = event => {event.preventDefault(); searchHistory();};
let historyRequest = 0;
let historyExport = [];

function exportHistory() {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(historyExport),'Архив линий');
  XLSX.writeFile(book,'Пролетарий-архив.xlsx');
}

function operatorRanges(rows) {
  const last = new Map();
  return rows.slice().sort((a,b) => Date.parse(a.created_at)-Date.parse(b.created_at) || Number(a.id)-Number(b.id)).flatMap(row => {
    if (!productionEvents.includes(row.event_type)) return [];
    const stages = [['Коробка',row.unit_to,row.unit_from,'boxes'],['Компонент 1',row.comp1_to,null,'comp1'],
      ['Компонент 2',row.comp2_to,null,'comp2'],['Готовая краска',row.finished_to,null,'finished']];
    const ranges = [];
    for (const [stage,end,explicit,key] of stages) {
      if (!row.batch_id || !Number(end)) continue;
      const index = row.batch_id + '|' + stage;
      const previous = last.get(index);
      const delta = Number(row['delta_'+key+'_kg']);
      const start = Number(row[key+'_from']) || Number(explicit) ||
        (delta > 0 && delta % 20 === 0 && (previous === undefined || previous === Number(end)-delta/20)
          ? Number(end)-delta/20+1 : 0);
      last.set(index,Number(end));
      if (start > 0 && start <= Number(end)) ranges.push({stage,start,end:Number(end)});
    }
    return [{row,ranges}];
  });
}

async function searchHistory() {
  const request = ++historyRequest;
  const output = document.getElementById('historyResults');
  output.textContent = 'Загрузка истории…';
  historyExport = [];
  try {
    const range = reportingRange(document.getElementById('historyFrom').value,document.getElementById('historyTo').value);
    const line = document.getElementById('historyLine').value;
    const party = document.getElementById('historyParty').value.trim().toLowerCase();
    const operator = document.getElementById('historyOperator').value.trim().toLowerCase();
    const box = Number(document.getElementById('historyBox').value);
    const [rows,supervisorReports] = await Promise.all([
      rangeReports(range,line),
      readPages(() => client.from('supervisor_shift_reports').select('shift_key, supervisor, closed_at')
        .gte('shift_key',range.from+'|ДЕНЬ').lte('shift_key',range.to+'|НОЧЬ'),'shift_key')
    ]);
    if (request !== historyRequest) return;
    const indexed = new Map(operatorRanges(rows).map(item => [item.row.id,item.ranges]));
    const matches = rows.filter(row =>
      (!party || String(row.batch_number || '').toLowerCase().includes(party)) &&
      (!operator || String(row.operator_name || '').toLowerCase().includes(operator)) &&
      (!box || (indexed.get(row.id) || []).some(item => box >= item.start && box <= item.end)))
      .sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
    const grouped = groupDashboardRows(matches,periodKeyForEvent);
    historyExport = matches.map(row=>({
      Время: dateText(row.created_at), Линия: Number(row.line_number), Оператор: row.operator_name || '',
      Партия: row.batch_number || '', Событие: row.event_type, Статус: row.line_status || '',
      'Готовая краска (кг)': productionEvents.includes(row.event_type) ? shiftTotals([row]).paint : '',
      'Полукомпоненты (кг)': row.chips_kg || 0, 'Пыль (кг)': row.dust_kg || 0,
      Диапазоны: (indexed.get(row.id)||[]).map(item=>item.stage+' №'+item.start+'–'+item.end).join('; ')
    }));
    const labels = {PRODUCTION:'Промежуточный выпуск',PARTY_CLOSE:'Партия закрыта',SHIFT_CLOSE:'Смена сдана',STATUS_CHANGE:'Статус линии'};
    output.innerHTML = '<h3>Отчёты цеха</h3>' + (supervisorReports.length ?
      supervisorReports.slice().reverse().map(row => '<button class="history-report" data-shift="'+escapeHtml(row.shift_key)+'">' +
        escapeHtml(row.shift_key.replace('|',' · ') + ' · ' + row.supervisor + (row.closed_at?'':' · открыта')) + '</button>').join('') :
      '<p class="board-muted">За период отчётов начальников нет.</p>') +
      '<h3>События линий</h3>' + (matches.length ? '<div class="board-actions"><button onclick="exportHistory()">Скачать в Excel</button></div>' : '') + (matches.length ? [...grouped].map(([key,events]) =>
        '<details class="history-group" '+(box?'open':'')+'><summary>'+escapeHtml(key.replace('|',' · '))+' · '+events.length+'</summary>'+
        '<div class="scroll-table"><table><thead><tr><th>Время</th><th>Линия</th><th>Оператор</th><th>Партия</th><th>Событие</th><th>Выпуск</th><th>Диапазоны</th></tr></thead><tbody>'+
        events.map(row => '<tr><td>'+clockText(row.created_at)+'</td><td>'+Number(row.line_number)+'</td><td>'+escapeHtml(row.operator_name || '—')+
          '</td><td>'+escapeHtml(row.batch_number || '—')+'</td><td>'+escapeHtml([labels[row.event_type] || row.event_type,row.line_status,row.repair_reason].filter(Boolean).join(' · '))+
          '</td><td>'+(productionEvents.includes(row.event_type)?kgText(row.total_good_kg):'—')+'</td><td>'+
          (indexed.get(row.id)||[]).map(item=>escapeHtml(item.stage+' №'+item.start+'–'+item.end)).join('<br>')+'</td></tr>').join('')+
        '</tbody></table></div></details>').join('') : '<p>Совпадений нет.</p>');
    output.querySelectorAll('[data-shift]').forEach(button => button.onclick = () => openSupervisorReport(button.dataset.shift));
  } catch (error) {
    if (request !== historyRequest) return;
    console.error(error);
    output.textContent = 'Не удалось загрузить историю. Проверьте даты и соединение.';
  }
}

const reportKey = document.getElementById('supervisorShiftLabel');
async function refreshSupervisorShift() {
  const key = currentKey();
  const {data,error} = await client.from('supervisor_shift_reports').select('*').eq('shift_key',key).maybeSingle().abortSignal(AbortSignal.timeout(12000));
  if (key !== currentKey()) return;
  if (error) {
    reportKey.textContent = 'Статус приёмки недоступен';
    return;
  }
  reportKey.textContent = data
    ? data.supervisor + ' · ' + (data.closed_at ? 'смена сдана' : 'принята в ' + clockText(data.accepted_at))
    : 'Смена цеха не принята';
  document.getElementById('acceptSupervisorButton').hidden = Boolean(data);
}

async function openSupervisorAcceptance() {
  const key = currentKey();
  const selected = document.getElementById('supervisorSelect').value;
  if (!selected) {showNotice('Выберите начальника смены.','warning');return;}
  showPanel('Принять смену · ' + key.replace('|',' · '),'<p>Смена будет записана на '+escapeHtml(selected)+'.</p><p id="handoverNote" class="board-muted"></p><ul class="handover-list">'+
    PRIMATEK_LINES.map(line => {
      const party = rawBatches.find(row => Number(row.line_number) === line);
      const status = rawReports.find(row => Number(row.line_number) === line && row.event_type === 'STATUS_CHANGE');
      const packageInfo = party?.package_type === 'mix'
        ? ' · 1 п/ф №'+Number(party.last_comp1||0)+' · 2 п/ф №'+Number(party.last_comp2||0)+' · краска №'+Number(party.last_finished||0)
        : party ? ' · последняя коробка №'+Number(party.last_unit||0) : '';
      return '<li>Линия №'+line+' · '+(party ? 'партия '+escapeHtml(party.batch_number)+packageInfo : 'без открытой партии')+
        (status?.line_status && status.line_status !== 'В РАБОТЕ' ? ' · последний статус: '+escapeHtml(status.line_status+(status.repair_reason?' · '+status.repair_reason:'')) : '')+'</li>';
    }).join('')+'</ul><div class="board-actions"><button id="confirmSupervisorAcceptance">Принять смену</button><p role="status"></p></div>');
  const note = document.getElementById('handoverNote');
  const button = document.getElementById('confirmSupervisorAcceptance');
  button.onclick = async () => {
    button.disabled = true;
    try {
      if (key !== currentKey()) throw Error('Смена уже изменилась.');
      const {error} = await client.from('supervisor_shift_reports').insert({shift_key:key,supervisor:selected});
      if (error) throw error;
      dashboardDialog.close();
      await refreshSupervisorShift();
    } catch (error) {
      console.error(error);
      showNotice(error.code === '23505' ? 'Эту смену уже приняли.' : 'Не удалось принять смену.','error');
      await refreshSupervisorShift();
    } finally {button.disabled = false;}
  };
  const previous = await client.from('supervisor_shift_reports').select('shift_key,supervisor,revisions').lt('shift_key',key)
    .order('shift_key',{ascending:false}).limit(1).maybeSingle();
  const comment = previous.data?.revisions?.at(-1)?.comment;
  if (comment) note.textContent = previous.data.supervisor + ' передал: ' + comment;
}

function shiftTotals(rows) {
  return rows.reduce((total,row) => {
    const components = Number(row.chips_kg)||0;
    total.paint += Math.max(0,(Number(row.total_good_kg)||0)-components);
    total.parts += components;
    total.dust += Number(row.dust_kg)||0;
    return total;
  },{paint:0,parts:0,dust:0});
}

function summarizeShift(rows, plans) {
  return PRIMATEK_LINES.map(line => {
    const events = rows.filter(row => Number(row.line_number) === line);
    const closed = events.filter(row => row.event_type === 'SHIFT_CLOSE');
    const closedSessions = new Set(closed.map(row => row.operator_session_id || row.operator_name));
    const confirmed = events.filter(row => productionEvents.includes(row.event_type) &&
      closedSessions.has(row.operator_session_id || row.operator_name));
    const pending = events.some(row => (row.operator_session_id || row.operator_name) &&
      !closedSessions.has(row.operator_session_id || row.operator_name));
    return {line, status:pending?'Ожидается сдача':closed.length?'Сдано':'Смена не принята', confirmed:Boolean(closed.length),
      ...shiftTotals(confirmed),plan:Number(plans.find(row => Number(row.line_number)===line)?.plan_kg)||0,
      operators:[...new Set(confirmed.map(row=>row.operator_name).filter(Boolean))],
      parties:[...new Set(confirmed.map(row=>row.batch_number).filter(Boolean))]};
  });
}

const reportColumns = [['paint','Готовая краска'],['parts','Полукомпоненты'],['dust','Пыль']];
function shiftReportTable(lines) {
  return '<div class="scroll-table report-table"><table><thead><tr><th>Линия</th><th>Отчёт</th>'+
    reportColumns.map(([,label])=>'<th>'+label+'</th>').join('')+
    '<th>План</th></tr></thead><tbody>'+lines.map(row =>
      '<tr><td>№'+row.line+'</td><td>'+escapeHtml(row.status)+
      ((row.operators.length || row.parties.length) ? '<details><summary>Операторы и партии</summary>'+escapeHtml([...row.operators,...row.parties].join(' · '))+'</details>':'')+
      '</td>'+reportColumns.map(([key])=>'<td>'+(row.confirmed || row.correction ? kgText(row[key]):'—')+'</td>').join('')+
      '<td>'+(row.plan ? kgText(row.plan)+' · '+ (row.confirmed || row.correction ? Math.round(row.paint/row.plan*100)+'%':'—'):'—')+'</td></tr>').join('')+
    '<tr><th colspan="2">Итого</th>'+reportColumns.map(([key])=>'<th>'+kgText(lines.reduce((sum,row)=>sum+row[key],0))+'</th>').join('')+'<th></th></tr></tbody></table></div>';
}

let supervisorReportRequest = 0;
async function openSupervisorReport(key = currentKey(), edit = false, version = null) {
  const request = ++supervisorReportRequest;
  showPanel('Отчёт смены · '+key.replace('|',' · '),'<p>Загрузка отчёта…</p>');
  try {
    const [date,shift] = key.split('|');
    const range = reportingRange(date,date);
    const [records, plans, owner] = await Promise.all([
      rangeReports(range),
      client.from('shift_plans').select('*').eq('plan_date',date).eq('shift',shift),
      client.from('supervisor_shift_reports').select('*').eq('shift_key',key).maybeSingle()
    ]);
    if (request !== supervisorReportRequest || !dashboardDialog.open) return;
    if (plans.error || owner.error) throw plans.error || owner.error;
    const record = owner.data;
    const revisions = record?.revisions || [];
    const saved = version === null ? revisions.at(-1) : revisions[version];
    const source = summarizeShift(records.filter(row => periodKeyForEvent(row) === key),plans.data);
    const snapshot = saved && !edit ? saved.lines : source.map(line => {
      const prior = saved?.lines.find(item => item.line === line.line);
      return prior?.correction ? {...line,...Object.fromEntries(reportColumns.map(([field])=>[field,prior[field]])),correction:prior.correction} : line;
    });
    const caption = record ? record.supervisor + ' · принято в ' + clockText(record.accepted_at) : 'Начальник ещё не принял смену';
    const state = saved && !edit ? (saved.preliminary?'Предварительный':'Подтверждён') + ' · версия '+(version === null ? revisions.length : version+1) : 'Предварительный · черновик';
    const comment = saved?.comment || '';
    const editable = record && (!saved || edit);
    dashboardPanel.innerHTML = '<div class="board-stack"><p>'+escapeHtml(caption)+' · '+state+'</p>'+shiftReportTable(snapshot)+
      (editable ? '<form id="supervisorReportForm" class="board-stack">'+
        '<details><summary>Скорректировать показатели</summary>'+snapshot.map(row=>'<fieldset class="correction-grid"><legend>Линия №'+row.line+'</legend>'+
          reportColumns.map(([field,label])=>'<label>'+label+'<input type="number" min="0" step="0.01" name="'+row.line+'-'+field+'" value="'+row[field]+'"></label>').join('')+
          '<label>Причина правки<input name="'+row.line+'-reason" value="'+escapeAttribute(row.correction?.reason || '')+'"></label></fieldset>').join('')+'</details>'+
        '<label>Комментарий следующей смене<textarea name="comment">'+escapeHtml(comment)+'</textarea></label>'+
        '<div class="board-actions"><button type="submit">'+(saved?'Сохранить новую версию':record.closed_at?'Сохранить отчёт':'Сдать смену')+'</button><p role="status"></p></div></form>' :
        (comment?'<p>Передача смены: '+escapeHtml(comment)+'</p>':''))+
      '<div class="board-actions"><button onclick="window.print()">Печать / PDF</button>'+
      (saved && !edit ? '<button id="editShiftReport">Скорректировать / обновить итоги</button>':'')+
      (revisions.length > 1 ? '<label>Версия<select id="shiftRevision">'+revisions.map((entry,i)=>'<option value="'+i+'" '+(i===(version??revisions.length-1)?'selected':'')+'>Версия '+(i+1)+' · '+escapeHtml(dateText(entry.at))+'</option>').join('')+'</select></label>':'')+'</div>'+
      (saved && !edit ? '<details><summary>Правки в этой версии</summary>'+snapshot.filter(row=>row.correction).map(row=>'<p>№'+row.line+' · '+escapeHtml(row.correction.reason)+' · '+escapeHtml(row.correction.by)+' · '+escapeHtml(dateText(row.correction.at))+' · '+
        reportColumns.filter(([field])=>row.correction.original?.[field]!==undefined).map(([field,label])=>label+': '+kgText(row.correction.original[field])+' → '+kgText(row[field])).join('; ')+'</p>').join('')+'</details>':'')+'</div>';
    const editButton = document.getElementById('editShiftReport');
    if (editButton) editButton.onclick = () => openSupervisorReport(key,true);
    const revision = document.getElementById('shiftRevision');
    if (revision) revision.onchange = () => openSupervisorReport(key,false,Number(revision.value));
    const form = document.getElementById('supervisorReportForm');
    if (!form) return;
    form.onsubmit = async event => {
      event.preventDefault();
      const status = form.querySelector('[role=status]');
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        if (document.getElementById('supervisorSelect').value !== record.supervisor) throw Error('Выберите профиль начальника, принявшего смену.');
        const fields = new FormData(form);
        const at = new Date().toISOString();
        const lines = snapshot.map(row => {
          const next = {...row};
          for (const [field] of reportColumns) next[field] = Number(fields.get(row.line+'-'+field));
          if (reportColumns.some(([field]) => next[field] !== row[field])) {
            const reason = String(fields.get(row.line+'-reason')).trim();
            if (!reason) throw Error('Укажите причину правки для линии №'+row.line+'.');
            next.correction = {reason,by:record.supervisor,at,original:Object.fromEntries(reportColumns.map(([field])=>[field,row[field]]))};
          }
          return next;
        });
        const preliminary = lines.some(row => row.status === 'Ожидается сдача');
        const {data,error} = await client.from('supervisor_shift_reports').update({
          closed_at:record.closed_at || at,
          revisions:[...revisions,{at,preliminary,lines,comment:String(fields.get('comment')).trim()}]
        }).eq('shift_key',key).filter('revisions','eq',JSON.stringify(revisions)).select('shift_key').maybeSingle();
        if (error) throw error;
        if (!data) throw Error('Отчёт уже изменился. Откройте его заново.');
        await refreshSupervisorShift();
        await openSupervisorReport(key);
      } catch (error) {
        console.error(error);
        status.textContent = error.message || 'Не удалось сохранить отчёт.';
      } finally {button.disabled = false;}
    };
  } catch (error) {
    if (request !== supervisorReportRequest) return;
    console.error(error);
    dashboardPanel.textContent = 'Не удалось загрузить отчёт. Попробуйте ещё раз.';
  }
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

const statusesForChart = ['В РАБОТЕ','ЧИСТКА','ПРОБЫ','РЕМОНТ'];
const statusColors = ['#82c8ac','#e3bf79','#8cbbe2','#e59ba0'];
const hoursText = ms => (ms / 3600000).toLocaleString('ru-RU',{maximumFractionDigits:2}) + ' ч';
let analyticsRoot;
let analyticsState = null;
let analyticsRequest = 0;

function chartBars(entries) {
  const max = Math.max(1,...entries.map(item=>item.value));
  return '<div class="board-bars">'+entries.map(item=>'<div><span>'+escapeHtml(item.label)+'</span><strong>'+escapeHtml(item.display)+'</strong>'+
    '<div class="board-bar"><i style="width:'+Math.max(0,item.value/max*100)+'%;background:'+(item.color||'#8cbbe2')+'"></i></div></div>').join('')+'</div>';
}

function openAnalytics(line = null, range = null) {
  const from = range?.from || dateAt(-6), to = range?.to || dateAt(0);
  const title = line ? 'Аналитика линии №'+line : 'Аналитика цеха';
  const controls = '<div class="board-stack"><form id="analyticsForm" class="board-filters">'+rangeInputs(from,to,'analytics')+
    (!line ? '<label>Начальник<select id="analyticsSupervisor"><option value="">Все начальники</option>'+
      ['Шарапов','Токин','Крылова'].map(name=>'<option>'+name+'</option>').join('')+'</select></label>' : '')+
    '<button type="submit">Показать</button></form><div class="board-actions" id="analyticsPeriods">'+
    '<button data-period="day">День</button><button data-period="week">Неделя</button><button data-period="month">Месяц</button></div>'+
    '<div id="analyticsResults"></div></div>';
  if (line) showPanel(title,controls);
  else document.getElementById('view-analytics').innerHTML = '<h2>'+title+'</h2>'+controls;
  analyticsRoot = line ? dashboardPanel : document.getElementById('view-analytics');
  const form = analyticsRoot.querySelector('#analyticsForm');
  form.onsubmit = event => {event.preventDefault();loadAnalytics(line);};
  analyticsRoot.querySelector('#analyticsPeriods').querySelectorAll('button').forEach(button=>button.onclick=()=>{
    analyticsRoot.querySelector('#analyticsTo').value = dateAt(0);
    analyticsRoot.querySelector('#analyticsFrom').value = button.dataset.period === 'month' ? dateAt(0).slice(0,8)+'01' :
      dateAt(button.dataset.period === 'week' ? -6 : 0);
    loadAnalytics(line);
  });
  loadAnalytics(line);
}

function statusIntervals(rows, seeds, range) {
  const start = Date.parse(range.start), end = Math.min(Date.now(),Date.parse(range.end));
  return PRIMATEK_LINES.flatMap(line => {
    const transitions = [...seeds,...rows].filter(row=>Number(row.line_number)===line &&
      ['STATUS_CHANGE','SHIFT_CLOSE'].includes(row.event_type)).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||Number(a.id)-Number(b.id));
    const changes = [];
    for (const row of transitions) {
      const status = row.event_type === 'SHIFT_CLOSE' ? '' : row.line_status;
      if (changes.at(-1)?.status === status && changes.at(-1)?.row.repair_reason === row.repair_reason &&
        (status !== 'В РАБОТЕ' || periodKeyForEvent(changes.at(-1).row) === periodKeyForEvent(row))) continue;
      changes.push({status,row});
    }
    return changes.flatMap(({row,status},i) => {
      const opened = Date.parse(row.created_at);
      const [date,shift] = periodKeyForEvent(row).split('|');
      const shiftEnd = Date.parse(date+(shift==='ДЕНЬ'?'T08:00:00+03:00':'T20:00:00+03:00'))+43200000;
      const ms = Math.min(end,Date.parse(changes[i+1]?.row.created_at)||end,
        status === 'В РАБОТЕ' ? Math.max(opened,shiftEnd) : end)-Math.max(start,opened);
      return statusesForChart.includes(status) && ms>0 ? [{line,status,ms,opened,reason:row.repair_reason || 'Причина не указана'}] : [];
    });
  });
}

async function loadAnalytics(line) {
  const request = ++analyticsRequest;
  const output = analyticsRoot.querySelector('#analyticsResults');
  output.textContent = 'Загрузка аналитики…';
  try {
    const range = reportingRange(analyticsRoot.querySelector('#analyticsFrom').value,analyticsRoot.querySelector('#analyticsTo').value);
    const supervisor = analyticsRoot.querySelector('#analyticsSupervisor')?.value;
    const [rows,plans,owners,pace,seeds] = await Promise.all([
      rangeReports(range,line),
      readPages(()=>client.from('shift_plans').select('*').gte('plan_date',range.from).lte('plan_date',range.to),'plan_date'),
      supervisor ? readPages(()=>client.from('supervisor_shift_reports').select('shift_key').eq('supervisor',supervisor)
        .gte('shift_key',range.from+'|ДЕНЬ').lte('shift_key',range.to+'|НОЧЬ'),'shift_key') : null,
      line ? readPages(()=>client.from('line_pace_measurements').select('*').eq('line_number',line)
        .gte('shift_key',range.from+'|ДЕНЬ').lte('shift_key',range.to+'|НОЧЬ'),'id') : [],
      Promise.all((line?[line]:PRIMATEK_LINES).map(async number=>{
        const {data,error}=await client.from('shift_reports').select('*').eq('line_number',number)
          .in('event_type',['STATUS_CHANGE','SHIFT_CLOSE']).lt('created_at',range.start)
          .order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1).maybeSingle();
        if(error) throw error;
        return data;
      }))
    ]);
    if (request !== analyticsRequest || !output.isConnected) return;
    const keys = owners ? new Set(owners.map(row=>row.shift_key)) : null;
    const produced = rows.filter(row=>productionEvents.includes(row.event_type)&&(!keys||keys.has(periodKeyForEvent(row))));
    const periods = new Map();
    const bucket = key => range.from===range.to ? key : key.split('|')[0];
    const point = key => {
      const id=bucket(key);
      if(!periods.has(id)) periods.set(id,{label:id.replace('|',' · '),paint:0,plan:0});
      return periods.get(id);
    };
    for (const row of produced) point(periodKeyForEvent(row)).paint += shiftTotals([row]).paint;
    const planned = {};
    for (const row of plans) {
      const key=row.plan_date+'|'+row.shift;
      const number=Number(row.line_number);
      if ((keys&&!keys.has(key)) || (line ? number!==line : number!==0&&!PRIMATEK_LINES.includes(number))) continue;
      const entry=planned[key] ||= {general:0,lines:0};
      if(number===0) entry.general=Number(row.plan_kg)||0;
      else entry.lines+=Number(row.plan_kg)||0;
    }
    for (const [key,plan] of Object.entries(planned)) point(key).plan+=plan.general||plan.lines;
    const points=[...periods.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,p])=>p);
    const intervals=statusIntervals(rows,seeds.filter(Boolean),range);
    const scoped = keys ? intervals.flatMap(interval => [...keys].flatMap(key => {
      const [date,shift] = key.split('|');
      const shiftStart = Date.parse(date+(shift==='ДЕНЬ'?'T08:00:00+03:00':'T20:00:00+03:00'));
      const originalStart = Math.max(interval.opened,Date.parse(range.start));
      const ms = Math.min(shiftStart+43200000,originalStart+interval.ms)-Math.max(shiftStart,originalStart);
      return ms>0 ? [{...interval,ms}] : [];
    })) : intervals;
    analyticsState={line,range,points,intervals:scoped,pace:pace.sort((a,b)=>Date.parse(a.measured_at)-Date.parse(b.measured_at)),
      lines:PRIMATEK_LINES.map(number=>({line:number,...shiftTotals(produced.filter(row=>Number(row.line_number)===number))}))};
    const plan=points.reduce((sum,p)=>sum+p.plan,0), fact=points.reduce((sum,p)=>sum+p.paint,0);
    const last=analyticsState.pace.at(-1);
    const repair=scoped.filter(row=>row.status==='РЕМОНТ').reduce((sum,row)=>sum+row.ms,0);
    output.innerHTML='<div class="analytics-grid">'+
      previewChart('plan','План и факт',plan?Math.round(fact/plan*100)+'% · '+kgText(fact):kgText(fact)+' · план не задан')+
      (line ? previewChart('pace','Темп линии',last?Math.round(72000000/last.elapsed_ms)+' кг/ч':'Замеров пока нет') :
        previewChart('lines','Выпуск по линиям',kgText(fact)))+
      previewChart('status','Время по статусам','Ремонт · '+hoursText(repair))+'</div>'+
      '<p class="board-muted">План сравнивается с выпуском готовой краски. Время рассчитывается по зарегистрированным статусам.</p>';
    for(const kind of ['plan',line?'pace':'lines','status']) renderChart(kind,output.querySelector('[data-preview="'+kind+'"]'),false);
  } catch(error) {
    if(request!==analyticsRequest)return;
    console.error(error);
    output.textContent='Не удалось загрузить аналитику. Проверьте даты и соединение.';
  }
}

function previewChart(kind,title,value) {
  return '<button class="analytics-preview" onclick="expandChart(\''+kind+'\')"><strong>'+title+' ↗</strong><span>'+value+'</span>'+
    '<span class="chart-content" data-preview="'+kind+'"></span></button>';
}

function drawSeries(canvas, series, max, dots) {
  const width=canvas.width, height=canvas.height, inset=24;
  const context=canvas.getContext('2d');
  context.strokeStyle='#667990';
  context.beginPath();context.moveTo(inset,8);context.lineTo(inset,height-inset);context.lineTo(width-8,height-inset);context.stroke();
  const count=Math.max(...series.map(item=>item.values.length),2);
  for(const item of series) {
    context.strokeStyle=item.color;context.fillStyle=item.color;context.lineWidth=3;
    context.setLineDash(item.dashed?[6,5]:[]);
    context.beginPath();
    item.values.forEach((value,i)=>{
      const x=inset+i/(count-1)*(width-inset-10);
      const y=height-inset-value/max*(height-inset-14);
      if(dots||item.values.length===1){context.moveTo(x+4,y);context.arc(x,y,4,0,Math.PI*2);}
      else if(i===0) context.moveTo(x,y); else context.lineTo(x,y);
    });
    if(dots||item.values.length===1)context.fill();else context.stroke();
  }
}

function renderChart(kind,target,expanded) {
  const {points,pace,lines,intervals}=analyticsState;
  if(kind==='plan'||kind==='pace') {
    let fact=0,plan=0;
    const series=kind==='plan' ? [
      {color:'#b8c6d5',dashed:true,values:points.map(p=>plan+=p.plan)},
      {color:'#8bc1fa',values:points.map(p=>fact+=p.paint)}] :
      [{color:'#8bc1fa',values:pace.map(row=>Math.round(72000000/row.elapsed_ms))}];
    target.innerHTML='<canvas width="'+(expanded?720:320)+'" height="'+(expanded?240:100)+'" aria-label="'+(kind==='plan'?'Накопленный план и выпуск':'Отдельные замеры темпа')+'"></canvas>'+
      (kind==='plan'?'<span class="board-muted">Пунктир — план · синяя линия — факт</span>':'');
    drawSeries(target.querySelector('canvas'),series,Math.max(1,...series.flatMap(item=>item.values)),kind==='pace');
    if(expanded) target.insertAdjacentHTML('beforeend','<div class="scroll-table"><table><thead><tr>'+
      (kind==='plan'?'<th>Период</th><th>План</th><th>Факт</th>':'<th>Замер</th><th>Этап</th><th>Темп</th>')+
      '</tr></thead><tbody>'+(kind==='plan'?points.map(p=>'<tr><td>'+escapeHtml(p.label)+'</td><td>'+kgText(p.plan)+'</td><td>'+kgText(p.paint)+'</td></tr>'):
        pace.map(row=>'<tr><td>'+dateText(row.measured_at)+'</td><td>'+escapeHtml(({unit:'Обычная партия',finished:'Готовая краска',comp1:'Компонент 1',comp2:'Компонент 2'})[row.production_stage]||'—')+'</td><td>'+Math.round(72000000/row.elapsed_ms)+' кг/ч</td></tr>')).join('')+
      '</tbody></table></div>');
  } else if(kind==='lines') {
    target.innerHTML=chartBars(lines.map(row=>({label:'№'+row.line,value:row.paint,display:kgText(row.paint)})))+
      (expanded?'<div class="board-actions">'+lines.map(row=>'<button onclick="openAnalytics('+row.line+',analyticsState.range)">Линия №'+row.line+'</button>').join('')+'</div>':'');
  } else {
    target.innerHTML=chartBars(statusesForChart.map((status,i)=>{
      const ms=intervals.filter(row=>row.status===status).reduce((sum,row)=>sum+row.ms,0);
      return {label:status,value:ms,display:hoursText(ms),color:statusColors[i]};
    }))+(expanded?'<button onclick="showRepairPareto()">Парето по ремонту</button>':'');
    if (expanded && !analyticsState.line) target.insertAdjacentHTML('beforeend', '<h3>По линиям</h3>'+chartBars(lines.map(row=>{
      const ms=intervals.filter(item=>item.line===row.line&&item.status!=='В РАБОТЕ').reduce((sum,item)=>sum+item.ms,0);
      return {label:'№'+row.line,value:ms,display:hoursText(ms)};
    })));
  }
}

function expandChart(kind) {
  const titles={plan:'План и факт',pace:'Темп линии',lines:'Выпуск по линиям',status:'Время по статусам'};
  showPanel(titles[kind]+(analyticsState.line?' · линия №'+analyticsState.line:' · цех'),
    '<div class="board-stack"><div id="expandedChart"></div><button onclick="backToAnalytics()">К аналитике</button></div>');
  renderChart(kind,document.getElementById('expandedChart'),true);
}

function backToAnalytics() {
  const {line,range}=analyticsState;
  if (line) openAnalytics(line,range);
  else dashboardDialog.close();
}

function showRepairPareto() {
  const repairs=analyticsState.intervals.filter(row=>row.status==='РЕМОНТ');
  const groups=[...groupDashboardRows(repairs,row=>row.reason)].map(([reason,events])=>({reason,events,ms:events.reduce((sum,row)=>sum+row.ms,0)}))
    .sort((a,b)=>b.ms-a.ms);
  const total=groups.reduce((sum,row)=>sum+row.ms,0);
  let cumulative=0;
  showPanel('Парето · причины ремонта','<div class="board-stack">'+
    (groups.length?chartBars(groups.map(group=>({label:group.reason,value:group.ms,
      display:hoursText(group.ms)+' · накоплено '+Math.round((cumulative+=group.ms)/total*100)+'%'}))):'<p>Ремонтов за период нет.</p>')+
    groups.map((group,i)=>'<details><summary>'+escapeHtml(group.reason)+' · остановок: '+group.events.length+'</summary>'+
      group.events.map(row=>'<p>№'+row.line+' · '+dateText(row.opened)+' · '+hoursText(row.ms)+'</p>').join('')+
      '<button data-fish="'+i+'">Разобрать по Исикаве</button></details>').join('')+
    '<button onclick="expandChart(\'status\')">К времени по статусам</button></div>');
  dashboardPanel.querySelectorAll('[data-fish]').forEach(button=>button.onclick=()=>showFishbone(groups[Number(button.dataset.fish)].reason));
}

function showFishbone(reason) {
  const {line,range}=analyticsState;
  const storageKey='primatek-ishikawa:'+JSON.stringify([line,range.from,range.to,reason]);
  let notes={};
  try {notes=JSON.parse(localStorage.getItem(storageKey))||{};} catch(error){console.error(error);}
  const branches=['Оборудование','Материал','Процесс','Обслуживание'];
  showPanel('Диаграмма Исикавы','<form id="fishboneForm" class="board-stack"><p><strong>Проблема:</strong> '+escapeHtml(reason)+
    (line?' · линия №'+line:' · цех')+'</p><div class="fishbone">'+branches.map(branch=>
      '<label>'+branch+'<textarea name="'+branch+'" placeholder="Гипотеза или подтверждённая причина">'+escapeHtml(notes[branch]||'')+'</textarea></label>').join('')+
    '</div><div class="board-actions"><button type="submit">Сохранить на этом устройстве</button><button type="button" onclick="showRepairPareto()">К Парето</button><p role="status"></p></div></form>');
  document.getElementById('fishboneForm').onsubmit=event=>{
    event.preventDefault();
    const status=event.currentTarget.querySelector('[role=status]');
    try {
      localStorage.setItem(storageKey,JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))));
      status.textContent='Сохранено на этом устройстве.';
    } catch(error){status.textContent='Не удалось сохранить.';}
  };
}
