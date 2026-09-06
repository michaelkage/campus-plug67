import { supabase } from './client'

export interface ImageOptimizationOptions {
  maxWidth?: number
  maxHeight?: number
  quality?: number
}

export async function optimizeImage(
  file: File,
  { maxWidth = 1600, maxHeight = 1600, quality = 0.86 }: ImageOptimizationOptions = {},
): Promise<File> {
  if (!file.type.startsWith('image/') || file.type.includes('gif') || file.type.includes('svg')) return file
  return new Promise((resolve) => {
    const image = new Image()
    const objectUrl = URL.createObjectURL(file)
    image.onload = () => {
      const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight)
      const width = Math.max(1, Math.round(image.naturalWidth * scale))
      const height = Math.max(1, Math.round(image.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) {
        URL.revokeObjectURL(objectUrl)
        resolve(file)
        return
      }
      context.drawImage(image, 0, 0, width, height)
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(objectUrl)
        resolve(blob ? new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }) : file)
      }, 'image/jpeg', quality)
    }
    image.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file) }
    image.src = objectUrl
  })
}

export async function uploadImage(file: File, bucket = 'listings', folder = 'public'): Promise<string> {
  const optimized = await optimizeImage(file)
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
  const path = `${folder}/${name}`
  const { error } = await supabase.storage.from(bucket).upload(path, optimized, {
    cacheControl: '3600',
    upsert: false,
    contentType: 'image/jpeg',
  })
  if (error) throw new Error(`Upload failed: ${error.message}`)
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
}

export async function deleteImage(publicUrl: string, bucket = 'listings'): Promise<void> {
  try {
    const url = new URL(publicUrl)
    const prefix = `/storage/v1/object/public/${bucket}/`
    const index = url.pathname.indexOf(prefix)
    if (index === -1) return
    const objectPath = url.pathname.slice(index + prefix.length)
    if (objectPath) await supabase.storage.from(bucket).remove([objectPath])
  } catch {
    // Image cleanup is intentionally best-effort.
  }
}
