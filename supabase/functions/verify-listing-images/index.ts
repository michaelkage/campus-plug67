import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { jsonResponse, optionsResponse, getAuthenticatedUser } from "../_shared/auth.ts";
import exifr from "npm:exifr@7.1.3";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type Listing = { id: string; seller_id: string; university: string | null };
type VerificationResult = {
  image_url: string;
  gps_lat: number | null;
  gps_lng: number | null;
  gps_mismatch: boolean;
  timestamp_flag: boolean;
  make: string | null;
  model: string | null;
  software: string | null;
};

const UNI_BOUNDS: Record<string, [number, number, number, number]> = {
  "University of Lagos": [6.495, 6.520, 3.390, 3.415],
  "Obafemi Awolowo University": [7.516, 7.535, 4.515, 4.535],
  "University of Ibadan": [7.440, 7.460, 3.890, 3.910],
  "University of Benin": [6.393, 6.415, 5.602, 5.625],
  "Ahmadu Bello University": [11.155, 11.180, 7.645, 7.670],
  "Yaba College of Technology": [6.497, 6.512, 3.375, 3.392],
  "Lagos State University": [6.555, 6.580, 3.290, 3.320],
  "University of Nigeria Nsukka": [6.853, 6.880, 7.390, 7.420],
};

function scalar(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function sanitizeExif(exif: Record<string, unknown>) {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(exif)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") output[key] = value;
  }
  return output;
}

async function verifyImage(imageUrl: string, university: string | null): Promise<VerificationResult> {
  const response = await fetch(imageUrl, { redirect: "error" });
  if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) throw new Error("Stored object is not an image");

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Image too large for verification");
  const exif = await exifr.parse(bytes, {
    gps: true, ifd0: true, exif: true, translateKeys: true, translateValues: true,
  }).catch(() => null) as Record<string, unknown> | null;

  const lat = typeof exif?.latitude === "number" ? exif.latitude : null;
  const lng = typeof exif?.longitude === "number" ? exif.longitude : null;
  let gpsMismatch = false;
  const bounds = university ? UNI_BOUNDS[university] : undefined;
  if (bounds && lat !== null && lng !== null) {
    const [latMin, latMax, lngMin, lngMax] = bounds;
    gpsMismatch = !(lat >= latMin && lat <= latMax && lng >= lngMin && lng <= lngMax);
  }

  const imageDate = scalar(exif?.DateTimeOriginal) ?? scalar(exif?.DateTime);
  let timestampFlag = false;
  if (imageDate !== null) {
    const imageTs = new Date(imageDate).getTime();
    if (Number.isFinite(imageTs)) {
      const diffMs = Date.now() - imageTs;
      timestampFlag = diffMs > 5 * 365 * 24 * 3600 * 1000 || diffMs < -3_600_000;
    }
  }

  return {
    image_url: imageUrl,
    gps_lat: lat,
    gps_lng: lng,
    gps_mismatch: gpsMismatch,
    timestamp_flag: timestampFlag,
    make: typeof exif?.Make === "string" ? exif.Make : null,
    model: typeof exif?.Model === "string" ? exif.Model : null,
    software: typeof exif?.Software === "string" ? exif.Software : null,
  };
}

async function verifyListing(listingId: string, userId: string) {
  const { data: listing, error } = await admin
    .from("listings")
    .select("id,seller_id,university,images")
    .eq("id", listingId)
    .single();
  if (error || !listing) throw new Error("Listing not found");
  if (listing.seller_id !== userId) throw new Error("Not authorized for this listing");

  const images = Array.isArray(listing.images) ? listing.images.filter((v): v is string => typeof v === "string") : [];
  const results: VerificationResult[] = [];
  for (const imageUrl of images.slice(0, 4)) {
    try {
      results.push(await verifyImage(imageUrl, listing.university));
    } catch (error) {
      console.warn("server image verification failed", imageUrl, error instanceof Error ? error.message : error);
    }
  }

  if (!results.length) return { verified: false, processed: 0 };

  await admin.from("listing_exif_flags").delete().eq("listing_id", listingId).eq("verification_source", "server_verified");
  const rows = results.map((result) => ({
    listing_id: listingId,
    image_url: result.image_url,
    gps_lat: result.gps_lat,
    gps_lng: result.gps_lng,
    gps_mismatch: result.gps_mismatch,
    timestamp_flag: result.timestamp_flag,
    make: result.make,
    model: result.model,
    software: result.software,
    raw_exif: null,
    verification_source: "server_verified",
    verified_at: new Date().toISOString(),
  }));
  const { error: insertError } = await admin.from("listing_exif_flags").insert(rows);
  if (insertError) throw insertError;

  const clean = results.every((result) => !result.gps_mismatch && !result.timestamp_flag);
  await admin.from("listings").update({ metadata_verified: clean }).eq("id", listingId).eq("seller_id", userId);
  return { verified: clean, processed: results.length, flagged: results.filter((r) => r.gps_mismatch || r.timestamp_flag).length };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
  const user = await getAuthenticatedUser(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);

  const body: unknown = await req.json().catch(() => null);
  if (typeof body !== "object" || body === null) return jsonResponse({ error: "Invalid JSON" }, 400, {}, req);
  const listingId = typeof (body as Record<string, unknown>).listing_id === "string" ? (body as Record<string, unknown>).listing_id as string : "";
  if (!listingId) return jsonResponse({ error: "Missing listing_id" }, 400, {}, req);

  // The browser can request verification, but cannot supply EXIF/GPS results.
  // The function re-downloads the stored bytes and calculates all security signals itself.
  const result = await verifyListing(listingId, user.id).catch((error) => {
    console.error("listing verification failed", error);
    return null;
  });
  if (!result) return jsonResponse({ error: "Verification failed" }, 500, {}, req);
  return jsonResponse({ success: true, ...result }, 200, {}, req);
});
