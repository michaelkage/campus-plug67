import { describe, expect, it } from 'vitest'
import { buildWorkspaceActions } from './workspaceModel'

describe('student workspace action center', () => {
  it('prioritizes disputes and inspection deadlines', () => {
    const actions = buildWorkspaceActions('buyer', [
      { id:'a', buyer_id:'buyer', seller_id:'seller', listing_id:'listing-a', status:'locked', escrow_status:'held' },
      { id:'b', buyer_id:'buyer', seller_id:'seller', listing_id:'listing-b', status:'disputed', escrow_status:'held' },
    ], [], [])
    expect(actions[0].id).toBe('purchase:b')
    expect(actions[0].priority).toBe('urgent')
    expect(actions[1].href).toBe('/marketplace/listing-a')
  })

  it('does not treat legacy completed status as proof that escrow was paid', () => {
    const actions = buildWorkspaceActions('seller', [
      { id:'a', buyer_id:'buyer', seller_id:'seller', listing_id:'listing-a', status:'completed', escrow_status:'held' },
    ], [], [])
    expect(actions).toHaveLength(1)
  })

  it('removes settled and cancelled purchases from active work', () => {
    const actions = buildWorkspaceActions('buyer', [
      { id:'released', buyer_id:'buyer', seller_id:'seller', listing_id:null, status:'released', escrow_status:'released' },
      { id:'refunded', buyer_id:'buyer', seller_id:'seller', listing_id:null, status:'cancelled', escrow_status:'refunded' },
    ], [], [])
    expect(actions).toHaveLength(0)
  })

  it('describes service and rental steps for the correct participant', () => {
    const actions = buildWorkspaceActions('buyer', [], [
      { id:'booking', client_id:'buyer', seller_id:'provider', status:'delivered', gigs:{title:'Math tutoring'} },
    ], [
      { id:'rental', borrower_id:'buyer', lender_id:'owner', rental_status:'return_pending' },
    ])
    expect(actions.find(action => action.id==='service:booking')?.title).toBe('Review delivered service')
    expect(actions.find(action => action.id==='rental:rental')?.title).toBe('Verify returned item')
  })

  it('caps the action list to eight items', () => {
    const transactions = Array.from({length:12},(_,index)=>({
      id:String(index), buyer_id:'buyer', seller_id:'seller', listing_id:null, status:'locked', escrow_status:'held',
    }))
    expect(buildWorkspaceActions('buyer',transactions,[],[])).toHaveLength(8)
  })
})
