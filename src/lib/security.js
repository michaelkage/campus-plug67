/**
 * Campus Plug — Security Utilities
 *
 * FIX #4: allowed_domains column is `institution_name`, not `university`.
 *         validateEduEmail in supabase.ts was querying `.select('university')` —
 *         fixed there to use `institution_name` (see supabase.ts).
 *
 * FIX #5: banned_devices column is `device_fingerprint`, not `device_hash`.
 *         registerDevice() and AuthContext.checkDeviceBan() were querying
 *         `.eq('device_hash', ...)` — corrected to `.eq('device_fingerprint', ...)`.
 *         The user_security upsert that stores device records is untouched —
 *         that table has a `device_hash` column (it is a separate security events
 *         table, not banned_devices).
 *
 * 1. Device fingerprinting via FingerprintJS
 * 2. EXIF metadata analysis + GPS mismatch detection
 * 3. Price floor enforcement with emergency sale tokens
 */

import { supabase } from '@/lib/supabase'

// ── University GPS bounding boxes ─────────────────────────────────────────────
// [lat_min, lat_max, lng_min, lng_max]
const UNI_BOUNDS = {
  'University of Lagos':          [6.495, 6.520,  3.390, 3.415],
  'Obafemi Awolowo University':   [7.516, 7.535,  4.515, 4.535],
  'University of Ibadan':         [7.440, 7.460,  3.890, 3.910],
  'University of Benin':          [6.393, 6.415,  5.602, 5.625],
  'Ahmadu Bello University':      [11.155, 11.180, 7.645, 7.670],
  'Yaba College of Technology':   [6.497, 6.512,  3.375, 3.392],
  'Lagos State University':       [6.555, 6.580,  3.290, 3.320],
  'University of Nigeria Nsukka': [6.853, 6.880,  7.390, 7.420],
}

// ── 1. DEVICE FINGERPRINTING ──────────────────────────────────────────────────

let _fpPromise = null

/**
 * Get FingerprintJS visitorId (device hash).
 * Lazy-loads the library on first call; subsequent calls return cached promise.
 */
export async function getDeviceHash() {
  if (!_fpPromise) {
    _fpPromise = import('@fingerprintjs/fingerprintjs')
      .then(async (FpJS) => {
        const fp     = await FpJS.default.load({ monitoring: false })
        const result = await fp.get()
        return result.visitorId
      })
      .catch(() => {
        // Fallback: generate a persistent local hash
        let stored = localStorage.getItem('_cp_dh')
        if (!stored) {
          stored = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
          localStorage.setItem('_cp_dh', stored)
        }
        return stored
      })
  }
  return _fpPromise
}

/**
 * Register device fingerprint for a logged-in user.
 * FIX #5: Checks banned_devices using `device_fingerprint` (correct column name).
 */
export async function registerDevice(userId) {
  const deviceHash = await getDeviceHash()

  // FIX #5: column is `device_fingerprint`, NOT `device_hash`
  const { data: banned } = await supabase
    .from('banned_devices')
    .select('ban_reason')
    .eq('device_fingerprint', deviceHash)
    .maybeSingle()

  if (banned) {
    throw new Error(
      `DEVICE_BANNED: ${banned.ban_reason || 'This device has been flagged for policy violations.'}`
    )
  }

  // user_security stores device registration records (device_hash column is correct here —
  // this is a different table from banned_devices)
  const { error } = await supabase.from('user_security').upsert(
    {
      user_id:      userId,
      device_hash:  deviceHash,
      device_label: getDeviceLabel(),
      last_seen_at: new Date().toISOString(),
      trusted:      true,
    },
    { onConflict: 'user_id,device_hash' }
  )

  if (error) console.warn('Device registration error:', error.message)
  return deviceHash
}

function getDeviceLabel() {
  const ua = navigator.userAgent
  const browser =
    ua.includes('Chrome')  ? 'Chrome'  :
    ua.includes('Firefox') ? 'Firefox' :
    ua.includes('Safari')  ? 'Safari'  : 'Browser'
  const os =
    ua.includes('iPhone')  ? 'iPhone'  :
    ua.includes('iPad')    ? 'iPad'    :
    ua.includes('Android') ? 'Android' :
    ua.includes('Mac')     ? 'macOS'   :
    ua.includes('Win')     ? 'Windows' : 'Unknown'
  return `${browser} · ${os}`
}

// ── 2. EXIF METADATA ANALYSIS ─────────────────────────────────────────────────

/**
 * Analyze EXIF data from an image File object.
 * Returns flags for GPS mismatch and timestamp anomalies.
 * Strips all EXIF before upload (returns clean blob).
 */
