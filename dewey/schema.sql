-- Dewey app schema. Run once in Supabase: SQL Editor → New query → paste → Run.
-- Every row belongs to one signed-in user; row-level security means nobody can read or change anyone else's books.

-- ---------- books ----------
create table if not exists public.books (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- the book
  title         text not null check (char_length(title) between 1 and 500),
  subtitle      text,
  authors       text[] not null default '{}',
  isbn13        text,
  isbn10        text,
  publisher     text,
  published     text,            -- usually a year; text so "c. 1890" is allowed
  pages         integer check (pages is null or pages > 0),
  description   text,
  cover_url     text,            -- cover image from Open Library / Google Books
  cover_path    text,            -- your own photo, in the "covers" storage bucket
  subjects      text[] not null default '{}',   -- raw subject headings from the lookup
  source        text,

  -- your categories
  categories    text[] not null default '{}',

  -- your copy
  format        text,
  condition     text,
  location      text,
  acquired_on   date,
  acquired_from text,
  loaned_to     text,
  notes         text,

  -- reading, rating, review
  status        text not null default 'unread'
                check (status in ('wishlist', 'unread', 'reading', 'read', 'dnf')),
  rating        smallint check (rating between 1 and 5),
  review        text,
  started_on    date,
  finished_on   date
);

create index if not exists books_user_created_idx on public.books (user_id, created_at desc);
create index if not exists books_user_isbn_idx    on public.books (user_id, isbn13);

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists books_touch on public.books;
create trigger books_touch before update on public.books
  for each row execute function public.touch_updated_at();

alter table public.books enable row level security;

drop policy if exists "Read own books"   on public.books;
drop policy if exists "Add own books"    on public.books;
drop policy if exists "Edit own books"   on public.books;
drop policy if exists "Delete own books" on public.books;
create policy "Read own books"   on public.books for select to authenticated using ((select auth.uid()) = user_id);
create policy "Add own books"    on public.books for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Edit own books"   on public.books for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Delete own books" on public.books for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------- categories ----------
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.categories enable row level security;

drop policy if exists "Read own categories"   on public.categories;
drop policy if exists "Add own categories"    on public.categories;
drop policy if exists "Edit own categories"   on public.categories;
drop policy if exists "Delete own categories" on public.categories;
create policy "Read own categories"   on public.categories for select to authenticated using ((select auth.uid()) = user_id);
create policy "Add own categories"    on public.categories for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Edit own categories"   on public.categories for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Delete own categories" on public.categories for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.books, public.categories to authenticated;

-- ---------- cover photos ----------
-- Public-read bucket (covers aren't private); each user can only write inside a folder named with their user id.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "Upload own covers" on storage.objects;
drop policy if exists "Read own covers"   on storage.objects;
drop policy if exists "Update own covers" on storage.objects;
drop policy if exists "Delete own covers" on storage.objects;
create policy "Upload own covers" on storage.objects for insert to authenticated
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Read own covers" on storage.objects for select to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Update own covers" on storage.objects for update to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Delete own covers" on storage.objects for delete to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
