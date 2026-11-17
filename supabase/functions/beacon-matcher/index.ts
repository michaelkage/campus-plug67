import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser, getBearerToken, jsonResponse, optionsResponse } from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type BeaconBody = {
  action?: unknown; transaction_id?: unknown; latitude?: unknown; longitude?: unknown;
  beacon_type?: unknown; max_distance?: unknown;
};
type SafeZone = { id: string; university: string | null; name: string; description: string | null; lat: number; lng: number; radius_m: number };

type CurrentBeacon = { latitude: number; longitude: number; created_at: string };

function calculateDistance(lat1:number, lon1:number, lat2:number, lon2:number):number {
  const R=6_371_000, p1=lat1*Math.PI/180, p2=lat2*Math.PI/180, dp=(lat2-lat1)*Math.PI/180, dl=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function validCoordinate(value: unknown, min:number, max:number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

serve(async (req:Request) => {
  if(req.method==="OPTIONS") return optionsResponse(req);
  if(req.method==="GET" && new URL(req.url).pathname.endsWith("/ping")) return jsonResponse({status:"warm",ts:Date.now(),fn:"beacon-matcher"},200,{},req);
  if(req.method!=="POST") return jsonResponse({error:"Method not allowed"},405,{},req);
  const user=await getAuthenticatedUser(req);
  if(!user) return jsonResponse({error:"Unauthorized"},401,{},req);
  const token=getBearerToken(req);
  if(!token) return jsonResponse({error:"Unauthorized"},401,{},req);
  try {
    const limit=await enforceRateLimitWithToken(token,"beacon-matcher",120,60);
    if(!limit.allowed) return jsonResponse({error:"Rate limit exceeded"},429,{},req);
  } catch { return jsonResponse({error:"Rate limit service unavailable"},503,{},req); }

  const body: BeaconBody = await req.json().catch(() => ({}));
  const action=typeof body.action === "string" ? body.action : "";
  const transactionId=typeof body.transaction_id === "string" ? body.transaction_id : null;
  const latitude=body.latitude;
  const longitude=body.longitude;
  const beaconType=typeof body.beacon_type === "string" ? body.beacon_type : "meetup";
  const distanceLimit=Number(body.max_distance ?? 500);
  if(!action || !validCoordinate(latitude,-90,90) || !validCoordinate(longitude,-180,180)) return jsonResponse({error:"Invalid action or coordinates"},400,{},req);
  if(!Number.isFinite(distanceLimit) || distanceLimit<=0 || distanceLimit>5000) return jsonResponse({error:"Invalid max_distance"},400,{},req);

  if(transactionId){
    const {data:tx,error}=await admin.from("transactions").select("id,buyer_id,seller_id,meetup_latitude,meetup_longitude").eq("id",transactionId).maybeSingle();
    if(error) return jsonResponse({error:error.message},500,{},req);
    if(!tx) return jsonResponse({error:"Transaction not found"},404,{},req);
    if(tx.buyer_id!==user.id && tx.seller_id!==user.id) return jsonResponse({error:"Not authorized for this transaction"},403,{},req);
  }

  const now=new Date().toISOString();
  if(action==="update_beacon"){
    const metadata={beacon_type:beaconType,transaction_id:transactionId};
    const {error:upsertErr}=await admin.from("ticker_events").upsert({user_id:user.id,event_type:"beacon_current",latitude,longitude,transaction_id:transactionId,metadata,created_at:now},{onConflict:"user_id,event_type"});
    if(upsertErr) return jsonResponse({error:"Failed to update beacon: "+upsertErr.message},500,{},req);
    const {error:historyErr}=await admin.from("ticker_events").insert({user_id:user.id,event_type:"beacon_update",latitude,longitude,transaction_id:transactionId,metadata,created_at:now});
    if(historyErr) return jsonResponse({error:"Failed to record beacon history: "+historyErr.message},500,{},req);
    const {data:safeZones,error:zonesErr}=await admin.from("safe_zones").select("id,university,name,description,lat,lng,radius_m").eq("active",true);
    if(zonesErr) return jsonResponse({error:zonesErr.message},500,{},req);
    const nearbySafeZones=(safeZones??[] as SafeZone[]).filter((zone: SafeZone)=>calculateDistance(latitude,longitude,zone.lat,zone.lng)<=zone.radius_m);
    const nearbyBuddies:{user_id:string;distance:number;last_seen:string}[]=[];
    if(transactionId){
      const {data:tx}=await admin.from("transactions").select("buyer_id,seller_id").eq("id",transactionId).single();
      const other=tx?.buyer_id===user.id?tx?.seller_id:tx?.buyer_id;
      if(other){
        const {data:b}=await admin.from("ticker_events").select("latitude,longitude,created_at").eq("user_id",other).eq("event_type","beacon_current").maybeSingle() as {data: CurrentBeacon | null};
        if(b?.latitude!=null&&b?.longitude!=null){const d=calculateDistance(latitude,longitude,b.latitude,b.longitude);if(d<=distanceLimit)nearbyBuddies.push({user_id:other,distance:Math.round(d),last_seen:b.created_at});}
      }
    }
    return jsonResponse({success:true,message:"Beacon updated successfully",nearby_safe_zones:nearbySafeZones,nearby_buddies:nearbyBuddies},200,{},req);
  }

  if(action==="check_proximity"){
    if(!transactionId) return jsonResponse({error:"Transaction ID required for proximity check"},400,{},req);
    const {data:tx,error}=await admin.from("transactions").select("meetup_latitude,meetup_longitude").eq("id",transactionId).single();
    if(error||tx?.meetup_latitude==null||tx?.meetup_longitude==null) return jsonResponse({error:"Transaction meetup location not set"},404,{},req);
    const distance=calculateDistance(latitude,longitude,tx.meetup_latitude,tx.meetup_longitude);
    const within_range=distance<=distanceLimit;
    const {error:logErr}=await admin.from("ticker_events").insert({user_id:user.id,event_type:"proximity_check",transaction_id:transactionId,latitude,longitude,metadata:{distance_to_meetup:Math.round(distance),within_range},created_at:now});
    if(logErr) return jsonResponse({error:logErr.message},500,{},req);
    return jsonResponse({success:true,distance:Math.round(distance),within_range,message:within_range?"Within meetup range":"Outside meetup range"},200,{},req);
  }
  return jsonResponse({error:"Unknown action: "+action},400,{},req);
});
