-- Harden Paystack refund initiation and dispute-admin authorization.
-- The refund claim is atomically marked as processing before the external Paystack call,
-- preventing concurrent Edge Function invocations from issuing duplicate refunds.

alter table public.transactions drop constraint if exists transactions_refund_status_check;
alter table public.transactions add constraint transactions_refund_status_check
  check (refund_status is null or refund_status in ('pending','processing','needs-attention','processed','failed'));

create or replace function public.claim_paystack_refund(p_transaction_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx public.transactions%rowtype;
begin
  select * into v_tx from public.transactions where id = p_transaction_id for update;
  if not found then raise exception 'Transaction % not found', p_transaction_id; end if;
  if coalesce(v_tx.payment_method,'paystack') = 'campus_wallet' then
    raise exception 'Campus Wallet transactions do not use Paystack refunds';
  end if;
  if v_tx.status not in ('locked','meetup_initiated','release_requested','disputed') then
    raise exception 'Transaction cannot be refunded from its current state';
  end if;
  if not v_tx.paystack_ref then
    raise exception 'Paystack reference is missing; refund cannot be initiated safely';
  end if;
  if v_tx.refund_status in ('pending','processing','processed') then
    return jsonb_build_object('claimed',false,'status',v_tx.refund_status,'refund_id',v_tx.paystack_refund_id);
  end if;
  update public.transactions
    set refund_status='processing',
        refund_initiated_at=coalesce(refund_initiated_at, now()),
        refund_failure_reason=null,
        updated_at=now()
  where id=p_transaction_id;
  return jsonb_build_object('claimed',true,'status','processing','refund_id',null);
end;
$$;

revoke all on function public.claim_paystack_refund(uuid) from public, anon, authenticated;
grant execute on function public.claim_paystack_refund(uuid) to service_role;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((auth.jwt()->'app_metadata'->>'role') in ('admin','platform_admin'), false)
      or coalesce(auth.jwt()->>'role','') = 'service_role';
$$;

create or replace function public.resolve_dispute_verdict(
  p_case_id uuid,
  p_verdict text,
  p_admin_override boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case public.jury_cases%rowtype;
  v_tx public.transactions%rowtype;
  v_recipient uuid;
  v_reason text;
begin
  if p_admin_override then
    if not public.is_platform_admin() then
      raise exception 'Only platform admins can override dispute resolution';
    end if;
  elsif coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Only service_role can execute resolve_dispute_verdict';
  end if;

  select * into v_case from public.jury_cases where id=p_case_id for update;
  if not found then raise exception 'Jury case % not found',p_case_id; end if;
  if v_case.status in ('closed','decided') then return jsonb_build_object('success',true,'already_resolved',true); end if;
  select * into v_tx from public.transactions where id=v_case.transaction_id for update;
  if not found then raise exception 'Associated transaction % not found',v_case.transaction_id; end if;

  if p_verdict='claimant' then
    if coalesce(v_tx.payment_method,'paystack') <> 'campus_wallet'
       and coalesce(v_tx.refund_status,'') not in ('pending','processing','processed') then
      raise exception 'External Paystack refund must be initiated before dispute refund settlement';
    end if;
    v_recipient:=v_tx.buyer_id; v_reason:='Dispute refund: settled in favour of buyer';
    perform set_config('app.escrow_transition','true',true);
    update public.transactions set status='cancelled',cancelled_at=now(),updated_at=now() where id=v_tx.id;
    update public.profiles set plug_score=greatest(coalesce(plug_score,500)-50,0) where id=v_tx.seller_id;
    update public.listings set status='active',updated_at=now() where id=v_tx.listing_id and status='sold';
    if coalesce(v_tx.payment_method,'paystack')='campus_wallet' then
      insert into public.plug_credit_ledger(user_id,amount,reason,reference_id) values(v_recipient,v_tx.amount,v_reason,v_tx.id)
      on conflict (reference_id,reason) do nothing;
    end if;
  elsif p_verdict='respondent' then
    v_recipient:=v_tx.seller_id; v_reason:='Dispute settlement: released to seller';
    perform set_config('app.escrow_transition','true',true);
    update public.transactions set status='released',released_at=now(),completed_at=now(),updated_at=now() where id=v_tx.id;
    insert into public.plug_credit_ledger(user_id,amount,reason,reference_id) values(v_recipient,v_tx.amount,v_reason,v_tx.id)
    on conflict (reference_id,reason) do nothing;
  else
    raise exception 'Invalid verdict %. Must be claimant or respondent',p_verdict;
  end if;

  update public.jury_cases set status='decided',verdict=p_verdict,verdict_decided_at=now() where id=v_case.id;
  insert into public.audit_logs(entity_type,entity_id,user_id,action,metadata)
  values('jury_case',v_case.id,coalesce(auth.uid(),v_tx.seller_id),'dispute_resolved',
    jsonb_build_object('verdict',p_verdict,'transaction_id',v_tx.id,'amount',v_tx.amount,'recipient',v_recipient,'refund_status',v_tx.refund_status));
  return jsonb_build_object('success',true,'case_id',v_case.id,'transaction_id',v_tx.id,'verdict',p_verdict,'recipient',v_recipient,'amount',v_tx.amount);
end;
$$;
