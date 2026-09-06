import { supabase } from './client'

export async function uploadImage(
  file: File,
  bucket = 'listings',
  folder = 'public',
): Promise<string> {
  const ext = file.name?.split('.').pop() || 'jpg'
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const path = `${folder}/${name}`
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || 'image/jpeg',
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
