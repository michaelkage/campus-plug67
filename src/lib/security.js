/**
 * Campus Plug — Security Utilities
 *
 * Device checks are server-authoritative. The browser fingerprint is retained
 * only as a correlation signal; it is never trusted as proof of device identity.
 * Browser EXIF is advisory only; authoritative verification runs in Supabase.
 */

import { supabase } from '@/lib/supabase'

const UNI_BOUNDS = {
  'University of Lagos': [6.495, 6.520, 3.390, 3.415],
  'Obafemi Awolowo University': [7.516, 7.535, 4.515, 4.535],
  'University of Ibadan': [7.440, 7.460, 3.890, 3.910],
  'University of Benin': [6.393, 6.415, 5.602, 5.625],
  'Ahmadu Bello University': [11.155, 11.180, 7.645, 7.670],
  'Yaba College of Technology': [6.497, 6.512, 3.375, 3.392],
  'Lagos State University': [6.555, 6.580, 3.290, 3.320],
  'University of Nigeria Nsukka': [6.853, 6.880, 7.390, 7.420],
}

let _fpPromise = null

export async function getDeviceHash() {
  if (!_fpPromise) {
    _fpPromise = import('@fingerprintjs/fingerprintjs')
      .then(async (FpJS) => {
        const fp = await FpJS.default.load({ monitoring: false })
        const result = await fp.get()
        return result.visitorId
      })
      .catch(() => {
        let stored = localStorage.getItem('_cp_dh')
        if (!stored) {
          stored = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0')).join('')
          localStorage.setItem('_cp_dh', stored)
        }
        return stored
      })
  }
  return _fpPromise
}

export async function registerDevice(userId) {
  const clientFingerprint = await getDeviceHash().catch(() => null)
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token || session.user.id !== userId) throw new Error('Unauthorized')

  const { data, error } = await supabase.functions.invoke('security-gate', {
    body: { action: 'register', client_fingerprint: clientFingerprint },
  })
  if (error) throw new Error(error.message || 'Security service unavailable')
  if (data?.error?.startsWith?.('DEVICE_BANNED')) throw new Error(data.error)
  if (!data?.success) throw new Error('Security registration failed')
  return data.server_fingerprint || clientFingerprint
}

/**
 * Browser-side analysis is UX/advisory only. It never grants score or trust.
 * The uploaded, stored bytes are independently re-downloaded and verified by
 * the verify-listing-images Edge Function.
 */
export async function analyzeAndStripExif(file, userUniversity) {
  const result = {
    gps_lat: null, gps_lng: null, gps_mismatch: false, timestamp_flag: false,
    make: null, model: null, software: null, raw_exif: null, clean_blob: null,
  }

  try {
    const exifr = await import('exifr')
    const exif = await exifr.default.parse(file, {
      gps: true, ifd0: true, exif: true, translateKeys: true, translateValues: true,
    }).catch(() => null)

    if (exif) {
      result.raw_exif = sanitizeExif(exif)
      result.make = exif.Make || null
      result.model = exif.Model || null
      result.software = exif.Software || null

      if (exif.latitude != null && exif.longitude != null) {
        result.gps_lat = exif.latitude
        result.gps_lng = exif.longitude
        const bounds = UNI_BOUNDS[userUniversity]
        if (bounds) {
          const [latMin, latMax, lngMin, lngMax] = bounds
          result.gps_mismatch = !(
            exif.latitude >= latMin && exif.latitude <= latMax &&
            exif.longitude >= lngMin && exif.longitude <= lngMax
          )
        }
      }

      const imageDate = exif.DateTimeOriginal || exif.DateTime
      if (imageDate) {
        const imageTs = new Date(imageDate).getTime()
        const diffMs = Date.now() - imageTs
        const fiveYearsMs = 5 * 365 * 24 * 3600 * 1000
        if (diffMs > fiveYearsMs || diffMs < -3_600_000) result.timestamp_flag = true
      }
    }
    result.clean_blob = await stripExif(file)
  } catch (err) {
    console.warn('EXIF analysis error:', err?.message || err)
    result.clean_blob = file
  }
  return result
}

async function stripExif(file) {
  if (!file.type.includes('jpeg') && !file.type.includes('jpg') && !file.type.includes('webp')) return file
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      canvas.toBlob((blob) => resolve(new File([blob], file.name, { type: 'image/jpeg' })), 'image/jpeg', 0.92)
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })
}

function sanitizeExif(exif) {
  const safe = {}
  for (const [k, v] of Object.entries(exif)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') safe[k] = v
  }
  return safe
}

/**
 * Preserve the existing Marketplace call-site, but never persist browser EXIF.
 * This schedules authoritative server verification for the stored listing images.
 */
export async function saveExifFlags(listingId, _imageUrl, _exifResult) {
  const { error } = await supabase.functions.invoke('verify-listing-images', {
    body: { listing_id: listingId },
  })
  if (error) console.warn('Server image verification request failed:', error.message)
}

export async function checkPriceFloor(priceNaira, category, university, userId) {
  const priceKobo = Math.round(priceNaira * 100)
  const { data: floorData, error } = await supabase.rpc('get_price_floor', {
    p_category: category, p_university: university,
  })
  if (error || !floorData?.has_floor) return { allowed: true, floor_price: null, needs_token: false, token_available: false }
  const floorKobo = floorData.floor_price
  if (priceKobo >= floorKobo) return { allowed: true, floor_price: floorKobo, needs_token: false, token_available: false, savings_pct: 0 }

  const monthKey = new Date().toISOString().slice(0, 7)
  await supabase.rpc('provision_emergency_tokens', { p_user_id: userId })
  const { data: tokens } = await supabase.from('emergency_sale_tokens')
    .select('id, used').eq('user_id', userId).eq('month_year', monthKey).eq('used', false)
  const below_pct = Math.round((1 - priceKobo / floorKobo) * 100)
  return {
    allowed: false, floor_price: floorKobo, needs_token: true,
    token_available: (tokens?.length ?? 0) > 0, tokens_remaining: tokens?.length ?? 0,
    below_pct, available_token_id: tokens?.[0]?.id ?? null,
  }
}

export async function consumeEmergencyToken(tokenId, listingId) {
  const { data, error } = await supabase.from('emergency_sale_tokens')
    .update({ used: true, used_at: new Date().toISOString(), used_for: listingId })
    .eq('id', tokenId).eq('used', false).select('id').maybeSingle()
  return !error && !!data
}
