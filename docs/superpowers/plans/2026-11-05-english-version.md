# CS 콘솔 영문 버전 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 CS 콘솔이 브라우저 언어(또는 상단 버튼)에 따라 한국어/영어로 보이고, 사람이 쓴 CS 내용은 Claude 번역본을 저장해 두었다가 화면 언어에 맞게 보여 준다. 영문 가이드를 만든다.

**Architecture:** 화면 글자는 새 사전 `js/i18n.js` 로 옮기고 `t(key, params)` 로 그린다. 번역은 Edge Function `ai` 의 새 모드(`translate`, `translate_backfill`)가 Claude 로 ko·en 을 함께 만들어 새 테이블 `cs_ticket_translations` 에 저장한다(원문 `cs_tickets` 는 건드리지 않음). 프론트는 원문 해시로 최신 여부를 판단해 번역본을 겹쳐 그린다.

**Tech Stack:** 바닐라 JS (빌드 없음, GitHub Pages), Supabase Postgres + RLS, Supabase Edge Function (Deno, `npm:@anthropic-ai/sdk@0.133.0`), 테스트 `node --test js/*.test.js`, `npx -y deno-bin test supabase/functions/ai/`.

**Spec:** `docs/superpowers/specs/2026-11-04-english-version-design.md`

## Global Constraints

- 언어 판정: 저장값 `localStorage['cs.lang']`(`ko`|`en`) 우선, 없으면 `navigator.languages[0]` 이 `ko` 로 시작하면 `ko`, 아니면 `en`. localStorage 접근은 try/catch.
- 번역 칸: `title`, `description`, `notes`, `status_note`, `timeline[]`. 번역 안 함: `customer`, `reporter`, `assignee`, `ticket_assignee`, `version`, `tickets[]`, `device`/`status`/`severity` 값.
- 원문 `cs_tickets` 행은 번역 때문에 절대 update 하지 않는다 (`updated_at` 낙관적 잠금 보호).
- 한국어 화면의 문구·배치는 지금과 같아야 한다. 한국어 사전 값은 현재 하드코딩된 문자열을 그대로 옮긴다.
- 모델은 기존 `MODEL` (`claude-sonnet-5-5`), Claude 호출은 Edge Function 안에서만.
- asset 버전: `index.html` 의 `app-version`·`?v=` 와 `js/app.js` 의 `APP_VERSION` 을 함께 `20261105` 로.
- Supabase CLI·배포·push 는 사용자가 실행한다 (`! npx supabase db query --linked -f supabase/schema.sql`, `! npx supabase functions deploy ai --no-verify-jwt`, `! git push origin main`).
- 프론트 커밋 메시지는 한국어, 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **번역 테이블이 아직 없는 DB** (배포 순서상 프론트가 먼저 뜨는 경우 포함): 목록·상세가 원문으로 정상 표시되고 오류 줄에 한 번만 알림 → Task 6 의 `loadTranslations` 실패 경로 테스트(목 하네스).
2. **수정 창이 열려 있는 동안 다른 탭이 그 CS 를 번역**: 저장 시 충돌 오류가 나면 안 됨 → Task 3 이 `cs_tickets` 에 쓰지 않음을 SQL 에서 보장(트리거 없음), Task 4 가 `cs_tickets` update 를 호출하지 않음을 코드 리뷰 체크.
3. **원문을 고친 직후**: 오래된 번역이 새 원문인 척 보이지 않고 원문이 보였다가 재번역 후 바뀜 → Task 2 `displayFields` 의 해시 불일치 테스트.
4. **처리 이력 날짜 접두어**(`11/04 14:20 로그 요청`): 번역 후에도 날짜가 그대로 남아 `splitTimeline` 이 같은 날짜를 뽑음 → Task 4 `splitTimelinePrefix`·`mergeTranslation` 테스트.
5. **고객사·티켓 번호가 번역문에 섞여 바뀜**(`com 831` → `company 831`): 프롬프트에 금지 명시 + 정규화에서 원문의 `com \d+`·티켓 ID 가 번역문에서 사라지면 그 칸은 원문 사용 → Task 4 `normalizeTranslation` 테스트.

---

### Task 1: 언어 사전과 판정 (`js/i18n.js`)

