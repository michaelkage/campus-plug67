import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { jsonResponse, optionsResponse, getAuthenticatedUser } from "../_shared/auth.ts";
import exifr from "npm:exifr@7.1.3";

declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
type VerificationResult = { image_url:string; gps_lat:number|null; gps_lng:number|null; gps_mismatch:boolean; timestamp_flag:boolean; has_capture_timestamp:boolean; make:string|null; model:string|null; software:string|null };
type BrowserLocation = { latitude: number; longitude: number; accuracy: number; capturedAt: string };
const UNI_BOUNDS:Record<string,[number,number,number,number]> = { "University of Lagos":[6.495,6.520,3.390,3.415], "Obafemi Awolowo University":[7.516,7.535,4.515,4.535], "University of Ibadan":[7.440,7.460,3.890,3.910], "University of Benin":[6.393,6.415,5.602,5.625], "Ahmadu Bello University":[11.155,11.180,7.645,7.670], "Yaba College of Technology":[6.497,6.512,3.375,3.392], "Lagos State University":[6.555,6.580,3.290,3.320], "University of Nigeria Nsukka":[6.853,6.880,7.390,7.420] };

function scalar(value:unknown):string|number|null { return typeof value === 'string' || typeof value === 'number' ? value : null }
function requestDevice(req:Request):'mobile'|'desktop'|'unknown' { const ua=(req.headers.get('user-agent')||'').toLowerCase(); if(/android|iphone|ipad|ipod|mobile|windows phone/.test(ua))return'mobile'; if(/windows|macintosh|linux x86_64|cros/.test(ua))return'desktop'; return'unknown' }

async function verifyImage(imageUrl:string, university:string|null):Promise<VerificationResult> {
  const response=await fetch(imageUrl,{redirect:'error'}); if(!response.ok)throw new Error(`Image fetch failed: ${response.status}`);
  const contentType=response.headers.get('content-type')??''; if(!contentType.startsWith('image/'))throw new Error('Stored object is not an image');
  const bytes=new Uint8Array(await response.arrayBuffer()); if(bytes.byteLength>8*1024*1024)throw new Error('Image too large for verification');
  const exif=await (exifr as any).parse(bytes,{gps:true,ifd0:true,exif:true,translateKeys:true,translateValues:true}).catch(()=>null) as Record<string,unknown>|null;
  const lat=typeof exif?.latitude==='number'?exif.latitude:null; const lng=typeof exif?.longitude==='number'?exif.longitude:null;
  let gpsMismatch=false; const bounds=university?UNI_BOUNDS[university]:undefined;
  if(bounds&&lat!==null&&lng!==null){const [latMin,latMax,lngMin,lngMax]=bounds;gpsMismatch=!(lat>=latMin&&lat<=latMax&&lng>=lngMin&&lng<=lngMax)}
  const imageDate=scalar(exif?.DateTimeOriginal)??scalar(exif?.DateTime); let timestampFlag=false;
  if(imageDate!==null){const imageTs=new Date(imageDate).getTime();if(Number.isFinite(imageTs)){const diffMs=Date.now()-imageTs;timestampFlag=diffMs>5*365*24*3600*1000||diffMs<-3_600_000}}
  return {image_url:imageUrl,gps_lat:lat,gps_lng:lng,gps_mismatch:gpsMismatch,timestamp_flag:timestampFlag,has_capture_timestamp:imageDate!==null,make:typeof exif?.Make==='string'?exif.Make:null,model:typeof exif?.Model==='string'?exif.Model:null,software:typeof exif?.Software==='string'?exif.Software:null};
}

