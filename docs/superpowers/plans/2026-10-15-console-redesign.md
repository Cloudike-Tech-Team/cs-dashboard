# CS 콘솔 리디자인 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 디자인 시안대로 CS 대시보드를 상태·제목 컬럼, 구조화 월간 요약, 3열 레이아웃(요약·필터 / 목록 / 상세)으로 재편한다.

**Architecture:** DB는 `cs_tickets`에 `title/status/status_note`, `cs_monthly_summaries`에 `issues/notes` jsonb를 추가한다. Edge Function `ai`의 summarize는 Claude 구조화 출력(JSON)으로 주요 이슈·특이사항만 받고, 미해결 목록과 마크다운은 함수가 결정적으로 만든다. 프론트는 빌드 없는 정적 파일 그대로이며, 순수 함수를 `js/lib.js`로 분리해 `node --test`로 검증하고 `js/app.js`는 렌더·이벤트만 맡는다.

**Tech Stack:** Supabase(Postgres + RLS, Edge Function on Deno), `@anthropic-ai/sdk` 0.133 (`claude-sonnet-5-5`, `output_config.format = json_schema`), supabase-js v2 UMD, 바닐라 JS, Node 20 (`node --test`), `npx deno-bin`.

**Spec:** `docs/superpowers/specs/2026-10-15-console-redesign-design.md`

## Global Constraints

- 빌드 도구 없음. `index.html`이 `<script>`로 `js/config.js`, `js/lib.js`, `js/app.js`를 순서대로 읽는다.
- `innerHTML` 사용 금지. DOM은 기존 `el()` 헬퍼로만 만든다.
- 모든 날짜·월 경계는 KST(`Asia/Seoul`, `+09:00`) 기준.
- `status` 허용값은 정확히 `'open' | 'done' | 'unknown'`, 기본값 `'open'`. `status_note` 최대 50자. `title` 최대 200자.
- `issues` 원소 형태 `{ label: string, detail: string, ticket_ids: string[] }`, `notes` 원소 형태 `{ customer: string, text: string }`.
- 이슈 색 팔레트(순서 고정): `#B45309, #1D4ED8, #0F766E, #6B7280, #7C3AED`. 상태색 open `#B45309`, done `#15803D`, unknown `#6B7280`.
- 디자인 토큰: 글자 `#111318`, 보조 `#6B7280`, 선 `#D9DBE0`, 패널 배경 `#F7F7F8`, 선택 `#F1F3F6`, 링크 `#1D4ED8`, 라운드 2px. 폰트 IBM Plex Sans KR / IBM Plex Mono. 다크 모드 없음.
- 낙관적 잠금: 모든 update/delete는 `.eq('updated_at', row.updated_at)`를 붙이고 0건이면 `CONFLICT_MSG`.
- 커밋 메시지는 한국어 한 줄 + 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. `git push`는 하지 않는다(사용자가 직접).
- Claude 구조화 출력 스키마에 `maxItems`, `minItems`, `minLength` 같은 제약 키워드를 쓰지 않는다(지원되지 않음). 개수 제한은 프롬프트 + 함수의 `slice`로.

## Review Focus

1. 타임라인 항목이 `3.19.61 업데이트 안내`처럼 버전 번호로 시작해도 날짜로 오인하지 않아야 한다 → Task 2 `splitTimeline` 테스트.
2. 모델이 돌려준 `ticket_indexes`가 범위 밖·중복·정수가 아닐 때 함수가 조용히 버리고 빈 이슈를 제거해야 한다 → Task 4 `mapIssueIndexes` 테스트.
3. 요약이 가리키는 CS가 그 뒤 삭제되면 이슈 건수는 남은 것만 세고 0건이면 버튼이 비활성이어야 한다 → Task 2 `issueCounts` 테스트, Task 7 수동 확인.
4. `status='done'`인데 `status_note`가 남아 있어도 미해결 목록에서 빠지고, 표시 라벨은 메모를 우선해야 한다 → Task 4 `unresolvedLines`, Task 2 `statusLabel` 테스트.
5. 검색어는 제목과 상태 라벨에도 걸려야 한다(이전에는 description만 있었음) → Task 2 `matchesSearch` 테스트.

---

### Task 1: 스키마 컬럼 추가

**Files:**
- Modify: `supabase/schema.sql`
- Modify: `README.md` (1-1 절의 객체 표)

**Interfaces:**
- Produces: `cs_tickets.title text`, `cs_tickets.status text ('open'|'done'|'unknown')`, `cs_tickets.status_note text`, `cs_monthly_summaries.issues jsonb`, `cs_monthly_summaries.notes jsonb`. 이후 모든 태스크가 이 컬럼명을 그대로 쓴다.

- [ ] **Step 1: `create table cs_tickets` 에 새 컬럼 추가 (신규 설치용)**

`supabase/schema.sql`의 `cs_tickets` 테이블 정의에서 `tickets      text[] not null default '{}',` 줄 바로 아래에 추가:

```sql
  title        text not null default '' check (char_length(title) <= 200),      -- 현상 제목
  status       text not null default 'open'
                 check (status in ('open', 'done', 'unknown')),                 -- 처리 상태
  status_note  text not null default '' check (char_length(status_note) <= 50), -- 상태 메모(예: 로그 대기)
```

- [ ] **Step 2: 기존 설치용 `alter table` + 백필 블록 추가**

`cs_tickets_received_at_idx` 인덱스 생성문 바로 아래에 추가:

```sql
-- 1-b. 2026-10 리디자인: 제목·상태 컬럼 (기존 설치에 추가. 신규 설치는 위 create 에 이미 포함)
alter table public.cs_tickets
  add column if not exists title       text not null default ''
                                        check (char_length(title) <= 200),
  add column if not exists status      text not null default 'open'
                                        check (status in ('open', 'done', 'unknown')),
  add column if not exists status_note text not null default ''
                                        check (char_length(status_note) <= 50);

-- 기존 행 백필: 제목이 비어 있으면 현상설명 첫 줄
update public.cs_tickets
   set title = left(split_part(description, E'\n', 1), 200)
 where title = '' and description <> '';
```

- [ ] **Step 3: `cs_monthly_summaries` 에 jsonb 컬럼 추가**

`create table if not exists public.cs_monthly_summaries` 정의에서 `ticket_count int  not null check (ticket_count >= 0),` 아래에 추가:

```sql
  issues       jsonb not null default '[]'::jsonb,   -- [{label, detail, ticket_ids: uuid[]}]
  notes        jsonb not null default '[]'::jsonb,   -- [{customer, text}]
```

그리고 그 `create table` 문 바로 아래(RLS `alter table ... enable row level security` 앞)에:

```sql
-- 기존 설치에 추가
alter table public.cs_monthly_summaries
  add column if not exists issues jsonb not null default '[]'::jsonb,
  add column if not exists notes  jsonb not null default '[]'::jsonb;
```

- [ ] **Step 4: 문법 확인**

로컬 Postgres가 없으므로 Supabase SQL Editor에서 전체 파일을 두 번 연속 Run 한다(두 번째도 오류 없어야 idempotent).
Run: Dashboard → SQL Editor → 붙여넣기 → Run → 다시 Run
Expected: 두 번 모두 "Success". `Table Editor → cs_tickets`에 `title`, `status`, `status_note` 열이 보이고 기존 행의 `title`이 채워져 있음.

- [ ] **Step 5: README 객체 표 갱신**

`README.md` 1-1 절 표의 `cs_tickets` 행을 아래로 교체하고 요약 행을 추가:

```markdown
| `cs_tickets` | CS 테이블. 제목·상태(`open/done/unknown`)·상태 메모 포함. 타임라인·티켓은 `text[]` 배열 |
| `cs_monthly_summaries` | 월간 요약. `content`(마크다운) + `issues`/`notes`(jsonb, 화면 필터용) |
```

- [ ] **Step 6: 커밋**

```bash
git add supabase/schema.sql README.md
git commit -m "$(cat <<'EOF'
스키마: cs_tickets 제목·상태 컬럼, cs_monthly_summaries issues·notes 추가

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 프론트 순수 함수 `js/lib.js`

**Files:**
- Create: `js/lib.js`
- Create: `js/lib.test.js`

**Interfaces:**
- Produces (`window.CSLib`, Node에서는 `require('./lib.js')`):
  - `STATUS: { open:{label,color}, done:{label,color}, unknown:{label,color} }`
  - `ISSUE_COLORS: string[]`
  - `statusLabel(row) → string`, `statusColor(row) → string`
  - `splitTimeline(entry: string) → { when: string, text: string }` (`when`은 `MM-DD` 또는 `''`)
  - `kpi(rows) → { total, open, done, ticketed }`
  - `issueCounts(issues, rows) → (issue & { count })[]`
  - `applyFilter(rows, filter, issues) → rows` (`filter`는 `null | {type:'issue', value:number} | {type:'device', value:string}`)
  - `matchesSearch(row, q) → boolean`

- [ ] **Step 1: 실패하는 테스트 작성**

`js/lib.test.js`:

```js
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
```

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/donghun/cs-dashboard && node --test js/lib.test.js`
Expected: FAIL, `Cannot find module './lib.js'`

- [ ] **Step 3: 구현**

`js/lib.js`:

