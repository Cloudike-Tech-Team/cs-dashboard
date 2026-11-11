# CS 대시보드

접수된 CS를 등록·수정·조회하고, 안 끝난 CS 를 한눈에 처리하며, 보이는 목록을 CSV로 내보내는 정적 웹사이트입니다.
화면은 GitHub Pages에서 호스팅하고, 데이터는 Supabase(Postgres)에 저장합니다.

```
cs-dashboard/
├── index.html            # 화면 (로그인 / 목록 / 등록·수정 모달)
├── css/style.css
├── js/config.js          # Supabase URL, anon key  ← 여기만 채우면 됨
├── js/lib.js             # 순수 함수 (상태 라벨·필터·KPI). `node --test js/lib.test.js`
├── js/app.js             # 로직 (supabase-js v2, CDN 로드, 빌드 없음)
├── supabase/schema.sql   # 테이블 + RLS + 월별 건수 뷰 + 월간 요약 테이블
├── supabase/functions/ai # Edge Function: 슬랙 메시지 자동 입력 · 월간 요약 (Claude API)
├── supabase/functions/tickets # Edge Function: 연결된 티켓의 담당자·상태 조회 (YouTrack · Jira API)
└── .nojekyll
```

## 구조와 보안 모델

```
브라우저 (GitHub Pages, 정적 파일)
   │  supabase-js  +  anon key (공개) + 로그인 세션(JWT)
   ▼
Supabase  ── Auth: 이메일/비밀번호 로그인
          └─ Postgres: cs_tickets 테이블 (RLS: authenticated 만 읽기/쓰기)
```

- GitHub Pages는 정적 호스팅이라 **anon key가 누구에게나 보입니다.** 이것은 정상이며, 데이터 보호는 RLS가 담당합니다.
- 고객사 정보가 들어가므로 **로그인한 사용자만** 조회·수정할 수 있게 했습니다. 비로그인(anon) 요청은 DB에서 차단됩니다.
- **공개 회원가입은 반드시 끄고**, 관리자가 계정을 직접 만들어 줍니다. 회원가입이 켜져 있으면 누구나 가입해서 데이터를 볼 수 있습니다.
- `service_role` key는 RLS를 우회하므로 절대 프론트엔드나 레포에 넣지 않습니다.

## 1. Supabase 설정

### 1-1. 스키마 생성
Dashboard → **SQL Editor** → `supabase/schema.sql` 내용 전체를 붙여넣고 **Run**.

생성되는 것:
| 객체 | 설명 |
|---|---|
| `cs_tickets` | CS 테이블. 제목·상태·상태 메모·담당자(`assignee`)·티켓 담당(`ticket_assignee`) 포함. 타임라인·티켓은 `text[]` 배열 |
| `cs_assignees` · `rename_cs_assignee()` | CS 담당 명단과 이름 수정 함수(명단·기존 CS 를 한 번에 변경). 처음 실행 시 기존 CS 의 담당자 이름으로 명단을 채움 |
| `cs_monthly_summaries` | 월간 요약. `content`(마크다운) + `issues`/`notes`(jsonb, 화면 필터용) |
| `cs_tickets_stamp` 트리거 | `created_by / updated_by / updated_at` 자동 기록 |
| RLS 정책 4개 | `authenticated` 역할만 select/insert/update/delete |
| `cs_monthly_counts` 뷰 | KST 기준 월별 건수 (현재 화면에서는 사용하지 않음) |

확인: **Table Editor → cs_tickets** 에 "RLS enabled" 표시가 있어야 합니다.

### 1-2. 회원가입 끄기
Dashboard → **Authentication → Sign In / Providers**
- **Allow new users to sign up** → **OFF**
- **Allow anonymous sign-ins** → **OFF** (기본값 OFF. 익명 로그인도 `authenticated` 역할이라 켜면 누구나 데이터를 봅니다)
- Email provider는 켜둔 상태 유지

