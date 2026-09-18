-- ============================================================
-- حساباتي - Schema لقاعدة بيانات Supabase (Postgres)
-- نفّذ هذا الملف كاملاً في: Supabase Dashboard > SQL Editor > New Query
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- profiles ----------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  phone text,
  role text not null default 'cashier' check (role in ('owner', 'cashier')),
  created_at timestamptz not null default now()
);

-- ---------- app_settings (سجل واحد فقط لبيانات المحل) ----------
create table if not exists app_settings (
  id text primary key default 'app',
  shop_name text not null default 'محلي',
  phone text,
  address text,
  currency text not null default '₪',
  timezone text not null default 'Asia/Gaza',
  theme text not null default 'auto',
  last_invoice_number integer not null default 0,
  opening_cash_balance integer not null default 0,
  opening_cash_date timestamptz default now(),
  updated_at timestamptz not null default now()
);

-- ---------- categories ----------
create table if not exists categories (
  id text primary key,
  name text not null,
  icon text,
  created_at timestamptz not null default now()
);

insert into categories (id, name, icon) values
  ('cat-meat', 'لحوم', '🥩'),
  ('cat-chicken', 'دجاج', '🍗'),
  ('cat-vegetables', 'خضار', '🥬'),
  ('cat-fruits', 'فواكه', '🍎'),
  ('cat-groceries', 'مواد غذائية', '🧂'),
  ('cat-other', 'أخرى', '📦')
on conflict (id) do nothing;

-- ---------- customers ----------
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  notes text,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_customers_deleted on customers (is_deleted);

-- ---------- products ----------
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category_id text references categories(id),
  unit text not null default 'كغ',
  cost_price integer not null default 0,     -- بالسنت (1/100 شيكل)
  selling_price integer not null default 0,  -- بالسنت
  notes text,
  quick_access boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_products_category on products (category_id);
create index if not exists idx_products_active on products (is_active);

-- ---------- sales (رأس الفاتورة) ----------
create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  invoice_seq integer not null,
  customer_id uuid references customers(id),
  customer_name_snapshot text,
  subtotal integer not null default 0,
  total_cost integer not null default 0,
  total_profit integer not null default 0,
  total_amount integer not null default 0,
  paid_cash integer not null default 0,
  paid_transfer integer not null default 0,
  paid_debt integer not null default 0,
  transfer_reference text,
  transfer_bank text,
  payment_status text not null default 'paid' check (payment_status in ('paid', 'partial', 'debt')),
  notes text,
  is_deleted boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  edit_history jsonb not null default '[]'::jsonb
);
create index if not exists idx_sales_customer on sales (customer_id);
create index if not exists idx_sales_created on sales (created_at);
create index if not exists idx_sales_deleted on sales (is_deleted);

-- ---------- sale_items (تفاصيل الفاتورة) ----------
create table if not exists sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete cascade,
  product_id uuid references products(id),
  product_name text not null,
  quantity numeric not null,
  unit text not null,
  cost_price integer not null default 0,
  selling_price integer not null default 0,
  total_cost integer not null default 0,
  total_price integer not null default 0,
  profit integer not null default 0
);
create index if not exists idx_sale_items_sale on sale_items (sale_id);
create index if not exists idx_sale_items_product on sale_items (product_id);

-- ---------- payments (تحصيل ديون الزبائن) ----------
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  sale_id uuid references sales(id),
  amount integer not null,
  method text not null check (method in ('cash', 'transfer')),
  reference_number text,
  bank_name text,
  notes text,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_payments_customer on payments (customer_id);
create index if not exists idx_payments_created on payments (created_at);

-- ---------- expenses ----------
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  amount integer not null,
  category text not null,
  notes text,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_expenses_created on expenses (created_at);

-- ---------- cash_transactions (سجل تدقيقي لحركة الصندوق) ----------
create table if not exists cash_transactions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('sale_cash', 'payment_cash', 'expense', 'opening')),
  amount integer not null,
  reference_type text,
  reference_id uuid,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_cash_tx_created on cash_transactions (created_at);

-- ---------- audit_log ----------
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id text not null,
  action text not null,
  changes jsonb,
  user_id text,
  user_name text,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_entity on audit_log (entity_type, entity_id);

