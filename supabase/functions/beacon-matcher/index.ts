import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser } from "../_shared/auth.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: CORS });
const bad = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: CORS });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function calculateDistance(lat1:number, lon1:number, lat2:number, lon2:number):number {
  const R=6_371_000, p1=lat1*Math.PI/180, p2=lat2*Math.PI/180, dp=(lat2-lat1)*Math.PI/180, dl=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function validCoordinate(value: unknown, min:number, max:number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

serve(async (req:Request) => {
  if(req.method==="OPTIONS") return new Response("ok",{headers:CORS});
  if(req.method==="GET" && new URL(req.url).pathname.endsWith("/ping")) return ok({status:"warm",ts:Date.now(),fn:"beacon-matcher"});
  if(req.method!=="POST") return bad("Method not allowed",405);

  const user=await getAuthenticatedUser(req);
  if(!user) return bad("Unauthorized",401);

  let body:Record<string,any>;
  try{body=await req.json();}catch{return bad("Invalid JSON");}
  const { action, transaction_id, latitude, longitude, beacon_type="meetup", max_distance=500 }=body;
  if(!action || !validCoordinate(latitude,-90,90) || !validCoordinate(longitude,-180,180)) return bad("Invalid action or coordinates");
  const distanceLimit=Number(max_distance);
  if(!Number.isFinite(distanceLimit) || distanceLimit<=0 || distanceLimit>5000) return bad("Invalid max_distance");

  if(transaction_id){
    const {data:tx,error}=await admin.from("transactions").select("id,buyer_id,seller_id,meetup_latitude,meetup_longitude").eq("id",transaction_id).maybeSingle();
    if(error) return bad(error.message,500);
    if(!tx) return bad("Transaction not found",404);
    if(tx.buyer_id!==user.id && tx.seller_id!==user.id) return bad("Not authorized for this transaction",403);
  }

  const now=new Date().toISOString();

  if(action==="update_beacon"){
    const {error:upsertErr}=await admin.from("ticker_events").upsert({
      user_id:user.id,event_type:"beacon_current",latitude,longitude,transaction_id:transaction_id??null,
      metadata:{beacon_type,transaction_id},created_at:now
    },{onConflict:"user_id,event_type"});
    if(upsertErr) return bad("Failed to update beacon: "+upsertErr.message,500);

    const {error:historyErr}=await admin.from("ticker_events").insert({
      user_id:user.id,event_type:"beacon_update",latitude,longitude,transaction_id:transaction_id??null,
      metadata:{beacon_type,transaction_id},created_at:now
    });
    if(historyErr) return bad("Failed to record beacon history: "+historyErr.message,500);

    const {data:safeZones,error:zonesErr}=await admin.from("safe_zones").select("id,university,name,description,lat,lng,radius_m").eq("active",true);
    if(zonesErr) return bad(zonesErr.message,500);
    const nearbySafeZones=(safeZones??[]).filter((z:any)=>calculateDistance(latitude,longitude,z.lat,z.lng)<=z.radius_m);

    const nearbyBuddies:any[]=[];
    if(transaction_id){
      const {data:tx}=await admin.from("transactions").select("buyer_id,seller_id").eq("id",transaction_id).single();
      const other=tx?.buyer_id===user.id?tx?.seller_id:tx?.buyer_id;
      if(other){
        const {data:b}=await admin.from("ticker_events").select("latitude,longitude,created_at").eq("user_id",other).eq("event_type","beacon_current").maybeSingle();
        if(b?.latitude!=null&&b?.longitude!=null){
          const d=calculateDistance(latitude,longitude,b.latitude,b.longitude);
          if(d<=distanceLimit) nearbyBuddies.push({user_id:other,distance:Math.round(d),last_seen:b.created_at});
        }
      }
    }
    return ok({success:true,message:"Beacon updated successfully",nearby_safe_zones:nearbySafeZones,nearby_buddies:nearbyBuddies});
  }

  if(action==="check_proximity"){
    if(!transaction_id) return bad("Transaction ID required for proximity check");
    const {data:tx,error}=await admin.from("transactions").select("meetup_latitude,meetup_longitude").eq("id",transaction_id).single();
    if(error||tx?.meetup_latitude==null||tx?.meetup_longitude==null) return bad("Transaction meetup location not set",404);
    const distance=calculateDistance(latitude,longitude,tx.meetup_latitude,tx.meetup_longitude);
    const within_range=distance<=distanceLimit;
    const {error:logErr}=await admin.from("ticker_events").insert({user_id:user.id,event_type:"proximity_check",transaction_id,latitude,longitude,metadata:{distance_to_meetup:Math.round(distance),within_range},created_at:now});
    if(logErr) return bad(logErr.message,500);
    return ok({success:true,distance:Math.round(distance),within_range,message:within_range?"Within meetup range":"Outside meetup range"});
  }
  return bad("Unknown action: "+action);
});