**Files:**
- Create: `js/i18n.js`, `js/i18n.test.js`
- Modify: `index.html` (lib.js 앞에 `<script src="js/i18n.js?v=…">`)

**Interfaces:**
- Produces (window.CSI18n, Node `module.exports` — `lib.js` 와 같은 UMD 패턴):
  - `detectLang(stored: string|null, navLangs: string[]) -> 'ko'|'en'`
  - `DICT: { ko: Record<string,string>, en: Record<string,string> }`
  - `t(lang, key, params?) -> string` — `{name}` 자리표시자 치환, 없는 키는 키 자체를 반환
  - `weekday(lang, enShort) -> string` (`'Wed'` → ko `'수'`, en `'Wed'`)
  - `monthCount(lang, ym, sameYear, n) -> string` (밀린 미해결 머리글 조각: ko `'10월 2'`·`'25년 12월 1'`, en `'Oct 2'`·`'Dec 2025 1'`)

- [ ] **Step 1: 실패하는 테스트 작성** — `js/i18n.test.js`
  - `detectLang('en', ['ko-KR']) === 'en'`, `detectLang(null, ['ko-KR','en']) === 'ko'`, `detectLang(null, ['en-US','ko']) === 'en'`, `detectLang(null, []) === 'en'`, `detectLang('xx', ['ko']) === 'ko'`
  - `Object.keys(DICT.ko).sort()` deep-equal `Object.keys(DICT.en).sort()`
  - `t('en','count',{n:3}) === '3'` 같은 자리표시자 치환 1건, 없는 키는 키 반환
  - `monthCount('ko','2026-10',true,2) === '10월 2'`, `monthCount('ko','2025-12',false,1) === '25년 12월 1'`, `monthCount('en','2026-10',true,2) === 'Oct 2'`, `monthCount('en','2025-12',false,1) === 'Dec 2025 1'`
  - **사전 누락 검사**: `index.html` 의 모든 `data-i18n*="키"` 와 `js/app.js` 의 모든 `t('키'` 호출 키가 `DICT.ko`·`DICT.en` 둘 다에 있음 (파일을 읽어 정규식으로 수집)
- [ ] **Step 2: 실행해 실패 확인** — `node --test js/i18n.test.js` → FAIL (모듈 없음)
- [ ] **Step 3: `js/i18n.js` 구현** — 사전은 이 Task 에서는 위 테스트가 쓰는 키만 넣고, Task 5 에서 화면 전체 키를 채운다.
- [ ] **Step 4: 통과 확인** — `node --test js/i18n.test.js` → PASS
- [ ] **Step 5: 커밋** — `i18n: 언어 판정과 사전 뼈대`

### Task 2: 라벨·번역 표시용 순수 함수 (`js/lib.js`)

**Files:**
- Modify: `js/lib.js`, `js/lib.test.js`

**Interfaces:**
- Consumes: `CSI18n.t`
- Produces:
  - `STATUS[key]`, `SEVERITY[key]` 의 `label` 을 `{ ko, en }` 로: `STATUS.open.label = { ko: '처리 중', en: 'In progress' }` (en: open `In progress`, waiting `Waiting`, delayed `Delayed`, deploy `Awaiting deploy`, done `Done`, unknown `Cause unknown`; severity normal `Normal`, major `Major`, critical `Critical`, hotfix `Hotfix`). `RECENCY` 도 같은 형태 (en `This month`, `Last 30 days`, `Last year`, `Older`).
  - `statusLabel(row, lang='ko', fields?)` — `fields` 가 있으면 그 `status_note` 우선 (번역 표시용)
  - `deviceLabel(device, lang) -> string` — en 에서 `웹`→`Web`, `기타`→`Other`, 나머지 그대로
  - `assigneeLine(row, yt, lang='ko')` — en `Owner X · Ticket Y` / `Unassigned`
  - `TR_FIELDS = ['title','description','notes','status_note','timeline']`
  - `sourceText(row) -> string` = `JSON.stringify([row.title||'', row.description||'', row.notes||'', row.status_note||'', row.timeline||[]])`
  - `async sourceHash(row) -> string` — `crypto.subtle.digest('SHA-256', utf8(sourceText(row)))` 의 소문자 hex
  - `hasHangul(row) -> boolean` — `sourceText` 에 `[가-힣ㄱ-ㆎ]` 가 있으면 true
  - `needsTranslation(row, hash, trByLang, lang) -> boolean` — 번역 칸이 모두 비면 false; `lang==='ko' && hasHangul(row)` 면 false; 그 외 `!trByLang?.[lang] || trByLang[lang].source_hash !== hash`
  - `displayFields(row, hash, trByLang, lang) -> { title, description, notes, status_note, timeline, translated: boolean }` — 최신 번역(`source_hash === hash`)이 있으면 그 값, 없거나 오래됐으면 원문, `translated` 는 번역본을 썼고 원문과 하나라도 다를 때 true
  - `matchesSearch(row, q, yt, extra=[])` — `extra`(현재 언어 번역 칸들)도 검색, 심각도·상태 라벨은 ko·en 둘 다 검색