```js
// 프론트 순수 함수. DOM·supabase 에 의존하지 않아 `node --test js/lib.test.js` 로 검증한다.
// 브라우저에서는 window.CSLib 로 노출된다.
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.CSLib = lib;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const STATUS = {
    open:    { label: '처리 중',     color: '#B45309' },
    done:    { label: '완료',        color: '#15803D' },
    unknown: { label: '원인 미확인', color: '#6B7280' },
  };
  const ISSUE_COLORS = ['#B45309', '#1D4ED8', '#0F766E', '#6B7280', '#7C3AED'];

  function statusDef(row) { return STATUS[row.status] || STATUS.open; }
  function statusLabel(row) { return row.status_note || statusDef(row).label; }
  function statusColor(row) { return statusDef(row).color; }

  // 타임라인 문자열 앞의 "10/12", "10-12 14:00", "2026-10-12" 를 떼어 MM-DD 로. 버전 번호(3.19.61)는 '.' 이라 매칭 안 됨.
  const TL_RE = /^(?:\d{4}-)?(\d{1,2})[/-](\d{1,2})(?:\s+\d{1,2}:\d{2})?(?:\s+|$)/;
  function splitTimeline(entry) {
    const s = String(entry || '');
    const m = s.match(TL_RE);
    if (m) {
      const mo = Number(m[1]), d = Number(m[2]);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return { when: `${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, text: s.slice(m[0].length) };
      }
    }
    return { when: '', text: s };
  }

  function kpi(rows) {
    return {
      total: rows.length,
      open: rows.filter((r) => r.status !== 'done').length,
      done: rows.filter((r) => r.status === 'done').length,
      ticketed: rows.filter((r) => (r.tickets || []).length > 0).length,
    };
  }

  function issueCounts(issues, rows) {
    const ids = new Set(rows.map((r) => r.id));
    return issues.map((is) => ({ ...is, count: (is.ticket_ids || []).filter((id) => ids.has(id)).length }));
  }

  function applyFilter(rows, filter, issues) {
    if (!filter) return rows;
    if (filter.type === 'device') return rows.filter((r) => r.device === filter.value);
    const issue = issues[filter.value];
    if (!issue) return rows;
    const ids = new Set(issue.ticket_ids || []);
    return rows.filter((r) => ids.has(r.id));
  }

  function matchesSearch(row, q) {
    const needle = (q || '').trim().toLowerCase();
    if (!needle) return true;
    return [row.title, row.reporter, row.customer, row.version, row.description, row.notes,
      statusLabel(row), ...(row.timeline || []), ...(row.tickets || [])]
      .some((v) => (v || '').toLowerCase().includes(needle));
  }

  return { STATUS, ISSUE_COLORS, statusLabel, statusColor, splitTimeline, kpi, issueCounts, applyFilter, matchesSearch };
});
```

- [ ] **Step 4: 통과 확인**

Run: `node --test js/lib.test.js`
Expected: `# pass 8`, `# fail 0`

- [ ] **Step 5: 커밋**

```bash
git add js/lib.js js/lib.test.js
git commit -m "$(cat <<'EOF'
프론트 순수 함수 분리: 상태 라벨, 타임라인 날짜 분리, KPI, 필터, 검색

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Edge Function `lib.ts` — Ticket 확장, 입력 줄에 제목·상태, parse 에 title

**Files:**
- Modify: `supabase/functions/ai/lib.ts`
- Modify: `supabase/functions/ai/lib_test.ts`

**Interfaces:**
- Produces: `Ticket` 타입에 `id, title, status, status_note` 추가. `sortByReceived(rows)`, `statusText(row)`, `buildSummaryInput(month, rows)` 새 열 형식, `Parsed.title`, `normalizeParsed(...).title`.
- Task 4·5가 `sortByReceived`의 정렬 순서(= 입력 목록 번호)에 의존한다.

- [ ] **Step 1: 테스트 수정·추가**

`lib_test.ts`의 `row` 픽스처를 교체:

```ts
const row = (over = {}) => ({
  id: 'id-1', received_at: '2026-10-12T05:47:00.000Z', reporter: '정양훈', customer: 'com 81838 / user 119607',
  device: 'CLDAstream Win', version: '3.19.61', title: '로그인 실패', status: 'open' as const, status_note: '',
  description: '로그인\n실패', notes: '', timeline: ['10/12 로그 요청'], tickets: ['CLD-1'], ...over,
});
```

`buildSummaryInput` 테스트를 교체:

```ts
Deno.test('buildSummaryInput: 집계 헤더와 한 줄 행 (제목·상태 포함)', () => {
  const out = buildSummaryInput('2026-10', [
    row(),
    row({ id: 'id-0', device: '웹', received_at: '2026-10-01T01:00:00.000Z', timeline: [], tickets: [], status: 'done', title: '' }),
    row({ id: 'id-2', received_at: '2026-10-13T01:00:00.000Z', status: 'unknown', status_note: '로그 수집 실패' }),
  ]);
  const lines = out.split('\n');
  assertEquals(lines[0], '[집계] 2026년 10월 · 총 3건 · CLDAstream Win 2 · 웹 1');
  assertEquals(lines[2], '[CS 목록] 번호. 날짜 | 고객사 | 기기 | 버전 | 제목 | 현상 | 특이사항 | 타임라인 | 티켓 | 상태');
  assertEquals(lines[3], '1. 10/01 | com 81838 / user 119607 | 웹 | 3.19.61 | - | 로그인 실패 | - | (없음) | - | 완료');
  assertEquals(lines[4], '2. 10/12 | com 81838 / user 119607 | CLDAstream Win | 3.19.61 | 로그인 실패 | 로그인 실패 | - | 10/12 로그 요청 | CLD-1 | 처리 중');
  assertEquals(lines[5], '3. 10/13 | com 81838 / user 119607 | CLDAstream Win | 3.19.61 | 로그인 실패 | 로그인 실패 | - | 10/12 로그 요청 | CLD-1 | 원인 미확인(로그 수집 실패)');
});

Deno.test('sortByReceived: 날짜 오름차순, 동률은 id', () => {
  const r = sortByReceived([row({ id: 'b' }), row({ id: 'a' }), row({ id: 'c', received_at: '2026-10-01T00:00:00.000Z' })]);
  assertEquals(r.map((x) => x.id), ['c', 'a', 'b']);
});

Deno.test('statusText', () => {
  assertEquals(statusText(row()), '처리 중');
  assertEquals(statusText(row({ status: 'open', status_note: '로그 대기' })), '처리 중(로그 대기)');
  assertEquals(statusText(row({ status: 'done' })), '완료');
});
```

`normalizeParsed` 테스트에서 기대값에 `title` 추가 — 첫 `assertEquals(p, {...})`의 입력에 `title: ' 로그인 안 됨 '`, 기대 객체에 `title: '로그인 안 됨'`을 넣고, 마지막에 한 줄 추가:

```ts
  assertEquals(normalizeParsed({}).title, '');
```

import 줄을 교체:

```ts
import {
  BadRequest, buildSummaryInput, deviceCounts, monthRange, normalizeParsed, sortByReceived, statusText, validateRequest,
} from './lib.ts';
```

- [ ] **Step 2: 실패 확인**

Run: `cd supabase/functions/ai && npx -y deno-bin test --allow-net=jsr.io`
Expected: 컴파일 오류 — `sortByReceived`, `statusText` 가 export 되지 않음.

- [ ] **Step 3: 구현**

`lib.ts`에서 `Ticket` 타입을 교체:

```ts
export type Status = 'open' | 'done' | 'unknown';

export type Ticket = {
  id: string;
  received_at: string;
  reporter: string;
  customer: string;
  device: string;
  version: string;
  title: string;
  status: Status;
  status_note: string;
  description: string;
  notes: string;
  timeline: string[];
  tickets: string[];
};

export const STATUS_LABEL: Record<Status, string> = { open: '처리 중', done: '완료', unknown: '원인 미확인' };

// "처리 중(로그 대기)" 형태. 모델 입력과 마크다운에 공통 사용.
export function statusText(r: Pick<Ticket, 'status' | 'status_note'>): string {
  const base = STATUS_LABEL[r.status] ?? r.status;
  return r.status_note ? `${base}(${r.status_note})` : base;
}

// 입력 목록 번호(1부터)의 기준 순서. mapIssueIndexes 도 같은 순서를 쓴다.
export function sortByReceived<T extends Pick<Ticket, 'received_at' | 'id'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id));
}
```

`buildSummaryInput`을 교체:

```ts
export function buildSummaryInput(month: string, rows: Ticket[]): string {
  const [year, mon] = month.split('-');
  const lines: string[] = [];
  lines.push(`[집계] ${year}년 ${Number(mon)}월 · 총 ${rows.length}건 · ` +
    deviceCounts(rows).map(([d, n]) => `${d} ${n}`).join(' · '));
  lines.push('');
  lines.push('[CS 목록] 번호. 날짜 | 고객사 | 기기 | 버전 | 제목 | 현상 | 특이사항 | 타임라인 | 티켓 | 상태');
  sortByReceived(rows).forEach((r, i) => {
    lines.push([
      `${i + 1}. ${kstDate(r.received_at)}`,
      r.customer,
      r.device,
      r.version || '-',
      oneLine(r.title) || '-',
      oneLine(r.description) || '-',
      oneLine(r.notes) || '-',
      r.timeline.map(oneLine).join(' → ') || '(없음)',
      r.tickets.join(', ') || '-',
      statusText(r),
    ].join(' | '));
  });
  return lines.join('\n');
}
```

`summaryUserMessage`를 교체:

```ts
export function summaryUserMessage(month: string, rows: Ticket[]): string {
  const [year, mon] = month.split('-');
  return `${buildSummaryInput(month, rows)}\n\n위 목록으로 ${year}년 ${Number(mon)}월의 주요 이슈와 특이사항을 JSON 으로 작성하세요. ticket_indexes 에는 위 목록의 번호를 넣습니다.`;
}
```

`Parsed` 타입에 `title: string;` 을 `customer` 다음 줄에 추가하고, `normalizeParsed`의 반환 객체에 `title: str(o.title),` 을 `customer` 다음에 추가.

`oneLine`은 Task 4에서도 쓰므로 `export function oneLine(...)` 으로 바꾼다.

- [ ] **Step 4: 통과 확인**

Run: `npx -y deno-bin test --allow-net=jsr.io`
Expected: 모든 테스트 `ok`.

- [ ] **Step 5: 커밋**

```bash
git add supabase/functions/ai/lib.ts supabase/functions/ai/lib_test.ts
git commit -m "$(cat <<'EOF'
Edge Function: Ticket 에 제목·상태 추가, 요약 입력에 반영, parse 에 title

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Edge Function `lib.ts` — 구조화 요약 정규화·매핑·마크다운 생성

**Files:**
- Modify: `supabase/functions/ai/lib.ts`
- Modify: `supabase/functions/ai/lib_test.ts`

**Interfaces:**
- Consumes: `Ticket`, `sortByReceived`, `statusText`, `oneLine`, `deviceCounts` (Task 3).
- Produces:
  - `type RawIssue = { label: string; detail: string; ticket_indexes: number[] }`
  - `type Issue = { label: string; detail: string; ticket_ids: string[] }`
  - `type Note = { customer: string; text: string }`
  - `normalizeSummary(raw: unknown) → { issues: RawIssue[]; notes: Note[] }` (각 최대 5개)
  - `mapIssueIndexes(issues: RawIssue[], rows) → Issue[]`
  - `unresolvedLines(rows: Ticket[]) → string[]`
  - `buildSummaryMarkdown(month, rows, issues: Issue[], notes: Note[]) → string`

- [ ] **Step 1: 테스트 추가**

`lib_test.ts` 끝에 추가 (import 에 `buildSummaryMarkdown, mapIssueIndexes, normalizeSummary, unresolvedLines` 추가):