-- ============================================================
-- Row Level Security
-- المشروع مصمم لكل محل على حدة (قاعدة بيانات منفصلة لكل صاحب محل)
-- لذلك القاعدة العامة: كل مستخدم مسجل دخول (owner أو cashier) يستطيع القراءة والكتابة
-- بينما الحذف الفعلي والعمليات الحساسة مقيّدة بدور "owner" فقط
-- ============================================================

alter table profiles enable row level security;
alter table app_settings enable row level security;
alter table categories enable row level security;
alter table customers enable row level security;
alter table products enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table payments enable row level security;
alter table expenses enable row level security;
alter table cash_transactions enable row level security;
alter table audit_log enable row level security;

create or replace function is_owner()
returns boolean language sql stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'owner');
$$;

-- profiles: كل مستخدم يرى ملفه الشخصي، وصاحب المحل يرى كل الحسابات
create policy "profiles_select" on profiles for select using (auth.uid() = id or is_owner());
create policy "profiles_insert_self" on profiles for insert with check (auth.uid() = id);
create policy "profiles_update_self_or_owner" on profiles for update using (auth.uid() = id or is_owner());

-- app_settings: قراءة/تحديث لأي مستخدم مسجل، بدون حذف
create policy "settings_select" on app_settings for select using (auth.role() = 'authenticated');
create policy "settings_upsert" on app_settings for insert with check (auth.role() = 'authenticated');
create policy "settings_update" on app_settings for update using (auth.role() = 'authenticated');

-- categories: قراءة للجميع، تعديل لصاحب المحل فقط
create policy "categories_select" on categories for select using (auth.role() = 'authenticated');
create policy "categories_write" on categories for all using (is_owner()) with check (is_owner());

-- customers
create policy "customers_select" on customers for select using (auth.role() = 'authenticated');
create policy "customers_insert" on customers for insert with check (auth.role() = 'authenticated');
create policy "customers_update" on customers for update using (auth.role() = 'authenticated');
create policy "customers_delete_owner" on customers for delete using (is_owner());

-- products
create policy "products_select" on products for select using (auth.role() = 'authenticated');
create policy "products_insert" on products for insert with check (auth.role() = 'authenticated');
create policy "products_update" on products for update using (auth.role() = 'authenticated');
create policy "products_delete_owner" on products for delete using (is_owner());

-- sales
create policy "sales_select" on sales for select using (auth.role() = 'authenticated');
create policy "sales_insert" on sales for insert with check (auth.role() = 'authenticated');
create policy "sales_update_owner" on sales for update using (is_owner());
create policy "sales_delete_owner" on sales for delete using (is_owner());

-- sale_items
create policy "sale_items_select" on sale_items for select using (auth.role() = 'authenticated');
create policy "sale_items_insert" on sale_items for insert with check (auth.role() = 'authenticated');
create policy "sale_items_update_owner" on sale_items for update using (is_owner());
create policy "sale_items_delete_owner" on sale_items for delete using (is_owner());

-- payments
create policy "payments_select" on payments for select using (auth.role() = 'authenticated');
create policy "payments_insert" on payments for insert with check (auth.role() = 'authenticated');
create policy "payments_update_owner" on payments for update using (is_owner());
create policy "payments_delete_owner" on payments for delete using (is_owner());

-- expenses: صاحب المحل فقط (المصروفات حساسة)
create policy "expenses_select_owner" on expenses for select using (is_owner());
create policy "expenses_write_owner" on expenses for all using (is_owner()) with check (is_owner());

-- cash_transactions: قراءة لصاحب المحل فقط
create policy "cash_tx_select_owner" on cash_transactions for select using (is_owner());
create policy "cash_tx_insert" on cash_transactions for insert with check (auth.role() = 'authenticated');

-- audit_log: صاحب المحل فقط
create policy "audit_select_owner" on audit_log for select using (is_owner());
create policy "audit_insert" on audit_log for insert with check (auth.role() = 'authenticated');

-- ============================================================
-- ملاحظة مهمة: لا تضع Service Role Key داخل كود الواجهة أبدًا.
-- استخدم فقط Project URL و anon public key في إعدادات التطبيق.
-- ============================================================
