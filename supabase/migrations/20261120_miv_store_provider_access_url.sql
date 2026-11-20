-- Persist the per-purchase course/content URL supplied by Kiwify.
-- The value is only returned to the same buyer after a paid purchase is validated.

alter table public.miv_customer_purchases
  add column if not exists provider_access_url text;

comment on column public.miv_customer_purchases.provider_access_url is
  'HTTPS delivery/access URL supplied for this specific Kiwify order; exposed only to the buyer after a paid-order check.';
