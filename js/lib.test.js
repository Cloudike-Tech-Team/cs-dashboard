const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib.js');

const row = (over = {}) => ({
  id: 'a', received_at: '2026-10-12T05:47:00.000Z', reporter: '정양훈', customer: 'com 831',
  device: '기타', version: '', title: '트래픽 초과', description: '반복 다운로드', notes: '',
  timeline: [], tickets: [], status: 'open', status_note: '', assignee: '', ticket_assignee: '', ...over,
});

test('statusLabel: 메모 우선, 없으면 기본 라벨', () => {
  assert.equal(L.statusLabel(row()), '처리 중');
  assert.equal(L.statusLabel(row({ status: 'open', status_note: '로그 대기' })), '로그 대기');
  assert.equal(L.statusLabel(row({ status: 'done', status_note: '잔여 메모' })), '잔여 메모');
  assert.equal(L.statusLabel(row({ status: 'unknown' })), '원인 미확인');
  assert.equal(L.statusLabel(row({ status: 'weird' })), '처리 중');
  assert.equal(L.statusLabel(row({ status: 'waiting' })), '대기');
  assert.equal(L.statusLabel(row({ status: 'delayed' })), '지연');
  assert.equal(L.statusLabel(row({ status: 'deploy' })), '배포대기');
});

test('STATUS: 순서는 처리 중 → 대기 → 지연 → 배포대기 → 완료 → 원인 미확인, 색은 서로 다름', () => {
  assert.deepEqual(Object.keys(L.STATUS), ['open', 'waiting', 'delayed', 'deploy', 'done', 'unknown']);
  assert.equal(new Set(Object.values(L.STATUS).map((s) => s.color)).size, 6);
});

test('statusColor', () => {
  assert.equal(L.statusColor(row({ status: 'done' })), '#15803D');
  assert.equal(L.statusColor(row({ status: 'unknown' })), '#6B7280');
  assert.equal(L.statusColor(row()), '#B45309');
});

test('splitTimeline: 접두 날짜 분리', () => {
  assert.deepEqual(L.splitTimeline('10/12 로그 요청'), { when: '10-12', text: '로그 요청' });
  assert.deepEqual(L.splitTimeline('10-12 14:00 로그 요청'), { when: '10-12', text: '로그 요청' });
  assert.deepEqual(L.splitTimeline('2026-10-12 접수'), { when: '10-12', text: '접수' });
  assert.deepEqual(L.splitTimeline('1/3 확인'), { when: '01-03', text: '확인' });
  assert.deepEqual(L.splitTimeline('10/12'), { when: '10-12', text: '' });
});

test('splitTimeline: 날짜가 아니면 그대로', () => {
  assert.deepEqual(L.splitTimeline('로그 요청'), { when: '', text: '로그 요청' });
  assert.deepEqual(L.splitTimeline('3.19.61 업데이트 안내'), { when: '', text: '3.19.61 업데이트 안내' });
  assert.deepEqual(L.splitTimeline('13/40 이상한 값'), { when: '', text: '13/40 이상한 값' });
  assert.deepEqual(L.splitTimeline(''), { when: '', text: '' });
});

test('kpi', () => {
  const rows = [row(), row({ status: 'done', tickets: ['NRF-1'] }), row({ status: 'unknown', tickets: ['a', 'b'] })];
  assert.deepEqual(L.kpi(rows), { total: 3, open: 2, done: 1, ticketed: 2 });
  assert.deepEqual(L.kpi([row({ status: 'waiting' }), row({ status: 'delayed' }), row({ status: 'deploy' })]).open, 3);
  assert.deepEqual(L.kpi([]), { total: 0, open: 0, done: 0, ticketed: 0 });
});

