import { supabase } from './client'
import { debugError, debugInfo, debugSuccess, startDebugTrace } from '@/lib/debugger'

export interface ImageOptimizationOptions { maxWidth?: number; maxHeight?: number; quality?: number }

export async function optimizeImage(file: File,{ maxWidth = 1600, maxHeight = 1600, quality = 0.86 }: ImageOptimizationOptions = {}): Promise<File> {
  const trace = startDebugTrace('storage.optimizeImage',{name:file.name,type:file.type,size:file.size,maxWidth,maxHeight})
  if (!file.type.startsWith('image/') || file.type.includes('gif') || file.type.includes('svg')) { debugInfo('storage','Image optimization skipped',{name:file.name,type:file.type}); trace.end('Storage optimization skipped'); return file }
  return new Promise((resolve) => {
    const image = new Image(); const objectUrl = URL.createObjectURL(file)
    image.onload = () => {
      const scale = Math.min(1,maxWidth/image.naturalWidth,maxHeight/image.naturalHeight); const width=Math.max(1,Math.round(image.naturalWidth*scale)); const height=Math.max(1,Math.round(image.naturalHeight*scale)); const canvas=document.createElement('canvas'); canvas.width=width; canvas.height=height; const context=canvas.getContext('2d')
      if(!context){URL.revokeObjectURL(objectUrl);debugInfo('storage','Canvas unavailable; original image retained',{name:file.name});trace.end('Storage optimization fallback');resolve(file);return}
      context.drawImage(image,0,0,width,height)
      canvas.toBlob((blob)=>{URL.revokeObjectURL(objectUrl);const optimized=blob?new File([blob],file.name.replace(/\.[^.]+$/,'.jpg'),{type:'image/jpeg'}):file;debugSuccess('storage','Image optimization completed',{name:file.name,inputBytes:file.size,outputBytes:optimized.size,width,height},Math.round(optimized.size));trace.end('Storage optimization completed',{outputBytes:optimized.size,width,height});resolve(optimized)},'image/jpeg',quality)
    }
    image.onerror=()=>{URL.revokeObjectURL(objectUrl);debugError('storage','Image optimization failed; original retained',{name:file.name});trace.end('Storage optimization failed');resolve(file)}
    image.src=objectUrl
  })
}

export async function uploadImage(file: File,bucket='listings',folder='public'): Promise<string> {
  const trace=startDebugTrace('storage.uploadImage',{bucket,folder,name:file.name,type:file.type,size:file.size})
  try {
    const optimized=await optimizeImage(file); const name=`${Date.now()}-${Math.random().toString(36).slice(2,8)}.jpg`; const path=`${folder}/${name}`
    debugInfo('storage','Storage upload started',{bucket,path,name:file.name,inputBytes:file.size,uploadBytes:optimized.size})
    const {error}=await supabase.storage.from(bucket).upload(path,optimized,{cacheControl:'3600',upsert:false,contentType:'image/jpeg'})
    if(error){debugError('storage','Storage upload failed',{bucket,path,error});trace.fail(error,{bucket,path});throw new Error(`Upload failed: ${error.message}`)}
    const publicUrl=supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
    debugSuccess('storage','Storage upload completed',{bucket,path,publicUrl,name:file.name,bytes:optimized.size})
    trace.end('Storage upload lifecycle completed',{bucket,path})
    return publicUrl
  } catch(error) { if(!(error instanceof Error&&error.message.startsWith('Upload failed:')))debugError('storage','Storage upload lifecycle failed',{bucket,folder,name:file.name,error}); throw error }
}

export async function deleteImage(publicUrl:string,bucket='listings'):Promise<void>{
  const trace=startDebugTrace('storage.deleteImage',{bucket,publicUrl:publicUrl.split('/').slice(-2).join('/')})
  try{const url=new URL(publicUrl);const prefix=`/storage/v1/object/public/${bucket}/`;const index=url.pathname.indexOf(prefix);if(index===-1){trace.end('Storage delete skipped: URL outside bucket');return}const objectPath=url.pathname.slice(index+prefix.length);if(objectPath){const {error}=await supabase.storage.from(bucket).remove([objectPath]);if(error)debugError('storage','Storage delete failed',{bucket,objectPath,error});else debugSuccess('storage','Storage delete completed',{bucket,objectPath})}}catch(error){debugError('storage','Image cleanup failed',{bucket,error});trace.fail(error)}}
