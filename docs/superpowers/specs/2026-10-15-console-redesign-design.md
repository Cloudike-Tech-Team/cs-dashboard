# CS 콘솔 리디자인 설계 — 상태·제목 컬럼, 구조화 월간 요약, 3열 레이아웃

작성일: 2026-10-15
디자인 원본: `docs/design/Main.dc.html` (현재 루트의 `Main.dc.html`을 이동)

## 목표

디자인 시안 `Main.dc.html`대로 화면을 재편한다.

1. **상태 관리**: CS마다 상태(처리 중·완료·원인 미확인 + 짧은 라벨)를 두고, 목록·상세·KPI에 표시한다.
2. **제목/설명 분리**: 현상을 한 줄 제목과 본문 설명으로 나눈다.
3. **구조화 월간 요약**: AI 요약을 "주요 이슈(건별 연결, 눌러서 필터)"와 "특이사항" 구조로 저장한다. 마크다운 보고서는 그 결과에서 결정적으로 생성한다.
4. **3열 레이아웃**: 왼쪽 요약·필터 / 가운데 목록 / 오른쪽 상세 패널. 상세에서 상태 변경·이력 추가를 바로 한다.

## 결정 사항

| 항목 | 결정 | 이유 |
|---|---|---|
| 상태 모델 | `status` 3값 enum(`open`/`done`/`unknown`) + `status_note` 짧은 라벨 | 색·KPI는 enum으로 확정, "로그 대기" 같은 세부 라벨은 자유 입력 |
| 제목 | `title` 컬럼 추가, 기존 행은 description 첫 줄로 백필 | 목록 가독성. 파서가 함께 채움 |
| 처리 이력 | `timeline text[]` 유지. 표시할 때 접두 날짜를 정규식으로 분리 | 마이그레이션·Edge Function 변경 없음. 입력 방식 그대로 |
| 요약 저장 | `cs_monthly_summaries`에 `issues jsonb`, `notes jsonb` 추가. `content`(마크다운) 유지 | 이슈 필터는 JSON, 복사·보고서는 마크다운 |
| 요약 생성 방식 | Claude 구조화 출력(JSON 스키마). 이슈별 CS 번호를 받아 함수가 UUID로 매핑 | 모델이 UUID를 직접 쓰지 않게. 범위 검증 가능 |
| 미해결 목록 | LLM이 아니라 함수가 `status != done` 행으로 생성 | 상태 컬럼이 진실. 환각 여지 제거 |
| 다크 모드 | 제거(라이트 전용) | 디자인이 라이트 전용. 토큰 한 벌만 유지 |
| 상단 탭 고객사·티켓 | 제외 | 해당 화면 없음 |
| 상세 헤더 ID | 접수 일시 표시 | 디자인의 `c6384`는 가짜 ID |
| 월 칩, 기기 select | 제거 | 디자인에 없음. 기기 필터는 왼쪽 막대로 대체. `cs_monthly_counts` 뷰는 그대로 둠(무해) |

## DB 변경 (`supabase/schema.sql`에 추가, 재실행 안전)

```sql
-- cs_tickets: 제목 · 상태
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

-- cs_monthly_summaries: 구조화 요약
alter table public.cs_monthly_summaries
  add column if not exists issues jsonb not null default '[]'::jsonb,
  add column if not exists notes  jsonb not null default '[]'::jsonb;
```

- `issues`: `[{ "label": string, "detail": string, "ticket_ids": uuid[] }]`
- `notes`: `[{ "customer": string, "text": string }]`
- `content`: 함수가 JSON에서 만든 마크다운. 기존 행은 `issues`가 빈 배열이라 화면에 "재생성 필요" 안내.
- RLS·트리거·뷰·인덱스 변경 없음. `check` 제약은 `add column if not exists`와 함께 선언되므로 두 번째 실행에서도 오류 없음.

## Edge Function `ai` 변경

### parse 모드
- `PARSE_SCHEMA`에 `title` 추가(`string`, 필수). `normalizeParsed`가 `title` 정리. 반환 `Parsed`에 `title: string`.
- 상태는 파서가 정하지 않는다. 새 CS는 항상 `open`.

### summarize 모드
- 입력 줄 형식: `번호. 날짜 | 고객사 | 기기 | 버전 | 제목 | 현상 | 특이사항 | 타임라인 | 티켓 | 상태`
  상태는 `완료` / `원인 미확인` / `처리 중(note)` 로 표기.
- Claude 호출: `output_config.format = json_schema`, 스키마 `SUMMARY_SCHEMA`:
  ```
  { issues: [{ label, detail, ticket_indexes: int[] }],   // 3~5개, 건수 많은 순
    notes:  [{ customer, text }] }                         // 0~5개
  ```
