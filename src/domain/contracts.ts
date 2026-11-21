import type { Database, Json } from '@/types/database'

/** Branded identifiers prevent accidentally passing one domain's ID to another. */
export type Id<T extends string> = string & { readonly __entity: T }
export type UserId = Id<'user'>
export type ListingId = Id<'listing'>
export type TransactionId = Id<'transaction'>
export type RentalId = Id<'rental'>
export type BookingId = Id<'booking'>
export type ConversationId = Id<'conversation'>
export type MessageId = Id<'message'>
export type InstitutionId = Id<'institution'>
export type NotificationId = Id<'notification'>

export const asId = <T extends string>(value: string): Id<T> => value as Id<T>

export type ISODateTime = string & { readonly __format: 'ISODateTime' }
export type CurrencyCode = 'NGN'
export type Money = Readonly<{ amountMinor: number; currency: CurrencyCode }>

export type DomainActor = Readonly<{
  userId: UserId
  roles: readonly ('student' | 'seller' | 'provider' | 'admin' | 'moderator' | 'juror')[]
  institutionId?: InstitutionId | null
}>

export type DomainErrorCode =
  | 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'CONFLICT' | 'INVALID_STATE' | 'RATE_LIMITED' | 'OFFLINE'
  | 'DEPENDENCY_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'UNKNOWN'

export type DomainError = Readonly<{
  code: DomainErrorCode
  message: string
  retryable: boolean
  correlationId?: string
  details?: Readonly<Record<string, unknown>>
}>

export type Result<T, E = DomainError> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>

export const success = <T>(value: T): Result<T> => ({ ok: true, value })
export const failure = (error: DomainError): Result<never> => ({ ok: false, error })

export type PageRequest = Readonly<{ limit: number; cursor?: string | null }>
export type Page<T> = Readonly<{ items: readonly T[]; nextCursor: string | null; hasMore: boolean }>

export type ListingLifecycle = 'draft' | 'active' | 'reserved' | 'sold' | 'rented' | 'archived' | 'removed'
export type CommerceKind = 'purchase' | 'rental' | 'service'
export type TransactionStatus = Database['public']['Tables']['transactions']['Row']['status']
export type PaymentRail = 'paystack' | 'campus_wallet' | 'plug_credit'
export type EscrowResolutionStatus = 'unresolved' | 'released' | 'refunded' | 'split' | 'manual_review'
export type SellerPayoutStatus = 'not_applicable' | 'pending' | 'processing' | 'paid' | 'failed' | 'needs_attention'
export type RefundStatus = 'not_requested' | 'pending' | 'processing' | 'needs-attention' | 'processed' | 'failed'

export type CommerceTransaction = Readonly<{
  id: TransactionId
  kind: CommerceKind
  status: TransactionStatus
  buyerId: UserId
  sellerId: UserId
  listingId?: ListingId | null
  amount: Money
  paymentRail: PaymentRail
  escrow: Readonly<{ resolution: EscrowResolutionStatus; fundedAt?: ISODateTime | null }>
  refund: Readonly<{ status: RefundStatus; amount?: Money | null }>
  payout: Readonly<{ status: SellerPayoutStatus; paidAt?: ISODateTime | null }>
  createdAt: ISODateTime
  updatedAt: ISODateTime
  version?: number
}>

export type TransactionCommand =
  | Readonly<{ type: 'FUND'; paymentRail: PaymentRail; providerReference: string }>
  | Readonly<{ type: 'START_MEETUP' }>
  | Readonly<{ type: 'CONFIRM_HANDOFF'; proofReference: string }>
  | Readonly<{ type: 'OPEN_DISPUTE'; reason: string }>
  | Readonly<{ type: 'REQUEST_SELLER_RELEASE' }>
  | Readonly<{ type: 'RESOLVE_DISPUTE'; outcome: 'release' | 'refund' | 'split'; resolutionReference: string }>
  | Readonly<{ type: 'CANCEL'; reason: string }>

export type LedgerAccountKind = 'buyer_wallet' | 'seller_wallet' | 'escrow' | 'platform_revenue' | 'provider_clearing' | 'refund_clearing'
export type LedgerEntry = Readonly<{
  id: string
  transactionId?: TransactionId | null
  account: LedgerAccountKind
  direction: 'debit' | 'credit'
  amount: Money
  idempotencyKey: string
  reference: string
  occurredAt: ISODateTime
}>

export type RentalStatus = 'requested' | 'accepted' | 'funded' | 'ready_for_pickup' | 'active' | 'return_pending' | 'returned' | 'disputed' | 'cancelled' | 'completed'
export type RentalAgreement = Readonly<{
  id: RentalId
  listingId: ListingId
  renterId: UserId
  ownerId: UserId
  status: RentalStatus
  startsAt: ISODateTime
  endsAt: ISODateTime
  deposit: Money
  price: Money
  version: number
}>

export type ServiceBookingStatus = 'requested' | 'quoted' | 'accepted' | 'funded' | 'in_progress' | 'delivered' | 'completed' | 'disputed' | 'cancelled'
export type ServiceBooking = Readonly<{
  id: BookingId
  providerId: UserId
  customerId: UserId
  status: ServiceBookingStatus
  quotedAmount: Money | null
  quoteExpiresAt: ISODateTime | null
  deliveryDueAt: ISODateTime | null
  version: number
}>

export type Conversation = Readonly<{
  id: ConversationId
  participantIds: readonly UserId[]
  transactionId?: TransactionId | null
  listingId?: ListingId | null
  lastMessageAt: ISODateTime | null
  createdAt: ISODateTime
}>

export type Message = Readonly<{
  id: MessageId
  conversationId: ConversationId
  senderId: UserId
  body: string | null
  createdAt: ISODateTime
  readAt: ISODateTime | null
  deliveryStatus: 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
}>

export type NotificationEvent =
  | 'transaction.updated' | 'escrow.updated' | 'refund.updated' | 'payout.updated'
  | 'rental.updated' | 'booking.updated' | 'message.created' | 'security.alert'

export type Notification = Readonly<{
  id: NotificationId
  userId: UserId
  event: NotificationEvent
  title: string
  body: string
  readAt: ISODateTime | null
  createdAt: ISODateTime
  data?: Json
}>

export type Institution = Readonly<{
  id: InstitutionId
  name: string
  slug: string
  verifiedDomains: readonly string[]
  active: boolean
}>

export type TrustSignal = Readonly<{
  subjectId: UserId
  category: 'identity' | 'fulfilment' | 'communication' | 'safety'
  score: number
  confidence: number
  evaluatedAt: ISODateTime
  explanation: string
}>

export type DomainEvent<TType extends string = string, TPayload = unknown> = Readonly<{
  id: string
  type: TType
  aggregateId: string
  aggregateVersion: number
  occurredAt: ISODateTime
  actorId: UserId | null
  payload: TPayload
  correlationId: string
}>
