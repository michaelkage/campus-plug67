-- Campus Plug: marketplace permissions, academic cohorts, categorisation and order notifications.
-- Timestamped after the existing 050+ social schema migrations so group tables exist first.

-- Gigs: fix the exact 42501 permission-denied failure without disabling RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.gigs TO authenticated;
GRANT SELECT ON TABLE public.gigs TO anon;
ALTER TABLE public.gigs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Gigs viewable by all" ON public.gigs;
DROP POLICY IF EXISTS "Gigs view active listings" ON public.gigs;
CREATE POLICY "Gigs view active listings" ON public.gigs
  FOR SELECT TO anon, authenticated USING (active = true OR auth.uid() = seller_id);
DROP POLICY IF EXISTS "Auth users create gigs" ON public.gigs;
DROP POLICY IF EXISTS "Sellers create own gigs" ON public.gigs;
CREATE POLICY "Sellers create own gigs" ON public.gigs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = seller_id);
DROP POLICY IF EXISTS "Sellers update own gigs" ON public.gigs;
CREATE POLICY "Sellers update own gigs" ON public.gigs
  FOR UPDATE TO authenticated USING (auth.uid() = seller_id) WITH CHECK (auth.uid() = seller_id);
DROP POLICY IF EXISTS "Sellers delete own gigs" ON public.gigs;
CREATE POLICY "Sellers delete own gigs" ON public.gigs
  FOR DELETE TO authenticated USING (auth.uid() = seller_id);

-- Academic programme/course. Department and university already exist in profiles.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS course text;
CREATE INDEX IF NOT EXISTS profiles_university_department_idx ON public.profiles (university, department);
CREATE INDEX IF NOT EXISTS profiles_university_course_idx ON public.profiles (university, course);

-- Keep the Auth trigger authoritative: email-confirmation signups must not depend
-- on a client-side profile UPDATE (which has no authenticated session yet).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  INSERT INTO public.profiles
    (id, email, full_name, university, department, course, matric_number, is_verified)
  VALUES
    (NEW.id,
     NEW.email,
     COALESCE(NULLIF(btrim(NEW.raw_user_meta_data->>'full_name'), ''), split_part(NEW.email, '@', 1)),
     NULLIF(btrim(NEW.raw_user_meta_data->>'university'), ''),
     NULLIF(btrim(NEW.raw_user_meta_data->>'department'), ''),
     NULLIF(btrim(NEW.raw_user_meta_data->>'course'), ''),
     NULLIF(btrim(NEW.raw_user_meta_data->>'matric'), ''),
     false)
  ON CONFLICT (id) DO UPDATE SET
    full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
    university = COALESCE(EXCLUDED.university, public.profiles.university),
    department = COALESCE(EXCLUDED.department, public.profiles.department),
    course = COALESCE(EXCLUDED.course, public.profiles.course),
    matric_number = COALESCE(EXCLUDED.matric_number, public.profiles.matric_number);
  RETURN NEW;
END;
$;


-- Expanded categories are accepted by the database, not merely displayed in the UI.
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS subcategory text;
ALTER TABLE public.listings DROP CONSTRAINT IF EXISTS listings_category_check;
ALTER TABLE public.listings ADD CONSTRAINT listings_category_check CHECK (category IN (
  'Textbooks','Electronics','Hostels','Gadgets','Clothing','Lab Equipment','Other',
  'Stationery & Supplies','Course Materials','Study Tools & Calculators','Past Questions & Exam Prep',
  'Engineering Tools','Phone Accessories','Gaming & Consoles','Audio & Speakers','Charging & Power',
  'Headphones & Earbuds','Computer Accessories','Phones & Wearables','Networking & Smart Home',
  'Musical Instruments','Music Accessories','Sports & Fitness','Bicycles & Transport','Outdoor Gear',
  'Shoes & Sneakers','Bags & Accessories','Jewellery & Watches','Beauty & Personal Care','Home & Decor',
  'Furniture','Kitchen & Appliances','Bedding','Cleaning Supplies','Art & Craft Supplies',
  'Photography & Video','Snacks & Drinks','Groceries','Tickets & Events'
));

CREATE OR REPLACE FUNCTION public.campus_plug_suggest_category(p_title text)
RETURNS TABLE(category text, subcategory text)
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT
    CASE
      WHEN lower(coalesce(p_title,'')) ~ '(oraimo|boom pop|power bank|charger|earbud|earphone|headphone|bluetooth speaker|smart watch|usb drive|flash drive|keyboard|mouse|monitor|laptop|phone|tablet|gamepad|controller|console|router|projector)' THEN 'Electronics'
      WHEN lower(coalesce(p_title,'')) ~ '(textbook|lecture note|past question|workbook|calculator|lab coat|drawing board|stationery|notebook|pen set)' THEN 'Textbooks'
      WHEN lower(coalesce(p_title,'')) ~ '(shoe|sneaker|shirt|jean|trouser|hoodie|dress|bag|watch)' THEN 'Clothing'
      WHEN lower(coalesce(p_title,'')) ~ '(rice cooker|blender|kettle|microwave|fan|fridge|mattress|chair|table|bedsheet)' THEN 'Home & Decor'
      WHEN lower(coalesce(p_title,'')) ~ '(football|basketball|dumbbell|bicycle|bike|tennis racket)' THEN 'Sports & Fitness'
      ELSE 'Other'
    END,
    CASE
      WHEN lower(coalesce(p_title,'')) ~ '(oraimo|boom pop|bluetooth speaker|speaker)' THEN 'Audio & Speakers'
      WHEN lower(coalesce(p_title,'')) ~ '(power bank|charger|cable|adapter)' THEN 'Charging & Power'
      WHEN lower(coalesce(p_title,'')) ~ '(earbud|earphone|headphone)' THEN 'Headphones & Earbuds'
      WHEN lower(coalesce(p_title,'')) ~ '(laptop|keyboard|mouse|monitor|usb drive|flash drive)' THEN 'Computer Accessories'
      WHEN lower(coalesce(p_title,'')) ~ '(phone|tablet|smart watch)' THEN 'Phones & Wearables'
      WHEN lower(coalesce(p_title,'')) ~ '(textbook|lecture note|past question|workbook)' THEN 'Course Materials'
      ELSE NULL
    END;