```ts
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
  ];
  assertEquals(unresolvedLines(rows), [
    '**com 81838 / user 119607** — 로그인 실패 · 로그 대기 · NRF-1',
    '**com 81838 / user 119607** — 로그인 실패 · 10/03 개발팀 전달',
    '**com 81838 / user 119607** — 설명만 있음 · 원인 미확인',
    '**com 81838 / user 119607** — (내용 없음) · 조치 이력 없음',
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
```

- [ ] **Step 2: 실패 확인**

Run: `npx -y deno-bin test --allow-net=jsr.io`
Expected: 컴파일 오류 — 네 함수가 export 되지 않음.

- [ ] **Step 3: 구현**

`lib.ts` 끝에 추가:

```ts
// ───────────── summarize 구조화 출력 처리 ─────────────
export type RawIssue = { label: string; detail: string; ticket_indexes: number[] };
export type Issue = { label: string; detail: string; ticket_ids: string[] };
export type Note = { customer: string; text: string };

export const MAX_ISSUES = 5;
export const MAX_NOTES = 5;

// 구조화 출력이라 형태는 보장되지만 방어적으로 정리. 개수 제한은 여기서(스키마의 maxItems 는 미지원).
export function normalizeSummary(raw: unknown): { issues: RawIssue[]; notes: Note[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const obj = (v: unknown) => (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const issues = arr(o.issues).slice(0, MAX_ISSUES).map((x) => {
    const i = obj(x);
    return {
      label: str(i.label),
      detail: str(i.detail),
      ticket_indexes: arr(i.ticket_indexes).filter((n): n is number => Number.isInteger(n)),
    };
  });
  const notes = arr(o.notes).slice(0, MAX_NOTES)
    .map((x) => { const n = obj(x); return { customer: str(n.customer), text: str(n.text) }; })
    .filter((n) => n.text);
  return { issues, notes };
}

// 목록 번호(1부터, sortByReceived 순서) → 행 id. 범위 밖·중복은 버리고, 남는 id 가 없거나 라벨이 비면 이슈 제거.
export function mapIssueIndexes(issues: RawIssue[], rows: Pick<Ticket, 'id' | 'received_at'>[]): Issue[] {
  const sorted = sortByReceived(rows);
  const out: Issue[] = [];
  for (const is of issues) {
    const ids = new Set<string>();
    for (const i of is.ticket_indexes) {
      if (Number.isInteger(i) && i >= 1 && i <= sorted.length) ids.add(sorted[i - 1].id);
    }
    const label = oneLine(is.label);
    if (ids.size && label) out.push({ label, detail: oneLine(is.detail), ticket_ids: [...ids] });
  }
  return out;
}

// 미해결 목록은 LLM 에 맡기지 않고 status 로 만든다.
export function unresolvedLines(rows: Ticket[]): string[] {
  return sortByReceived(rows).filter((r) => r.status !== 'done').map((r) => {
    const what = oneLine(r.title) || oneLine(r.description) || '(내용 없음)';
    const state = r.status === 'unknown' ? STATUS_LABEL.unknown
      : r.status_note || (r.timeline.length ? oneLine(r.timeline[r.timeline.length - 1]) : '조치 이력 없음');
    const tickets = r.tickets.length ? ` · ${r.tickets.join(', ')}` : '';
    return `**${r.customer}** — ${what} · ${state}${tickets}`;
  });
}

export function buildSummaryMarkdown(month: string, rows: Ticket[], issues: Issue[], notes: Note[]): string {
  const [year, mon] = month.split('-');
  const lines: string[] = [
    `## ${year}년 ${Number(mon)}월 CS 요약`, '',
    `**총 ${rows.length}건** · ` + deviceCounts(rows).map(([d, n]) => `${d} ${n}`).join(' · '), '',
    '### 주요 이슈',
  ];
  if (issues.length) issues.forEach((is, i) => lines.push(`${i + 1}. **${is.label}** (${is.ticket_ids.length}건) — ${is.detail}`));
  else lines.push('- 없음');
  lines.push('', '### 미해결');
  const un = unresolvedLines(rows);
  lines.push(...(un.length ? un.map((l) => `- ${l}`) : ['- 없음']));
  lines.push('', '### 특이사항');
  lines.push(...(notes.length ? notes.map((n) => `- **${n.customer}** ${oneLine(n.text)}`) : ['- 없음']));
  return lines.join('\n');
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx -y deno-bin test --allow-net=jsr.io`
Expected: 모든 테스트 `ok`. 실패하면 기대 문자열과 실제 출력을 비교해 구현(테스트가 아님)을 고친다.

- [ ] **Step 5: 커밋**

```bash
git add supabase/functions/ai/lib.ts supabase/functions/ai/lib_test.ts
git commit -m "$(cat <<'EOF'
Edge Function: 구조화 요약 정규화·번호→id 매핑·미해결 목록·마크다운 생성

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 프롬프트·스키마 교체와 summarize 경로 전환, 배포

**Files:**
- Modify: `supabase/functions/ai/prompts.ts`
- Modify: `supabase/functions/ai/index.ts`

**Interfaces:**
- Consumes: Task 3·4의 함수 전부.
- Produces: `PARSE_SCHEMA.properties.title`, `SUMMARY_SCHEMA`, 새 `SUMMARY_SYSTEM`. `SUMMARY_TEMPLATE` 삭제. 응답 `{ summary: <cs_monthly_summaries 행> }` (이제 `issues`, `notes` 포함).

- [ ] **Step 1: `PARSE_SCHEMA` 에 title 추가**

`prompts.ts`의 `PARSE_SCHEMA.required` 배열에 `'title'` 을 `'customer'` 다음에 넣고, `properties` 에 `received_at` 앞에 추가:

```ts
    title: { type: 'string', description: '고객이 겪는 현상을 20자 안팎 한 줄로. 예) "웹에서 35MB 엑셀 열리지 않음".' },
```

- [ ] **Step 2: `PARSE_SYSTEM` 에 title 규칙 추가**

`- customer:` 규칙 줄 바로 아래에 추가:

```
- title: 고객이 겪는 현상을 20자 안팎 한 줄로. 예) "웹에서 35MB 엑셀 열리지 않음", "트래픽 초과 — 반복 다운로드", "CLDAstream 표시 언어 영어 고정". 오류 메시지 원문보다 현상 요약을 우선. 고객사 번호는 넣지 않습니다.
```

그리고 `- description:` 규칙 끝에 문장 추가: ` 제목(title)과 같은 문장을 반복하지 않습니다.`

- [ ] **Step 3: summarize 프롬프트를 JSON 출력용으로 교체**

`prompts.ts`에서 `SUMMARY_TEMPLATE` 상수와 `SUMMARY_SYSTEM` 상수를 삭제하고 아래로 교체:

```ts
// ───────────── summarize: 월간 CS 목록 → 주요 이슈·특이사항 JSON ─────────────
// 통계·미해결 목록·마크다운은 모델이 아니라 lib.ts 가 만든다. 모델은 "묶기"와 "기억할 사실 고르기"만 한다.

export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues', 'notes'],
  properties: {
    issues: {
      type: 'array',
      description: '비슷한 현상끼리 묶은 주요 이슈. 건수가 많은 순. 3~5개.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'detail', 'ticket_indexes'],
        properties: {
          label: { type: 'string', description: '이슈 이름 12자 안팎. 화면 버튼에 들어감. 예) "트래픽 초과", "CLDAstream 로그인·표시"' },
          detail: { type: 'string', description: '어떤 고객사가 어떤 증상인지 한 문장, 60자 안팎. 고객사 번호(com6384)와 티켓 번호를 포함.' },
          ticket_indexes: { type: 'array', items: { type: 'integer' }, description: '이 이슈에 속하는 CS 목록 번호(1부터).' },
        },
      },
    },
    notes: {
      type: 'array',
      description: '보고서에 꼭 남길 사실. 0~5개.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['customer', 'text'],
        properties: {
          customer: { type: 'string', description: '고객사 번호. 예) "com82171"' },
          text: { type: 'string', description: '수치·경위·후속 조치를 한 문장으로. 예) "9월 초과 — 공유 링크 51개, 외부 약 140개 IP 가 원본 다운로드"' },
        },
      },
    },
  },
} as const;

export const SUMMARY_SYSTEM = `당신은 Cloudike 기술팀의 월간 CS 보고서 작성을 돕습니다. 아래 CS 목록을 읽고 주어진 JSON 스키마에 맞춰 "주요 이슈"와 "특이사항"만 작성합니다. 통계, 미해결 여부, 건수는 시스템이 따로 계산하므로 쓰지 않습니다.

주요 이슈(issues):
- 비슷한 현상끼리 묶어 건수가 많은 순으로 3~5개. CS 가 3건 이하면 그만큼만.
- label: 이슈 이름 12자 안팎. 화면 필터 버튼의 글자이므로 짧고 구체적으로. 예) "트래픽 초과", "CLDAstream 로그인·표시", "웹 대용량 엑셀".
- detail: 어떤 고객사가 어떤 증상인지 한 문장, 60자 안팎. 고객사 번호(com6384 형식)와 티켓 번호(있을 때)를 포함.
- ticket_indexes: 그 이슈에 속하는 CS 의 목록 번호. 한 CS 는 한 이슈에만 넣습니다. 어디에도 묶이지 않는 건은 "기타"로 묶지 말고 제외합니다.

특이사항(notes):
- 다음 달에도 기억해야 할 사실: 수치(용량·건수·IP 수), 경위, 완료된 후속 조치나 재발 방지 조치. 0~5개.
- customer 는 고객사 번호, text 는 한 문장. 목록의 "특이사항"·"타임라인" 열에 있는 내용을 우선합니다.

공통:
- 목록에 없는 내용을 추가하지 않습니다. 추측 표현("~로 보임")은 목록에 근거가 있을 때만 씁니다.
- 한국어, 간결체.`;
```

- [ ] **Step 4: `index.ts` summarize 경로 전환**

import 줄 두 개를 교체:

```ts
import { MODEL, PARSE_SCHEMA, PARSE_SYSTEM, SUMMARY_SCHEMA, SUMMARY_SYSTEM } from './prompts.ts';
import {
  BadRequest, buildSummaryMarkdown, mapIssueIndexes, monthRange, normalizeParsed, normalizeSummary,
  summaryUserMessage, validateRequest, type Ticket,
} from './lib.ts';
```

`// ── summarize` 블록을 아래로 교체 (`const { from, to } = ...` 부터 `return json({ summary: saved });` 까지):