test('issueCounts: 현재 월에 있는 id 만 센다', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b' })];
  const issues = [
    { label: 'X', detail: '', ticket_ids: ['a', 'b', 'deleted'] },
    { label: 'Y', detail: '', ticket_ids: ['deleted'] },
  ];
  assert.deepEqual(L.issueCounts(issues, rows).map((i) => i.count), [2, 0]);
  assert.deepEqual(L.issueCounts([], rows), []);
});

test('applyFilter', () => {
  const rows = [row({ id: 'a', device: '웹' }), row({ id: 'b', device: '기타' })];
  const issues = [{ label: 'X', detail: '', ticket_ids: ['b'] }];
  assert.deepEqual(L.applyFilter(rows, null, issues).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(L.applyFilter(rows, { type: 'device', value: '웹' }, issues).map((r) => r.id), ['a']);
  assert.deepEqual(L.applyFilter(rows, { type: 'issue', value: 0 }, issues).map((r) => r.id), ['b']);
  assert.deepEqual(L.applyFilter(rows, { type: 'issue', value: 9 }, issues).map((r) => r.id), ['a', 'b']);
});

test('applyFilter: 담당자 필터, 빈 값은 미지정', () => {
  const rows = [row({ id: 'a', assignee: '오민식' }), row({ id: 'b' }), row({ id: 'c', assignee: '오민식' })];
  assert.deepEqual(L.applyFilter(rows, { type: 'assignee', value: '오민식' }, []).map((r) => r.id), ['a', 'c']);
  assert.deepEqual(L.applyFilter(rows, { type: 'assignee', value: '' }, []).map((r) => r.id), ['b']);
});

test('assigneeLine: 담당·티켓 담당 표시', () => {
  assert.equal(L.assigneeLine(row()), '담당 미지정');
  assert.equal(L.assigneeLine(row({ assignee: '오민식' })), '담당 오민식');
  assert.equal(L.assigneeLine(row({ assignee: '오민식', ticket_assignee: '김개발' })), '담당 오민식 · 티켓 김개발');
  assert.equal(L.assigneeLine(row({ ticket_assignee: '김개발' })), '담당 미지정 · 티켓 김개발');
  assert.equal(L.assigneeLine(row({ assignee: '오민식', ticket_assignee: '오민식' })), '담당 오민식');
});

test('matchesSearch: 제목·상태 라벨·티켓·타임라인까지, 대소문자 무시', () => {
  const r = row({ title: '웹에서 엑셀 열리지 않음', status_note: '로그 대기', tickets: ['NRF-5029'], timeline: ['10/12 PC 로그 요청'] });
  assert.equal(L.matchesSearch(r, '엑셀'), true);
  assert.equal(L.matchesSearch(r, '로그 대기'), true);
  assert.equal(L.matchesSearch(r, 'nrf-5029'), true);
  assert.equal(L.matchesSearch(r, 'pc 로그'), true);
  assert.equal(L.matchesSearch(row({ assignee: '오민식' }), '민식'), true);
  assert.equal(L.matchesSearch(row({ ticket_assignee: '김개발' }), '김개발'), true);
  assert.equal(L.matchesSearch(r, '없는말'), false);
  assert.equal(L.matchesSearch(r, ''), true);
});

test('applyFilter status', () => {
  const rows = [row({ id: 1, status: 'done' }), row({ id: 2, status: 'open' }), row({ id: 3, status: 'bogus' })];
  assert.deepEqual(L.applyFilter(rows, { type: 'status', value: 'done' }, []).map((r) => r.id), [1]);
  assert.deepEqual(L.applyFilter(rows, { type: 'status', value: 'open' }, []).map((r) => r.id), [2, 3]);
});

// ── YouTrack 티켓
const YT = {
  'NRF-1': { state: 'In Testing', resolved: false, assignees: ['Toussaint Aurelien'] },
  'NRF-2': { state: 'Done', resolved: true, assignees: ['Hongjae Yim'] },
  'NPR-3': { state: '개발중 (Blocked)', resolved: false, assignees: ['Hongjae Yim', 'Donghun Lee'] },
};

test('ticketId / ticketIds: URL·텍스트에서 이슈 ID, 중복 제거', () => {
  assert.equal(L.ticketId('https://yt.cloudike.io/issue/NRF-4817/some-slug'), 'NRF-4817');
  assert.equal(L.ticketId('NRF-5029 로그인 오류'), 'NRF-5029');
  assert.equal(L.ticketId('v3.19.61-2'), '');
  assert.equal(L.ticketId('nrf-1'), '');
  assert.equal(L.ticketId('https://cloudike.atlassian.net/browse/CLDA-82'), 'CLDA-82');
  assert.deepEqual(L.ticketIds([row({ tickets: ['NRF-1', 'x'] }), row({ tickets: ['https://yt.cloudike.io/issue/NRF-1', 'CLDQA-9'] })]), ['NRF-1', 'CLDQA-9']);
});

test('ticketAssignees: YouTrack 우선, 못 읽으면 수동 입력값', () => {
  assert.deepEqual(L.ticketAssignees(row({ tickets: ['NRF-1', 'NRF-2', 'NPR-3'], ticket_assignee: '김개발' }), YT),
    { names: ['Toussaint Aurelien', 'Hongjae Yim', 'Donghun Lee'], manual: false });
  assert.deepEqual(L.ticketAssignees(row({ tickets: ['JIRA 링크'], ticket_assignee: '김개발' }), YT), { names: ['김개발'], manual: true });
  assert.deepEqual(L.ticketAssignees(row({ tickets: ['NRF-1'], ticket_assignee: '김개발' }), {}), { names: ['김개발'], manual: true });
  assert.deepEqual(L.ticketAssignees(row(), YT), { names: [], manual: false });
});

test('ticketState: 안 끝난 첫 티켓, 모두 끝났으면 첫 티켓, 여러 개면 외 n', () => {
  assert.equal(L.ticketState(row({ tickets: ['x'] }), YT), null);
  const s = L.ticketState(row({ tickets: ['NRF-2', 'NRF-1'] }), YT);
  assert.equal(s.label, 'In Testing 외 1');
  assert.equal(s.title, 'NRF-2 Done · NRF-1 In Testing');
  assert.equal(s.allResolved, false);
  const d = L.ticketState(row({ tickets: ['NRF-2'] }), YT);
  assert.deepEqual([d.label, d.color, d.allResolved], ['Done', '#15803D', true]);
});

test('ytStateColor', () => {
  assert.equal(L.ytStateColor({ state: 'Rejected', resolved: true }), '#6B7280');
  assert.equal(L.ytStateColor({ state: '개발중 (Blocked)', resolved: false }), '#B91C1C');
  assert.equal(L.ytStateColor({ state: 'Code Review', resolved: false }), '#7C3AED');
  assert.equal(L.ytStateColor({ state: 'In Progress', resolved: false }), '#B45309');
  assert.equal(L.ytStateColor({ state: 'Backlog', resolved: false }), '#1D4ED8');
  // Jira
  assert.equal(L.ytStateColor({ state: '해결', resolved: true }), '#15803D');
  assert.equal(L.ytStateColor({ state: '진행 불가 (재현X)', resolved: true }), '#6B7280');
  assert.equal(L.ytStateColor({ state: '원인 분석중', resolved: false }), '#B45309');
});

test('assigneeLine·matchesSearch: YouTrack 값 반영', () => {
  const r = row({ assignee: '오민식', tickets: ['NRF-1'], ticket_assignee: '김개발' });
  assert.equal(L.assigneeLine(r, YT), '담당 오민식 · 티켓 Toussaint Aurelien');
  assert.equal(L.matchesSearch(r, 'aurelien', YT), true);
  assert.equal(L.matchesSearch(r, 'in testing', YT), true);
  assert.equal(L.matchesSearch(r, 'aurelien'), false);
});
