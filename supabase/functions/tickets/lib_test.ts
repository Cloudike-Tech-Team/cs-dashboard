import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { BadRequest, jiraToTicket, mapLimit, MAX_IDS, splitBySource, toTicket, validateIds } from './lib.ts';

Deno.test('validateIds: 대문자화·중복 제거·형식 아닌 값 버림', () => {
  assertEquals(validateIds({ ids: ['nrf-1', 'NRF-1', ' CLDQA-5142 ', 'https://x/NRF-2', '', null] }), ['NRF-1', 'CLDQA-5142']);
  assertEquals(validateIds({ ids: [] }), []);
  assertThrows(() => validateIds({}), BadRequest);
  assertThrows(() => validateIds(null), BadRequest);
  assertThrows(() => validateIds({ ids: Array.from({ length: MAX_IDS + 1 }, (_, i) => `NRF-${i}`) }), BadRequest);
});

Deno.test('toTicket: 일반 프로젝트 (State · Assignee)', () => {
  const t = toTicket({
    idReadable: 'NRF-4817', summary: '요약', resolved: null,
    customFields: [
      { $type: 'SingleEnumIssueCustomField', name: 'Type', value: { name: 'Bug' } },
      { $type: 'StateIssueCustomField', name: 'State', value: { name: 'In Testing' } },
      { $type: 'SingleUserIssueCustomField', name: 'Assignee', value: { fullName: 'Toussaint Aurelien', login: 'ta' } },
    ],
  }, 'https://yt.cloudike.io/');
  assertEquals(t, {
    id: 'NRF-4817', source: 'youtrack', summary: '요약', state: 'In Testing', resolved: false,
    assignees: ['Toussaint Aurelien'], url: 'https://yt.cloudike.io/issue/NRF-4817',
  });
});

Deno.test('toTicket: NPR (진행 상황 · 개발 담당자 다중, 요청자 무시)', () => {
  const t = toTicket({
    idReadable: 'NPR-134', summary: 's', resolved: 1700000000000,
    customFields: [
      { $type: 'StateIssueCustomField', name: '진행 상황', value: { name: '테스트 완료' } },
      { $type: 'MultiUserIssueCustomField', name: '요청자', value: [{ fullName: 'Taeho Kang' }] },
      { $type: 'MultiUserIssueCustomField', name: '개발 담당자', value: [{ fullName: 'Hongjae Yim' }, { login: 'dh' }] },
    ],
  }, 'https://yt.cloudike.io');
  assertEquals([t.state, t.resolved, t.assignees], ['테스트 완료', true, ['Hongjae Yim', 'dh']]);
});

Deno.test('toTicket: 담당·상태 비어 있음', () => {
  const t = toTicket({ idReadable: 'NRF-1', customFields: [{ name: 'Assignee', value: null }] }, 'https://y');
  assertEquals([t.state, t.assignees, t.resolved, t.summary], ['', [], false, '']);
});

Deno.test('mapLimit: 순서 유지, 동시 실행 수 제한', async () => {
  let running = 0, peak = 0;
  const out = await mapLimit([5, 1, 3, 2], 2, async (n) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, n));
    running--;
    return n * 10;
  });
  assertEquals(out, [50, 10, 30, 20]);
  assertEquals(peak, 2);
  assertEquals(await mapLimit([], 3, async (n: number) => n), []);
});

Deno.test('splitBySource: Jira 프로젝트 키만 Jira 로', () => {
  assertEquals(splitBySource(['NRF-1', 'CLDA-82', 'GOVNIPA-3', 'CLDAX-1'], ['clda', ' GOVNIPA', '']),
    { youtrack: ['NRF-1', 'CLDAX-1'], jira: ['CLDA-82', 'GOVNIPA-3'] });
  assertEquals(splitBySource(['NRF-1'], []), { youtrack: ['NRF-1'], jira: [] });
});

Deno.test('jiraToTicket: 상태·완료 분류·담당', () => {
  const t = jiraToTicket({
    key: 'CLDA-82',
    fields: { summary: 's', status: { name: '진행 불가 (재현X)', statusCategory: { key: 'done' } }, assignee: { displayName: 'Seungyeon Yoo' } },
  }, 'https://cloudike.atlassian.net/');
  assertEquals(t, {
    id: 'CLDA-82', source: 'jira', summary: 's', state: '진행 불가 (재현X)', resolved: true,
    assignees: ['Seungyeon Yoo'], url: 'https://cloudike.atlassian.net/browse/CLDA-82',
  });
  const u = jiraToTicket({ key: 'CLDA-1', fields: { status: { name: '원인 분석중', statusCategory: { key: 'new' } }, assignee: null } }, 'https://x');
  assertEquals([u.resolved, u.assignees, u.summary], [false, [], '']);
});