- 함수 처리(`lib.ts` 순수 함수):
  - `mapIssueIndexes(issues, rows)`: `ticket_indexes`(1-based)를 `rows[i-1].id`로 변환. 범위 밖·중복은 버린다. 결과 `ticket_ids`가 빈 이슈는 제거.
  - `unresolvedLines(rows)`: `status != 'done'` 행을 `고객사 — 제목, 현재 상태(status_note 또는 마지막 타임라인), 티켓` 한 줄로.
  - `buildSummaryMarkdown(month, stats, issues, unresolved, notes)`: 기존 템플릿과 같은 섹션 순서(집계 한 줄 / 주요 이슈 / 미해결 / 특이사항). "결제·계정 문의" 섹션은 제거(이슈 묶음으로 흡수).
- upsert: `content`, `issues`(ticket_ids 매핑 후), `notes`, `ticket_count`, `generated_by`, `generated_at`.
- `rows.select`에 `id, title, status, status_note` 추가.

### 프롬프트 변경 (`prompts.ts`)

**PARSE_SYSTEM** — 필드 규칙에 추가:
- `title`: 고객이 겪는 현상을 20자 안팎 한 줄로. 예) "웹에서 35MB 엑셀 열리지 않음", "트래픽 초과 — 반복 다운로드". 오류 메시지 원문보다 현상 요약을 우선.
- `description`에는 제목을 반복하지 않는다.

**SUMMARY_SYSTEM** — 마크다운 템플릿 지시를 제거하고 JSON 출력 지시로 교체:
- 역할: 월간 CS 목록을 읽고 **비슷한 현상끼리 묶어 주요 이슈 3~5개**와 **특이사항**을 JSON으로 낸다.
- `issues[].label`: 이슈 이름 12자 안팎(예: "트래픽 초과", "CLDAstream 로그인·표시"). 화면 버튼 라벨이므로 짧게.
- `issues[].detail`: 어떤 고객사가 어떤 증상인지 한 문장. 고객사 번호(`com6384`)와 티켓 번호를 포함. 60자 안팎.
- `issues[].ticket_indexes`: 그 이슈에 속하는 CS 목록 번호. 한 CS는 한 이슈에만 넣는다. 묶이지 않는 건은 "기타"로 묶지 말고 제외.
- `notes`: 수치·경위·후속 조치처럼 보고서에 꼭 남길 사실(예: 반복 다운로드 용량, 재활성화 완료와 재발 방지 조치). 고객사 번호와 함께. 목록에 없는 내용 금지.
- 미해결 여부·건수·통계는 묻지 않는다(함수가 계산).
- `SUMMARY_TEMPLATE`는 삭제하고, 마크다운 형태는 `lib.ts`의 `buildSummaryMarkdown`이 담당.
- `MODEL`, effort(`parse: low`, `summarize: medium`)는 유지.

### 테스트 (`lib_test.ts`)
- `mapIssueIndexes`: 범위 밖·중복·빈 이슈 제거.
- `unresolvedLines`: done 제외, status_note 우선, 없으면 마지막 타임라인.
- `buildSummaryMarkdown`: 섹션 순서·"없음" 처리.
- `buildSummaryInput`: 새 열(제목·상태) 포함.
- `normalizeParsed`: `title` 정리.

## 프론트엔드

### 레이아웃 (`index.html`)
```
header   CS 콘솔 | 접수 현황 ·········· 이메일 · 로그아웃
toolbar  ◀ 2026-10 ▶ 이번 달 | 검색 ·········· CSV 내보내기 · + 새 CS
kpi      접수 | 대기·미해결 | 완료 | 연결 티켓
body     [요약·필터 300px] [목록 flex] [상세 400px, 선택 시만]
```
- 월 칩, 기기 select, `details` 패널(월 통계·월간 요약), 테이블 제거.
- 왼쪽: 요약 헤더(생성 시각, 복사·재생성), "주요 이슈 · 눌러서 필터", "기기별 · 눌러서 필터", "특이사항".
- 목록: 헤더 행(접수·고객사·현상·상태) + 행 버튼. 행: 일자·시각 / 고객사·기기·버전 / 제목·설명(2줄)·티켓 칩 / 상태 점·라벨.
- 상세: 접수 일시 헤더·닫기, 상태·제목, dl(고객사·기기·접수·접수자·티켓), 현상 설명, 처리 이력(날짜·점·내용), 버튼 `상태 변경 / 이력 추가 / 수정`.
- 수정 모달에 `제목 *`, `상태`(select 3값), `상태 메모`(50자) 추가. 붙여넣기 자동 입력이 제목도 채움.
- 900px 이하: 세 열이 세로로 쌓임. 상세는 목록 아래.