export async function analyzeAndStripExif(file, userUniversity) {
  const result = {
    gps_lat:        null,
    gps_lng:        null,
    gps_mismatch:   false,
    timestamp_flag: false,
    make:           null,
    model:          null,
    software:       null,
    raw_exif:       null,
    clean_blob:     null,
  }

  try {
    const exifr = await import('exifr')

    const exif = await exifr.default
      .parse(file, {
        gps:             true,
        ifd0:            true,
        exif:            true,
        translateKeys:   true,
        translateValues: true,
      })
      .catch(() => null)

    if (exif) {
      result.raw_exif = sanitizeExif(exif)
      result.make     = exif.Make     || null
      result.model    = exif.Model    || null
      result.software = exif.Software || null

      if (exif.latitude && exif.longitude) {
        result.gps_lat = exif.latitude
        result.gps_lng = exif.longitude

        const bounds = UNI_BOUNDS[userUniversity]
        if (bounds) {
          const [latMin, latMax, lngMin, lngMax] = bounds
          const inBounds =
            exif.latitude  >= latMin && exif.latitude  <= latMax &&
            exif.longitude >= lngMin && exif.longitude <= lngMax
          result.gps_mismatch = !inBounds
        }
      }

      const imageDate = exif.DateTimeOriginal || exif.DateTime
      if (imageDate) {
        const imagTs     = new Date(imageDate).getTime()
        const now        = Date.now()
        const diffMs     = now - imagTs
        const fiveYearsMs = 5 * 365 * 24 * 3600 * 1000
        if (diffMs > fiveYearsMs || diffMs < -3_600_000) {
          result.timestamp_flag = true
        }
      }
    }

    result.clean_blob = await stripExif(file)
  } catch (err) {
    console.warn('EXIF analysis error:', err.message)
    result.clean_blob = file
  }

  return result
}

async function stripExif(file) {
  if (
    !file.type.includes('jpeg') &&
    !file.type.includes('jpg') &&
    !file.type.includes('webp')
  ) {
    return file
  }

  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const canvas  = document.createElement('canvas')
      canvas.width  = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      canvas.toBlob(
        (blob) => resolve(new File([blob], file.name, { type: 'image/jpeg' })),
        'image/jpeg',
        0.92
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(file)
    }
    img.src = url
  })
}

function sanitizeExif(exif) {
  const safe = {}
  for (const [k, v] of Object.entries(exif)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      safe[k] = v
    }
  }
  return safe
}

/**
 * Save EXIF analysis results to the database after listing is created.
 */
export async function saveExifFlags(listingId, imageUrl, exifResult) {
  const {
    gps_lat, gps_lng, gps_mismatch, timestamp_flag,
    make, model, software, raw_exif,
  } = exifResult

  const { error } = await supabase.from('listing_exif_flags').insert({
    listing_id:     listingId,
    image_url:      imageUrl,
    gps_lat,
    gps_lng,
    gps_mismatch,
    timestamp_flag,
    make,
    model,
    software,
    raw_exif,
  })

  if (error) console.warn('EXIF flag save error:', error.message)

  if (gps_mismatch || timestamp_flag) {
    await supabase.from('listings').update({ exif_flagged: true }).eq('id', listingId)
  }
}

// ── 3. PRICE FLOOR ENFORCEMENT ────────────────────────────────────────────────

/**
 * Check if a price violates the category floor.
 */
export async function checkPriceFloor(priceNaira, category, university, userId) {
  const priceKobo = Math.round(priceNaira * 100)

  const { data: floorData, error } = await supabase.rpc('get_price_floor', {
    p_category:   category,
    p_university: university,
  })

  if (error || !floorData?.has_floor) {
    return { allowed: true, floor_price: null, needs_token: false, token_available: false }
  }

  const floorKobo = floorData.floor_price

  if (priceKobo >= floorKobo) {
    return { allowed: true, floor_price: floorKobo, needs_token: false, token_available: false, savings_pct: 0 }
  }

  const monthKey = new Date().toISOString().slice(0, 7)
  await supabase.rpc('provision_emergency_tokens', { p_user_id: userId })

  const { data: tokens } = await supabase
    .from('emergency_sale_tokens')
    .select('id, used')
    .eq('user_id', userId)
    .eq('month_year', monthKey)
    .eq('used', false)

  const below_pct = Math.round((1 - priceKobo / floorKobo) * 100)

  return {
    allowed:             false,
    floor_price:         floorKobo,
    needs_token:         true,
    token_available:     (tokens?.length ?? 0) > 0,
    tokens_remaining:    tokens?.length ?? 0,
    below_pct,
    available_token_id:  tokens?.[0]?.id ?? null,
  }
}

/**
 * Consume an emergency sale token for a listing.
 */
export async function consumeEmergencyToken(tokenId, listingId) {
  const { error } = await supabase
    .from('emergency_sale_tokens')
    .update({ used: true, used_at: new Date().toISOString(), used_for: listingId })
    .eq('id', tokenId)
    .eq('used', false)

  return !error
}
