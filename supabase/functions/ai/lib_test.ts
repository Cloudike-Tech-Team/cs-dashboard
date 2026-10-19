import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  BadRequest, buildSummaryInput, buildSummaryMarkdown, deviceCounts, mapIssueIndexes, monthRange, normalizeParsed,
  normalizeSummary, sortByReceived, statusText, unresolvedLines, validateRequest,
} from './lib.ts';

Deno.test('validateRequest: parse 모드', () => {
  assertEquals(validateRequest({ mode: 'parse', text: '  hi ' }), { mode: 'parse', text: 'hi' });
  assertThrows(() => validateRequest({ mode: 'parse', text: '' }), BadRequest);
  assertThrows(() => validateRequest({ mode: 'parse', text: 'x'.repeat(8001) }), BadRequest);
});

Deno.test('validateRequest: summarize 모드', () => {
  assertEquals(validateRequest({ mode: 'summarize', month: '2026-10' }), { mode: 'summarize', month: '2026-10' });
  assertThrows(() => validateRequest({ mode: 'summarize', month: '2026-13' }), BadRequest);
  assertThrows(() => validateRequest({ mode: 'summarize', month: '202610' }), BadRequest);
  assertThrows(() => validateRequest({ mode: 'other' }), BadRequest);
  assertThrows(() => validateRequest(null), BadRequest);
});

Deno.test('monthRange: KST 경계, 12월 넘김', () => {
  assertEquals(monthRange('2026-10'), { from: '2026-09-30T15:00:00.000Z', to: '2026-10-31T15:00:00.000Z' });
  assertEquals(monthRange('2026-12').to, '2026-12-31T15:00:00.000Z');
});

Deno.test('deviceCounts: 건수 내림차순, 동률은 DEVICES 순서', () => {
  assertEquals(
    deviceCounts([{ device: 'Android' }, { device: '웹' }, { device: 'Android' }, { device: '기타' }]),
    [['Android', 2], ['웹', 1], ['기타', 1]],
  );
});

const row = (over = {}) => ({
  id: 'id-1', received_at: '2026-10-12T05:47:00.000Z', reporter: '정양훈', customer: 'com 81838 / user 119607',
  device: 'CLDAstream Win', version: '3.19.61', title: '로그인 실패', status: 'open' as const, status_note: '',
  description: '로그인\n실패', notes: '', timeline: ['10/12 로그 요청'], tickets: ['CLD-1'], assignee: '', ticket_assignee: '', ...over,
});

Deno.test('buildSummaryInput: 집계 헤더와 한 줄 행 (제목·상태 포함)', () => {
  const out = buildSummaryInput('2026-10', [
    row(),
    row({ id: 'id-0', device: '웹', received_at: '2026-10-01T01:00:00.000Z', timeline: [], tickets: [], status: 'done', title: '' }),
    row({ id: 'id-2', received_at: '2026-10-13T01:00:00.000Z', status: 'unknown', status_note: '로그 수집 실패', assignee: '오민식', ticket_assignee: '김개발' }),
  ]);
  const lines = out.split('\n');
  assertEquals(lines[0], '[집계] 2026년 10월 · 총 3건 · CLDAstream Win 2 · 웹 1');
  assertEquals(lines[2], '[CS 목록] 번호. 날짜 | 고객사 | 기기 | 버전 | 제목 | 현상 | 특이사항 | 타임라인 | 티켓 | 상태 | 담당');
  assertEquals(lines[3], '1. 10/01 | com 81838 / user 119607 | 웹 | 3.19.61 | - | 로그인 실패 | - | (없음) | - | 완료 | -');
  assertEquals(lines[4], '2. 10/12 | com 81838 / user 119607 | CLDAstream Win | 3.19.61 | 로그인 실패 | 로그인 실패 | - | 10/12 로그 요청 | CLD-1 | 처리 중 | -');
  assertEquals(lines[5], '3. 10/13 | com 81838 / user 119607 | CLDAstream Win | 3.19.61 | 로그인 실패 | 로그인 실패 | - | 10/12 로그 요청 | CLD-1 | 원인 미확인(로그 수집 실패) | 오민식(티켓 김개발)');
});

Deno.test('sortByReceived: 날짜 오름차순, 동률은 id', () => {
  const r = sortByReceived([row({ id: 'b' }), row({ id: 'a' }), row({ id: 'c', received_at: '2026-10-01T00:00:00.000Z' })]);
  assertEquals(r.map((x) => x.id), ['c', 'a', 'b']);
});