```ts
    // ── summarize
    const { from, to } = monthRange(body.month);
    const { data: rows, error: qErr } = await sb
      .from('cs_tickets')
      .select('id,received_at,reporter,customer,device,version,title,status,status_note,description,notes,timeline,tickets')
      .gte('received_at', from).lt('received_at', to)
      .order('received_at', { ascending: true })
      .limit(2000);
    if (qErr) throw new HttpError(500, 'CS 목록 조회 실패: ' + qErr.message);
    if (!rows || rows.length === 0) throw new HttpError(400, `${body.month} 에는 요약할 CS가 없습니다.`);
    const tickets = rows as Ticket[];

    const res = await claude.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SUMMARY_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
      messages: [{ role: 'user', content: summaryUserMessage(body.month, tickets) }],
    });
    checkStop(res, 'summarize');
    let raw: unknown;
    try { raw = JSON.parse(textOf(res)); }
    catch { throw new HttpError(502, '모델 응답을 해석하지 못했습니다. 다시 시도하세요.'); }
    const { issues: rawIssues, notes } = normalizeSummary(raw);
    const issues = mapIssueIndexes(rawIssues, tickets);
    const content = buildSummaryMarkdown(body.month, tickets, issues, notes);

    const { data: saved, error: upErr } = await sb
      .from('cs_monthly_summaries')
      .upsert({
        month: body.month,
        content,
        issues,
        notes,
        ticket_count: tickets.length,
        generated_by: user.id,
        generated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (upErr) throw new HttpError(500, '요약 저장 실패: ' + upErr.message);
    return json({ summary: saved });
```

- [ ] **Step 5: 타입 검사·테스트**

Run: `cd supabase/functions/ai && npx -y deno-bin check index.ts && npx -y deno-bin test --allow-net=jsr.io`
Expected: check 오류 없음, 테스트 전부 `ok`. `SUMMARY_TEMPLATE` 참조가 남아 있으면 check 가 잡는다.

- [ ] **Step 6: 배포 후 실제 호출 확인**

Run: `cd /Users/donghun/cs-dashboard && npx -y supabase functions deploy ai --no-verify-jwt`
Expected: `Deployed Functions on project ...`.

그다음 현재 index.html(아직 구버전)에서 로그인 → 「재생성」 → Dashboard → Table Editor → `cs_monthly_summaries` 의 해당 월 행에 `issues` 배열(각 `ticket_ids` 가 uuid)과 `notes` 가 채워졌는지 확인. 구버전 화면은 `content` 마크다운을 그대로 렌더하므로 깨지지 않아야 한다.

- [ ] **Step 7: 커밋**

```bash
git add supabase/functions/ai/prompts.ts supabase/functions/ai/index.ts
git commit -m "$(cat <<'EOF'
Edge Function: 요약을 구조화 출력(주요 이슈·특이사항)으로 전환, parse 에 제목 추가

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 레이아웃·스타일 재작성 (`index.html`, `css/style.css`)

**Files:**
- Modify: `index.html` (전면 교체)
- Modify: `css/style.css` (전면 교체)

**Interfaces:**
- Produces: Task 7~9의 `app.js`가 참조하는 element id 전부. 목록:
  `login-view login-form login-email login-password login-error app-view user-email logout-btn prev-month month-label next-month this-month search-input export-btn new-btn kpi-total kpi-open kpi-done kpi-ticketed summary-meta summary-copy-btn summary-gen-btn summary-error filter-clear issue-list device-list notes-list list-title list-error cs-list empty detail detail-when detail-close detail-status detail-title detail-customer detail-device detail-received detail-reporter detail-tickets detail-desc detail-history detail-error quick-box status-btn history-btn edit-btn cs-dialog cs-form dialog-title paste-box paste-text paste-btn paste-status paste-notes form-meta form-error delete-btn delete-confirm delete-yes delete-no save-btn toast`
- 폼 필드 name: `reporter customer received_at device version title status status_note description notes` + 리스트 `data-list="timeline|tickets"`.
- 상태색은 CSS 변수 `--c` 로 받는다(`.cs-row`, `.status-pill`, `.issue-btn` 이 `style="--c: ..."` 또는 `style.setProperty('--c', ...)` 로 설정).

- [ ] **Step 1: `index.html` 전면 교체**

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CS 콘솔</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <!-- 로그인 -->
  <section id="login-view" class="login" hidden>
    <form id="login-form" class="login-card">
      <h1>CS 콘솔</h1>
      <p class="muted">팀 계정으로 로그인하세요.</p>
      <label>이메일<input id="login-email" type="email" autocomplete="username" required></label>
      <label>비밀번호<input id="login-password" type="password" autocomplete="current-password" required></label>
      <button type="submit" class="btn primary">로그인</button>
      <p id="login-error" class="error" hidden></p>
    </form>
  </section>

  <!-- 메인 -->
  <section id="app-view" class="app" hidden>
    <header class="topbar">
      <div class="topbar-left">
        <strong class="brand">CS 콘솔</strong>
        <span class="vsep"></span>
        <nav class="tabs"><a href="#" class="tab active">접수 현황</a></nav>
      </div>
      <div class="topbar-right">
        <span id="user-email" class="mono muted"></span>
        <button id="logout-btn" class="btn small" type="button">로그아웃</button>
      </div>
    </header>

    <div class="toolbar">
      <div class="toolbar-left">
        <button id="prev-month" class="btn icon" type="button" aria-label="이전 달">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <span id="month-label" class="month-label mono"></span>
        <button id="next-month" class="btn icon" type="button" aria-label="다음 달">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </button>
        <button id="this-month" class="btn" type="button">이번 달</button>
        <span class="vsep"></span>
        <label class="search">
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input id="search-input" type="search" placeholder="고객사 · 현상 · 티켓">
        </label>
      </div>
      <div class="toolbar-right">
        <button id="export-btn" class="btn" type="button">CSV 내보내기</button>
        <button id="new-btn" class="btn primary" type="button">+ 새 CS</button>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><span class="kpi-label">접수</span><span id="kpi-total" class="kpi-value mono">0</span></div>
      <div class="kpi"><span class="kpi-label">대기 · 미해결</span><span id="kpi-open" class="kpi-value mono c-open">0</span></div>
      <div class="kpi"><span class="kpi-label">완료</span><span id="kpi-done" class="kpi-value mono c-done">0</span></div>
      <div class="kpi"><span class="kpi-label">연결 티켓</span><span id="kpi-ticketed" class="kpi-value mono">0</span></div>
    </div>

    <div class="body">
      <!-- 요약 · 필터 -->
      <aside class="side" aria-label="월간 요약">
        <div class="panel-head">
          <div class="panel-head-text">
            <strong>월간 요약</strong>
            <span id="summary-meta" class="mono muted small"></span>
          </div>
          <div class="panel-head-actions">
            <button id="summary-copy-btn" class="btn xs" type="button" hidden>복사</button>
            <button id="summary-gen-btn" class="btn xs" type="button">생성</button>
          </div>
        </div>
        <p id="summary-error" class="error side-pad" hidden></p>

        <div class="side-title">
          <h3>주요 이슈 · 눌러서 필터</h3>
          <button id="filter-clear" class="link-btn" type="button" hidden>필터 해제 ×</button>
        </div>
        <div id="issue-list" class="issue-list"></div>

        <div class="side-title"><h3>기기별 · 눌러서 필터</h3></div>
        <div id="device-list" class="device-list"></div>

        <div class="side-title bordered"><h3>특이사항</h3></div>
        <div id="notes-list" class="notes-list"></div>
      </aside>

      <!-- 목록 -->
      <section class="list" aria-label="CS 목록">
        <div class="panel-head">
          <strong id="list-title"></strong>
          <span class="muted small">행을 누르면 상세가 열립니다</span>
        </div>
        <p id="list-error" class="error side-pad" hidden></p>
        <div class="list-head"><span>접수</span><span>고객사</span><span>현상</span><span>상태</span></div>
        <div id="cs-list" class="cs-list"></div>
        <p id="empty" class="empty" hidden></p>
      </section>

      <!-- 상세 -->
      <aside id="detail" class="detail" aria-label="CS 상세" hidden>
        <div class="panel-head">
          <span id="detail-when" class="mono muted small"></span>
          <button id="detail-close" class="btn icon xs" type="button" aria-label="상세 닫기">
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <div class="detail-body">
          <div>
            <span id="detail-status" class="status-pill"></span>
            <h2 id="detail-title" class="detail-title"></h2>
          </div>
          <dl class="meta">
            <dt>고객사</dt><dd id="detail-customer" class="mono bold"></dd>
            <dt>기기</dt><dd id="detail-device"></dd>
            <dt>접수</dt><dd id="detail-received" class="mono"></dd>
            <dt>접수자</dt><dd id="detail-reporter"></dd>
            <dt>티켓</dt><dd id="detail-tickets" class="ticket-chips"></dd>
          </dl>
          <div class="detail-section">
            <h3>현상 설명</h3>
            <p id="detail-desc" class="detail-desc"></p>
          </div>
          <div class="detail-section">
            <h3>처리 이력</h3>
            <ol id="detail-history" class="history"></ol>
          </div>
          <p id="detail-error" class="error" hidden></p>
          <div id="quick-box"></div>
          <div class="detail-actions">
            <button id="status-btn" class="btn" type="button">상태 변경</button>
            <button id="history-btn" class="btn" type="button">이력 추가</button>
            <button id="edit-btn" class="btn" type="button">수정</button>
          </div>
        </div>
      </aside>
    </div>
  </section>

  <!-- 등록/수정 모달 -->
  <dialog id="cs-dialog">
    <form id="cs-form" class="cs-form" novalidate>
      <header class="dialog-head">
        <h2 id="dialog-title">새 CS</h2>
        <button type="button" class="btn icon xs" data-close aria-label="닫기">✕</button>
      </header>

      <details id="paste-box" class="paste-box">
        <summary>슬랙 메시지 붙여넣기로 자동 입력</summary>
        <textarea id="paste-text" rows="5" maxlength="8000" placeholder="슬랙 메시지를 그대로 붙여넣으세요 (작성자·시각 줄 포함)"></textarea>
        <div class="paste-actions">
          <button type="button" id="paste-btn" class="btn small">분석해서 채우기</button>
          <span id="paste-status" class="muted small"></span>
        </div>
        <p id="paste-notes" class="muted small" hidden></p>
      </details>

      <div class="grid">
        <label>접수자 *<input name="reporter" maxlength="100" required></label>
        <label>고객사, 유저 *<input name="customer" maxlength="200" required></label>
        <label>날짜 *<input name="received_at" type="datetime-local" required></label>
        <label>기기 *<select name="device" required></select></label>
        <label>버전<input name="version" maxlength="100"></label>
        <label>상태<select name="status"></select></label>
        <label>상태 메모<input name="status_note" maxlength="50" placeholder="예) 로그 대기"></label>
      </div>

      <label>제목 *<input name="title" maxlength="200" required placeholder="현상을 한 줄로"></label>
      <label>현상설명<textarea name="description" rows="3" maxlength="10000"></textarea></label>
      <label>특이사항<textarea name="notes" rows="2" maxlength="10000"></textarea></label>

      <fieldset class="list-field">
        <legend>처리 타임라인</legend>
        <div class="list-items" data-list="timeline"></div>
        <button type="button" class="btn small" data-add="timeline">+ 항목 추가</button>
      </fieldset>

      <fieldset class="list-field">
        <legend>티켓</legend>
        <div class="list-items" data-list="tickets"></div>
        <button type="button" class="btn small" data-add="tickets">+ 티켓 추가</button>
      </fieldset>

      <p id="form-meta" class="muted small"></p>
      <p id="form-error" class="error" hidden></p>

      <footer class="dialog-foot">
        <div class="delete-zone">
          <button type="button" id="delete-btn" class="btn danger" hidden>삭제</button>
          <span id="delete-confirm" hidden>
            정말 삭제할까요?
            <button type="button" id="delete-yes" class="btn danger small">삭제</button>
            <button type="button" id="delete-no" class="btn small">취소</button>
          </span>
        </div>
        <div>
          <button type="button" class="btn" data-close>취소</button>
          <button type="submit" id="save-btn" class="btn primary">저장</button>
        </div>
      </footer>
    </form>
  </dialog>

  <div id="toast" class="toast" hidden></div>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
  <script src="js/config.js"></script>
  <script src="js/lib.js"></script>
  <script src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: `css/style.css` 전면 교체**

```css
:root {
  --text: #111318;
  --text-2: #4B5563;
  --muted: #6B7280;
  --line: #D9DBE0;
  --line-2: #E5E7EB;
  --panel: #F7F7F8;
  --panel-2: #FAFAFB;
  --selected: #F1F3F6;
  --bar: #E5E7EB;
  --link: #1D4ED8;
  --link-hover: #1E3A8A;
  --danger: #B91C1C;
  --c-open: #B45309;
  --c-done: #15803D;
  --c-unknown: #6B7280;
  --sans: 'IBM Plex Sans KR', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  color-scheme: light;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: #FFFFFF; color: var(--text); font: 13px/1.45 var(--sans); }
a { color: var(--link); } a:hover { color: var(--link-hover); }
h1, h2, h3 { margin: 0; }
.mono { font-family: var(--mono); }
.muted { color: var(--muted); }
.small { font-size: 11px; }
.bold { font-weight: 600; }
.error { color: var(--danger); margin: 8px 0; white-space: pre-wrap; font-size: 12px; }
.c-open { color: var(--c-open); } .c-done { color: var(--c-done); }

/* 폼 요소 */
input, select, textarea {
  font: inherit; color: inherit; background: #FFFFFF;
  border: 1px solid var(--line); border-radius: 2px; padding: 6px 9px; width: 100%;
}
textarea { resize: vertical; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--text); outline-offset: -1px; }
label { display: flex; flex-direction: column; gap: 4px; font-weight: 500; font-size: 12px; }

