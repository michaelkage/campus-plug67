import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, validateEduEmail } from '@/lib/supabase'
import { debugError, debugInfo, debugSuccess, debugWarn, startDebugTrace } from '@/lib/debugger'
import { registerDevice, getDeviceHash, checkDeviceBan } from '@/lib/security'
import { registerPasskey, authenticateWithPasskey, browserSupportsWebAuthn } from '@/lib/passkeys'
import type { Database, MyProfile } from '@/types/database'
import toast from 'react-hot-toast'

type Profile = MyProfile
type AuthResult={data?:unknown;error?:unknown;success?:boolean}
type AuthContextValue={session:Session|null;profile:Profile|null;user:User|null;loading:boolean;deviceHash:string|null;isAuthenticated:boolean;passkeySupported:boolean;signUp:(args:{email:string;password:string;fullName:string;university?:string;department?:string;course?:string;matric?:string})=>Promise<AuthResult>;signIn:(args:{email:string;password:string})=>Promise<AuthResult>;signInWithPasskey:(email:string)=>Promise<AuthResult>;addPasskey:(deviceLabel:string)=>Promise<AuthResult>;signOut:()=>Promise<void>;updateProfile:(updates:Partial<Profile>)=>Promise<AuthResult|undefined>;refreshProfile:()=>Promise<Profile|null|undefined>}
const AuthContext=createContext<AuthContextValue|null>(null)
function errorMessage(error:unknown,fallback:string){return error instanceof Error?error.message:fallback}
export function AuthProvider({children}:{children:ReactNode}){
 const[session,setSession]=useState<Session|null>(null),[profile,setProfile]=useState<Profile|null>(null),[loading,setLoading]=useState(true),[deviceHash,setDeviceHash]=useState<string|null>(null)
 const fetchProfile=useCallback(async(userId:string)=>{
  const trace=startDebugTrace('profile.fetch',{userId});
  const{data:existing,error}=await supabase.rpc('get_my_profile',{});
  if(error){
   trace.fail(error,{userId});
   debugError('auth','Private profile RPC failed',{userId,error});
   return null;
  }
  if(existing){
   let resolved=existing;
   // Profiles created directly in Supabase Auth may exist without a university.
   // Hydrate that missing field from the verified education email.
   if(!resolved.university){
    const{data:{user}}=await supabase.auth.getUser();
    const{university:detectedUniversity}=await validateEduEmail(user?.email||resolved.email||'');
    if(detectedUniversity){
     const{error:hydrateError}=await supabase.from('profiles').update({university:detectedUniversity}).eq('id',userId);
     if(hydrateError){
      debugWarn('auth','Profile university hydration failed',{userId,error:hydrateError});
     }else{
      const{data:hydrated,error:refreshError}=await supabase.rpc('get_my_profile',{});
      if(!refreshError&&hydrated) resolved=hydrated;
      else if(refreshError) debugWarn('auth','Profile refresh after university hydration failed',{userId,error:refreshError});
     }
    }
   }
   setProfile(resolved);
   trace.end('profile.fetch success',{userId,hasUniversity:Boolean(resolved.university),university:resolved.university});
   return resolved;
  }

  const{data:{user}}=await supabase.auth.getUser();
  if(!user||user.id!==userId){
   debugWarn('auth','Profile bootstrap skipped: authenticated user unavailable',{userId});
   return null;
  }

  const{university:detectedUniversity}=await validateEduEmail(user.email||'');
  const metadataUniversity=typeof user.user_metadata?.university==='string'?user.user_metadata.university.trim():'';
  const university=metadataUniversity||detectedUniversity||null;
  const fullName=typeof user.user_metadata?.full_name==='string'&&user.user_metadata.full_name.trim()
   ?user.user_metadata.full_name.trim()
   :((user.email||'').split('@')[0]);

  const{error:createError}=await supabase.from('profiles').insert({
   id:user.id,
   email:user.email||'',
   full_name:fullName,
   university
  });
  if(createError) debugWarn('auth','Profile bootstrap insert did not complete; checking trigger-created profile',{userId,error:createError});

  const{data:created,error:refreshError}=await supabase.rpc('get_my_profile',{});
  if(refreshError||!created){
   trace.fail(refreshError||'Profile row unavailable after bootstrap',{userId});
   debugError('auth','Profile bootstrap could not hydrate private profile',{userId,error:refreshError});
   return null;
  }
  setProfile(created);
  trace.end('profile.bootstrap success',{userId,hasUniversity:Boolean(created.university),university:created.university});
  return created;
 },[])
 const hydrateSession=useCallback(async(nextSession:Session|null)=>{debugInfo('auth','Session hydration started',{hasSession:Boolean(nextSession),userId:nextSession?.user?.id});setSession(nextSession);if(!nextSession?.user){setProfile(null);debugInfo('auth','Session cleared');return}await fetchProfile(nextSession.user.id);try{await registerDevice(nextSession.user.id);debugSuccess('auth','Device registration completed',{userId:nextSession.user.id})}catch(error:unknown){debugError('auth','Device registration failed',{userId:nextSession.user.id,error});if(errorMessage(error,'').startsWith('DEVICE_BANNED')){await supabase.auth.signOut();setSession(null);setProfile(null);toast.error('🚫 This device has been flagged for policy violations.')}}},[fetchProfile])
 useEffect(()=>{getDeviceHash().then(h=>{setDeviceHash(h);debugInfo('auth','Device hash available')}).catch(error=>debugWarn('auth','Device hash unavailable',{error}));supabase.auth.getSession().then(async({data:{session}})=>{debugInfo('auth','Initial auth session loaded',{hasSession:Boolean(session),userId:session?.user?.id});await hydrateSession(session);setLoading(false)});const{data:{subscription}}=supabase.auth.onAuthStateChange((event,next)=>{debugInfo('auth','Auth state changed',{event,hasSession:Boolean(next),userId:next?.user?.id});setTimeout(()=>{void hydrateSession(next)},0)});return()=>subscription.unsubscribe()},[hydrateSession])
 const signUp=async({email,password,fullName,university,department,course,matric}:{email:string;password:string;fullName:string;university?:string;department?:string;course?:string;matric?:string})=>{const t=startDebugTrace('auth.signUp',{emailDomain:email.split('@')[1],hasUniversity:Boolean(university),hasDepartment:Boolean(department),hasCourse:Boolean(course),hasMatric:Boolean(matric)});const{valid,university:detectedUni}=await validateEduEmail(email);debugInfo('auth','Education email validation completed',{valid,detectedUniversity:detectedUni});if(!valid){toast.error('Please use an approved university email from the allowlist');t.fail('Invalid email domain');return{error:'Invalid email domain'}}try{if(await checkDeviceBan()){toast.error('🚫 This device is restricted from creating new accounts.');t.fail('DEVICE_BANNED');return{error:'DEVICE_BANNED'}}}catch(error:unknown){toast.error('Security check unavailable. Please try again.');t.fail(error);return{error}}const{data,error}=await supabase.auth.signUp({email,password,options:{data:{full_name:fullName,university:university||detectedUni,department:department||null,course:course||null,matric:matric||null},emailRedirectTo:`${import.meta.env.VITE_APP_URL}/auth/callback`}});if(error){toast.error(error.message);t.fail(error);return{error}}if(data.user){const resolvedUniversity=university||detectedUni||null;const{data:profileId,error:profileError}=await supabase.from('profiles').update({full_name:fullName,university:resolvedUniversity,matric_number:matric||null,department:department||null,course:course||null}).eq('id',data.user.id).select('id').maybeSingle();if(profileError)debugError('auth','Initial profile update failed',{userId:data.user.id,error:profileError});else if(profileId)debugSuccess('auth','Initial profile update succeeded',{userId:data.user.id,university:resolvedUniversity});else{const{error:profileInsertError}=await supabase.from('profiles').insert({id:data.user.id,email:data.user.email||email,full_name:fullName,university:resolvedUniversity,matric_number:matric||null,department:department||null,course:course||null});if(profileInsertError)debugError('auth','Initial profile bootstrap failed',{userId:data.user.id,error:profileInsertError});else debugSuccess('auth','Initial profile bootstrap succeeded',{userId:data.user.id,university:resolvedUniversity})}const{error:tokenError}=await supabase.rpc('provision_my_emergency_tokens');if(tokenError)debugWarn('auth','Initial emergency token provisioning unavailable',{error:tokenError.message})}toast.success('Account created! Check your email to verify.');t.end('auth.signUp success',{hasUser:Boolean(data.user)});return{data}}
 const signIn=async({email,password}:{email:string;password:string})=>{const t=startDebugTrace('auth.signIn',{emailDomain:email.split('@')[1]});try{if(await checkDeviceBan()){toast.error('🚫 This device is restricted from signing in.');t.fail('DEVICE_BANNED');return{error:'DEVICE_BANNED'}}}catch(error:unknown){toast.error('Security check unavailable. Please try again.');t.fail(error);return{error}}const{data,error}=await supabase.auth.signInWithPassword({email,password});if(error){toast.error(error.message);t.fail(error);return{error}}debugSuccess('auth','Password sign-in succeeded',{userId:data.user?.id});t.end('auth.signIn success');return{data}}
 const signInWithPasskey=async(email:string)=>{if(!browserSupportsWebAuthn()){toast.error('Passkeys not supported on this device');debugWarn('auth','Passkey sign-in unavailable: browser unsupported');return{error:'NOT_SUPPORTED'}};try{if(await checkDeviceBan()){toast.error('🚫 This device is restricted from signing in.');return{error:'DEVICE_BANNED'}}}catch(error:unknown){toast.error('Security check unavailable. Please try again.');return{error}}try{const result=await authenticateWithPasskey(email);toast.success('Signed in with biometrics! 🔐');debugSuccess('auth','Passkey authentication succeeded',{emailDomain:email.split('@')[1]});return{data:result}}catch(error:unknown){toast.error(errorMessage(error,'Passkey authentication failed'));debugError('auth','Passkey authentication failed',{error});return{error:errorMessage(error,'Passkey authentication failed')}}}
 const addPasskey=async(deviceLabel:string)=>{if(!session?.user)return{error:'Not authenticated'};try{await registerPasskey(session.user,deviceLabel);toast.success('🔐 Passkey registered! Use biometrics to sign in next time.');debugSuccess('auth','Passkey registered',{userId:session.user.id});return{success:true}}catch(error:unknown){toast.error(errorMessage(error,'Passkey registration failed'));debugError('auth','Passkey registration failed',{error});return{error:errorMessage(error,'Passkey registration failed')}}}
 const signOut=async()=>{debugInfo('auth','Sign-out started',{userId:session?.user?.id});await supabase.auth.signOut();setProfile(null);debugSuccess('auth','Sign-out completed')}
 const updateProfile=async(updates:Partial<Profile>)=>{if(!session?.user)return;const safeUpdates:Partial<Profile>={};if(updates.full_name!==undefined)safeUpdates.full_name=String(updates.full_name).trim().slice(0,120);if(updates.department!==undefined)safeUpdates.department=String(updates.department).trim().slice(0,120);if(updates.course!==undefined)safeUpdates.course=String(updates.course).trim().slice(0,120);if(updates.level!==undefined)safeUpdates.level=updates.level;if(updates.bio!==undefined)safeUpdates.bio=String(updates.bio).trim().slice(0,1000);if(updates.university!==undefined)safeUpdates.university=updates.university?String(updates.university).trim():null;if(Object.keys(safeUpdates).length===0)return{error:'No editable profile fields supplied'};const profileUpdate=safeUpdates as unknown as Database['public']['Tables']['profiles']['Update'];const{error}=await supabase.from('profiles').update(profileUpdate).eq('id',session.user.id);if(error){debugError('auth','Profile update failed',{userId:session.user.id,error});toast.error('Failed to update profile');return{error}}const{data,error:refreshError}=await supabase.rpc('get_my_profile',{});if(refreshError||!data){debugError('auth','Profile refresh after update failed',{userId:session.user.id,error:refreshError});toast.error('Profile updated, but refresh failed');return{error:refreshError||new Error('Profile refresh failed')}}setProfile(data);debugSuccess('auth','Profile update succeeded',{userId:session.user.id,fields:Object.keys(safeUpdates)});toast.success('Profile updated!');return{data}}
 const refreshProfile=()=>session?.user?fetchProfile(session.user.id):Promise.resolve(undefined)
 return <AuthContext.Provider value={{session,profile,user:session?.user??null,loading,deviceHash,isAuthenticated:!!session,passkeySupported:browserSupportsWebAuthn(),signUp,signIn,signInWithPasskey,addPasskey,signOut,updateProfile,refreshProfile}}>{children}</AuthContext.Provider>
}
export const useAuth=():AuthContextValue=>{const ctx=useContext(AuthContext);if(!ctx)throw new Error('useAuth must be used within AuthProvider');return ctx}
