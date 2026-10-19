-- CS 대시보드 스키마
-- Supabase Dashboard → SQL Editor 에 전체 붙여넣고 Run.
-- 여러 번 실행해도 안전하도록 작성되어 있음(idempotent).

-- ─────────────────────────────────────────────
-- 1. 테이블
-- ─────────────────────────────────────────────
create table if not exists public.cs_tickets (
  id           uuid primary key default gen_random_uuid(),
  reporter     text not null check (char_length(reporter) between 1 and 100),   -- 접수자
  customer     text not null check (char_length(customer) between 1 and 200),   -- 고객사, 유저
  received_at  timestamptz not null default now(),                              -- 날짜(접수 일시)
  device       text not null check (device in (
                 '웹', 'CLDAstream Win', 'CLDAstream MAC',
                 'PC client Win', 'PC client MAC', 'Android', 'IOS', '기타')),  -- 기기
  version      text not null default '' check (char_length(version) <= 100),    -- 버전
  description  text not null default '' check (char_length(description) <= 10000), -- 현상설명
  notes        text not null default '' check (char_length(notes) <= 10000),   -- 특이사항
  timeline     text[] not null default '{}',                                    -- 처리 타임라인
  tickets      text[] not null default '{}',                                    -- 티켓
  title        text not null default '' check (char_length(title) <= 200),      -- 현상 제목
  status       text not null default 'open'
                 check (status in ('open', 'waiting', 'delayed', 'deploy', 'done', 'unknown')), -- 처리 상태
  status_note  text not null default '' check (char_length(status_note) <= 50), -- 상태 메모(예: 로그 대기)
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 월별 조회 + 날짜 역순 정렬용 인덱스
create index if not exists cs_tickets_received_at_idx
  on public.cs_tickets (received_at desc, created_at desc);

-- 1-b. 2026-10 리디자인: 제목·상태 컬럼 (기존 설치에 추가. 신규 설치는 위 create 에 이미 포함)
alter table public.cs_tickets
  add column if not exists title       text not null default ''
                                        check (char_length(title) <= 200),
  add column if not exists status      text not null default 'open'
                                        check (status in ('open', 'waiting', 'delayed', 'deploy', 'done', 'unknown')),
  add column if not exists status_note text not null default ''
                                        check (char_length(status_note) <= 50);

-- 상태 목록이 바뀌면 여기 제약과 js/lib.js 의 STATUS, functions/ai/lib.ts 의 Status 를 함께 바꾼다.
-- (컬럼이 이미 있던 설치는 위 add column 이 건너뛰므로 제약을 다시 건다)
alter table public.cs_tickets drop constraint if exists cs_tickets_status_check;
alter table public.cs_tickets add constraint cs_tickets_status_check
  check (status in ('open', 'waiting', 'delayed', 'deploy', 'done', 'unknown'));

-- 기존 행 백필: 제목이 비어 있으면 현상설명 첫 줄.
-- 감사 트리거를 잠시 끈다 (updated_by/updated_at 이 덮이지 않게, 열려 있는 수정 모달이 충돌 오류를 받지 않게).
alter table public.cs_tickets disable trigger cs_tickets_stamp;
update public.cs_tickets
   set title = left(split_part(description, E'\n', 1), 200)
 where title = '' and split_part(description, E'\n', 1) <> '';
alter table public.cs_tickets enable trigger cs_tickets_stamp;

-- ─────────────────────────────────────────────
-- 2. 작성자/수정자/수정시각 자동 기록 (클라이언트가 위조 불가)
-- ─────────────────────────────────────────────
create or replace function public.cs_tickets_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- auth.users 삭제 시 FK(on delete set null)가 일으키는 내부 UPDATE 는 그대로 통과시킴.
  -- (여기서 created_by 를 되돌리면 삭제된 유저를 가리키게 되고 updated_at 도 거짓으로 바뀜)
  if pg_catalog.pg_trigger_depth() > 1 then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cs_tickets_stamp on public.cs_tickets;
create trigger cs_tickets_stamp
  before insert or update on public.cs_tickets
  for each row execute function public.cs_tickets_stamp();

-- ─────────────────────────────────────────────
-- 3. RLS: 로그인한 사용자(authenticated)만 접근. 비로그인(anon)은 전부 차단.
--    anon key 는 GitHub Pages 에 공개되므로, 보안은 전적으로 이 정책에 의존함.
-- ─────────────────────────────────────────────
alter table public.cs_tickets enable row level security;

revoke all on table public.cs_tickets from anon;
grant select, insert, update, delete on table public.cs_tickets to authenticated;

drop policy if exists "cs_select" on public.cs_tickets;
drop policy if exists "cs_insert" on public.cs_tickets;
drop policy if exists "cs_update" on public.cs_tickets;
drop policy if exists "cs_delete" on public.cs_tickets;

create policy "cs_select" on public.cs_tickets
  for select to authenticated using (true);
create policy "cs_insert" on public.cs_tickets
  for insert to authenticated with check (true);
create policy "cs_update" on public.cs_tickets
  for update to authenticated using (true) with check (true);
create policy "cs_delete" on public.cs_tickets
  for delete to authenticated using (true);

-- (선택) 회사 도메인 계정만 허용하고 싶다면 위 4개 정책의 true 를 아래 식으로 교체:
--   (auth.jwt() ->> 'email') like '%@cloudike.io'

-- ─────────────────────────────────────────────
-- 4. 월별 건수 뷰 (KST 기준). security_invoker 로 RLS 를 그대로 적용.
-- ─────────────────────────────────────────────
create or replace view public.cs_monthly_counts
with (security_invoker = true) as
select to_char(received_at at time zone 'Asia/Seoul', 'YYYY-MM') as month,
       count(*)::int as count
from public.cs_tickets
group by 1;

revoke all on public.cs_monthly_counts from anon;
grant select on public.cs_monthly_counts to authenticated;

-- ─────────────────────────────────────────────
-- 5. 월간 요약 (Edge Function `ai` 의 summarize 모드가 upsert)
-- ─────────────────────────────────────────────
create table if not exists public.cs_monthly_summaries (
  month        text primary key check (month ~ '^\d{4}-\d{2}$'),
  content      text not null check (char_length(content) <= 20000),
  ticket_count int  not null check (ticket_count >= 0),
  issues       jsonb not null default '[]'::jsonb,   -- [{label, detail, ticket_ids: uuid[]}]
  notes        jsonb not null default '[]'::jsonb,   -- [{customer, text}]
  generated_by uuid references auth.users(id) on delete set null,
  generated_at timestamptz not null default now()
);

-- 기존 설치에 추가
alter table public.cs_monthly_summaries
  add column if not exists issues jsonb not null default '[]'::jsonb,
  add column if not exists notes  jsonb not null default '[]'::jsonb;

alter table public.cs_monthly_summaries enable row level security;

revoke all on table public.cs_monthly_summaries from anon;
grant select, insert, update, delete on table public.cs_monthly_summaries to authenticated;

drop policy if exists "sum_select" on public.cs_monthly_summaries;
drop policy if exists "sum_insert" on public.cs_monthly_summaries;
drop policy if exists "sum_update" on public.cs_monthly_summaries;
drop policy if exists "sum_delete" on public.cs_monthly_summaries;

create policy "sum_select" on public.cs_monthly_summaries
  for select to authenticated using (true);
create policy "sum_insert" on public.cs_monthly_summaries
  for insert to authenticated with check (true);
create policy "sum_update" on public.cs_monthly_summaries
  for update to authenticated using (true) with check (true);
create policy "sum_delete" on public.cs_monthly_summaries
  for delete to authenticated using (true);
