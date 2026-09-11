-- InterparkSeatChecker 웹앱용 스키마.
-- Supabase SQL Editor에서 순서대로 실행하세요.

-- 1) 조회 설정 (개인용 단일 사용자 앱이라 id=1 단일 행만 사용)
create table if not exists public.avail_seats (
  id bigint primary key default 1,
  goods_code text not null,
  interval_minutes integer not null default 10,
  quiet_hours_enabled boolean not null default false,
  last_checked_at timestamptz,
  last_result jsonb,
  updated_at timestamptz not null default now(),
  constraint avail_seats_singleton check (id = 1)
);

-- 2) 웹푸시 구독 정보 (기기별로 여러 행 가능)
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.avail_seats enable row level security;
alter table public.push_subscriptions enable row level security;

-- 개인용 앱이라 로그인 없이 anon(publishable) 키로 읽기/쓰기를 허용한다.
-- 여러 사람이 접근 가능한 공개 프로젝트에 배포한다면 반드시 인증을 추가할 것.
drop policy if exists "anon can read avail_seats" on public.avail_seats;
create policy "anon can read avail_seats" on public.avail_seats
  for select to anon using (true);

drop policy if exists "anon can upsert avail_seats" on public.avail_seats;
create policy "anon can upsert avail_seats" on public.avail_seats
  for insert to anon with check (true);

drop policy if exists "anon can update avail_seats" on public.avail_seats;
create policy "anon can update avail_seats" on public.avail_seats
  for update to anon using (true);

drop policy if exists "anon can upsert push_subscriptions" on public.push_subscriptions;
create policy "anon can upsert push_subscriptions" on public.push_subscriptions
  for insert to anon with check (true);

drop policy if exists "anon can update push_subscriptions" on public.push_subscriptions;
create policy "anon can update push_subscriptions" on public.push_subscriptions
  for update to anon using (true);

drop policy if exists "anon can delete push_subscriptions" on public.push_subscriptions;
create policy "anon can delete push_subscriptions" on public.push_subscriptions
  for delete to anon using (true);

-- 3) pg_cron이 Edge Function을 호출할 수 있도록 확장 활성화.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- 4) 1분마다 check-seats Edge Function 호출을 예약한다.
--    함수 내부에서 avail_seats.interval_minutes가 지났는지 스스로 판단하므로,
--    이 크론 주기(1분)는 "가장 촘촘한 조회 해상도"일 뿐 실제 조회 주기가 아니다.
--    YOUR_PROJECT_REF / YOUR_SERVICE_ROLE_KEY를 실제 값으로 바꿔서 실행하세요.
--    (service_role 키가 이 SQL과 함께 cron.job 테이블에 평문 저장되니, 반드시 본인 프로젝트에서만 실행할 것)
select cron.schedule(
  'check-seats-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://ejovypvaeopcvxrjdwyb.supabase.co/functions/v1/check-seats',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqb3Z5cHZhZW9wY3Z4cmpkd3liIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MzUwMTAzNiwiZXhwIjoyMDk5MDc3MDM2fQ.JLz9yXYiXyLx2P7IT8qpkwL_4dCjCG0insWPeKETg2E',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- 크론 등록 확인: select * from cron.job;
-- 크론 삭제:     select cron.unschedule('check-seats-every-minute');