.btn {
  font: inherit; font-size: 12px; font-weight: 500; height: 32px; padding: 0 10px;
  border: 1px solid var(--line); border-radius: 2px; background: #FFFFFF; color: var(--text);
  cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
}
.btn:hover { background: var(--panel); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--text); border-color: var(--text); color: #FFFFFF; font-weight: 600; padding: 0 12px; }
.btn.primary:hover { background: #000; }
.btn.danger { color: var(--danger); border-color: var(--danger); }
.btn.small { height: 28px; }
.btn.xs { height: 26px; padding: 0 8px; font-size: 11px; }
.btn.icon { width: 32px; padding: 0; }
.btn.icon.xs { width: 26px; }
.link-btn { font: inherit; font-size: 11px; font-weight: 500; padding: 2px 6px; border: 0; background: transparent; color: var(--link); cursor: pointer; }

/* 로그인 */
.login { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
.login-card { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 12px; border: 1px solid var(--line); padding: 24px; }
.login-card h1 { font-size: 15px; }

/* 앱 뼈대 */
.app { min-height: 100vh; display: flex; flex-direction: column; }
.topbar {
  height: 44px; padding: 0 24px; background: var(--panel); border-bottom: 1px solid var(--line);
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.topbar-left, .topbar-right { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.topbar-left { gap: 14px; }
.brand { font-size: 13px; font-weight: 700; letter-spacing: .02em; }
.vsep { width: 1px; height: 16px; background: var(--line); }
.tabs { display: flex; gap: 2px; }
.tab { font-size: 12px; font-weight: 500; padding: 4px 10px; color: var(--muted); text-decoration: none; border-bottom: 2px solid transparent; }
.tab.active { color: var(--text); font-weight: 600; border-bottom-color: var(--text); }

.toolbar { padding: 10px 24px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.toolbar .vsep { height: 20px; margin: 0 4px; }
.month-label { font-size: 15px; font-weight: 600; padding: 0 8px; letter-spacing: -.01em; }
.search { position: relative; display: flex; align-items: center; color: var(--muted); }
.search svg { position: absolute; left: 9px; }
.search input { font-size: 12px; height: 32px; width: 220px; padding: 0 10px 0 28px; }

.kpis { border-bottom: 1px solid var(--line); background: var(--line); display: grid; gap: 1px; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); }
.kpi { background: #FFFFFF; padding: 14px 24px; display: flex; flex-direction: column; gap: 4px; }
.kpi-label { font-size: 11px; font-weight: 500; color: var(--muted); letter-spacing: .04em; }
.kpi-value { font-size: 26px; font-weight: 600; line-height: 1; }

/* 3열 본문 */
.body { display: flex; flex-wrap: wrap; align-items: stretch; flex: 1; }
.side { flex: 0 1 300px; min-width: 0; border-right: 1px solid var(--line); display: flex; flex-direction: column; }
.list { flex: 999 1 480px; min-width: 0; display: flex; flex-direction: column; }
.detail { flex: 0 1 400px; min-width: 0; border-left: 1px solid var(--line); background: var(--panel-2); display: flex; flex-direction: column; }

.panel-head { padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.panel-head strong { font-size: 12px; font-weight: 700; }
.panel-head-text { display: flex; flex-direction: column; }
.panel-head-actions { display: flex; gap: 4px; }
.side-pad { padding: 0 20px; }

/* 사이드바 */
.side-title { padding: 14px 20px 6px; display: flex; align-items: baseline; justify-content: space-between; }
.side-title.bordered { border-top: 1px solid var(--line); margin-top: 8px; padding-top: 16px; }
.side-title h3, .detail-section h3 { font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: .04em; }
.side-empty { margin: 0; padding: 6px 20px 10px; font-size: 12px; color: var(--muted); }
.issue-list, .device-list, .notes-list { display: flex; flex-direction: column; }
.issue-btn {
  font: inherit; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; align-items: center;
  width: 100%; text-align: left; padding: 10px 20px; border: 0; border-left: 3px solid transparent;
  background: transparent; color: var(--text); cursor: pointer;
}
.issue-btn:hover { background: var(--panel); }
.issue-btn.active { background: var(--selected); border-left-color: var(--c); }
.issue-btn:disabled { opacity: .45; cursor: default; }
.issue-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.swatch { width: 8px; height: 8px; flex: none; background: var(--c); }
.issue-label { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.issue-btn b { font-family: var(--mono); font-size: 13px; font-weight: 600; }
.issue-detail { grid-column: 1 / -1; font-size: 12px; color: var(--text-2); line-height: 1.4; }
.device-list { padding: 0 12px 8px; }
.device-btn {
  font: inherit; display: grid; grid-template-columns: 110px minmax(0, 1fr) 24px; gap: 10px; align-items: center;
  width: 100%; padding: 7px 8px; border: 0; background: transparent; color: var(--text); cursor: pointer; text-align: left;
}
.device-btn:hover { background: var(--panel); }
.device-btn.active { background: var(--selected); }
.device-btn .lbl { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar { height: 6px; background: var(--bar); display: flex; }
.bar > span { background: var(--text); }
.device-btn b { font-family: var(--mono); font-size: 12px; font-weight: 600; text-align: right; }
.notes-list { padding: 0 20px 20px; gap: 10px; font-size: 12px; color: var(--text-2); line-height: 1.5; }
.notes-list p { margin: 0; }
.notes-list .cust { font-family: var(--mono); font-weight: 600; color: var(--text); margin-right: 4px; }

/* 목록 */
.list-head {
  display: grid; grid-template-columns: 92px 150px minmax(0, 1fr) 120px; gap: 12px; padding: 6px 20px;
  border-bottom: 1px solid var(--line); font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: .04em;
}
.cs-list { display: flex; flex-direction: column; }
.cs-row {
  font: inherit; display: grid; grid-template-columns: 92px 150px minmax(0, 1fr) 120px; gap: 12px; align-items: start;
  width: 100%; text-align: left; padding: 12px 20px; border: 0; border-bottom: 1px solid var(--line-2);
  border-left: 3px solid transparent; background: #FFFFFF; color: var(--text); cursor: pointer;
}
.cs-row:hover { background: var(--panel); }
.cs-row.active { background: var(--selected); border-left-color: var(--text); }
.col-when { display: flex; flex-direction: column; gap: 1px; font-size: 12px; }
.col-when b { font-weight: 600; }
.col-who { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.col-who b { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-who span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-what { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.row-title { font-size: 14px; font-weight: 600; letter-spacing: -.01em; line-height: 1.3; }
.row-desc { font-size: 12px; color: var(--text-2); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-line; }
.ticket-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.chip { font-family: var(--mono); font-size: 11px; font-weight: 500; padding: 1px 6px; border: 1px solid var(--line); color: var(--link); text-decoration: none; }
.col-status { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; font-weight: 500; color: var(--c); }
.dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; flex: none; background: var(--c); }
.empty { text-align: center; color: var(--muted); padding: 40px 20px; font-size: 12px; margin: 0; }

/* 상세 */
.detail-body { padding: 18px 20px; display: flex; flex-direction: column; gap: 18px; }
.status-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--c); margin-bottom: 6px; }
.status-pill::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
.detail-title { font-size: 17px; font-weight: 700; letter-spacing: -.01em; line-height: 1.3; }
.meta { margin: 0; display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 6px 12px; font-size: 12px; }
.meta dt { color: var(--muted); } .meta dd { margin: 0; }
.detail-section { display: flex; flex-direction: column; gap: 6px; }
.detail-desc { margin: 0; font-size: 13px; line-height: 1.6; white-space: pre-line; padding: 10px 12px; background: #FFFFFF; border: 1px solid var(--line); }
.history { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.history li { display: grid; grid-template-columns: 52px 12px minmax(0, 1fr); gap: 8px; padding: 6px 0; font-size: 12px; }
.history li.muted { grid-template-columns: 1fr; }
.hist-dot { display: flex; justify-content: center; padding-top: 5px; }
.hist-dot::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #9CA3AF; }
.detail-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.quick-form { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; background: #FFFFFF; border: 1px solid var(--line); }
.quick-actions { display: flex; gap: 6px; justify-content: flex-end; }

/* 모달 */
dialog { width: min(760px, calc(100vw - 24px)); max-height: calc(100vh - 24px); border: 1px solid var(--line); border-radius: 2px; padding: 0; background: #FFFFFF; color: var(--text); }
dialog::backdrop { background: rgba(17, 19, 24, .4); }
.cs-form { display: flex; flex-direction: column; gap: 14px; padding: 18px 20px; }
.dialog-head, .dialog-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.dialog-head h2 { font-size: 15px; }
.dialog-foot > div { display: flex; gap: 6px; align-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.list-field { border: 1px solid var(--line); padding: 10px 12px; margin: 0; }
.list-field legend { font-weight: 500; padding: 0 4px; font-size: 12px; }
.list-items { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.list-row { display: flex; gap: 6px; }
.delete-zone { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.paste-box { border: 1px dashed var(--line); padding: 8px 12px; background: var(--panel); }
.paste-box > summary { cursor: pointer; font-weight: 500; font-size: 12px; }
.paste-box textarea { margin-top: 8px; }
.paste-actions { display: flex; align-items: center; gap: 10px; margin-top: 6px; }

.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--text); color: #FFFFFF; padding: 8px 16px; border-radius: 2px; z-index: 10; font-size: 12px; }

@media (max-width: 900px) {
  .side, .list, .detail { flex: 1 1 100%; border-left: 0; border-right: 0; border-bottom: 1px solid var(--line); }
  .list-head { display: none; }
  .cs-row { grid-template-columns: 72px minmax(0, 1fr); }
  .col-who { grid-column: 2; }
  .col-what { grid-column: 1 / -1; }
  .col-status { grid-column: 1 / -1; }
}
@media (max-width: 640px) {
  .topbar, .toolbar, .kpi { padding-left: 16px; padding-right: 16px; }
  .search input { width: 100%; }
  .toolbar-left, .toolbar-right, .search { width: 100%; }
}
```

- [ ] **Step 3: 정적 확인**

`js/app.js`는 아직 구버전이라 콘솔에 `Cannot read properties of null` 오류가 나는 것이 정상이다. 레이아웃만 본다.
Run: `cd /Users/donghun/cs-dashboard && python3 -m http.server 8000` 후 브라우저에서 `http://localhost:8000`. 개발자도구 콘솔에서 `document.getElementById('login-view').hidden = true; document.getElementById('app-view').hidden = false;` 실행.
Expected: 헤더·툴바·KPI 4칸·3열(왼쪽 300px, 가운데, 오른쪽은 `hidden`이라 안 보임)이 디자인과 같은 색·폰트로 보인다. 창을 900px 미만으로 줄이면 세로로 쌓인다. 가로 스크롤 없음.

- [ ] **Step 4: 커밋**

```bash
git add index.html css/style.css
git commit -m "$(cat <<'EOF'
화면: 3열 레이아웃·KPI 스트립·상세 패널 마크업, 디자인 토큰으로 스타일 교체

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `app.js` — 상태·조회·KPI·사이드바·목록 렌더

**Files:**
- Modify: `js/app.js`

**Interfaces:**
- Consumes: `window.CSLib` (Task 2), Task 6의 element id.
- Produces: `state.filter`, `state.selected`, `state.quick`, `loadMonth({ selected })`, `renderAll()`, `renderKpi()`, `renderSidebar()`, `renderList()`, `filteredRows()`, `selectRow(id)`, `deviceLine(r)`, `ticketChip(t)`, `ticketNode(t)`. `renderDetail()`는 이 태스크에서 빈 함수로 두고 Task 8이 채운다.

- [ ] **Step 1: 상수·state 수정**

`const LS_REPORTER = 'cs.lastReporter';` 아래에 추가:

```js
  const L = window.CSLib;
```

`state` 객체를 교체:

```js
  const state = {
    month: currentMonthKST(),  // 'YYYY-MM'
    rows: [],
    rowsMonth: null,           // state.rows 가 실제로 속한 월 (export 파일명용)
    loading: false,
    editing: null,             // 수정 중인 원본 row (신규면 null)
    busy: false,               // 저장/삭제/빠른 조작 요청 진행 중
    loadSeq: 0,                // 빠른 월 이동 시 늦게 도착한 응답 무시용
    summary: null,             // 현재 월의 저장된 요약 행 (없으면 null)
    summaryBusy: false,        // 요약 생성 요청 진행 중
    filter: null,              // null | { type: 'issue', value: index } | { type: 'device', value: device }
    selected: null,            // 상세 패널에 열린 row id
    quick: null,               // 상세 패널의 인라인 폼: null | 'status' | 'history'
  };
```

- [ ] **Step 2: `renderAuth` 로그아웃 분기 수정**

```js
    } else {
      state.rows = [];
      state.selected = null;
      state.filter = null;
      $('cs-list').replaceChildren();
    }
```

- [ ] **Step 3: `loadMonth` 교체 (월 칩·통계 제거, 필터·선택 초기화)**

```js
  async function loadMonth(opts = {}) {
    const seq = ++state.loadSeq;
    const month = state.month;
    $('month-label').textContent = month;
    showError($('list-error'), '');
    $('list-title').textContent = '불러오는 중…';
    setLoading(true);

    const { data, error } = await fetchMonth(month);

    if (seq !== state.loadSeq) return;
    setLoading(false);
    if (error) {
      state.rows = [];
      showError($('list-error'), '불러오기 실패: ' + error.message);
    } else {
      state.rows = data;
    }
    state.rowsMonth = month;
    state.filter = null;
    state.quick = null;
    state.selected = opts.selected && state.rows.some((r) => r.id === opts.selected) ? opts.selected : null;
    renderAll();
    loadSummary(seq);
  }

  function renderAll() {
    renderKpi();
    renderSidebar();
    renderList();
    renderDetail();
  }
```

`loadMonthChips` 함수 전체를 삭제한다.

- [ ] **Step 4: `filteredRows`, 목록 렌더 교체**

`filteredRows`, `ticketNode`, `shortTicket`, `renderTable` 를 아래로 교체:

```js
  function filteredRows() {
    const q = $('search-input').value;
    const issues = state.summary ? state.summary.issues || [] : [];
    return L.applyFilter(state.rows, state.filter, issues).filter((r) => L.matchesSearch(r, q));
  }

  function deviceLine(r) { return r.version ? `${r.device} · v${r.version}` : r.device; }

  function shortTicket(t) {
    try { const u = new URL(t); return u.pathname.split('/').filter(Boolean).pop() || u.host; }
    catch { return t; }
  }
  // 목록용(버튼 안이라 링크 불가) / 상세용(링크)
  function ticketChip(t) { return el('span', { class: 'chip', text: shortTicket(t) }); }
  function ticketNode(t) {
    return isSafeUrl(t)
      ? el('a', { class: 'chip', href: t, target: '_blank', rel: 'noopener noreferrer', text: shortTicket(t) })
      : el('span', { class: 'chip', text: t });
  }

  function filterName() {
    const f = state.filter;
    if (!f) return '';
    if (f.type === 'device') return f.value;
    const issue = (state.summary && state.summary.issues || [])[f.value];
    return issue ? issue.label : '';
  }

  function rowNode(r) {
    const p = kstParts(new Date(r.received_at));
    const b = el('button', { type: 'button', class: 'cs-row' + (state.selected === r.id ? ' active' : '') },
      el('span', { class: 'col-when mono' },
        el('b', { text: `${p.month}-${p.day} ${WEEKDAY_KO[p.weekday] || p.weekday}` }),
        el('span', { class: 'muted', text: `${p.hour}:${p.minute}` })),
      el('span', { class: 'col-who' },
        el('b', { class: 'mono', text: r.customer }),
        el('span', { class: 'muted small', text: deviceLine(r) })),
      el('span', { class: 'col-what' },
        el('span', { class: 'row-title', text: r.title || '(제목 없음)' }),
        r.description ? el('span', { class: 'row-desc', text: r.description }) : null,
        r.tickets.length ? el('span', { class: 'ticket-chips' }, r.tickets.map(ticketChip)) : null),
      el('span', { class: 'col-status' }, el('span', { class: 'dot' }), el('span', { text: L.statusLabel(r) })),
    );
    b.style.setProperty('--c', L.statusColor(r));
    b.addEventListener('click', () => selectRow(r.id));
    return b;
  }

  function renderList() {
    const rows = filteredRows();
    $('cs-list').replaceChildren(...rows.map(rowNode));
    const total = state.rows.length;
    const name = filterName();
    $('list-title').textContent = state.filter
      ? `${name} · ${rows.length}건 / 전체 ${total}건`
      : (rows.length === total ? `${state.month} 접수 · ${total}건` : `${state.month} 검색 · ${rows.length}건 / 전체 ${total}건`);
    const err = !!$('list-error').textContent;
    $('empty').hidden = rows.length > 0 || err;
    $('empty').textContent = total > 0 ? '해당 조건의 접수 건이 없습니다.' : '이 달에 접수된 CS가 없습니다.';
  }

  function selectRow(id) {
    state.selected = state.selected === id ? null : id;
    state.quick = null;
    renderList();
    renderDetail();
  }

  function renderDetail() { /* Task 8 */ }
```

- [ ] **Step 5: KPI·사이드바 렌더 추가 (`renderList` 아래)**

```js
  // ───────────── KPI · 사이드바 ─────────────
  function renderKpi() {
    const k = L.kpi(state.rows);
    $('kpi-total').textContent = String(k.total);
    $('kpi-open').textContent = String(k.open);
    $('kpi-done').textContent = String(k.done);
    $('kpi-ticketed').textContent = String(k.ticketed);
  }

  function isActive(type, value) { return !!state.filter && state.filter.type === type && state.filter.value === value; }
  function toggleFilter(type, value) {
    state.filter = isActive(type, value) ? null : { type, value };
    renderSidebar();
    renderList();
  }

  function countBy(rows, key) {
    const m = new Map();
    rows.forEach((r) => { const k = r[key] || '(없음)'; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'ko'));
  }

  function fmtShort(iso) {
    const p = kstParts(new Date(iso));
    return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  function renderSidebar() {
    const s = state.summary;
    // 헤더
    $('summary-meta').textContent = state.summaryBusy ? '생성 중… (최대 1분)' : s ? `생성 ${fmtShort(s.generated_at)} · ${s.ticket_count}건 기준` : '아직 생성된 요약이 없습니다';
    $('summary-copy-btn').hidden = !s;
    $('summary-gen-btn').textContent = s ? '재생성' : '생성';
    $('summary-gen-btn').disabled = state.summaryBusy || state.loading;
    $('filter-clear').hidden = !state.filter;

    // 주요 이슈
    const issueBox = $('issue-list');
    const issues = L.issueCounts(s ? s.issues || [] : [], state.rows);
    if (!s) issueBox.replaceChildren(el('p', { class: 'side-empty', text: '요약을 생성하면 주요 이슈가 표시됩니다.' }));
    else if (!issues.length) issueBox.replaceChildren(el('p', { class: 'side-empty', text: '이전 형식의 요약입니다. 재생성하면 주요 이슈가 표시됩니다.' }));
    else issueBox.replaceChildren(...issues.map((is, i) => {
      const b = el('button', { type: 'button', class: 'issue-btn' + (isActive('issue', i) ? ' active' : '') },
        el('span', { class: 'issue-head' }, el('span', { class: 'swatch' }), el('span', { class: 'issue-label', text: is.label })),
        el('b', { text: String(is.count) }),
        is.detail ? el('span', { class: 'issue-detail', text: is.detail }) : null);
      b.style.setProperty('--c', L.ISSUE_COLORS[i % L.ISSUE_COLORS.length]);
      b.disabled = is.count === 0;
      b.addEventListener('click', () => toggleFilter('issue', i));
      return b;
    }));

    // 기기별
    const devBox = $('device-list');
    const counts = countBy(state.rows, 'device');
    const max = counts.length ? counts[0][1] : 0;
    if (!counts.length) devBox.replaceChildren(el('p', { class: 'side-empty', text: '이 달에 접수된 CS가 없습니다.' }));
    else devBox.replaceChildren(...counts.map(([d, n]) => {
      const fill = el('span');
      fill.style.width = `${Math.round((n / max) * 100)}%`;
      const b = el('button', { type: 'button', class: 'device-btn' + (isActive('device', d) ? ' active' : '') },
        el('span', { class: 'lbl', text: d }),
        el('span', { class: 'bar', 'aria-hidden': 'true' }, fill),
        el('b', { text: String(n) }));
      b.addEventListener('click', () => toggleFilter('device', d));
      return b;
    }));

    // 특이사항
    const notesBox = $('notes-list');
    const notes = s ? s.notes || [] : [];
    notesBox.replaceChildren(...(notes.length
      ? notes.map((n) => el('p', {}, n.customer ? el('span', { class: 'cust', text: n.customer }) : null, n.text))
      : [el('p', { class: 'muted', text: s ? '없음' : '—' })]));
  }
  $('filter-clear').addEventListener('click', () => { state.filter = null; renderSidebar(); renderList(); });
```

- [ ] **Step 6: 툴바 이벤트 정리**

툴바 블록을 교체:

```js
  // ───────────── 툴바 ─────────────
  $('prev-month').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); loadMonth(); });
  $('next-month').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); loadMonth(); });
  $('this-month').addEventListener('click', () => { state.month = currentMonthKST(); loadMonth(); });
  $('search-input').addEventListener('input', renderList);
  $('export-btn').addEventListener('click', exportCsv);
  $('new-btn').addEventListener('click', () => openDialog(null));
```

- [ ] **Step 7: 월 통계·마크다운 렌더 제거, 요약 로드를 사이드바로 연결**

- `// ── 월 통계` 블록의 `statGroup`, `renderStats` 삭제 (`countBy`는 Step 5로 옮겼으므로 여기서도 삭제).
- `renderSummary` 함수 삭제. `loadSummary`를 교체:

```js
  async function loadSummary(seq) {
    state.summary = null;
    renderSidebar();
    const { data, error } = await sb
      .from('cs_monthly_summaries').select('*').eq('month', state.month).maybeSingle();
    if (seq !== state.loadSeq) return;
    if (error) { showError($('summary-error'), '요약 불러오기 실패: ' + error.message); return; }
    showError($('summary-error'), '');
    state.summary = data;
    renderSidebar();
  }
```

- 요약 생성 핸들러를 교체:

```js
  $('summary-gen-btn').addEventListener('click', async () => {
    if (state.summaryBusy) return;
    if (state.loading || !state.rows.length) { toast('요약할 CS가 없습니다.'); return; }
    const month = state.month;
    const seq = state.loadSeq;
    state.summaryBusy = true;
    showError($('summary-error'), '');
    renderSidebar();
    try {
      const { summary } = await callAi({ mode: 'summarize', month });
      state.summaryBusy = false;
      if (seq !== state.loadSeq) return;     // 그 사이 월을 옮겼으면 화면에 반영하지 않음
      state.summary = summary;
      if (state.filter && state.filter.type === 'issue') state.filter = null;   // 이슈 번호가 바뀌므로
      renderSidebar();
      renderList();
      toast('요약을 저장했습니다.');
    } catch (e) {
      state.summaryBusy = false;
      if (seq !== state.loadSeq) return;
      renderSidebar();
      showError($('summary-error'), '요약 생성 실패: ' + e.message);
    }
  });
```

- `inlineNodes`, `markdownNodes` 함수와 그 위의 주석을 삭제. `summary-copy-btn` 핸들러는 그대로 둔다.

- [ ] **Step 8: 초기화 블록에서 `device-filter` 제거**

```js
  // ───────────── 초기화 ─────────────
  const devSelect = form.elements.device;
  devSelect.append(el('option', { value: '', text: '선택하세요' }));
  DEVICES.forEach((d) => devSelect.append(el('option', { value: d, text: d })));
  const statusSelect = form.elements.status;
  Object.entries(L.STATUS).forEach(([k, v]) => statusSelect.append(el('option', { value: k, text: v.label })));
  initAuth();
```

- [ ] **Step 9: 브라우저 확인**

Run: `python3 -m http.server 8000` → 로그인.
Expected:
- KPI 4칸에 숫자. 목록에 행이 디자인대로(날짜·고객사·제목·상태 점). 행 클릭 시 왼쪽 3px 검은 선 + 회색 배경(상세는 아직 안 열림).
- 기기별 막대 클릭 → 목록이 그 기기만, 제목이 `기타 · 2건 / 전체 6건`, "필터 해제 ×" 노출. 다시 클릭하면 해제.
- Task 5에서 재생성한 월이면 주요 이슈 버튼이 색·건수와 함께 보이고 클릭 시 필터됨. 요약 없는 월은 안내 문구.
- 검색어 입력 시 필터와 AND. 월 이동 시 필터 해제.
- 콘솔 오류 없음 (`renderDetail`은 빈 함수라 상세는 안 열린다).

- [ ] **Step 10: 커밋**

```bash
git add js/app.js
git commit -m "$(cat <<'EOF'
app: KPI·사이드바(이슈·기기 필터·특이사항)·새 목록 렌더, 월 칩·통계 패널·마크다운 렌더 제거

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `app.js` — 상세 패널과 빠른 조작(상태 변경·이력 추가)

**Files:**
- Modify: `js/app.js`

**Interfaces:**
- Consumes: `state.selected`, `state.quick`, `state.busy`, `renderAll`, `renderList`, `deviceLine`, `ticketNode`, `CONFLICT_MSG`, `openDialog` (Task 7·기존).
- Produces: `renderDetail()`, `saveQuick(row, patch)`.

- [ ] **Step 1: `renderDetail` 구현 (Task 7의 빈 함수를 교체)**

```js
  // ───────────── 상세 패널 ─────────────
  function selectedRow() { return state.rows.find((x) => x.id === state.selected) || null; }

  function renderDetail() {
    const r = selectedRow();
    $('detail').hidden = !r;
    if (!r) return;
    $('detail-when').textContent = fmtDateTime(r.received_at);
    $('detail-status').textContent = L.statusLabel(r);
    $('detail-status').style.setProperty('--c', L.statusColor(r));
    $('detail-title').textContent = r.title || '(제목 없음)';
    $('detail-customer').textContent = r.customer;
    $('detail-device').textContent = deviceLine(r);
    $('detail-received').textContent = fmtDateTime(r.received_at);
    $('detail-reporter').textContent = r.reporter;
    $('detail-tickets').replaceChildren(...(r.tickets.length ? r.tickets.map(ticketNode) : [el('span', { class: 'muted small', text: '없음' })]));
    $('detail-desc').textContent = r.description || '—';
    $('detail-history').replaceChildren(...(r.timeline.length
      ? r.timeline.map((t) => {
          const { when, text } = L.splitTimeline(t);
          return el('li', {}, el('span', { class: 'mono muted', text: when }), el('span', { class: 'hist-dot' }), el('span', { text }));
        })
      : [el('li', { class: 'muted', text: '이력 없음' })]));
    showError($('detail-error'), '');
    renderQuick(r);
  }

  function renderQuick(r) {
    const box = $('quick-box');
    box.replaceChildren();
    ['status-btn', 'history-btn', 'edit-btn'].forEach((id) => { $(id).disabled = !!state.quick || state.busy; });
    if (state.quick === 'status') {
      const sel = el('select', { 'aria-label': '상태' },
        Object.entries(L.STATUS).map(([k, v]) => el('option', { value: k, text: v.label })));
      sel.value = r.status;
      const note = el('input', { type: 'text', maxlength: '50', placeholder: '상태 메모 (예: 로그 대기)' });
      note.value = r.status_note;
      const submit = () => saveQuick(r, { status: sel.value, status_note: note.value.trim() });
      note.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
      box.append(el('div', { class: 'quick-form' }, sel, note, quickButtons(submit)));
      sel.focus();
    } else if (state.quick === 'history') {
      const input = el('input', { type: 'text', maxlength: '2000', placeholder: '처리 내용' });
      const p = kstParts(new Date());
      input.value = `${p.month}/${p.day} `;
      const submit = () => {
        const t = input.value.trim();
        if (!t || /^\d{1,2}\/\d{1,2}$/.test(t)) { showError($('detail-error'), '처리 내용을 입력하세요.'); input.focus(); return; }
        saveQuick(r, { timeline: [...r.timeline, t] });
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
      box.append(el('div', { class: 'quick-form' }, input, quickButtons(submit)));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function quickButtons(onSave) {
    const save = el('button', { type: 'button', class: 'btn primary small', text: '저장' });
    save.addEventListener('click', onSave);
    const cancel = el('button', { type: 'button', class: 'btn small', text: '취소' });
    cancel.addEventListener('click', () => { state.quick = null; renderDetail(); });
    return el('div', { class: 'quick-actions' }, save, cancel);
  }

  // 상세 패널에서 한 필드만 고치는 저장. 수정 모달과 같은 낙관적 잠금.
  async function saveQuick(r, patch) {
    if (state.busy) return;
    state.busy = true;
    showError($('detail-error'), '');
    const controls = [...$('quick-box').querySelectorAll('button, input, select')];
    controls.forEach((n) => { n.disabled = true; });
    const { data, error } = await sb.from('cs_tickets').update(patch)
      .eq('id', r.id)
      .eq('updated_at', r.updated_at)
      .select();
    state.busy = false;
    if (error || data.length === 0) {
      controls.forEach((n) => { n.disabled = false; });
      showError($('detail-error'), error ? '저장 실패: ' + error.message : CONFLICT_MSG);
      return;
    }
    const idx = state.rows.findIndex((x) => x.id === r.id);
    if (idx >= 0) state.rows[idx] = data[0];
    state.quick = null;
    toast('저장했습니다.');
    renderAll();
  }

  $('status-btn').addEventListener('click', () => { state.quick = 'status'; renderDetail(); });
  $('history-btn').addEventListener('click', () => { state.quick = 'history'; renderDetail(); });
  $('edit-btn').addEventListener('click', () => { const r = selectedRow(); if (r) openDialog(r); });
  $('detail-close').addEventListener('click', () => { state.selected = null; state.quick = null; renderList(); renderDetail(); });
```

`CONFLICT_MSG`는 현재 폼 submit 핸들러 아래에 `const`로 선언되어 있다. `saveQuick`이 호출 시점에만 읽으므로 그대로 두어도 되지만, 읽기 쉽게 `const CONFLICT_MSG = ...` 줄을 `// ───────────── 등록/수정 폼` 주석 바로 아래로 옮긴다.

- [ ] **Step 2: 브라우저 확인**

Expected:
- 행 클릭 → 오른쪽 상세 패널. 상태 pill 색, 제목, dl, 설명(줄바꿈 유지), 처리 이력(`10/12 로그 요청` → 왼쪽 `10-12`, 오른쪽 `로그 요청`). 티켓 URL은 새 탭 링크.
- 「상태 변경」 → select + 메모 입력. `완료` 저장 → 패널·목록·KPI(완료 +1)가 즉시 갱신, 토스트.
- 「이력 추가」 → `10/15 ` 접두가 채워진 입력. 내용 없이 저장하면 빨간 안내. 입력 후 Enter → 이력 맨 아래에 추가.
- 다른 탭에서 같은 CS를 먼저 수정한 뒤 빠른 조작 저장 → `CONFLICT_MSG` 표시, 입력 유지.
- 「수정」 → 기존 모달. ✕ → 패널 닫힘, 목록 하이라이트 해제.

- [ ] **Step 3: 커밋**

```bash
git add js/app.js
git commit -m "$(cat <<'EOF'
app: 상세 패널, 상태 변경·이력 추가 빠른 조작(낙관적 잠금)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `app.js` — 수정 모달·파서·CSV 반영, README 갱신

**Files:**
- Modify: `js/app.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: 폼 필드 `title`, `status`, `status_note` (Task 6), `Parsed.title` (Task 3·5).

- [ ] **Step 1: `openDialog` 필드 채우기**

`if (row) {` 블록에서 `f.version.value = row.version;` 아래에 추가:

```js
      f.title.value = row.title;
      f.status.value = row.status;
      f.status_note.value = row.status_note;
```

`} else {` 블록에서 `f.received_at.value = ...` 아래에 추가:

```js
      f.status.value = 'open';
```

- [ ] **Step 2: `readForm` 교체**

```js
  function readForm() {
    const f = form.elements;
    const payload = {
      reporter: f.reporter.value.trim(),
      customer: f.customer.value.trim(),
      received_at: fromLocalInput(f.received_at.value),
      device: f.device.value,
      version: f.version.value.trim(),
      title: f.title.value.trim(),
      status: f.status.value,
      status_note: f.status_note.value.trim(),
      description: f.description.value.trim(),
      notes: f.notes.value.trim(),
      timeline: listValues('timeline'),
      tickets: listValues('tickets'),
    };
    const missing = [];
    if (!payload.reporter) missing.push('접수자');
    if (!payload.customer) missing.push('고객사, 유저');
    if (!payload.received_at) missing.push('날짜');
    if (!DEVICES.includes(payload.device)) missing.push('기기');
    if (!payload.title) missing.push('제목');
    if (!L.STATUS[payload.status]) missing.push('상태');
    return { payload, missing };
  }
```

- [ ] **Step 3: 저장 후 선택 유지**

submit 핸들러 끝의 두 줄을 교체:

```js
    // 저장한 CS 가 있는 달로 이동하고, 그 CS 를 상세에 연다
    state.month = toLocalInput(res.data[0].received_at).slice(0, 7);
    loadMonth({ selected: res.data[0].id });
```

- [ ] **Step 4: `applyParsed` 에 title**

`if (p.customer) f.customer.value = p.customer;` 아래에 추가:

```js
    f.title.value = p.title || '';
```

그리고 `hints` 계산에 추가:

```js
    if (!p.title) hints.push('제목: 메시지에서 뽑지 못함, 직접 입력 필요');
```

- [ ] **Step 5: CSV 열 추가**

`exportCsv`의 `header`와 행 매핑을 교체:

```js
    const header = ['접수 일시', '접수자', '고객사/유저', '기기', '버전', '제목', '상태', '현상설명', '특이사항', '처리 타임라인', '티켓', '등록 일시', '최종 수정'];
    const lines = [header, ...state.rows.map((r) => [
      fmtDateTime(r.received_at), r.reporter, r.customer, r.device, r.version,
      r.title, L.statusLabel(r),
      r.description, r.notes, r.timeline.join('\n'), r.tickets.join('\n'),
      fmtDateTime(r.created_at), fmtDateTime(r.updated_at),
    ])].map((cols) => cols.map(csvCell).join(','));
```

- [ ] **Step 6: 남은 참조 정리**

Run: `grep -nE "device-filter|month-chips|month-input|stats-body|summary-content|summary-empty|cs-tbody|renderTable|renderStats|markdownNodes|loadMonthChips|getElementById\('summary'\)" js/app.js`
Expected: 출력 없음. 남아 있으면 해당 줄을 삭제하거나 새 id로 바꾼다.

Run: `node --test js/lib.test.js`
Expected: `# fail 0`

- [ ] **Step 7: 브라우저 전체 확인**

- 「+ 새 CS」 → 상태 기본 `처리 중`, 제목 비우고 저장하면 `필수 항목: 제목`.
- 슬랙 메시지 붙여넣기 → 제목까지 채워짐.
- 저장 후 그 CS가 상세에 열린 채 목록 갱신.
- 수정 모달에서 상태 `완료` 저장 → KPI 반영.
- CSV 내보내기 → 제목·상태 열 포함.
- 창 폭 900px 미만: 사이드바 → 목록 → 상세 순으로 세로 배치, 가로 스크롤 없음.
- 요약 없는 과거 월로 이동 → 이슈 영역 안내 문구, 특이사항 `—`, 「생성」 버튼.

- [ ] **Step 8: README 기능 표·AI 절 갱신**

4절 표를 교체:

```markdown
| 요구사항 | 구현 |
|---|---|
| 모든 CS 수정 가능 | 행 클릭 → 상세 패널. 「상태 변경」「이력 추가」는 패널에서 바로, 나머지는 「수정」 모달. 동시 수정 충돌 시 경고(낙관적 잠금) |
| 상태 관리 | `처리 중 / 완료 / 원인 미확인` + 상태 메모(예: 로그 대기). 상단 KPI(접수·대기·완료·연결 티켓)에 집계 |
| 날짜 역순 정렬 | `received_at desc, created_at desc` |
| 월별 보기 | ◀ ▶ 이번 달. 월 경계는 KST 기준 |
| 필터 | 왼쪽 패널의 주요 이슈(요약에서 생성)·기기별 막대를 눌러 목록 필터. 검색어와 AND |
| 월별 export | **CSV 내보내기** → `CS_YYYY-MM.csv` (해당 월 전체, BOM 포함) |
| 리스트 입력 | 처리 타임라인·티켓은 `+ 추가` / `−`로 행 단위 입력. 타임라인 앞의 `10/12` 날짜는 상세에서 분리 표시 |
```

AI 절의 "월 통계 패널"·"월간 요약 패널" 두 항목을 아래로 교체:

```markdown
- **월간 요약(왼쪽 패널)**: 「생성」/「재생성」을 누르면 그 달 CS 전체를 읽어 **주요 이슈**(비슷한 현상 묶음, 눌러서 목록 필터)와 **특이사항**을 만들어 `cs_monthly_summaries` 에 저장합니다. 미해결 목록·통계는 AI 가 아니라 상태 컬럼으로 계산합니다. 「복사」는 보고서용 마크다운(집계 / 주요 이슈 / 미해결 / 특이사항)을 복사합니다.
```

배포 절 끝에 한 줄 추가:

```markdown
2026-10 리디자인 이후 처음 배포할 때는 4번(schema.sql 재실행)을 먼저 하고, 각 월의 요약을 한 번씩 「재생성」해야 주요 이슈 필터가 채워집니다.
```

- [ ] **Step 9: 커밋**

```bash
git add js/app.js README.md
git commit -m "$(cat <<'EOF'
app: 수정 모달에 제목·상태, 파서 제목 반영, CSV 열 추가, README 갱신

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## 완료 후

- `git push`는 사용자가 `! git push origin main` 으로 직접 실행한다.
- Pages 반영 후 실제 데이터로 각 월 「재생성」 한 번씩.
