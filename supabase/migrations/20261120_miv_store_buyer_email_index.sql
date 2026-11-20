-- Match the case-normalized buyer_email equality filter used by the customer store API.
create index if not exists miv_customer_purchases_buyer_email_idx
  on public.miv_customer_purchases (buyer_email, purchased_at desc);
