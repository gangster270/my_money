-- ═══════════════════════════════════════════════════════════════════
--  회의실 예약 — Supabase(PostgreSQL) 스키마
--  Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 Run 하세요.
--  (설치 방법 전체는 rooms/README.md 참고)
-- ═══════════════════════════════════════════════════════════════════

-- 시간 구간 겹침 검사를 위해 필요합니다
create extension if not exists btree_gist;

-- ───────────────────────── 예약 테이블 ─────────────────────────
create table if not exists public.bookings (
  id         text primary key,
  room_id    text        not null,
  date       date        not null,
  start_min  integer     not null,          -- 자정부터 분 단위 (예: 09:30 → 570)
  end_min    integer     not null,
  dept       text        not null,
  name       text        not null,
  title      text        not null default '',
  attendees  integer,
  memo       text        not null default '',
  pin_hash   text        not null,          -- 취소용 비밀번호의 해시 (원문 저장 안 함)
  created_at timestamptz not null default now(),

  constraint bookings_time_ok  check (end_min > start_min),
  constraint bookings_range_ok check (start_min >= 0 and end_min <= 1440),
  constraint bookings_len_ok   check (
    length(dept) between 1 and 40 and
    length(name) between 1 and 40 and
    length(title) <= 120 and
    length(memo)  <= 500 and
    length(room_id) <= 40 and
    length(id) <= 60
  )
);

-- ★ 핵심: 같은 회의실 · 같은 날짜에 시간이 겹치는 예약을 데이터베이스가 거부합니다.
--   두 사람이 동시에 «예약» 을 눌러도 한 건만 저장됩니다.
alter table public.bookings drop constraint if exists bookings_no_overlap;
alter table public.bookings add constraint bookings_no_overlap
  exclude using gist (
    room_id with =,
    date    with =,
    int4range(start_min, end_min) with &&
  );

create index if not exists bookings_date_idx on public.bookings (date, start_min);

-- ───────────────────────── 공용 설정 테이블 ─────────────────────────
create table if not exists public.app_config (
  key   text primary key,
  value jsonb not null
);

-- ───────────────────────── 권한 (중요) ─────────────────────────
alter table public.bookings   enable row level security;
alter table public.app_config enable row level security;

-- 익명 키로는 «조회 + 등록» 만 가능하고, 수정·삭제는 아래 함수로만 할 수 있습니다.
revoke all on public.bookings   from anon, authenticated;
revoke all on public.app_config from anon, authenticated;

-- pin_hash 는 아예 읽을 수 없도록 컬럼 단위로 권한을 줍니다.
grant select (id, room_id, date, start_min, end_min, dept, name, title,
              attendees, memo, created_at) on public.bookings to anon, authenticated;
grant insert (id, room_id, date, start_min, end_min, dept, name, title,
              attendees, memo, pin_hash)  on public.bookings to anon, authenticated;
grant select on public.app_config to anon, authenticated;

drop policy if exists bookings_read   on public.bookings;
drop policy if exists bookings_write  on public.bookings;
drop policy if exists config_read     on public.app_config;

create policy bookings_read  on public.bookings   for select using (true);
create policy bookings_write on public.bookings   for insert with check (true);
create policy config_read    on public.app_config for select using (true);

-- ───────────────────────── 예약 취소 함수 ─────────────────────────
-- 본인 비밀번호 또는 관리자 비밀번호가 맞을 때만 삭제합니다(서버에서 검증).
create or replace function public.cancel_booking(p_id text, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash  text;
  v_admin text;
begin
  select pin_hash into v_hash from bookings where id = p_id;
  if v_hash is null then
    return false;
  end if;

  select value ->> 'adminPinHash' into v_admin from app_config where key = 'main';

  if v_hash = p_pin or (v_admin is not null and v_admin = p_pin) then
    delete from bookings where id = p_id;
    return true;
  end if;

  return false;
end;
$$;

-- ───────────────────────── 설정 저장 함수 ─────────────────────────
-- 관리자 비밀번호가 이미 정해져 있으면 일치할 때만 저장됩니다.
create or replace function public.set_app_config(p_value jsonb, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin text;
begin
  select value ->> 'adminPinHash' into v_admin from app_config where key = 'main';

  if v_admin is not null and v_admin is distinct from p_pin then
    raise exception '관리자 비밀번호가 맞지 않습니다.';
  end if;

  insert into app_config (key, value) values ('main', p_value)
  on conflict (key) do update set value = excluded.value;

  return true;
end;
$$;

revoke all on function public.cancel_booking(text, text)  from public;
revoke all on function public.set_app_config(jsonb, text) from public;
grant execute on function public.cancel_booking(text, text)  to anon, authenticated;
grant execute on function public.set_app_config(jsonb, text) to anon, authenticated;