async function verifyListing(listingId:string,userId:string,sourceDevice:string,browserLocation:BrowserLocation|null,cameraCaptureReported:boolean) {
  const {data:listing,error}=await admin.from('listings').select('id,seller_id,university,images').eq('id',listingId).single(); if(error||!listing)throw new Error('Listing not found'); if(listing.seller_id!==userId)throw new Error('Not authorized for this listing');
  const images=Array.isArray(listing.images)?listing.images.filter((v):v is string=>typeof v==='string'):[]; const results:VerificationResult[]=[];
  for(const imageUrl of images.slice(0,4)){try{results.push(await verifyImage(imageUrl,listing.university))}catch(error){console.warn('server image verification failed',imageUrl,error instanceof Error?error.message:error)}}
  const now = Date.now();
  const locationTime = browserLocation ? new Date(browserLocation.capturedAt).getTime() : NaN;
  const locationIsPlausible = !!browserLocation
    && Number.isFinite(browserLocation.latitude) && browserLocation.latitude >= -90 && browserLocation.latitude <= 90
    && Number.isFinite(browserLocation.longitude) && browserLocation.longitude >= -180 && browserLocation.longitude <= 180
    && Number.isFinite(browserLocation.accuracy) && browserLocation.accuracy > 0 && browserLocation.accuracy <= 100
    && Number.isFinite(locationTime) && now - locationTime >= -60_000 && now - locationTime <= 5 * 60_000;
  const bounds = listing.university ? UNI_BOUNDS[listing.university] : undefined;
  const locationInCampusBounds = locationIsPlausible && !!bounds
    ? browserLocation!.latitude >= bounds[0] && browserLocation!.latitude <= bounds[1]
      && browserLocation!.longitude >= bounds[2] && browserLocation!.longitude <= bounds[3]
    : false;

  const {error:clearImageEvidenceError}=await admin.from('listing_exif_flags').delete().eq('listing_id',listingId).eq('verification_source','server_verified');
  if(clearImageEvidenceError)throw clearImageEvidenceError;
  if(results.length){
    const rows=results.map(({has_capture_timestamp,...result})=>({...result,listing_id:listingId,raw_exif:null,verification_source: "server_verified",verified_at:new Date().toISOString()}));
    const {error:insertError}=await admin.from('listing_exif_flags').insert(rows); if(insertError)throw insertError;
  }
  if(locationIsPlausible){
    const {error:clearLocationEvidenceError}=await admin.from('listing_exif_flags').delete().eq('listing_id',listingId).eq('verification_source','browser_geolocation');
    if(clearLocationEvidenceError)throw clearLocationEvidenceError;
    const {error:locationError}=await admin.from('listing_exif_flags').insert({
      listing_id:listingId,image_url:null,flag_type:'browser_geolocation_evidence',
      description:cameraCaptureReported?'User-reported camera capture with recent browser geolocation. This is untrusted corroborating evidence.':'Recent browser geolocation supplied without a camera-capture claim. This is untrusted corroborating evidence.',
      severity:locationInCampusBounds?'low':'medium',gps_lat:Number(browserLocation!.latitude.toFixed(3)),
      gps_lng:Number(browserLocation!.longitude.toFixed(3)),gps_mismatch:!locationInCampusBounds,
      timestamp_flag:false,make:null,model:null,software:null,raw_exif:null,
      verification_source:'browser_geolocation',verified_at:new Date().toISOString(),
    });
    if(locationError)throw locationError;
  }

  // Stripped images commonly have no EXIF. Absence of a mismatch is not proof:
  // require server-readable GPS and capture time before awarding metadata_verified.
  const metadataComplete = results.length > 0 && results.length === images.length && results.every(result =>
    result.gps_lat !== null && result.gps_lng !== null && result.has_capture_timestamp
      && !result.gps_mismatch && !result.timestamp_flag
  );
  const needsMobile=sourceDevice==='desktop';
  await admin.from('listings').update({metadata_verified:metadataComplete&&!needsMobile,verification_source_device:sourceDevice,mobile_verification_required:needsMobile,mobile_verification_requested_at:needsMobile?new Date().toISOString():null}).eq('id',listingId).eq('seller_id',userId);
  if(needsMobile){await admin.from('notifications').insert({user_id:userId,type:'mobile_verification_required',title:'📱 Live photo verification needed',body:'Your listing was uploaded from a laptop. Use the in-app camera and location evidence on a phone; browser signals are reviewed separately and do not automatically verify metadata.',data:{listing_id:listingId,grace_window_hours:24}})}
  return {verified:metadataComplete&&!needsMobile,processed:results.length,flagged:results.filter(r=>r.gps_mismatch||r.timestamp_flag).length,metadata_missing:results.length !== images.length || results.some(r=>r.gps_lat===null||r.gps_lng===null||!r.has_capture_timestamp),location_evidence_submitted:locationIsPlausible,location_evidence_in_campus_bounds:locationInCampusBounds,camera_capture_reported:cameraCaptureReported,mobile_verification_required:needsMobile};
}

serve(async(req:Request)=>{
  // Keep-alive requests must never enter image processing or EdgeRuntime.waitUntil.
  if(req.headers.get('x-health-check')==='true') return new Response('Warm',{status:200,headers:{'content-type':'text/plain; charset=utf-8'}});
  if(req.method==='OPTIONS')return optionsResponse(req); if(req.method!=='POST')return jsonResponse({error:'Method not allowed'},405,{},req);
  const user=await getAuthenticatedUser(req); if(!user)return jsonResponse({error:'Unauthorized'},401,{},req);
  const body:unknown=await req.json().catch(()=>null); if(typeof body!=='object'||body===null)return jsonResponse({error:'Invalid JSON'},400,{},req);
  const record=body as Record<string,unknown>; const listingId=typeof record.listing_id==='string'?record.listing_id:''; if(!listingId)return jsonResponse({error:'Missing listing_id'},400,{},req);
  const browserLocation = record.browser_location && typeof record.browser_location === 'object' ? record.browser_location as BrowserLocation : null;
  const cameraCaptureReported = record.camera_capture_reported === true;
  const sourceDevice=requestDevice(req); EdgeRuntime.waitUntil(verifyListing(listingId,user.id,sourceDevice,browserLocation,cameraCaptureReported).catch(error=>console.error('listing verification failed',error)));
  return jsonResponse({success:true,queued:true,verification_source_device:sourceDevice,mobile_verification_required:sourceDevice==='desktop',location_evidence_received:!!browserLocation,camera_capture_reported:cameraCaptureReported},202,{},req);
});