### 스타일 (`css/style.css`) — 전면 교체
- 폰트: IBM Plex Sans KR(본문) / IBM Plex Mono(날짜·고객사·숫자). Google Fonts 링크를 `index.html`에 추가.
- 토큰: 텍스트 `#111318`, 보조 `#6B7280`, 선 `#D9DBE0`, 패널 배경 `#F7F7F8`, 선택 `#F1F3F6`, 링크 `#1D4ED8`, 상태색 open `#B45309` / done `#15803D` / unknown `#6B7280`.
- 라운드 2px, 버튼 32px(툴바)·26px(패널), KPI 숫자 26px 모노.
- 기존 다크 모드 블록 제거.

### 로직 (`js/app.js`)
- `state` 추가: `filter: null | {type:'issue'|'device', value}`, `selected: null | id`.
- `STATUS = { open:{label:'처리 중', color}, done:{label:'완료', color}, unknown:{label:'원인 미확인', color} }`. 표시 라벨 = `status_note || STATUS[status].label`.
- `filteredRows()`: 검색어 AND 필터. issue 필터는 `summary.issues[i].ticket_ids`에 포함된 행, device 필터는 `device` 일치.
- `renderAll()` = KPI + 왼쪽 패널 + 목록 + 상세. `loadMonth` 후 호출. 월 이동 시 `filter`·`selected` 초기화. 요약 로드 후 왼쪽 패널만 다시 그림.
- KPI: 월 전체 행 기준. 접수 = 행 수, 대기·미해결 = `status != done`, 완료 = `done`, 연결 티켓 = `tickets.length > 0`인 행 수.
- 주요 이슈 버튼: 건수 = `ticket_ids ∩ 현재 월 행 id`. 색은 고정 팔레트 `['#B45309','#1D4ED8','#0F766E','#6B7280','#7C3AED']` 순서. `issues`가 비면 "요약을 생성하면 주요 이슈가 표시됩니다".
- 기기별 막대: 현재 월 행 기준, 건수 0인 기기는 숨김. 막대 폭 = 건수/최대.
- 타임라인 표시: `^(\d{4}-)?(\d{1,2})[\/.-](\d{1,2})(\s+\d{1,2}:\d{2})?\s*` 매칭 시 `MM-DD`를 "언제" 열에, 나머지를 내용에. 매칭 없으면 "언제" 비움.
- 상세 패널 빠른 조작(둘 다 낙관적 잠금 `eq('updated_at')` 사용, 충돌 시 기존 `CONFLICT_MSG`):
  - 상태 변경: 버튼 → 인라인 폼(select 3값 + note 입력 + 저장/취소). `update({status, status_note})`.
  - 이력 추가: 버튼 → 인라인 입력(기본값 `MM/DD ` 오늘 날짜 접두). `update({timeline: [...row.timeline, text]})`.
  - 성공 시 `state.rows`의 해당 행을 응답으로 교체하고 `renderAll()`. 월 재조회 없음.
- 수정 모달 `readForm`: `title` 필수, `status`, `status_note` 포함. `applyParsed`가 `title` 채움.
- CSV 헤더에 `제목`, `상태` 열 추가(상태는 표시 라벨).
- 월 라벨: `<input type="month">` 대신 모노 텍스트. 월 이동은 ◀ ▶ 이번 달.
- 복사 버튼: `summary.content` 복사(기존 동작).
- 마크다운 렌더러(`markdownNodes`)는 제거한다. 요약 패널이 구조화 데이터를 직접 그린다.

## 에러 처리
- 상세 패널 빠른 조작 실패: 패널 안에 빨간 문구, 입력 유지.
- 요약 `issues`의 `ticket_ids`가 현재 월 행에 없으면(삭제됨) 건수에서 제외. 모두 없으면 버튼 비활성.
- `issues`가 없는 기존 요약: 특이사항·마크다운 복사는 동작, 이슈 영역에 "재생성 필요".

## 테스트
- Edge Function: `npx deno-bin test --allow-net=jsr.io`, `npx deno-bin check index.ts`.
- 프론트: 로컬 서버에서 수동 확인 — 상태 변경·이력 추가 충돌 메시지, 이슈 필터 토글, 기기 필터 토글, 검색 AND 결합, 월 이동 시 필터 초기화, 900px 이하 레이아웃, CSV 새 열.

## 배포 순서 (README 갱신)
1. SQL Editor에서 `schema.sql` 재실행(컬럼 추가·백필).
2. `npx supabase functions deploy ai --no-verify-jwt`.
3. `git push`는 사용자가 직접(auto-mode에서 차단됨).
4. 각 월의 요약 「재생성」으로 `issues`·`notes` 채움.