- [ ] **Step 1: 실패하는 테스트 작성** — `js/lib.test.js` 에 추가
  - `statusLabel(row({status:'deploy'}),'en') === 'Awaiting deploy'`, `statusLabel(row({status_note:'로그 대기'}),'en',{status_note:'Waiting for logs'}) === 'Waiting for logs'`, 기존 ko 테스트는 그대로 통과
  - `deviceLabel('웹','en') === 'Web'`, `deviceLabel('기타','en') === 'Other'`, `deviceLabel('Android','en') === 'Android'`, `deviceLabel('웹','ko') === '웹'`
  - `sourceHash(row({title:'A',timeline:['11/04 접수']}))` 가 고정 hex 와 같음 — 구현 후 한 번 계산해 이 테스트와 Task 4 Deno 테스트에 **같은 리터럴**로 넣는다
  - `hasHangul(row({title:'Sync stops'})) === false`, `hasHangul(row({title:'x',timeline:['접수']})) === true`
  - `needsTranslation(korRow, h, {}, 'ko') === false`, `needsTranslation(korRow, h, {}, 'en') === true`, `needsTranslation(korRow, h, {en:{source_hash:h}}, 'en') === false`, `needsTranslation(korRow, h, {en:{source_hash:'old'}}, 'en') === true`, 번역 칸이 모두 빈 행은 false
  - `displayFields(row, h, {en:{source_hash:'old', fields:{title:'X'}}}, 'en').title === row.title` 이고 `translated === false` (Review Focus 3)
  - `matchesSearch(row({title:'로그인'}), 'login', null, ['Login fails']) === true`, `matchesSearch(row({severity:'hotfix'}), 'hotfix') === true`
- [ ] **Step 2: 실패 확인** — `node --test js/lib.test.js` → FAIL
- [ ] **Step 3: 구현** — `js/lib.js`. `applyFilter`·`kpi` 등 키 기반 함수는 그대로.
- [ ] **Step 4: 통과 확인** — `node --test js/*.test.js` → PASS
- [ ] **Step 5: 커밋** — `lib: 언어별 라벨, 번역 해시·표시 함수`

### Task 3: DB 스키마

**Files:**
- Modify: `supabase/schema.sql` (끝에 `-- 7. CS 번역` 구역)

**Interfaces:**
- Produces: 테이블 `public.cs_ticket_translations(ticket_id uuid references cs_tickets(id) on delete cascade, lang text check in ('ko','en'), fields jsonb not null, source_hash text not null, translated_at timestamptz not null default now(), primary key (ticket_id, lang))`, RLS authenticated select/insert/update/delete (정책 이름 `tr_select` … `tr_delete`, 기존 패턴과 동일, anon revoke). `cs_monthly_summaries` 에 `content_en text`(null 허용, `char_length <= 20000`), `issues_en jsonb`, `notes_en jsonb` (null 허용 = 영어판 없음).
- 이 테이블에는 트리거를 달지 않는다 (Review Focus 2).

- [ ] **Step 1: SQL 작성** — idempotent (`create table if not exists`, `add column if not exists`, `drop policy if exists`)
- [ ] **Step 2: 문법 확인** — scratchpad 에서 `npm i libpg-query@16` 후 `node -e "require('libpg-query').parse(require('fs').readFileSync('supabase/schema.sql','utf8')).then(()=>console.log('ok'))"` → `ok`
- [ ] **Step 3: 커밋** — `스키마: CS 번역 테이블, 월간 요약 영어 칸`

