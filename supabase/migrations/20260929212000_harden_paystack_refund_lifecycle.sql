-- Paystack refund lifecycle hardening.
-- The live functions below were verified after deployment.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS refund_status text,
  ADD COLUMN IF NOT EXISTS paystack_refund_id text,
  ADD COLUMN IF NOT EXISTS refund_initiated_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_failure_reason text;

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_refund_status_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_refund_status_check CHECK (refund_status IS NULL OR refund_status IN ('pending','processing','needs-attention','processed','failed'));
CREATE UNIQUE INDEX IF NOT EXISTS transactions_paystack_refund_id_uq ON public.transactions(paystack_refund_id) WHERE paystack_refund_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.process_escrow_action(p_transaction_id uuid, p_action text, p_qr_secret text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  tx public.transactions%rowtype;
  actor uuid := auth.uid();
  privileged boolean := (auth.role()='service_role');
  safe_zone record;
  previous_status text;
begin
  if actor is null and not privileged then raise exception 'Authentication required'; end if;
  select * into tx from public.transactions where id=p_transaction_id for update;
  if not found then raise exception 'Transaction not found'; end if;
  if not privileged and actor<>tx.buyer_id and actor<>tx.seller_id then raise exception 'Not authorized for this transaction'; end if;
  previous_status := tx.status;

  if coalesce((tx.metadata->>'duress_active')::boolean,false)
     and p_action in ('release','auto_release','request_release') then
    raise exception 'Escrow is frozen by a safety alert';
  end if;

  perform set_config('app.escrow_transition','true',true);

  case p_action
    when 'initiate_meetup' then
      if privileged or actor<>tx.seller_id then raise exception 'Only the seller can initiate the meetup'; end if;
      if tx.status<>'locked' then raise exception 'Meetup can only start from locked state'; end if;
      update public.transactions set status='meetup_initiated',meetup_initiated_at=coalesce(meetup_initiated_at,now()) where id=tx.id;

    when 'request_release' then
      if privileged or actor<>tx.seller_id then raise exception 'Only the seller can request release'; end if;
      if tx.status<>'meetup_initiated' then raise exception 'Release can only be requested after meetup initiation'; end if;
      if tx.meetup_initiated_at is null or tx.meetup_initiated_at>now()-interval '24 hours' then raise exception '24-hour release gate has not elapsed'; end if;
      update public.transactions set status='release_requested',release_requested_at=coalesce(release_requested_at,now()),auto_release_at=now()+interval '48 hours' where id=tx.id;

    when 'release' then
      if privileged or actor<>tx.buyer_id then raise exception 'Only the buyer can release escrow'; end if;
      if tx.status not in ('meetup_initiated','release_requested') then raise exception 'Escrow is not ready for buyer release'; end if;
      if tx.meetup_initiated_at is null or tx.meetup_initiated_at>now()-interval '24 hours' then raise exception '24-hour release gate has not elapsed'; end if;
      if tx.status='release_requested' and tx.auto_release_at is not null and tx.auto_release_at<=now() then raise exception 'Buyer release window has expired'; end if;
      if p_qr_secret is null or p_qr_secret<>coalesce(tx.qr_secret,tx.release_code) then raise exception 'Invalid release credential'; end if;
      if tx.buyer_lat is null or tx.buyer_lng is null or tx.buyer_location_captured_at is null or tx.buyer_location_captured_at<now()-interval '10 minutes' then raise exception 'Safe Swap location is missing or stale'; end if;
      select * into safe_zone from public.is_in_safe_swap_zone(tx.buyer_lat,tx.buyer_lng,(select university from public.profiles where id=tx.buyer_id)) limit 1;
      if not found then raise exception 'QR release is only allowed inside an approved 50m Safe Swap Zone'; end if;
      update public.transactions set status='released',released_at=now(),completed_at=now(),buyer_safe_zone_id=safe_zone.zone_id where id=tx.id;
      insert into public.plug_credit_ledger(user_id,amount,reason,reference_id) values(tx.seller_id,tx.amount,'Escrow release',tx.id) on conflict do nothing;

    when 'dispute' then
      if privileged or actor<>tx.buyer_id then raise exception 'Only the buyer can dispute'; end if;
      if tx.status<>'release_requested' then raise exception 'Transaction is not in the dispute window'; end if;
      if tx.auto_release_at is not null and tx.auto_release_at<=now() then raise exception 'Dispute window has expired'; end if;
      if p_reason is null or length(trim(p_reason))<20 then raise exception 'Dispute reason must be at least 20 characters'; end if;
      update public.transactions set status='disputed',disputed_at=now(),dispute_reason=trim(p_reason) where id=tx.id;

    when 'refund' then
      if not privileged then raise exception 'Refund is an administrative action'; end if;
      if tx.status not in ('locked','meetup_initiated','release_requested','disputed') then raise exception 'Transaction cannot be refunded'; end if;
      if coalesce(tx.payment_method,'paystack') <> 'campus_wallet'
         and coalesce(tx.refund_status,'') not in ('pending','processing','processed') then
        raise exception 'Paystack refund must be initiated before escrow can be closed';
      end if;
      update public.transactions set status='cancelled',cancelled_at=now() where id=tx.id;
      if coalesce(tx.payment_method,'paystack')='campus_wallet' then
        insert into public.plug_credit_ledger(user_id,amount,reason,reference_id) values(tx.buyer_id,tx.amount,'Escrow refund',tx.id) on conflict do nothing;
      end if;
      update public.listings set status='active',updated_at=now() where id=tx.listing_id and status='sold';

    when 'auto_release' then
      if not privileged then raise exception 'Auto-release is service-only'; end if;
      if tx.status<>'release_requested' or tx.auto_release_at is null or tx.auto_release_at>now() then raise exception 'Transaction is not due for auto-release'; end if;
      update public.transactions set status='released',released_at=now(),completed_at=now() where id=tx.id;
      insert into public.plug_credit_ledger(user_id,amount,reason,reference_id) values(tx.seller_id,tx.amount,'Escrow auto-release',tx.id) on conflict do nothing;

    else
      raise exception 'Invalid escrow action: %',p_action;
  end case;

  insert into public.audit_logs(user_id,entity_type,entity_id,action,metadata)
  values(coalesce(actor,tx.seller_id),'transaction',tx.id,'escrow_'||p_action,
    jsonb_build_object('previous_status',previous_status,'new_status',
      case p_action when 'initiate_meetup' then 'meetup_initiated' when 'request_release' then 'release_requested'
      when 'release' then 'released' when 'dispute' then 'disputed' when 'refund' then 'cancelled'
      when 'auto_release' then 'released' else tx.status end));
  return jsonb_build_object('success',true,'transaction_id',tx.id,'action',p_action);
end;
$function$


CREATE OR REPLACE FUNCTION public.resolve_dispute_verdict(p_case_id uuid, p_verdict text, p_admin_override boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_case public.jury_cases%rowtype;
  v_tx public.transactions%rowtype;
  v_recipient uuid;
  v_reason text;
begin
  if not p_admin_override and auth.role() <> 'service_role' then raise exception 'Only service_role or admin can execute resolve_dispute_verdict'; end if;
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
      insert into public.plug_credit_ledger(user_id,amount,reason,reference_id) values(v_recipient,v_tx.amount,v_reason,v_tx.id) on conflict (reference_id,reason) do nothing;
    end if;
  elsif p_verdict='respondent' then
    v_recipient:=v_tx.seller_id; v_reason:='Dispute settlement: released to seller';
    perform set_config('app.escrow_transition','true',true);
    update public.transactions set status='released',released_at=now(),completed_at=now(),updated_at=now() where id=v_tx.id;
    insert into public.plug_credit_ledger(user_id,amount,reason,reference_id) values(v_recipient,v_tx.amount,v_reason,v_tx.id) on conflict (reference_id,reason) do nothing;
  else raise exception 'Invalid verdict %. Must be claimant or respondent',p_verdict; end if;

  update public.jury_cases set status='decided',verdict=p_verdict,verdict_decided_at=now() where id=v_case.id;
  insert into public.audit_logs(entity_type,entity_id,user_id,action,metadata)
  values('jury_case',v_case.id,coalesce(auth.uid(),v_tx.seller_id),'dispute_resolved',
    jsonb_build_object('verdict',p_verdict,'transaction_id',v_tx.id,'amount',v_tx.amount,'recipient',v_recipient,'refund_status',v_tx.refund_status));
  return jsonb_build_object('success',true,'case_id',v_case.id,'transaction_id',v_tx.id,'verdict',p_verdict,'recipient',v_recipient,'amount',v_tx.amount);
end;
$function$;
