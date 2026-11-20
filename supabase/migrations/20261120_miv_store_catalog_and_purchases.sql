-- MIV customer store: catalog and add-on purchase ledger.
-- All access is server-side through the Supabase service role. No public table access is granted.

begin;

create table if not exists public.miv_products (
  id uuid primary key default gen_random_uuid(),
  kiwify_product_id text not null unique,
  slug text not null unique,
  title text not null,
  short_description text,
  description text,
  cover_image_url text,
  checkout_url text,
  access_url text,
  access_instructions text,
  is_published boolean not null default false,
  display_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint miv_products_kiwify_product_id_not_blank check (length(btrim(kiwify_product_id)) > 0),
  constraint miv_products_slug_not_blank check (length(btrim(slug)) > 0),
  constraint miv_products_title_not_blank check (length(btrim(title)) > 0)
);

create table if not exists public.miv_customer_purchases (
  id uuid primary key default gen_random_uuid(),
  buyer_email text not null,
  kiwify_order_id text not null unique,
  kiwify_product_id text not null,
  product_name text not null,
  purchase_status text not null default 'paid'
    check (purchase_status in ('paid','refunded','chargeback')),
  amount numeric(12,2),
  currency text,
  purchased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint miv_customer_purchases_email_not_blank check (length(btrim(buyer_email)) > 0),
  constraint miv_customer_purchases_order_not_blank check (length(btrim(kiwify_order_id)) > 0),
  constraint miv_customer_purchases_product_not_blank check (length(btrim(kiwify_product_id)) > 0)
);

create index if not exists miv_customer_purchases_email_idx
  on public.miv_customer_purchases (lower(buyer_email), purchased_at desc);
create index if not exists miv_customer_purchases_product_idx
  on public.miv_customer_purchases (kiwify_product_id, purchase_status);
create index if not exists miv_products_published_order_idx
  on public.miv_products (is_published, display_order, title);

alter table public.miv_products enable row level security;
alter table public.miv_customer_purchases enable row level security;

revoke all on public.miv_products from anon, authenticated;
revoke all on public.miv_customer_purchases from anon, authenticated;
grant all on public.miv_products to service_role;
grant all on public.miv_customer_purchases to service_role;

comment on table public.miv_products is
  'Catalog of additional Tri Digital digital products. Product content is unlocked only after a matching paid Kiwify order.';
comment on table public.miv_customer_purchases is
  'Minimal Kiwify purchase ledger for additional MIV customer-area products; stores no raw webhook payload or payment-card data.';

commit;