### 1-3. 팀원 계정 만들기
Dashboard → **Authentication → Users → Add user → Create new user**
- 이메일 / 비밀번호 입력, **Auto Confirm User** 체크
- 팀원에게 비밀번호를 전달하고, 이후 필요하면 Dashboard에서 재설정

### 1-4. URL 설정 (선택이지만 권장)
Dashboard → **Authentication → URL Configuration**
- **Site URL**: `https://<GitHub계정>.github.io/cs-dashboard/`
- **Redirect URLs**: 같은 주소 추가 (나중에 비밀번호 재설정·초대 메일 기능을 쓸 때 필요)

### 1-5. API 키 복사
Dashboard → **Project Settings → API** (또는 **API Keys**)
- **Project URL** → `js/config.js`의 `SUPABASE_URL`
- **anon public** key (새 키 체계라면 **publishable** key `sb_publishable_...`) → `SUPABASE_ANON_KEY`

## 2. 로컬에서 확인

```bash
cd cs-dashboard
python3 -m http.server 8000
# http://localhost:8000 접속 → 1-3에서 만든 계정으로 로그인
```
`file://`로 직접 열지 말고 반드시 로컬 서버로 여세요.

## 3. GitHub 레포 생성 & Pages 배포

`gh` CLI 사용 시 (계정/조직명은 바꿔서):

```bash
cd cs-dashboard
git init -b main
git add .
git commit -m "CS 대시보드 초기 버전"

# private 레포 생성 + push
gh repo create <계정또는조직>/cs-dashboard --private --source=. --push

# GitHub Pages 켜기: main 브랜치의 루트(/)에서 배포
gh api -X POST repos/<계정또는조직>/cs-dashboard/pages \
  -f "source[branch]=main" -f "source[path]=/"

# 배포 상태/URL 확인 (1~2분 소요)
gh api repos/<계정또는조직>/cs-dashboard/pages --jq '.html_url,.status'
```

웹 UI로 할 경우: 레포 → **Settings → Pages → Build and deployment**
- Source: **Deploy from a branch**
- Branch: **main** / **/(root)** → Save

> **주의 — private 레포와 Pages**
> - private 레포에서 Pages를 쓰려면 GitHub **Pro / Team / Enterprise** 플랜이 필요합니다. Free 플랜이면 레포를 public으로 해야 합니다.
> - 레포가 private이어도 **Pages 사이트 자체는 기본적으로 공개**입니다(사이트 접근 제한은 Enterprise Cloud 전용).
> - 둘 다 괜찮습니다. 레포에는 코드와 anon key만 있고 CS 데이터는 없으며, 데이터는 로그인 + RLS로 보호됩니다.

배포 주소: `https://<계정또는조직>.github.io/cs-dashboard/`
→ 이 주소를 1-4의 Site URL/Redirect URLs에 넣습니다.

이후 수정 사항은 `git push`만 하면 자동으로 재배포됩니다.

> **js/css 를 바꿨다면** `index.html` 의 `<meta name="app-version">` · `?v=` 와 `js/app.js` 의 `APP_VERSION` 을 같은 값(예: 날짜)으로 함께 올리세요.
> GitHub Pages 는 파일마다 10분씩 캐시해서 배포 직후 예전 HTML 과 새 JS 가 섞일 수 있는데, 버전이 다르면 앱이 HTML 을 새로 받아 한 번 자동 새로고침합니다.

## 4. 기능 요약

