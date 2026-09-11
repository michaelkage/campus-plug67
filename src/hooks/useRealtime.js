import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { debugError, debugInfo, debugSuccess, debugWarn, startDebugTrace } from '@/lib/debugger'
export function useRealtimeTable({ table, onInsert, onUpdate, onDelete, filter, enabled = true, batchMs = 0 }) {
  const channelRef = useRef(null); const onInsertRef = useRef(onInsert); const onUpdateRef = useRef(onUpdate); const onDeleteRef = useRef(onDelete); const pendingInsertsRef = useRef([]); const flushTimerRef = useRef(null)
  onInsertRef.current = onInsert; onUpdateRef.current = onUpdate; onDeleteRef.current = onDelete
  useEffect(() => {
    if (!enabled) return
    const filterKey = filter ? `${filter.column}=${filter.value}` : 'all'; const channelName = `rt:${table}:${filterKey}`
    const trace = startDebugTrace('realtime.subscribe', { table, filter: filter ? { column: filter.column, value: filter.value } : undefined, batchMs })
    const flushInserts = () => { flushTimerRef.current = null; const batch = pendingInsertsRef.current; pendingInsertsRef.current = []; if (!batch.length || !onInsertRef.current) return; debugInfo('supabase','Realtime INSERT batch flushed',{table,channel:channelName,count:batch.length}); if(batch.length===1) onInsertRef.current(batch[0]); else onInsertRef.current(batch) }
    const staleChannel = supabase.getChannels().find(channel => channel.topic === `realtime:${channelName}`)
    if (staleChannel) { debugWarn('supabase','Removing stale realtime channel',{table,channel:channelName}); void supabase.removeChannel(staleChannel) }
    const channel = supabase.channel(channelName).on('postgres_changes',{event:'*',schema:'public',table,...(filter?{filter:`${filter.column}=eq.${filter.value}`}:{})},payload=>{
      debugInfo('supabase',`Realtime ${payload.eventType}`,{table,channel:channelName,eventType:payload.eventType,id:payload.new?.id||payload.old?.id,status:payload.new?.status})
      if(payload.eventType==='INSERT'&&onInsertRef.current){if(batchMs>0){pendingInsertsRef.current.push(payload.new);if(!flushTimerRef.current)flushTimerRef.current=setTimeout(flushInserts,batchMs)}else onInsertRef.current(payload.new)}
      if(payload.eventType==='UPDATE'&&onUpdateRef.current)onUpdateRef.current(payload.new,payload.old)
      if(payload.eventType==='DELETE'&&onDeleteRef.current)onDeleteRef.current(payload.old)
    })
    channelRef.current=channel
    channel.subscribe((status,err)=>{if(status==='SUBSCRIBED'){debugSuccess('supabase','Realtime subscription active',{table,channel:channelName,filter});trace.end('Realtime subscription established',{table,channel:channelName})}else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'){debugError('supabase','Realtime subscription failed',{table,channel:channelName,status,error:err});trace.fail(err||status,{table,channel:channelName})}else debugInfo('supabase','Realtime subscription status',{table,channel:channelName,status})})
    return()=>{if(flushTimerRef.current){clearTimeout(flushTimerRef.current);flushTimerRef.current=null;flushInserts()}channelRef.current=null;debugInfo('supabase','Realtime subscription removed',{table,channel:channelName});void supabase.removeChannel(channel)}
  },[table,filter?.column,filter?.value,enabled,batchMs])
}
export function useNotifications(userId,onNotification,{batchMs=200}={}){useRealtimeTable({table:'notifications',filter:userId?{column:'user_id',value:userId}:undefined,onInsert:onNotification,enabled:!!userId,batchMs})}
export function useTransactionStatus(transactionId,onUpdate){useRealtimeTable({table:'transactions',filter:transactionId?{column:'id',value:transactionId}:undefined,onUpdate,enabled:!!transactionId})}
export function useMessages(senderId,receiverId,onMessage){const onMessageRef=useRef(onMessage);onMessageRef.current=onMessage;useEffect(()=>{if(!senderId||!receiverId)return;const channelName=`messages:${[senderId,receiverId].sort().join(':')}`;debugInfo('supabase','Messages realtime subscription starting',{channel:channelName});const channel=supabase.channel(channelName).on('postgres_changes',{event:'INSERT',schema:'public',table:'messages'},payload=>{const msg=payload.new;const isRelevant=(msg.sender_id===senderId&&msg.receiver_id===receiverId)||(msg.sender_id===receiverId&&msg.receiver_id===senderId);debugInfo('supabase','Messages realtime event received',{channel:channelName,relevant:isRelevant,messageId:msg.id});if(isRelevant)onMessageRef.current?.(msg)}).subscribe((status,err)=>{if(status==='SUBSCRIBED')debugSuccess('supabase','Messages realtime subscription active',{channel:channelName});else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')debugError('supabase','Messages realtime subscription failed',{channel:channelName,status,error:err})});return()=>{debugInfo('supabase','Messages realtime subscription removed',{channel:channelName});void supabase.removeChannel(channel)}},[senderId,receiverId])}
