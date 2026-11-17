import { supabase } from './client'
import { callEdgeFunction } from './paystack'

export interface ProcessEscrowParams {
  transaction_id: string
  release_code: string
  action: 'release' | 'refund'
}

export interface EscrowResult {
  success: boolean
  transaction_id: string
  action: string
}

export interface PriceSuggestion {
  suggested_price?: number
  lower_price_bound?: number
  upper_price_bound?: number
  [key: string]: unknown
}

interface PriceFloorParams {
  p_category: string
  p_university: string
}

interface SmartPriceParams {
  p_category: string
  p_university: string
}

async function typedRpc<T>(name: string, params: object): Promise<{ data: T | null; error: Error | null }> {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    rpcName: string,
    rpcParams: object,
  ) => Promise<{ data: T | null; error: { message: string } | null }>
  const result = await rpc(name, params)
  return { data: result.data, error: result.error ? new Error(result.error.message) : null }
}

export async function getSmartPrice(category: string, university: string): Promise<PriceSuggestion | null> {
  if (!category || !university) return null
  const params: SmartPriceParams = { p_category: category, p_university: university }
  const { data, error } = await typedRpc<PriceSuggestion>('get_price_suggestion', params)
  return error || !data ? null : data
}

export async function getPriceFloor(category: string, university: string): Promise<PriceSuggestion | null> {
  if (!category || !university) return null
  const params: PriceFloorParams = { p_category: category, p_university: university }
  const { data, error } = await typedRpc<PriceSuggestion>('get_price_floor', params)
  return error || !data ? null : data
}

export async function releaseEscrow(
  transactionId: string,
  releaseCode: string,
  action: ProcessEscrowParams['action'],
): Promise<EscrowResult> {
  const payload: ProcessEscrowParams = {
    transaction_id: transactionId,
    release_code: releaseCode,
    action,
  }
  const { data, error } = await callEdgeFunction<EscrowResult>('release-escrow', payload)
  if (error) throw new Error(error)
  if (!data) throw new Error('Escrow service returned no result')
  return data
}

export async function updateBeacon(
  _userId: string,
  latitude: number,
  longitude: number,
  beaconType: 'meetup' | 'general' = 'meetup',
  transactionId?: string,
  maxDistance = 500,
): Promise<unknown> {
  const { data, error } = await callEdgeFunction('beacon-matcher', {
    action: 'update_beacon', transaction_id: transactionId, latitude, longitude,
    beacon_type: beaconType, max_distance: maxDistance,
  })
  if (error) throw new Error(error)
  return data
}

export async function checkProximity(
  _userId: string,
  transactionId: string,
  latitude: number,
  longitude: number,
  maxDistance = 500,
): Promise<unknown> {
  const { data, error } = await callEdgeFunction('beacon-matcher', {
    action: 'check_proximity', transaction_id: transactionId, latitude, longitude,
    max_distance: maxDistance,
  })
  if (error) throw new Error(error)
  return data
}