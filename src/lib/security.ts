/**
 * Campus Plug — Security Utilities
 *
 * Device checks are server-authoritative. The browser fingerprint is retained
 * only as a correlation signal; it is never trusted as proof of device identity.
 * Browser EXIF is advisory only; authoritative verification runs in Supabase.
 */

import { supabase } from '@/lib/supabase'

type UniversityBounds = readonly [number, number, number, number]

type ExifResult = {
  gps_lat: number | null
  gps_lng: number | null
  gps_mismatch: boolean
  timestamp_flag: boolean
  make: string | null
  model: string | null
  software: string | null
  raw_exif: Record<string, string | number | boolean> | null
  clean_blob: File
}

type PriceFloorResult = {
  allowed: boolean
  floor_price: number | null
  needs_token: boolean
  token_available: boolean
  savings_pct?: number
  tokens_remaining?: number
  below_pct?: number
  available_token_id?: string | null
}

const UNI_BOUNDS: Record<string, UniversityBounds> = {
  'University of Lagos': [6.495, 6.520, 3.390, 3.415],
  'Obafemi Awolowo University': [7.516, 7.535, 4.515, 4.535],
  'University of Ibadan': [7.440, 7.460, 3.890, 3.910],
  'University of Benin': [6.393, 6.415, 5.602, 5.625],
  'Ahmadu Bello University': [11.155, 11.180, 7.645, 7.670],
  'Yaba College of Technology': [6.497, 6.512, 3.375, 3.392],
  'Lagos State University': [6.555, 6.580, 3.290, 3.320],
  'University of Nigeria Nsukka': [6.853, 6.880, 7.390, 7.420],
}

let fingerprintPromise: Promise<string> | null = null

export async function getDeviceHash(): Promise<string> {
  if (!fingerprintPromise) {
    fingerprintPromise = import('@fingerprintjs/fingerprintjs')
      .then(async ({ default: FingerprintJS }) => {
        const fp = await FingerprintJS.load({ monitoring: false })
        const result = await fp.get()
        return result.visitorId
      })
      .catch(() => {
        let stored = localStorage.getItem('_cp_dh')
        if (!stored) {
          stored = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join('')
          localStorage.setItem('_cp_dh', stored)
        }
        return stored
      })
  }
  return fingerprintPromise
}

export async function registerDevice(userId: string): Promise<string> {
  const clientFingerprint = await getDeviceHash().catch(() => null)
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token || session.user.id !== userId) throw new Error('Unauthorized')

  const { data, error } = await supabase.functions.invoke<{ success?: boolean; error?: string; server_fingerprint?: string }>('security-gate', {
    body: { action: 'register', client_fingerprint: clientFingerprint },
  })
  if (error) throw new Error(error.message || 'Security service unavailable')
  if (data?.error?.startsWith('DEVICE_BANNED')) throw new Error(data.error)
  if (!data?.success) throw new Error('Security registration failed')
  return data.server_fingerprint || clientFingerprint || ''
}

export async function analyzeAndStripExif(file: File, userUniversity: string): Promise<ExifResult> {
  const result: ExifResult = {
    gps_lat: null, gps_lng: null, gps_mismatch: false, timestamp_flag: false,
    make: null, model: null, software: null, raw_exif: null, clean_blob: file,
  }

  try {
    const { default: exifr } = await import('exifr')
    const exif = await exifr.parse(file, {
      gps: true, ifd0: true, exif: true, translateKeys: true, translateValues: true,
    })

    if (exif) {
      result.raw_exif = sanitizeExif(exif as Record<string, unknown>)
      result.make = typeof exif.Make === 'string' ? exif.Make : null
      result.model = typeof exif.Model === 'string' ? exif.Model : null
      result.software = typeof exif.Software === 'string' ? exif.Software : null

      if (typeof exif.latitude === 'number' && typeof exif.longitude === 'number') {
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
        if (Number.isFinite(imageTs)) {
          const diffMs = Date.now() - imageTs
          const fiveYearsMs = 5 * 365 * 24 * 3600 * 1000
          if (diffMs > fiveYearsMs || diffMs < -3_600_000) result.timestamp_flag = true
        }
      }
    }

    result.clean_blob = await stripExif(file)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('EXIF analysis error:', message)
    result.clean_blob = file
  }
  return result
}

async function stripExif(file: File): Promise<File> {
  if (!file.type.includes('jpeg') && !file.type.includes('jpg') && !file.type.includes('webp')) return file

  return new Promise(resolve => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) {
        URL.revokeObjectURL(url)
        resolve(file)
        return
      }
      context.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      canvas.toBlob(blob => {
        resolve(blob ? new File([blob], file.name, { type: 'image/jpeg' }) : file)
      }, 'image/jpeg', 0.92)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(file)
    }
    img.src = url
  })
}

function sanitizeExif(exif: Record<string, unknown>): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(exif)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') safe[key] = value
  }
  return safe
}

/** Browser EXIF is advisory; authoritative verification is performed server-side. */
export async function saveExifFlags(listingId: string, _imageUrl: string, _exifResult: ExifResult): Promise<void> {
  const { error } = await supabase.functions.invoke('verify-listing-images', {
    body: { listing_id: listingId },
  })
  if (error) console.warn('Server image verification request failed:', error.message)
}

export async function checkPriceFloor(
  priceNaira: number,
  category: string,
  university: string,
  userId: string,
): Promise<PriceFloorResult> {
  const priceKobo = Math.round(priceNaira * 100)
  const { data: floorData, error } = await supabase.rpc('get_price_floor', {
    p_category: category,
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
  const { error: provisionError } = await supabase.rpc('provision_my_emergency_tokens')
  if (provisionError) console.warn('Emergency token provisioning unavailable:', provisionError.message)

  const { data: tokens } = await supabase.from('emergency_sale_tokens')
    .select('id, used')
    .eq('user_id', userId)
    .eq('month_year', monthKey)
    .eq('used', false)

  const below_pct = Math.round((1 - priceKobo / floorKobo) * 100)
  return {
    allowed: false,
    floor_price: floorKobo,
    needs_token: true,
    token_available: (tokens?.length ?? 0) > 0,
    tokens_remaining: tokens?.length ?? 0,
    below_pct,
    available_token_id: tokens?.[0]?.id ?? null,
  }
}

export async function consumeEmergencyToken(tokenId: string, listingId: string): Promise<boolean> {
  const { data, error } = await supabase.from('emergency_sale_tokens')
    .update({ used: true, used_at: new Date().toISOString(), used_for: listingId })
    .eq('id', tokenId)
    .eq('used', false)
    .select('id')
    .maybeSingle()
  return !error && !!data
}