### Task 4: Edge Function — 번역 모드

**Files:**
- Modify: `supabase/functions/ai/lib.ts`, `supabase/functions/ai/prompts.ts`, `supabase/functions/ai/index.ts`, `supabase/functions/ai/lib_test.ts`

**Interfaces:**
- Consumes: Task 3 테이블
- Produces:
  - 요청: `{ mode:'translate', ids: string[] (1~20), lang:'ko'|'en' }` → 응답 `{ translations: { [ticket_id]: { ko: TrRow, en: TrRow } }, skipped: string[] }` (`TrRow = { fields, source_hash }`)
  - 요청: `{ mode:'translate_backfill', dry?: boolean, lang }` → `{ translated: number, remaining: number }` (dry 면 `translated: 0`, 남은 건수만). 한 호출에 최대 20건 처리.
  - 모든 모드의 요청에 `lang`(없으면 `'ko'`) — 오류 문구 언어 (Task 5 에서 사용)
  - lib.ts: `sourceText(row)`, `sourceHash(row)` — Task 2 와 같은 규칙, `splitTimelinePrefix(entry) -> { prefix, text }` (`lib.js` 의 `TL_RE` 와 같은 정규식, `prefix` 는 매치된 원문 그대로 공백 포함), `translateInput(rows) -> string` (번호 매긴 목록, 처리 이력은 prefix 뗀 text 만), `normalizeTranslation(raw, rows) -> Map<id, { ko: fields, en: fields }>`, `MAX_TRANSLATE_ROWS_PER_CALL = 10`
  - prompts.ts: `TRANSLATE_SCHEMA` (`{ items: [{ index:int, ko:{title,description,notes,status_note,timeline:string[]}, en:{…} }] }`), `TRANSLATE_SYSTEM` — 한국어↔영어, 이미 그 언어인 칸은 그대로, **고객사(`com 831`)·티켓 ID·사람 이름·제품명(CLDAstream, PC client)·버전·URL 은 그대로**, 짧은 업무체, 빈 칸은 빈 칸, timeline 개수·순서 유지

- [ ] **Step 1: 실패하는 테스트 작성** — `lib_test.ts`
  - `validateRequest({mode:'translate', ids:['a'], lang:'en'})` 통과, `ids` 0개·21개·문자열 아님은 `BadRequest`; `translate_backfill` 통과
  - `sourceHash` 가 Task 2 와 같은 리터럴 hex
  - `splitTimelinePrefix('11/04 14:20 로그 요청') → { prefix:'11/04 14:20 ', text:'로그 요청' }`, `splitTimelinePrefix('메모') → { prefix:'', text:'메모' }`
  - `normalizeTranslation`: 정상 응답에서 timeline 에 prefix 가 다시 붙음(`'11/04 14:20 Requested logs'`) (Review Focus 4); 모델이 timeline 개수를 틀리면 그 언어 timeline 은 원문; 원문에 있던 `com 831`·`NRF-5031` 이 번역문 칸에서 사라지면 그 칸은 원문 (Review Focus 5); 없는 index 는 무시
- [ ] **Step 2: 실패 확인** — `npx -y deno-bin test supabase/functions/ai/` → FAIL
- [ ] **Step 3: lib.ts·prompts.ts 구현**
- [ ] **Step 4: index.ts 에 두 모드 추가** — `cs_tickets` 에서 `id,title,description,notes,status_note,timeline` 읽기(요청자 JWT), `cs_ticket_translations` 에서 기존 `source_hash` 읽어 최신이면 `skipped`, 나머지를 10건씩 Claude 호출(`max_tokens: 16000`, `effort:'low'`, json_schema), `cs_ticket_translations` upsert(ko·en 두 행). backfill 은 전체 CS 의 id·번역칸과 번역 행을 읽어 함수 안에서 해시 비교, 오래된 순 20건만 처리. `cs_tickets` 에는 update 하지 않는다.
- [ ] **Step 5: 통과 확인** — `npx -y deno-bin test supabase/functions/ai/` PASS, `npx -y deno-bin check supabase/functions/ai/index.ts` 오류 없음
- [ ] **Step 6: 커밋** — `ai: CS 번역 모드(translate, translate_backfill)`