| 요구사항 | 구현 |
|---|---|
| 화면 구성 | 상단 탭 **접수 현황 / 월간 리포트**(주소 `#report`). 전체 CS 를 한 번에 읽어 와 화면에서 거름 |
| 접수 현황 첫 화면 | 처음 열면 달과 상관없이 **아직 끝나지 않은 CS 전체**(미해결)를 보여 줌. 목록은 **접수 월별로 묶어** 이번 달이 맨 위(없으면 「이번 달에 접수된 CS가 없습니다」), 그 아래 지난달 · 그 전 달 순 |
| 기간 이동 | 목록 위 「전체 기간 · ‹ 월별 ›」로 한 달만 골라 보기(검색도 그 달로 좁혀짐). 고른 달은 월간 리포트 달과 맞춰짐 |
| 월간 리포트 | 달 이동(‹ ›) · 그 달 숫자 · **주요 이슈**(누르면 접수 현황에서 걸러 봄) · **특이사항**(짧은 한 문장, 최대 3개) · 심각도 · 기기 · CS 담당 막대 · 이 달 CSV. 주요 이슈 · 특이사항은 리포트를 열 때 요약이 없으면 AI 가 자동 분석, 「AI 다시 분석」으로 새로 만듦. AI 요약 본문은 화면에 보이지 않음. 「CS 담당 관리」 · 「기존 기록 번역」도 여기 |
| 행동 카드 | 위쪽 카드 4장: **미해결**(이달 · 이월 건수) · **긴급**(핫픽스·크리티컬) · **7일 넘게 열림** · **담당 미지정**. 늘 전체 기준이며 누르면 그 조건으로 걸러 봄. 아래에 상태별 칩 · 티켓 연결 건수 |
| 보기 · 정렬 | 보기 `미해결 / 이월 / 전체 / 완료`, 정렬 `급한 순 / 오래된 순 / 최근 접수 순`. 고른 값은 브라우저에 기억. 이월은 이번 달 전에 접수돼 아직 안 끝난 CS(목록에 「이월」 꼬리표) |
| 필터 칩 겹쳐 걸기 | 목록 위 칩 5종(심각도 · 상태 · 기기 · CS 담당 · 주요 이슈)에서 여러 값 · 여러 종류를 겹쳐 걸 수 있고 메뉴에 건수 표시. 「필터 모두 지우기」. 검색어와 AND |
| 목록 5칸 | 현상(+ 고객사 · 기기 · 꼬리표) / CS 상태 / CS 담당 / 티켓(번호 외 N · 트래커 상태 · 개발 담당) / 접수 · 경과. 행 왼쪽 띠 색 = 심각도, 담당 미지정은 강조. 표 최대 폭 1,400px, 상세를 열면 티켓 · 경과 칸을 접고 경과는 아래 줄로 |
| 상세 서랍 · 바로 저장 | 행 클릭 → 오른쪽 서랍. **상태 버튼은 한 번 누르면 바로 저장**, 상태 메모 · CS 담당 · 심각도 · 티켓 담당도 서랍에서 바로 바꿈. 티켓 카드, 이력 한 줄 추가, 나머지는 「전체 수정」 창. Esc 로 닫기. 동시 수정 충돌 시 경고(낙관적 잠금) |
| 팝업으로 보기 | 상세 서랍 ✕ 옆 「팝업으로 보기」로 그 CS 를 떠 있는 창으로 엶. 바탕을 눌러도 닫히지 않고 여러 개 띄울 수 있음(같은 CS 는 하나), 머리글을 끌어 옮기고 누른 창이 맨 앞으로. 팝업에서도 상태 등을 서랍과 같은 방식으로 바로 변경, 「상세에서 열기」로 서랍에 엶 |
| 상태 관리 | `처리 중 / 대기 / 지연 / 배포대기 / 완료 / 원인 미확인` + 상태 메모(예: 로그 대기). 상태는 회색 알약(처리 중 파랑 · 완료 초록), 색은 심각도에만 씀 |
| 상태 어긋남 꼬리표 | 연결된 티켓이 모두 끝났는데 CS 가 미완료이거나, CS 는 완료인데 티켓이 아직 진행 중이면 목록에 꼬리표 · 상세에 경고 |
| 심각도 | CS마다 **보통**(기본) · **중요** · **크리티컬** · **핫픽스** 중 하나. YouTrack 티켓에 Priority(Hot Fix · Critical · Major · Normal/Minor)가 있으면 그 값을 따르고 콘솔에서는 잠김(여러 티켓이면 가장 급한 값, 바꾸려면 YouTrack 에서). 티켓이 없거나 Jira · NPR 티켓이면 상세 서랍 · 등록·수정 창에서 직접 선택. 목록에서는 배지와 행 왼쪽 띠로 표시(중요 주황 · 크리티컬 분홍 · 핫픽스 빨강). 필터 칩 · 검색 · CSV 에도 포함 |
| 경과 N일째 · 지연 | 완료 전 CS 는 목록 「접수 · 경과」 칸과 상세 · 팝업에 접수 후 **N일째** 표시, 7일 이상 열려 있으면 **지연 N일째** 빨강. 완료하면 사라짐 |
| 검색 | 기본은 **전체 기간**: 검색어가 있으면 보기와 상관없이 모든 CS(완료 포함)에서 찾아 이번 달 · 최근 30일 · 최근 1년 · 1년 이상 전으로 묶어 표시. 기간에서 달을 고르면 그 달만 검색. **`/`** 키로 검색창으로 이동 |
| 메일 주소 가리기 | 전사 공개 화면이라 고객 메일 주소는 저장할 때 앞글자 · @ · 도메인 앞글자만 남김(hong@cloudike.io → h***@c***). DB 트리거가 CS · 번역 · 월간 요약 저장을 모두 가리고, 슬랙 분석은 AI 에 보내기 전에 가림. 원래 주소는 남지 않음(슬랙 원글에서 확인) |
| 언어 | 처음에는 브라우저 선호 언어(크롬 설정)에 한국어가 있으면 한국어, 없으면 영어로 보이고, 상단 오른쪽 「한국어 / English」로 바꿀 수 있음(브라우저에 기억). 버튼·상태·심각도·기기 이름·날짜 표기가 언어에 맞게 바뀜. DB 값은 그대로 |
| 번역 | 제목·현상 설명·특이사항·상태 메모·처리 이력은 Claude 가 한국어·영어로 번역해 `cs_ticket_translations` 에 따로 저장하고 화면 언어 쪽을 보여 줌(원문은 그대로). 등록·수정하면 자동으로 다시 번역. 상세에서 「원문 보기」. 고객사·티켓 번호·사람 이름·버전은 번역하지 않음. 번역이 없는 옛 기록이 있으면 월간 리포트의 「기존 기록 번역」으로 한 번에 처리. 월간 요약도 영어판을 함께 만듦(예전 요약은 재생성) |
| 담당자 | **CS 담당**은 팀 공용 명단(`cs_assignees`)에서 드롭다운으로 선택(상세 서랍에서 바로 변경). 「CS 담당 관리」에서 추가·이름 수정·삭제(이름 수정 시 기존 CS 도 함께 변경, 삭제는 명단에서만 빠짐). **티켓 담당**은 YouTrack·Jira 에서 자동으로 읽음 (아래 티켓 연동) |
| 티켓 연동 | 목록 티켓 칸 · 상세 티켓 카드에 트래커 상태 · 개발 담당을 표시. CS 의 티켓 칸(`NRF-4817`, `CLDA-82` 또는 URL)으로 YouTrack·Jira 를 조회한 값 |
| 등록 창 | 슬랙 붙여넣기(자동 입력)를 펼친 채로 시작 → 현상 한 줄부터 입력. 빈 필수 칸은 빨간 테두리와 칸 이름으로 안내 |
| CSV 내보내기 | **지금 보이는 목록 그대로**(보기 · 필터 · 검색 · 정렬 반영) → `CS_<보기>_YYYY-MM-DD.csv` (BOM 포함) |
| 리스트 입력 | 처리 타임라인·티켓은 `+ 추가` / `−`로 행 단위 입력. 타임라인 앞의 `10/12` 날짜는 상세에서 분리 표시 |

