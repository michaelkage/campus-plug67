-- Fix the ticker university index created by migration 006.
-- PostgreSQL does not allow the volatile/stable `now()` function in an index
-- predicate. Expiry is evaluated at query time instead.

drop index if exists public.ticker_university_idx;

create index if not exists ticker_university_idx
on public.ticker_events (university, created_at desc);