### Task 5: Edge Function — 월간 요약 두 언어, 붙여넣기·오류 문구

**Files:**
- Modify: `supabase/functions/ai/lib.ts`, `prompts.ts`, `index.ts`, `lib_test.ts`

**Interfaces:**
- Consumes: Task 4 `cs_ticket_translations`
- Produces:
  - `SUMMARY_SCHEMA` 의 issue 에 `label_en`, `detail_en`, note 에 `text_en` 추가 (시스템 프롬프트에 "같은 내용을 영어로도")
  - `normalizeSummary(raw) -> { issues, notes, issuesEn, notesEn }`
  - `buildSummaryMarkdown(month, rows, issues, notes, lang='ko', titles?: Map<id,string>)` — en: `## CS summary · Nov 2026`, `**N total**`, `### Key issues` / `### Open` / `### Notes`, `- None`, 상태·기기 영어 라벨, 미해결 줄 제목은 `titles`(en 번역) 우선
  - summarize 가 `content_en`, `issues_en`, `notes_en` 함께 upsert
  - `PARSE_SYSTEM`: reporter 는 "한글 이름 또는 영문 이름", title·description·timeline 은 메시지 언어 그대로, `confidence_notes` 는 요청 `lang` 언어로 (사용자 메시지에 `응답 언어: en` 한 줄)
  - `MSG: Record<key, {ko,en}>` 와 `msg(lang, key, params)` — 지금 index.ts·lib.ts 의 사용자에게 보이는 오류 문구 전부를 이 표로
- [ ] **Step 1: 실패하는 테스트 작성** — `buildSummaryMarkdown(..., 'en', titles)` 이 영어 머리글과 번역 제목을 씀, 기존 ko 결과는 기존 테스트 그대로 통과; `normalizeSummary` 가 `_en` 칸 없으면 ko 값으로 채움; `msg('en','noText')` 영어
- [ ] **Step 2: 실패 확인** — deno test FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — deno test PASS, deno check OK
- [ ] **Step 5: 커밋** — `ai: 월간 요약 영어판, 붙여넣기 언어, 오류 문구 두 언어`

### Task 6: 화면 영어화 · 언어 버튼 · 번역 표시 (프론트)

**Files:**
- Modify: `index.html`, `js/app.js`, `js/i18n.js` (화면 전체 키), `css/style.css`

**Interfaces:**
- Consumes: Task 1 (`CSI18n`), Task 2 (lib), Task 4·5 (요청 형식)
- Produces (app.js 내부):
  - `state.lang`, `setLang(lang)` — localStorage `cs.lang` 저장, `document.documentElement.lang`, `applyStaticText()`, `renderAll()` (+ 열려 있는 모달·로그인 화면 글자)
  - `applyStaticText()` — `[data-i18n]` textContent, `[data-i18n-placeholder]`, `[data-i18n-aria]`, `[data-i18n-title]`
  - `state.tr = { [id]: { ko?: TrRow, en?: TrRow } }`, `state.hash = { [id]: string }`
  - `async loadTranslations(rows)` — 해시 계산, `cs_ticket_translations` 를 `in('ticket_id', ids)` 로 300건씩 조회, `needsTranslation` 인 것을 20건씩 `callFn('ai', {mode:'translate', ids, lang})`, 도착하면 `renderList()`·`renderDetail()`. 실패는 `tickets-error` 와 같은 줄 방식의 새 `tr-error` 에 한 번 (Review Focus 1)
  - 호출 지점: `loadMonth` 끝, `ensureHistory` 끝, 저장 성공 후(등록·수정·`saveQuick`; `saveSeverity` 는 제외)
  - 상세: 번역본을 쓰면 제목 아래 `⇄ 번역됨 · 원문 보기` / `⇄ Translated from Korean · Show original` (원문 언어 표기는 `hasHangul` 로), 누르면 `state.showOriginal` 토글 (상세 닫으면 초기화). 수정 모달은 항상 원문.
  - 상단 `#lang-switch` (로그아웃 왼쪽, 로그인 카드 아래에도): 버튼 `한국어` / `English`, 현재 언어 `.on`
  - 기존 기록 번역: 사이드바 맨 아래 `#backfill-box` — `translate_backfill {dry:true}` 결과 `remaining > 0` 일 때만 보임, 누르면 `remaining` 이 0 이 될 때까지 반복 호출하며 `N건 남음` 표시
  - CSV: 머리글·상태·심각도·기기는 화면 언어, 번역 칸은 `displayFields` 값
  - 영어 라벨 너비 (스파이크에서 확인): `html[lang="en"]` 에서 목록 CS 상태 칸 84px → 112px, 상세 `.meta` 첫 칸 64px → 88px. 한국어 화면 CSS 는 그대로.