Deno.test('statusText', () => {
  assertEquals(statusText(row()), '처리 중');
  assertEquals(statusText(row({ status: 'open', status_note: '로그 대기' })), '처리 중(로그 대기)');
  assertEquals(statusText(row({ status: 'done' })), '완료');
  assertEquals(statusText(row({ status: 'waiting' })), '대기');
  assertEquals(statusText(row({ status: 'delayed', status_note: '개발 일정' })), '지연(개발 일정)');
  assertEquals(statusText(row({ status: 'deploy' })), '배포대기');
});

Deno.test('normalizeParsed: 잘못된 기기·날짜는 null, 공백 정리', () => {
  const p = normalizeParsed({
    reporter: ' 정양훈 ', customer: '', title: ' 로그인 안 됨 ', received_at: '14:47', device: '클다스트림',
    version: ' 3.19.61 ', description: 'x', notes: 1, confidence_notes: '',
  });
  assertEquals(p, {
    reporter: '정양훈', customer: null, title: '로그인 안 됨', received_at: '14:47', device: null,
    version: '3.19.61', description: 'x', notes: '', timeline: [], assignee: '', confidence_notes: '',
  });
  assertEquals(normalizeParsed({ assignee: ' 오민식 ' }).assignee, '오민식');
  assertEquals(normalizeParsed({ assignee: 7 }).assignee, '');
  assertEquals(normalizeParsed({ received_at: '2026-10-12T14:47' }).received_at, '2026-10-12T14:47');
  assertEquals(normalizeParsed({ received_at: '어제' }).received_at, null);
  assertEquals(normalizeParsed({ device: 'IOS' }).device, 'IOS');
  assertEquals(normalizeParsed(null).version, '');
  assertEquals(normalizeParsed({}).title, '');
});

Deno.test('normalizeParsed: timeline 은 문자열만, 공백·빈 항목 제거, 순서 유지, 2000자·50개 제한', () => {
  const p = normalizeParsed({ timeline: [' 10/12 정양훈: 로그 요청 ', '', 3, null, '10/13 로그 수신', 'x'.repeat(2500)] });
  assertEquals(p.timeline.length, 3);
  assertEquals(p.timeline[0], '10/12 정양훈: 로그 요청');
  assertEquals(p.timeline[1], '10/13 로그 수신');
  assertEquals(p.timeline[2].length, 2000);
  assertEquals(normalizeParsed({ timeline: Array(60).fill('a') }).timeline.length, 50);
  assertEquals(normalizeParsed({ timeline: 'not array' }).timeline, []);
  assertEquals(normalizeParsed({}).timeline, []);
});

Deno.test('normalizeSummary: 타입 방어, 5개 제한, 빈 특이사항 제거', () => {
  const s = normalizeSummary({
    issues: [{ label: ' 트래픽 ', detail: 'd', ticket_indexes: [1, '2', 2.5, 3] }, 'junk', ...Array(6).fill({ label: 'x', detail: '', ticket_indexes: [] })],
    notes: [{ customer: 'com1', text: ' t ' }, { customer: 'com2', text: '' }, null],
  });
  assertEquals(s.issues.length, 5);
  assertEquals(s.issues[0], { label: '트래픽', detail: 'd', ticket_indexes: [1, 3] });
  assertEquals(s.issues[1], { label: '', detail: '', ticket_indexes: [] });
  assertEquals(s.notes, [{ customer: 'com1', text: 't' }]);
  assertEquals(normalizeSummary(null), { issues: [], notes: [] });
});

Deno.test('mapIssueIndexes: 번호→id, 범위 밖·중복 제거, 빈 이슈·빈 라벨 제거', () => {
  const rows = [row({ id: 'b' }), row({ id: 'a', received_at: '2026-10-01T00:00:00.000Z' })]; // 정렬 후 1=a, 2=b
  const out = mapIssueIndexes([
    { label: 'X', detail: 'dx', ticket_indexes: [2, 2, 0, 3, 1] },
    { label: 'Y', detail: '', ticket_indexes: [99] },
    { label: '', detail: '', ticket_indexes: [1] },
  ], rows);
  assertEquals(out, [{ label: 'X', detail: 'dx', ticket_ids: ['b', 'a'] }]);
});