$$;

-- Uniqueness lets concurrent signups safely share one group per cohort.
CREATE UNIQUE INDEX IF NOT EXISTS group_chats_department_cohort_unique
  ON public.group_chats (university, lower(name)) WHERE course_code IS NULL AND is_archived = false;
CREATE UNIQUE INDEX IF NOT EXISTS group_chats_course_cohort_unique
  ON public.group_chats (university, lower(name)) WHERE course_code IS NOT NULL AND is_archived = false;

CREATE OR REPLACE FUNCTION public.sync_student_cohort_groups()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  dept_group_id uuid;
  course_group_id uuid;
  dept_name text;
  course_name text;
BEGIN
  IF NULLIF(btrim(NEW.university),'') IS NULL OR NULLIF(btrim(NEW.department),'') IS NULL THEN
    RETURN NEW;
  END IF;
  dept_name := btrim(NEW.department);

  INSERT INTO public.group_chats(name, description, university, course_code, creator_id, is_archived)
  VALUES (NEW.university || ' · ' || dept_name || ' Department',
          'General department group for ' || dept_name, NEW.university, NULL, NEW.id, false)
  ON CONFLICT (university, lower(name)) WHERE course_code IS NULL AND is_archived = false DO NOTHING;

  SELECT id INTO dept_group_id FROM public.group_chats
   WHERE university = NEW.university AND lower(name) = lower(NEW.university || ' · ' || dept_name || ' Department')
     AND course_code IS NULL AND is_archived = false LIMIT 1;
  IF dept_group_id IS NOT NULL THEN
    INSERT INTO public.group_chat_members(group_id, user_id, role)
    VALUES (dept_group_id, NEW.id, 'member') ON CONFLICT (group_id, user_id) DO NOTHING;
  END IF;

  IF NULLIF(btrim(NEW.course),'') IS NOT NULL THEN
    course_name := btrim(NEW.course);
    INSERT INTO public.group_chats(name, description, university, course_code, creator_id, is_archived)
    VALUES (NEW.university || ' · ' || course_name,
            'Course group for ' || course_name, NEW.university, course_name, NEW.id, false)
    ON CONFLICT (university, lower(name)) WHERE course_code IS NOT NULL AND is_archived = false DO NOTHING;
    SELECT id INTO course_group_id FROM public.group_chats
     WHERE university = NEW.university AND lower(course_code) = lower(course_name)
       AND is_archived = false LIMIT 1;
    IF course_group_id IS NOT NULL THEN
      INSERT INTO public.group_chat_members(group_id, user_id, role)
      VALUES (course_group_id, NEW.id, 'member') ON CONFLICT (group_id, user_id) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_student_cohort_groups ON public.profiles;
CREATE TRIGGER sync_student_cohort_groups
AFTER INSERT OR UPDATE OF university, department, course ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_student_cohort_groups();
REVOKE ALL ON FUNCTION public.sync_student_cohort_groups() FROM PUBLIC, anon, authenticated;

-- Database-owned notifications for new transactions and material order-state transitions.
CREATE OR REPLACE FUNCTION public.notify_transaction_parties()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  item_title text;
BEGIN
  SELECT title INTO item_title FROM public.listings WHERE id = NEW.listing_id;
  item_title := coalesce(item_title, 'your item');
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.notifications(user_id,type,title,body,data) VALUES
      (NEW.seller_id,'purchase_request','You have a new purchase request','A buyer has started a purchase for ' || item_title || '.',
       jsonb_build_object('transaction_id',NEW.id,'listing_id',NEW.listing_id,'status',NEW.status)),
      (NEW.buyer_id,'purchase_started','Purchase started','Your order for ' || item_title || ' has been created.',
       jsonb_build_object('transaction_id',NEW.id,'listing_id',NEW.listing_id,'status',NEW.status));
    RETURN NEW;
  END IF;
  -- The existing transaction trigger already alerts the seller on escrow lock
  -- and both parties on release. Only add the buyer-facing processing notice here.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'locked' THEN
    INSERT INTO public.notifications(user_id,type,title,body,data)
    VALUES (NEW.buyer_id,'order_processing','Your order is being processed',
      'Payment is confirmed. Your order for ' || item_title || ' is now being processed.',
      jsonb_build_object('transaction_id',NEW.id,'listing_id',NEW.listing_id,'status',NEW.status));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_transaction_parties() FROM PUBLIC, anon, authenticated;

-- Enrol existing profiles with academic data using the same idempotent trigger.
UPDATE public.profiles SET course = course WHERE university IS NOT NULL AND department IS NOT NULL;