- 모든 하드코딩 한국어 문자열(현재 `index.html`·`app.js`)을 키로 옮긴다. ko 값은 지금 문자열 그대로 (Global Constraints).

- [ ] **Step 1: 사전 누락 테스트가 실패하는지 확인** — `index.html`·`app.js` 를 키로 바꾸는 동안 Task 1 의 누락 검사 테스트가 빠진 키를 알려 준다: `node --test js/i18n.test.js`
- [ ] **Step 2: `index.html` 에 `data-i18n*` 부여, `app.js` 문자열을 `t()` 로, 사전 채움**
- [ ] **Step 3: 테스트 통과** — `node --test js/*.test.js` → PASS, `node --check js/app.js`
- [ ] **Step 4: 번역 표시·언어 버튼·기존 기록 번역·CSV·CSS 구현**
- [ ] **Step 5: 목 하네스로 확인** — scratchpad 목 하네스(스파이크 `spike-en/harness.js` 를 토대로 `cs_ticket_translations` 와 `functions.invoke('ai', translate…)` 목 추가)에서: 한국어 화면이 직전 커밋 화면과 같은지(스크린샷 비교), English 버튼으로 전환, 번역됨·원문 보기, 번역 테이블 조회가 오류를 돌려줄 때 원문 정상 표시 + 오류 한 줄 (Review Focus 1), 수정 모달은 원문
- [ ] **Step 6: 버전 올림** (`20261105`) · README 의 기능 표에 「언어」「번역」 줄 추가
- [ ] **Step 7: 커밋** — `영문 버전: 화면 영어화, 언어 버튼, CS 번역 표시, 기존 기록 번역`

### Task 7: 영문 가이드

**Files:**
- Create: `docs/CS-Console-Guide.html` (이미지 포함 단일 파일)
- Scratchpad: `guide-en/` (하네스·빌드 스크립트, 커밋하지 않음)

**Interfaces:**
- Consumes: Task 6 화면, 한국어 가이드 빌드 방식(`scratchpad/guide/build.py`·`template.html` — 노란 번호 테두리, 범례)

- [ ] **Step 1: 영어 예시 데이터 하네스** — 고객사·사람 이름·제목·이력 모두 영어 + 한국어 원문 CS 2건(번역 행 포함). 브라우저 언어 대신 `localStorage['cs.lang']='en'`
- [ ] **Step 2: 캡처** — 한국어 가이드와 같은 24장면 + `Translated from Korean · Show original` 두 장면(번역/원문) + 언어 버튼 한 장면. 캡처 요령: CSS zoom 으로 키우고 `zoom` 액션 `save_to_disk` 는 scale 없이, 캡처와 JS 는 따로 호출, 커서는 영역 밖으로
- [ ] **Step 3: 영어 본문으로 빌드** — 짧게, 화면 위주. 모든 화면은 실제 콘솔 캡처(컴포넌트 다시 그리지 않음)
- [ ] **Step 4: 로컬 미리보기로 번호 위치 확인 1회** 후 Artifact 게시(새 URL), 단일 파일 `docs/CS-Console-Guide.html` 저장
- [ ] **Step 5: 커밋** — `영문 사용 가이드`

## 배포 (사용자 실행, 순서대로)

1. `! npx supabase db query --linked -f supabase/schema.sql`
2. `! npx supabase functions deploy ai --no-verify-jwt`
3. `! git push origin main`
4. 사이트 사이드바 맨 아래 「기존 기록 번역」 실행
