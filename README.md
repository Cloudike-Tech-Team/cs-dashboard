# CS 대시보드

월별로 접수된 CS를 등록·수정·조회하고, 월 단위로 CSV로 내보내는 정적 웹사이트입니다.
화면은 GitHub Pages에서 호스팅하고, 데이터는 Supabase(Postgres)에 저장합니다.

```
cs-dashboard/
├── index.html            # 화면 (로그인 / 목록 / 등록·수정 모달)
├── css/style.css
├── js/config.js          # Supabase URL, anon key  ← 여기만 채우면 됨
├── js/app.js             # 로직 (supabase-js v2, CDN 로드, 빌드 없음)
├── supabase/schema.sql   # 테이블 + RLS + 월별 건수 뷰 + 월간 요약 테이블
├── supabase/functions/ai # Edge Function: 슬랙 메시지 자동 입력 · 월간 요약 (Claude API)
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
| `cs_tickets` | CS 테이블. 타임라인·티켓은 `text[]` 배열 |
| `cs_tickets_stamp` 트리거 | `created_by / updated_by / updated_at` 자동 기록 |
| RLS 정책 4개 | `authenticated` 역할만 select/insert/update/delete |
| `cs_monthly_counts` 뷰 | KST 기준 월별 건수 (상단 월 칩) |

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

## 4. 기능 요약

| 요구사항 | 구현 |
|---|---|
| 모든 CS 수정 가능 | 목록의 행 클릭 → 모달에서 수정/저장. 동시 수정 충돌 시 경고(낙관적 잠금) |
| 날짜 역순 정렬 | `received_at desc, created_at desc` |
| 월별 보기 | 월 선택기 + ◀ ▶ + 최근 12개월 건수 칩. 월 경계는 KST 기준 |
| 월별 export | **CSV 내보내기** → `CS_YYYY-MM.csv` (해당 월 전체, BOM 포함이라 엑셀에서 한글이 정상 표시됨) |
| 리스트 입력 | 처리 타임라인·티켓은 `+ 추가` / `−`로 행 단위 입력 |
| 기타 | 월 내 검색, 기기 필터, 티켓 URL 자동 링크, 접수자 기본값 기억, 삭제(2단계 확인) |

## 5. 운영 메모

- **Supabase Free 플랜은 7일간 요청이 없으면 프로젝트가 일시정지**됩니다. 대시보드에서 Restore하면 복구됩니다. 꾸준히 쓰면 문제없습니다.
- 기기 목록을 바꾸려면 `js/app.js`의 `DEVICES`와 `schema.sql`의 `check (device in (...))`를 **둘 다** 바꿔야 합니다. DB 제약 변경 예:
  ```sql
  alter table public.cs_tickets drop constraint cs_tickets_device_check;
  alter table public.cs_tickets add constraint cs_tickets_device_check
    check (device in ('웹','CLDAstream Win','CLDAstream MAC','PC client Win','PC client MAC','Android','IOS','새기기'));
  ```
- 회사 계정만 허용하려면 `schema.sql`의 정책 조건을 `(auth.jwt() ->> 'email') like '%@cloudike.io'`로 바꾸세요.

## AI 기능 (슬랙 메시지 자동 입력 · 월간 요약)

두 기능 모두 Supabase Edge Function `ai` 가 Claude API(`claude-sonnet-5-5`)를 호출합니다.
API 키는 Supabase secrets 에만 저장되고, 함수는 로그인 JWT 를 검증한 뒤에만 동작합니다.

- **새 CS 모달 → "슬랙 메시지 붙여넣기로 자동 입력"**: 메시지 한 건을 붙여넣고 「분석해서 채우기」를 누르면 접수자·고객사·날짜·기기·버전·현상·특이사항이 채워집니다. 확인 후 저장하세요. 추측한 항목은 "검토 필요" 문구로 표시됩니다.
- **월 통계 패널**: 그 달의 기기별·고객사별·접수자별 건수. 브라우저에서 계산하며 API 호출이 없습니다.
- **월간 요약 패널**: 「요약 생성」을 누르면 그 달 CS 전체를 읽어 보고서 형식 마크다운을 만들고 `cs_monthly_summaries` 에 저장합니다. 팀원 모두 같은 요약을 봅니다. 「복사」로 마크다운 원문을 가져갈 수 있습니다.

프롬프트와 출력 형식은 `supabase/functions/ai/prompts.ts` 에 있습니다. 요약 섹션 구성이나 기기 매핑 규칙을 바꾸려면 이 파일만 고치고 다시 배포하면 됩니다.

### 배포 (최초 1회)

```bash
# 1. CLI 로그인 + 프로젝트 연결 (Node 가 있으면 npx 로 바로 실행됨)
npx supabase login
npx supabase link --project-ref <프로젝트 ref>   # URL 의 https://<ref>.supabase.co

# 2. Claude API 키 등록 (Console → API Keys 에서 발급. Max 플랜이면 월 크레딧으로 결제됨)
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# 3. 함수 배포. JWT 검증은 함수 안에서 하므로 게이트웨이 검증은 끔
npx supabase functions deploy ai --no-verify-jwt

# 4. 테이블 생성: Dashboard → SQL Editor 에 supabase/schema.sql 전체를 다시 Run
```

프롬프트를 고친 뒤에는 3번만 다시 실행하면 됩니다.

### 비용
Sonnet 5.5 기준 붙여넣기 분석 1회 약 $0.006, 월간 요약 1회(100건) 약 $0.1. 월 100건 처리해도 $1 안팎입니다.
함수 로그(Dashboard → Edge Functions → ai → Logs)에 호출마다 토큰 사용량이 남습니다.

### 로컬 테스트
```bash
cd supabase/functions/ai
npx deno-bin test --allow-net=jsr.io   # 순수 로직 단위 테스트
npx deno-bin check index.ts            # 타입 검사
```
