# CS 대시보드 AI 기능 설계 — 슬랙 메시지 자동 입력 · 월별 요약

작성일: 2026-10-14

## 목표

1. **붙여넣기 자동 입력**: 슬랙에 올라온 CS 메시지 한 건을 "새 CS" 모달에 붙여넣고 분석 버튼을 누르면 폼이 채워진다. 사용자가 검토 후 저장한다.
2. **월별 요약**: 월 화면에 통계 패널(기기별·고객사별·접수자별 건수)을 항상 보여주고, 버튼으로 서술형 월간 요약을 생성해 저장한다. 팀원 모두 같은 요약을 본다.

## 결정 사항

| 항목 | 결정 | 이유 |
|---|---|---|
| LLM 호출 위치 | Supabase Edge Function `ai` | API 키를 숨길 유일한 자리. 기존 인프라 안에서 해결 |
| 모델 | `claude-sonnet-5-5` | 추출·요약에 충분, Opus 대비 절반 단가 |
| 월별 요약 | `cs_monthly_summaries` 테이블에 저장, 재생성 버튼 | 팀원 간 동일 요약, 열 때마다 호출 안 함 |
| 통계 패널 | 브라우저에서 이미 가져온 월 데이터로 계산 | SQL 추가 불필요 |
| 붙여넣기 단위 | 한 건씩 | 저장 전 검토 가능, 중복 등록 방지 UI 불필요 |
| 비용 | Max 플랜 월 API 크레딧 | 월 사용량 $1 안팎 |

## 구성 요소

```
브라우저 (GitHub Pages)
  ├─ supabase-js: cs_tickets, cs_monthly_summaries 읽기/쓰기 (기존 방식)
  └─ sb.functions.invoke('ai', { mode, ... })  ── JWT 자동 첨부
            ▼
Supabase Edge Function  supabase/functions/ai/
  ├─ index.ts     요청 라우팅, JWT 검증, CORS, 에러 처리
  ├─ prompts.ts   시스템 프롬프트, 요약 템플릿, 출력 스키마
  └─ (secrets)    ANTHROPIC_API_KEY
            ▼
Claude API  claude-sonnet-5-5, 구조화 출력
```

## Edge Function `ai`

```
POST /functions/v1/ai
Authorization: Bearer <로그인 JWT>
{ "mode": "parse",     "text": "<슬랙 메시지>" }
{ "mode": "summarize", "month": "2026-10" }
```

### 인증
요청의 Authorization 헤더로 supabase 클라이언트를 만들고 `auth.getUser()`가 성공해야 진행. 실패 시 401.
게이트웨이 JWT 검증(`verify_jwt`)은 끄고 함수 안에서 검증한다 (새 publishable 키·비대칭 서명 키와 호환).

### parse 모드
- `text` 8,000자 초과 → 400.
- 구조화 출력(JSON 스키마)으로 요청. 스키마:
  `reporter, customer, received_at, device, version, description, notes, confidence_notes`
  - `received_at`: 날짜+시각이면 `YYYY-MM-DDTHH:MM`, 시각만이면 `HH:MM`, 없으면 null
  - `device`: 8종 enum 또는 null
- 브라우저가 null 날짜를 오늘 + 메시지 시각으로 채운다.
- effort `low`.

### summarize 모드
- `month` 형식 `YYYY-MM` 검증.
- 요청자 JWT로 해당 월 `cs_tickets` 조회 (RLS 적용). 0건이면 400 "요약할 CS가 없습니다".
- 함수가 총건수·기기별 건수를 계산해 입력 상단에 넣는다 (LLM이 숫자를 세지 않게).
- 건별 한 줄 텍스트로 변환해 Claude에 전달. effort `medium`.
- 결과 마크다운을 `cs_monthly_summaries`에 upsert 하고 저장된 행을 반환.

### 에러 응답
`{ "error": "<사용자에게 보여줄 한국어 메시지>" }` + 상태 코드.
Claude가 `stop_reason: refusal` 또는 `max_tokens`로 끝나면 502 + 안내 메시지.
API 키 미설정 시 500 "ANTHROPIC_API_KEY 가 설정되지 않았습니다".
토큰 사용량(`usage`)은 `console.log`로 남긴다.

## DB 변경 (`supabase/schema.sql` 에 추가)

```sql
create table if not exists public.cs_monthly_summaries (
  month        text primary key check (month ~ '^\d{4}-\d{2}$'),
  content      text not null,
  ticket_count int  not null,
  generated_by uuid references auth.users(id) on delete set null,
  generated_at timestamptz not null default now()
);
-- RLS: authenticated 만 select/insert/update/delete. anon 차단. cs_tickets 와 동일.
```

## UI

### 새 CS 모달
- 폼 상단에 접이식 영역 "슬랙 메시지 붙여넣기": textarea + "분석해서 채우기" 버튼.
- 분석 중에는 버튼 비활성·문구 변경. 완료 시 폼 필드를 채우고 `confidence_notes`가 있으면 안내 문구로 표시.
- 이미 입력된 필드는 덮어쓴다 (붙여넣기는 새 CS에서만 쓰는 흐름). 수정 모달에서는 영역을 숨긴다.
- device가 null이면 선택 상태를 비워 두어 필수 검증에 걸리게 한다.

### 월 화면
- 월 칩 아래 "월 통계" 패널: 총건수, 기기별, 고객사 상위 5, 접수자별. `state.rows` 기준. 검색 필터와 무관하게 월 전체.
- 그 아래 "월간 요약" 패널: 저장된 요약(마크다운을 간단 렌더링), 생성 시각·생성자, 버튼 "요약 생성" / "재생성", "복사"(마크다운 원문 복사).
- 요약 생성은 수 초~수십 초 걸리므로 진행 표시. 월 이동 시 늦게 도착한 응답은 무시 (`loadSeq` 패턴 재사용).

## 프롬프트 (prompts.ts)

parse 시스템 프롬프트와 summarize 시스템 프롬프트·출력 템플릿은 `supabase/functions/ai/prompts.ts`에 둔다. 내용은 대화에서 합의한 초안을 따른다. 요약 섹션: 통계 한 줄 / 주요 이슈 / 반복·미해결 건 / 결제·계정 문의 / 특이사항.

## 테스트

- Edge Function: `deno test`로 순수 함수(입력 텍스트 변환, 통계 계산, 요청 검증) 단위 테스트. 로컬에 deno가 없으면 `npx supabase functions serve`(Docker) 또는 배포 후 curl로 확인.
- 프론트: 브라우저에서 실제 샘플 메시지로 수동 확인. 폼 채움, 날짜 보정, 요약 생성·재생성·복사.

## 배포 절차 (README 에 기록)

1. `npx supabase login`, `npx supabase link --project-ref <ref>`
2. `npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`
3. `npx supabase functions deploy ai --no-verify-jwt`
4. SQL Editor 에서 schema.sql 재실행 (cs_monthly_summaries 생성)