## 5. 운영 메모

- **Supabase Free 플랜은 7일간 요청이 없으면 프로젝트가 일시정지**됩니다. 대시보드에서 Restore하면 복구됩니다. 꾸준히 쓰면 문제없습니다.
- 기기 목록을 바꾸려면 `js/app.js`의 `DEVICES`와 `schema.sql`의 `check (device in (...))`를 **둘 다** 바꿔야 합니다. DB 제약 변경 예:
  ```sql
  alter table public.cs_tickets drop constraint cs_tickets_device_check;
  alter table public.cs_tickets add constraint cs_tickets_device_check
    check (device in ('웹','CLDAstream Win','CLDAstream MAC','PC client Win','PC client MAC','Android','IOS','새기기'));
  ```
- 상태 목록을 바꾸려면 `js/lib.js`의 `STATUS`, `supabase/functions/ai/lib.ts`의 `Status`/`STATUS_LABEL`, `schema.sql`의 `cs_tickets_status_check` 제약을 **셋 다** 바꾸고 스키마 재실행·함수 재배포.
- 회사 계정만 허용하려면 `schema.sql`의 정책 조건을 `(auth.jwt() ->> 'email') like '%@cloudike.io'`로 바꾸세요.

## 티켓 연동 (YouTrack · Jira → 티켓 담당 · 티켓 상태)

