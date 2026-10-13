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
                 'PC client Win', 'PC client MAC', 'Android', 'IOS')),          -- 기기
  version      text not null default '' check (char_length(version) <= 100),    -- 버전
  description  text not null default '' check (char_length(description) <= 10000), -- 현상설명
  notes        text not null default '' check (char_length(notes) <= 10000),   -- 특이사항
  timeline     text[] not null default '{}',                                    -- 처리 타임라인
  tickets      text[] not null default '{}',                                    -- 티켓
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 월별 조회 + 날짜 역순 정렬용 인덱스
create index if not exists cs_tickets_received_at_idx
  on public.cs_tickets (received_at desc, created_at desc);

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
