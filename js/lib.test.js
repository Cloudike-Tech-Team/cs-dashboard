const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./lib.js');

const row = (over = {}) => ({
  id: 'a', received_at: '2026-10-12T05:47:00.000Z', reporter: '정양훈', customer: 'com 831',
  device: '기타', version: '', title: '트래픽 초과', description: '반복 다운로드', notes: '',
  timeline: [], tickets: [], status: 'open', status_note: '', ...over,
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

test('matchesSearch: 제목·상태 라벨·티켓·타임라인까지, 대소문자 무시', () => {
  const r = row({ title: '웹에서 엑셀 열리지 않음', status_note: '로그 대기', tickets: ['NRF-5029'], timeline: ['10/12 PC 로그 요청'] });
  assert.equal(L.matchesSearch(r, '엑셀'), true);
  assert.equal(L.matchesSearch(r, '로그 대기'), true);
  assert.equal(L.matchesSearch(r, 'nrf-5029'), true);
  assert.equal(L.matchesSearch(r, 'pc 로그'), true);
  assert.equal(L.matchesSearch(r, '없는말'), false);
  assert.equal(L.matchesSearch(r, ''), true);
});