Deno.test('unresolvedLines: done 제외, 메모 → 마지막 타임라인 → 이력 없음 순', () => {
  const rows = [
    row({ id: '1', received_at: '2026-10-01T00:00:00.000Z', status: 'done', status_note: '잔여' }),
    row({ id: '2', received_at: '2026-10-02T00:00:00.000Z', status: 'open', status_note: '로그 대기', tickets: ['NRF-1'] }),
    row({ id: '3', received_at: '2026-10-03T00:00:00.000Z', status: 'open', timeline: ['10/02 접수', '10/03 개발팀 전달'], tickets: [] }),
    row({ id: '4', received_at: '2026-10-04T00:00:00.000Z', status: 'unknown', timeline: [], tickets: [], title: '', description: '설명만 있음' }),
    row({ id: '5', received_at: '2026-10-05T00:00:00.000Z', status: 'open', timeline: [], tickets: [], title: '', description: '' }),
    row({ id: '6', received_at: '2026-10-06T00:00:00.000Z', status: 'delayed', status_note: '개발 일정', timeline: ['10/06 접수'], tickets: [] }),
    row({ id: '7', received_at: '2026-10-07T00:00:00.000Z', status: 'deploy', timeline: ['10/07 수정 완료'], tickets: [] }),
    row({ id: '8', received_at: '2026-10-08T00:00:00.000Z', status: 'unknown', status_note: '로그 없음', timeline: [], tickets: [] }),
    row({ id: '9', received_at: '2026-10-09T00:00:00.000Z', status: 'waiting', timeline: [], tickets: ['NRF-9'], assignee: '오민식', ticket_assignee: '김개발' }),
  ];
  assertEquals(unresolvedLines(rows), [
    '**com 81838 / user 119607** — 로그인 실패 · 로그 대기 · NRF-1',
    '**com 81838 / user 119607** — 로그인 실패 · 10/03 개발팀 전달',
    '**com 81838 / user 119607** — 설명만 있음 · 원인 미확인',
    '**com 81838 / user 119607** — (내용 없음) · 조치 이력 없음',
    '**com 81838 / user 119607** — 로그인 실패 · 지연(개발 일정)',
    '**com 81838 / user 119607** — 로그인 실패 · 배포대기',
    '**com 81838 / user 119607** — 로그인 실패 · 원인 미확인(로그 없음)',
    '**com 81838 / user 119607** — 로그인 실패 · 대기 · NRF-9 · 담당 오민식(티켓 김개발)',
  ]);
});

Deno.test('buildSummaryMarkdown: 섹션 순서와 없음 처리', () => {
  const rows = [row({ status: 'done' })];
  const md = buildSummaryMarkdown('2026-10', rows, [], []);
  assertEquals(md, [
    '## 2026년 10월 CS 요약', '',
    '**총 1건** · CLDAstream Win 1', '',
    '### 주요 이슈', '- 없음', '',
    '### 미해결', '- 없음', '',
    '### 특이사항', '- 없음',
  ].join('\n'));

  const md2 = buildSummaryMarkdown('2026-10', [row()], [{ label: '로그인', detail: 'com 81838 로그인 실패, CLD-1', ticket_ids: ['id-1'] }], [{ customer: 'com 81838', text: '재활성화\n완료' }]);
  const lines = md2.split('\n');
  assertEquals(lines[5], '1. **로그인** (1건) — com 81838 로그인 실패, CLD-1');
  assertEquals(lines[8], '- **com 81838 / user 119607** — 로그인 실패 · 10/12 로그 요청 · CLD-1');
  assertEquals(lines[11], '- **com 81838** 재활성화 완료');
});

Deno.test('unresolvedLines: 긴 제목·상태·티켓은 잘라서 content 제한을 지킨다', () => {
  const r = row({ title: '가'.repeat(300), status_note: '나'.repeat(300), tickets: ['다'.repeat(300)] });
  const line = unresolvedLines([r])[0];
  assertEquals(line.includes('가'.repeat(80) + '…'), true);
  assertEquals(line.includes('가'.repeat(81)), false);
  assertEquals(line.includes('나'.repeat(100) + '…'), true);
  assertEquals(line.includes('나'.repeat(101)), false);
  assertEquals(line.includes('다'.repeat(100) + '…'), true);
  assertEquals(line.includes('다'.repeat(101)), false);
});

Deno.test('buildSummaryMarkdown: 미해결 30건 초과는 "외 N건", 특이사항 본문 200자 제한, 전체 20,000자 이하', () => {
  const rows = Array.from({ length: 45 }, (_, i) => row({
    id: `id-${String(i).padStart(3, '0')}`, received_at: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    title: '제'.repeat(200), status_note: '상'.repeat(50), tickets: ['티'.repeat(2000)], customer: '고'.repeat(200),
  }));
  const md = buildSummaryMarkdown('2026-10', rows, [], [{ customer: 'com1', text: '특'.repeat(500) }]);
  const lines = md.split('\n');
  const unresolved = lines.filter((l) => l.startsWith('- **'));
  assertEquals(unresolved.length, 30 + 1);           // 30건 + 특이사항 1줄
  assertEquals(lines.includes('- 외 15건'), true);
  assertEquals(lines[lines.length - 1], '- **com1** ' + '특'.repeat(200) + '…');
  assertEquals(md.length <= 20000, true, `length ${md.length}`);
});
