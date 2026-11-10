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

test('STATUS: 순서는 처리 중 → 대기 → 지연 → 배포대기 → 완료 → 원인 미확인', () => {
  assert.deepEqual(Object.keys(L.STATUS), ['open', 'waiting', 'delayed', 'deploy', 'done', 'unknown']);
});

test('statusColor: 색은 처리 중(파랑) · 완료(초록)에만, 나머지는 회색', () => {
  assert.equal(L.statusColor(row({ status: 'done' })), '#15803D');
  assert.equal(L.statusColor(row()), '#2563EB');
  ['waiting', 'delayed', 'deploy', 'unknown'].forEach((s) => assert.equal(L.statusColor(row({ status: s })), '#6B7280'));
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

test('ytStateColor: 해결 초록, 진행·테스트 파랑, 그 외(반려·막힘·대기) 회색', () => {
  assert.equal(L.ytStateColor({ state: 'Rejected', resolved: true }), '#6B7280');
  assert.equal(L.ytStateColor({ state: '개발중 (Blocked)', resolved: false }), '#6B7280');
  assert.equal(L.ytStateColor({ state: 'Code Review', resolved: false }), '#2563EB');
  assert.equal(L.ytStateColor({ state: 'In Progress', resolved: false }), '#2563EB');
  assert.equal(L.ytStateColor({ state: 'Backlog', resolved: false }), '#6B7280');
  // Jira
  assert.equal(L.ytStateColor({ state: '해결', resolved: true }), '#15803D');
  assert.equal(L.ytStateColor({ state: '진행 불가 (재현X)', resolved: true }), '#6B7280');
  assert.equal(L.ytStateColor({ state: '원인 분석중', resolved: false }), '#2563EB');
});

test('assigneeLine·matchesSearch: YouTrack 값 반영', () => {
  const r = row({ assignee: '오민식', tickets: ['NRF-1'], ticket_assignee: '김개발' });
  assert.equal(L.assigneeLine(r, YT), '담당 오민식 · 티켓 Toussaint Aurelien');
  assert.equal(L.matchesSearch(r, 'aurelien', YT), true);
  assert.equal(L.matchesSearch(r, 'in testing', YT), true);
  assert.equal(L.matchesSearch(r, 'aurelien'), false);
});

test('daysSince: 24시간 단위, 미래는 0', () => {
  const now = Date.parse('2026-10-27T12:00:00+09:00');
  assert.equal(L.daysSince('2026-10-27T09:00:00+09:00', now), 0);
  assert.equal(L.daysSince('2026-09-27T12:00:00+09:00', now), 30);
  assert.equal(L.daysSince('2026-10-28T00:00:00+09:00', now), 0);
});

test('ageDays: 미해결이면 접수 후 경과일, 완료면 null', () => {
  const now = Date.parse('2026-11-09T12:00:00+09:00');
  assert.equal(L.ageDays(row({ received_at: '2026-11-04T14:20:00+09:00', status: 'open' }), now), 4);
  assert.equal(L.ageDays(row({ received_at: '2026-11-09T09:00:00+09:00', status: 'waiting' }), now), 0);
  assert.equal(L.ageDays(row({ received_at: '2026-10-01T09:00:00+09:00', status: 'deploy' }), now), 39);
  assert.equal(L.ageDays(row({ received_at: '2026-10-01T09:00:00+09:00', status: 'done' }), now), null);
});

test('carryMonths: KST 월별, 완료 제외, 최근 월부터', () => {
  const rows = [
    row({ received_at: '2026-09-30T15:30:00Z', status: 'open' }),     // KST 10-01
    row({ received_at: '2026-09-30T14:30:00Z', status: 'waiting' }),  // KST 09-30
    row({ received_at: '2026-08-02T00:00:00Z', status: 'delayed' }),
    row({ received_at: '2026-10-05T00:00:00Z', status: 'done' }),
    row({ received_at: '2025-12-20T00:00:00Z', status: 'open' }),
  ];
  assert.deepEqual(L.carryMonths(rows), [['2026-10', 1], ['2026-09', 1], ['2026-08', 1], ['2025-12', 1]]);
  assert.equal(L.monthKST('2026-09-30T15:30:00Z'), '2026-10');
});

test('recencyKey / groupByRecency: 이번 달 → 30일 → 1년 → 그 이전, 빈 묶음 제외', () => {
  const now = Date.parse('2026-10-28T12:00:00+09:00');
  assert.equal(L.recencyKey('2026-10-01T00:30:00+09:00', now), 'month');
  assert.equal(L.recencyKey('2026-09-30T23:00:00+09:00', now), 'd30');   // 지난달이지만 30일 이내
  assert.equal(L.recencyKey('2026-09-20T12:00:00+09:00', now), 'y1');    // 38일 전
  assert.equal(L.recencyKey('2025-10-29T12:00:00+09:00', now), 'y1');    // 364일 전
  assert.equal(L.recencyKey('2025-10-20T12:00:00+09:00', now), 'older');
  const g = L.groupByRecency([
    row({ id: 'a', received_at: '2026-10-20T00:00:00+09:00' }),
    row({ id: 'b', received_at: '2025-01-01T00:00:00+09:00' }),
    row({ id: 'c', received_at: '2026-10-02T00:00:00+09:00' }),
  ], now);
  assert.deepEqual(g.map((x) => [x.label, x.rows.map((r) => r.id)]), [['이번 달', ['a', 'c']], ['1년 이상 전', ['b']]]);
});

test('SEVERITY: 보통 → 중요 → 크리티컬 → 핫픽스, 값이 없거나 이상하면 보통', () => {
  assert.deepEqual(Object.values(L.SEVERITY).map((v) => v.label), ['보통', '중요', '크리티컬', '핫픽스']);
  assert.equal(L.severityKey(row()), 'normal');
  assert.equal(L.severityKey(row({ severity: 'weird' })), 'normal');
  assert.equal(L.severityDef(row({ severity: 'hotfix' })).label, '핫픽스');
});

test('applyFilter·matchesSearch: 심각도', () => {
  const rows = [row({ id: 1, severity: 'critical' }), row({ id: 2 }), row({ id: 3, severity: 'normal' })];
  assert.deepEqual(L.applyFilter(rows, { type: 'severity', value: 'critical' }, []).map((r) => r.id), [1]);
  assert.deepEqual(L.applyFilter(rows, { type: 'severity', value: 'normal' }, []).map((r) => r.id), [2, 3]);
  assert.equal(L.matchesSearch(row({ severity: 'critical' }), '크리티컬'), true);
  assert.equal(L.matchesSearch(row(), '보통'), false);
});

// ── 영문 버전: 언어별 라벨, 번역 표시
test('statusLabel·deviceLabel: 언어별 라벨, 번역된 상태 메모 우선', () => {
  assert.equal(L.statusLabel(row({ status: 'deploy' }), 'en'), 'To deploy');
  assert.equal(L.statusLabel(row({ status: 'unknown' }), 'en'), 'Unknown');
  assert.equal(L.statusLabel(row({ status_note: '로그 대기' }), 'en', { status_note: 'Waiting for logs' }), 'Waiting for logs');
  assert.equal(L.statusLabel(row({ status_note: '로그 대기' }), 'ko'), '로그 대기');
  assert.equal(L.deviceLabel('웹', 'en'), 'Web');
  assert.equal(L.deviceLabel('기타', 'en'), 'Other');
  assert.equal(L.deviceLabel('Android', 'en'), 'Android');
  assert.equal(L.deviceLabel('웹', 'ko'), '웹');
  assert.equal(L.severityLabel('hotfix', 'en'), 'Hotfix');
  assert.equal(L.severityLabel('major', 'ko'), '중요');
  assert.equal(L.recencyLabel('d30', 'en'), 'Last 30 days');
});

test('assigneeLine: 영어', () => {
  assert.equal(L.assigneeLine(row(), null, 'en'), 'Unassigned');
  assert.equal(L.assigneeLine(row({ assignee: 'Jihoon Kim', ticket_assignee: 'Marta' }), null, 'en'), 'Owner Jihoon Kim · Ticket Marta');
});

// 같은 리터럴을 supabase/functions/ai/lib_test.ts 에도 둔다 (브라우저·Edge Function 해시 규칙이 같아야 함)
test('sourceText·sourceHash: 번역 칸을 정해진 순서로 이은 문자열의 SHA-256', async () => {
  const r = row({ title: 'A', description: '', notes: '', status_note: '', timeline: ['11/04 접수'] });
  assert.equal(L.sourceText(r), '["A","","","",["11/04 접수"]]');
  assert.equal(await L.sourceHash(r), '6caa5ab1fcc2db1ff2968773421d27294fbaeb2dfdf6fe53097bea0e3d387d13');
});

test('hasHangul: 번역 칸 어디든 한글이 있으면 true', () => {
  assert.equal(L.hasHangul(row({ title: 'Sync stops', description: '', notes: '' })), false);
  assert.equal(L.hasHangul(row({ title: 'x', description: '', notes: '', timeline: ['접수'] })), true);
});

test('needsTranslation: 화면 언어 번역이 없거나 오래됐을 때만, 한국어 화면은 한글 없는 기록만', () => {
  const kor = row({ title: '로그인 실패' });
  const eng = row({ title: 'Login fails', description: 'x', notes: '' });
  assert.equal(L.needsTranslation(kor, 'h', {}, 'ko'), false);
  assert.equal(L.needsTranslation(kor, 'h', {}, 'en'), true);
  assert.equal(L.needsTranslation(kor, 'h', { en: { source_hash: 'h' } }, 'en'), false);
  assert.equal(L.needsTranslation(kor, 'h', { en: { source_hash: 'old' } }, 'en'), true);
  assert.equal(L.needsTranslation(eng, 'h', {}, 'ko'), true);
  assert.equal(L.needsTranslation(eng, 'h', undefined, 'ko'), true);
  const empty = row({ title: '', description: '', notes: '', status_note: '', timeline: [] });
  assert.equal(L.needsTranslation(empty, 'h', {}, 'en'), false);
});

test('displayFields: 최신 번역만 쓰고, 원문이 바뀌어 오래된 번역이면 원문', () => {
  const r = row({ title: '로그인 실패', status_note: '로그 대기', timeline: ['11/04 접수'] });
  const fresh = { en: { source_hash: 'h', fields: { title: 'Login fails', description: 'Desc', notes: '', status_note: 'Waiting for logs', timeline: ['11/04 Received'] } } };
  const d = L.displayFields(r, 'h', fresh, 'en');
  assert.equal(d.title, 'Login fails');
  assert.deepEqual(d.timeline, ['11/04 Received']);
  assert.equal(d.translated, true);
  const stale = L.displayFields(r, 'h', { en: { ...fresh.en, source_hash: 'old' } }, 'en');
  assert.equal(stale.title, '로그인 실패');
  assert.equal(stale.translated, false);
  const same = L.displayFields(row({ title: 'Same', description: '반복 다운로드', notes: '', timeline: [] }), 'h',
    { en: { source_hash: 'h', fields: { title: 'Same', description: '반복 다운로드', notes: '', status_note: '', timeline: [] } } }, 'en');
  assert.equal(same.translated, false);
});

test('matchesSearch: 번역문과 영어 라벨도 검색', () => {
  assert.equal(L.matchesSearch(row({ title: '로그인' }), 'login', null, ['Login fails']), true);
  assert.equal(L.matchesSearch(row({ severity: 'hotfix' }), 'hotfix'), true);
  assert.equal(L.matchesSearch(row({ status: 'deploy' }), 'to deploy'), true);
  assert.equal(L.matchesSearch(row(), 'zzz', null, ['Login fails']), false);
});

// ── 최종 리뷰 수정
test('cachedHash: 원문이 바뀌면 캐시된 해시를 쓰지 않음', async () => {
  const r = row({ title: '로그 대기' });
  const entry = { text: L.sourceText(r), hash: await L.sourceHash(r) };
  assert.equal(L.cachedHash(entry, r), entry.hash);
  assert.equal(L.cachedHash(entry, { ...r, status_note: '재현 확인' }), null);
  assert.equal(L.cachedHash(undefined, r), null);
});

test('displayFields·needsTranslation: 원문 언어 화면에서는 항상 원문 (모델이 다시 쓴 문장을 보이지 않음)', () => {
  const kor = row({ title: 'PC client sync 안 됨', description: '', notes: '' });
  const rewritten = { ko: { source_hash: 'h', fields: { title: 'PC client 동기화 안 됨', description: '', notes: '', status_note: '', timeline: [] } } };
  const d = L.displayFields(kor, 'h', rewritten, 'ko');
  assert.equal(d.title, 'PC client sync 안 됨');
  assert.equal(d.translated, false);
  const eng = row({ title: 'Login fails', description: '', notes: '' });
  const enRewritten = { en: { source_hash: 'h', fields: { title: 'Login failure', description: '', notes: '', status_note: '', timeline: [] } } };
  assert.equal(L.displayFields(eng, 'h', enRewritten, 'en').title, 'Login fails');
  assert.equal(L.needsTranslation(eng, 'h', {}, 'en'), false);
});

test('ticketState: 여러 티켓 라벨이 화면 언어', () => {
  const r = row({ tickets: ['NRF-1', 'NRF-2'] });
  const yt = { 'NRF-1': { state: 'Open', resolved: false, assignees: [] }, 'NRF-2': { state: 'Done', resolved: true, assignees: [] } };
  assert.equal(L.ticketState(r, yt).label, 'Open 외 1');
  assert.equal(L.ticketState(r, yt, 'en').label, 'Open +1');
});

test('backfillStep: 남은 건이 없으면 완료, 남았는데 한 건도 못 했을 때만 멈춤', () => {
  assert.equal(L.backfillStep(0, 0), 'done');      // 화면의 자동 번역이 먼저 끝낸 경우
  assert.equal(L.backfillStep(5, 0), 'done');
  assert.equal(L.backfillStep(10, 4), 'continue');
  assert.equal(L.backfillStep(0, 4), 'stuck');
});

test('dragTarget·dragShift: 끄는 줄 중심 위치로 놓일 순서, 다른 줄이 비켜 갈 방향', () => {
  const centers = [10, 50, 90, 130];            // 원래 순서의 줄 중심
  assert.equal(L.dragTarget(centers, 3, 5), 0);  // 맨 아래 줄을 맨 위로
  assert.equal(L.dragTarget(centers, 0, 100), 2);
  assert.equal(L.dragTarget(centers, 0, 200), 3);
  assert.equal(L.dragTarget(centers, 1, 52), 1); // 제자리
  // 0번을 2번 자리로: 1·2번은 위로(-1), 3번은 그대로
  assert.deepEqual([1, 2, 3].map((j) => L.dragShift(j, 0, 2)), [-1, -1, 0]);
  // 3번을 0번 자리로: 0·1·2번은 아래로(+1)
  assert.deepEqual([0, 1, 2].map((j) => L.dragShift(j, 3, 0)), [1, 1, 1]);
  assert.equal(L.dragShift(2, 1, 1), 0);
});

test('ytSeverity·severityOf: YouTrack Priority 가 있으면 그 값(여러 티켓이면 가장 급한 것), 없으면 콘솔 값', () => {
  const yt = {
    'NRF-1': { state: 'To Do', resolved: false, assignees: [], priority: 'Major' },
    'NRF-2': { state: 'To Do', resolved: false, assignees: [], priority: 'Hot Fix' },
    'NRF-3': { state: 'To Do', resolved: false, assignees: [], priority: 'Minor' },
    'NPR-9': { state: '검토중', resolved: false, assignees: [], priority: '' },
    'CLDA-1': { state: 'x', resolved: false, assignees: [], priority: '' },
  };
  assert.deepEqual(L.ytSeverity(row({ tickets: ['NRF-1', 'NRF-2'] }), yt), { key: 'hotfix', ids: ['NRF-2'] });
  assert.deepEqual(L.ytSeverity(row({ tickets: ['NRF-3'] }), yt), { key: 'normal', ids: ['NRF-3'] });
  assert.equal(L.ytSeverity(row({ tickets: ['NPR-9', 'CLDA-1'] }), yt), null);
  assert.equal(L.ytSeverity(row({ tickets: [] }), yt), null);
  assert.equal(L.ytSeverity(row({ tickets: ['NRF-1'] }), {}), null);      // 아직 못 읽음
  assert.equal(L.severityOf(row({ tickets: ['NRF-2'], severity: 'normal' }), yt), 'hotfix');
  assert.equal(L.severityOf(row({ tickets: ['NPR-9'], severity: 'major' }), yt), 'major');
  assert.equal(L.severityOf(row({ severity: 'critical' })), 'critical');
});

test('applyFilter·matchesSearch: 심각도는 YouTrack 값 기준', () => {
  const yt = { 'NRF-2': { state: 'To Do', resolved: false, assignees: [], priority: 'Critical' } };
  const rows = [row({ id: 1, tickets: ['NRF-2'], severity: 'normal' }), row({ id: 2, severity: 'critical' })];
  assert.deepEqual(L.applyFilter(rows, { type: 'severity', value: 'critical' }, [], yt).map((r) => r.id), [1, 2]);
  assert.deepEqual(L.applyFilter(rows, { type: 'severity', value: 'normal' }, [], yt).map((r) => r.id), []);
  assert.equal(L.matchesSearch(rows[0], '크리티컬', yt), true);
});

test('popupPlace: 새 팝업은 계단식으로 비켜 열리고 화면 밖으로 나가지 않음', () => {
  assert.deepEqual(L.popupPlace(0, 1600, 900, 400, 500), { x: 120, y: 90 });
  assert.deepEqual(L.popupPlace(1, 1600, 900, 400, 500), { x: 152, y: 122 });
  assert.deepEqual(L.popupPlace(8, 1600, 900, 400, 500), { x: 120, y: 90 });   // 8개마다 처음 자리로
  assert.deepEqual(L.popupPlace(7, 500, 600, 400, 500), { x: 84, y: 84 });     // 좁은 화면: 오른쪽·아래 끝에 맞춤 (여백 16)
});

test('popupBig: 머리글 두 번 클릭 시 크게 보기 크기 (가운데, 최대 760×85%, 여백 16)', () => {
  assert.deepEqual(L.popupBig(1600, 900), { x: 420, y: 68, w: 760, h: 765 });
  assert.deepEqual(L.popupBig(600, 500), { x: 16, y: 38, w: 568, h: 425 });
});

// ── UX 1차: 보기 · 정렬 · 경과 · 작은 오류
const NOW = Date.parse('2026-11-10T12:00:00+09:00');
const R = [
  row({ id: 'n1', received_at: '2026-11-08T10:00:00+09:00', status: 'open', severity: 'normal' }),
  row({ id: 'c1', received_at: '2026-10-12T10:00:00+09:00', status: 'deploy', severity: 'normal' }),
  row({ id: 'h1', received_at: '2026-11-09T10:00:00+09:00', status: 'waiting', severity: 'hotfix' }),
  row({ id: 'd1', received_at: '2026-10-20T10:00:00+09:00', status: 'done', severity: 'critical' }),
  row({ id: 'l1', received_at: '2026-11-01T10:00:00+09:00', status: 'delayed', severity: 'normal' }),
  row({ id: 's1', received_at: '2026-09-30T16:00:00+09:00', status: 'open', severity: 'major' }),
];
const ids = (rows) => rows.map((r) => r.id);

test('viewRows: 미해결(모든 달) · 이월(이번 달 전 접수 미해결) · 완료 · 전체', () => {
  assert.deepEqual(ids(L.viewRows(R, 'open', '2026-11')), ['n1', 'c1', 'h1', 'l1', 's1']);
  assert.deepEqual(ids(L.viewRows(R, 'carry', '2026-11')), ['c1', 's1']);
  assert.deepEqual(ids(L.viewRows(R, 'done', '2026-11')), ['d1']);
  assert.deepEqual(ids(L.viewRows(R, 'all', '2026-11')), ids(R));
  assert.deepEqual(ids(L.viewRows(R, 'weird', '2026-11')), ids(L.viewRows(R, 'open', '2026-11')));
});

test('isCarried: 이번 달(KST) 전에 접수됐고 완료가 아니면 이월', () => {
  assert.equal(L.isCarried(R[1], '2026-11'), true);
  assert.equal(L.isCarried(R[0], '2026-11'), false);
  assert.equal(L.isCarried(R[3], '2026-11'), false);   // 완료
  assert.equal(L.isCarried(row({ received_at: '2026-10-31T15:30:00Z' }), '2026-11'), false);   // KST 11-01
});

test('sortRows: 급한 순 = 심각도 → 지연 상태 → 오래된 순, 오래된 순, 최근 접수 순', () => {
  assert.deepEqual(ids(L.sortRows(R, 'urgent', {})), ['h1', 'd1', 's1', 'l1', 'c1', 'n1']);
  assert.deepEqual(ids(L.sortRows(R, 'oldest', {})), ['s1', 'c1', 'd1', 'l1', 'n1', 'h1']);
  assert.deepEqual(ids(L.sortRows(R, 'recent', {})), ['h1', 'n1', 'l1', 'd1', 'c1', 's1']);
  assert.deepEqual(ids(R), ['n1', 'c1', 'h1', 'd1', 'l1', 's1']);   // 원본은 그대로
});

test('ageInfo: 완료 전이면 경과일, 7일 이상은 지연(overdue), 완료면 null', () => {
  assert.deepEqual(L.ageInfo(R[0], NOW), { days: 2, overdue: false });
  assert.deepEqual(L.ageInfo(row({ received_at: '2026-11-03T12:00:00+09:00' }), NOW), { days: 7, overdue: true });
  assert.deepEqual(L.ageInfo(R[1], NOW), { days: 29, overdue: true });
  assert.equal(L.ageInfo(R[3], NOW), null);
  assert.equal(L.OVERDUE_DAYS, 7);
});

test('plainVersion: 앞의 v 는 떼고 저장 (vv2.1.6 방지)', () => {
  assert.equal(L.plainVersion('v2.1.6'), '2.1.6');
  assert.equal(L.plainVersion(' V3.19.61 '), '3.19.61');
  assert.equal(L.plainVersion('2.1.6'), '2.1.6');
  assert.equal(L.plainVersion('vNext'), 'vNext');   // 숫자가 아니면 그대로
  assert.equal(L.plainVersion(''), '');
});

test('datedEntry: 날짜가 없는 처리 이력은 오늘 날짜를 붙인다', () => {
  assert.equal(L.datedEntry('로그 요청', NOW), '11/10 로그 요청');
  assert.equal(L.datedEntry('11/04 로그 요청', NOW), '11/04 로그 요청');
  assert.equal(L.datedEntry('11-04 접수', NOW), '11-04 접수');
  assert.equal(L.datedEntry('  ', NOW), '');
});
