-- Search titles and descriptions without scanning every active listing.
-- PostgreSQL maintains this generated vector on every insert/update.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS listings_search_vector_gin_idx
  ON public.listings USING gin (search_vector);

COMMENT ON COLUMN public.listings.search_vector IS
  'Generated full-text search vector; title is weighted above description.';