CS 의 티켓 칸에 적힌 이슈 ID(`NRF-4817`, `CLDA-82`, `https://yt.cloudike.io/issue/NRF-4817`, `https://cloudike.atlassian.net/browse/CLDA-82` 등)로
Edge Function `tickets` 가 트래커를 조회해 **담당자** 와 **상태** 를 돌려줍니다.

| 트래커 | 대상 | 담당 / 상태 필드 |
|---|---|---|
| Jira (cloudike.atlassian.net) | `JIRA_PROJECTS` 의 프로젝트 키 (기본 `CLDA,GOVNIPA`) | assignee / status (완료 여부는 statusCategory=done) |
| YouTrack (yt.cloudike.io) | 그 밖의 모든 키 (NRF, CLM, DAM, VPI …) | Assignee / State. NPR 은 `개발 담당자` / `진행 상황` |

- 월을 열 때마다 새로 읽고, 목록 위 「티켓 새로고침」으로 언제든 다시 읽을 수 있습니다. **DB 에는 저장하지 않습니다**(표시 전용).
- 티켓이 여러 개면 목록에는 아직 안 끝난 첫 티켓 상태를 `In Progress 외 1` 처럼 표시하고, 상세에는 티켓별로 상태·담당·제목을 보여 줍니다.
- 트래커에서 읽지 못한 티켓만 있는 CS 는 수동 입력한 「티켓 담당」을 대신 표시합니다(`수동 입력` 표시).
- 한쪽 토큰만 등록돼 있으면 그쪽 티켓만 읽히고, 목록 위에 나머지를 못 읽었다는 안내가 뜹니다.
- CS 담당 · CS 상태는 지금처럼 대시보드에서 관리합니다.
- CSV 내보내기에 `티켓 담당`(트래커 값) · `티켓 상태` 열이 들어갑니다. 월간 요약(AI)은 여전히 DB 값만 사용합니다.

> Claude Code 의 YouTrack·Atlassian MCP 는 Claude 세션 안에서만 쓰는 도구라 웹 페이지에서 직접 호출할 수 없습니다. 그래서 같은 서버의 REST API 를 Edge Function 에서 호출합니다. 토큰은 Supabase secrets 에만 저장되고 브라우저에는 노출되지 않습니다.

### 배포
```bash
# YouTrack → 프로필 → Account Security → New token (Scope: YouTrack)
npx supabase secrets set YOUTRACK_TOKEN=perm:...
# Jira → https://id.atlassian.com/manage-profile/security/api-tokens → Create API token
#   토큰을 만든 계정의 이메일과 함께 등록. 그 계정이 CLDA·GOVNIPA 를 볼 수 있어야 함
npx supabase secrets set JIRA_EMAIL=you@cloudike.io JIRA_TOKEN=ATATT...
# (선택) 기본값과 다를 때만
# npx supabase secrets set YOUTRACK_URL=https://yt.cloudike.io JIRA_URL=https://cloudike.atlassian.net JIRA_PROJECTS=CLDA,GOVNIPA
npx supabase functions deploy tickets --no-verify-jwt
```
DB 스키마 변경은 없습니다. Jira 에 프로젝트가 늘면 `JIRA_PROJECTS` 만 다시 설정하면 됩니다(재배포 불필요).

