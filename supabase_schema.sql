-- Chạy một lần trong Supabase SQL editor.
create extension if not exists vector;

create table if not exists friday_memory (
  id           bigserial   primary key,
  fact         text        not null check (char_length(fact) <= 500),
  provenance   text        not null check (provenance in ('user', 'tool')),
  embedding    vector(768) not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

-- Defense in depth: the backend uses the service key (bypasses RLS), so all
-- protection currently rests on one secret. Enable RLS with a default-deny so
-- a leaked anon key or misconfigured client cannot read/write memories.
alter table friday_memory enable row level security;

drop policy if exists "deny_all" on friday_memory;
create policy "deny_all" on friday_memory
  for all to anon, authenticated
  using (false)
  with check (false);

-- Chưa có chỉ mục vector: tìm kiếm tương đồng chạy trong process trên cache RAM
-- ở quy mô hiện tại. Thêm ivfflat khi bảng lên hàng nghìn dòng.
