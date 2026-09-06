export type DeviceType = 'mobile' | 'desktop' | 'unknown'

export function getDeviceType(): DeviceType {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent.toLowerCase()
  if (/android|iphone|ipad|ipod|mobile|windows phone/.test(ua)) return 'mobile'
  if (/windows|macintosh|linux x86_64|cros/.test(ua)) return 'desktop'
  return 'unknown'
}

export function isMobileDevice() { return getDeviceType() === 'mobile' }
export function isDesktopDevice() { return getDeviceType() === 'desktop' }