## AI 기능 (슬랙 메시지 자동 입력 · 월간 요약)

두 기능 모두 Supabase Edge Function `ai` 가 Claude API(`claude-sonnet-5-5`)를 호출합니다.
API 키는 Supabase secrets 에만 저장되고, 함수는 로그인 JWT 를 검증한 뒤에만 동작합니다.

- **새 CS 모달 → "슬랙 메시지 붙여넣기로 자동 입력"**: 메시지 한 건을 붙여넣고 「분석해서 채우기」를 누르면 접수자·고객사·날짜·기기·버전·현상·특이사항이 채워집니다. 확인 후 저장하세요. 추측한 항목은 "검토 필요" 문구로 표시됩니다.
- **월간 리포트 → 주요 이슈 · 특이사항**: 리포트를 열었을 때 그 달 요약이 없으면 자동으로, 또는 「AI 다시 분석」을 누르면 그 달 CS 전체를 읽어 **주요 이슈**(비슷한 현상 묶음, 눌러서 목록 필터)와 **특이사항**(짧은 한 문장, 최대 3개)을 만들어 `cs_monthly_summaries` 에 저장합니다. 요약 본문은 화면에 띄우지 않습니다. 미해결 목록·통계는 AI 가 아니라 상태 컬럼으로 계산합니다.

프롬프트와 출력 형식은 `supabase/functions/ai/prompts.ts` 에 있습니다. 요약 섹션 구성이나 기기 매핑 규칙을 바꾸려면 이 파일만 고치고 다시 배포하면 됩니다.

### 배포 (최초 1회)

```bash
# 1. CLI 로그인 + 프로젝트 연결 (Node 가 있으면 npx 로 바로 실행됨)
npx supabase login
npx supabase link --project-ref <프로젝트 ref>   # URL 의 https://<ref>.supabase.co

# 2. Claude API 키 등록 (Console → API Keys 에서 발급. Max 플랜이면 월 크레딧으로 결제됨)
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
#    키가 "워크스페이스에 묶이지 않은" 기본 키라면 워크스페이스 ID 도 함께 등록
#    (Console → Settings → Workspaces 의 wrkspc_... 값). 워크스페이스 전용 키면 생략 가능.
npx supabase secrets set ANTHROPIC_WORKSPACE_ID=wrkspc_...

# 3. 함수 배포. JWT 검증은 함수 안에서 하므로 게이트웨이 검증은 끔
npx supabase functions deploy ai --no-verify-jwt

# 4. 테이블 생성: Dashboard → SQL Editor 에 supabase/schema.sql 전체를 다시 Run
```

프롬프트를 고친 뒤에는 3번만 다시 실행하면 됩니다.

2026-10 리디자인 이후 처음 배포할 때는 4번(schema.sql 재실행)을 먼저 합니다. 기존 CS 는 모두 상태가 `처리 중`으로 시작하므로, 과거 달은 상세 패널의 「상태 변경」으로 끝난 건을 `완료`로 정리한 뒤 「재생성」하세요. 정리 전에 재생성하면 그 달의 모든 건이 미해결 목록에 들어갑니다(최대 30건까지 표시). 지난달 이전 건을 한 번에 완료 처리하려면 SQL Editor 에서:
```sql
update public.cs_tickets set status = 'done'
 where status = 'open' and received_at < date_trunc('month', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
```

### 비용
Sonnet 5.5 기준 붙여넣기 분석 1회 약 $0.006, 월간 요약 1회(100건) 약 $0.1. 월 100건 처리해도 $1 안팎입니다.
함수 로그(Dashboard → Edge Functions → ai → Logs)에 호출마다 토큰 사용량이 남습니다.

### 로컬 테스트
```bash
cd supabase/functions/tickets && npx deno-bin test --allow-net=jsr.io && npx deno-bin check index.ts && cd -
cd supabase/functions/ai
npx deno-bin test --allow-net=jsr.io   # 순수 로직 단위 테스트
npx deno-bin check index.ts            # 타입 검사
```
