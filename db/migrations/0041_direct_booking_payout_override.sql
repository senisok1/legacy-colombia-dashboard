alter table direct_booking_commissions
  add column if not exists guest_payout_cop_override numeric(14,2);
