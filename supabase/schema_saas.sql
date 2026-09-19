-- ============================================================
-- حساباتي SaaS — ترقية من "قاعدة بيانات لكل محل" إلى "قاعدة بيانات مشتركة متعددة المحلات"
-- نفّذه مرة واحدة بعد schema.sql الأصلي، من: Supabase Dashboard > SQL Editor > New Query
-- آمن لإعادة التشغيل (Idempotent) بفضل IF NOT EXISTS / DROP POLICY IF EXISTS في كل مكان
-- ============================================================

-- ---------- 1) جداول SaaS الجديدة ----------

create table if not exists shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_name text,
  phone text,
  address text,
  status text not null default 'pending' check (status in ('active', 'suspended', 'pending')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  monthly_price integer not null default 0, -- بالسنت
  start_date date not null,
  end_date date not null,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_subscriptions_shop on subscriptions (shop_id);
create index if not exists idx_subscriptions_end_date on subscriptions (end_date);

create table if not exists subscription_payments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  subscription_id uuid references subscriptions(id),
  amount integer not null, -- بالسنت
  method text not null default 'cash' check (method in ('cash', 'transfer', 'other')),
  paid_at timestamptz not null default now(),
  period_from date,
  period_to date,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_sub_payments_shop on subscription_payments (shop_id);

create table if not exists admin_settings (
  id text primary key default 'global',
  grace_period_days integer not null default 7,     -- فترة السماح بعد انتهاء الاشتراك قبل التعليق التلقائي
  reminder_days_before integer not null default 7,   -- تنبيه اقتراب التجديد قبل كم يوم
  contact_message text default 'انتهى اشتراكك. للتجديد تواصل معنا.',
  updated_at timestamptz not null default now()
);
insert into admin_settings (id) values ('global') on conflict (id) do nothing;

create table if not exists admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid,
  admin_name text,
  action text not null, -- create_shop | suspend | reactivate | update_subscription | record_payment | update_settings
  target_shop_id uuid references shops(id),
  changes jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_audit_shop on admin_audit_log (target_shop_id);

-- ---------- 2) ربط profiles بالمحلات + دور super_admin ----------

alter table profiles add column if not exists shop_id uuid references shops(id);
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('owner', 'cashier', 'super_admin'));

-- ---------- 3) إضافة shop_id لكل جداول بيانات المحلات (categories تبقى مشتركة عالميًا) ----------

alter table customers add column if not exists shop_id uuid references shops(id);
alter table products add column if not exists shop_id uuid references shops(id);
alter table sales add column if not exists shop_id uuid references shops(id);
alter table sale_items add column if not exists shop_id uuid references shops(id);
alter table payments add column if not exists shop_id uuid references shops(id);
alter table expenses add column if not exists shop_id uuid references shops(id);
alter table cash_transactions add column if not exists shop_id uuid references shops(id);
alter table audit_log add column if not exists shop_id uuid references shops(id);
alter table app_settings add column if not exists shop_id uuid references shops(id);

-- ---------- 4) تهيئة أولية: تحويل الحساب الحالي (owner) إلى Super Admin + إنشاء محل تجريبي لبيانات الاختبار القديمة ----------
-- ملاحظة: هذا يفترض أنك حاليًا صاحب الحساب الوحيد المسجّل (owner)، وهو ما ينطبق على وضعك الآن كمالك للمشروع.
-- إن كانت لديك بيانات اختبار سابقة (فواتير، منتجات...) بدون shop_id، سيتم نقلها لمحل تجريبي جديد حتى لا تُفقد.

do $$
declare
  demo_shop_id uuid;
  has_orphan_data boolean;
begin
  select exists(
    select 1 from customers where shop_id is null
    union all select 1 from products where shop_id is null
    union all select 1 from sales where shop_id is null
    union all select 1 from app_settings where shop_id is null
  ) into has_orphan_data;

  if has_orphan_data then
    insert into shops (name, owner_name, phone, status)
    values ('المحل التجريبي (بيانات سابقة)', 'بيانات ما قبل الترقية', '', 'active')
    returning id into demo_shop_id;

    update customers set shop_id = demo_shop_id where shop_id is null;
    update products set shop_id = demo_shop_id where shop_id is null;
    update sales set shop_id = demo_shop_id where shop_id is null;
    update sale_items set shop_id = demo_shop_id where shop_id is null;
    update payments set shop_id = demo_shop_id where shop_id is null;
    update expenses set shop_id = demo_shop_id where shop_id is null;
    update cash_transactions set shop_id = demo_shop_id where shop_id is null;
    update audit_log set shop_id = demo_shop_id where shop_id is null;
    update app_settings set shop_id = demo_shop_id, id = demo_shop_id::text where shop_id is null;

    insert into subscriptions (shop_id, monthly_price, start_date, end_date, notes)
    values (demo_shop_id, 0, current_date, current_date + interval '365 days', 'اشتراك تجريبي تلقائي عند الترقية');
  end if;

  -- تحويل حساب owner الحالي إلى super_admin - مرة واحدة فقط (أول تشغيل) حتى لا يُعاد تنفيذها بالخطأ
  -- على مالكي محلات حقيقيين أُنشئوا لاحقًا بنفس الدور 'owner' لو أُعيد تشغيل هذا الملف
  if not exists (select 1 from profiles where role = 'super_admin') then
    update profiles set role = 'super_admin', shop_id = null where role = 'owner';
  end if;
end $$;

-- ---------- 5) دوال مساعدة آمنة من الاستدعاء الذاتي (SECURITY DEFINER + search_path ثابت) ----------

create or replace function is_super_admin()
returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'super_admin');
$$;

create or replace function my_shop_id()
returns uuid
language sql security definer set search_path = public stable as $$
  select shop_id from profiles where id = auth.uid();
$$;

-- ملاحظة: صلاحية "مالك المحل" تُفحص عبر is_owner() المعرّفة مسبقًا بـ schema.sql (نفس المنطق: role = 'owner')

-- تعليق تلقائي للمحلات المنتهي اشتراكها بعد فترة السماح؛ يستدعيها لوحة المدير عند التحميل (وبإمكانك جدولتها عبر pg_cron إن كانت متاحة)
create or replace function check_and_suspend_expired_shops()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  grace int;
  affected int;
begin
  select grace_period_days into grace from admin_settings where id = 'global';
  grace := coalesce(grace, 7);

  with latest_sub as (
    select distinct on (shop_id) shop_id, end_date
    from subscriptions
    order by shop_id, end_date desc
  )
  update shops s
  set status = 'suspended', updated_at = now()
  from latest_sub ls
  where s.id = ls.shop_id
    and s.status = 'active'
    and ls.end_date < (current_date - grace);

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- (اختياري) لو كانت إضافة pg_cron متاحة بمشروعك يمكنك جدولة الفحص يوميًا بتشغيل السطر التالي يدويًا لاحقًا:
-- select cron.schedule('suspend-expired-shops', '0 3 * * *', $$select check_and_suspend_expired_shops();$$);

-- سياسات profiles الأصلية كانت تعتمد على is_owner() فقط (مالك محله)؛ الآن نضيف Super Admin ليرى/يدير كل الحسابات
drop policy if exists "profiles_select" on profiles;
drop policy if exists "profiles_insert_self" on profiles;
drop policy if exists "profiles_update_self_or_owner" on profiles;
create policy profiles_select on profiles for select using (auth.uid() = id or is_owner() or is_super_admin());
create policy profiles_insert_self on profiles for insert with check (auth.uid() = id or is_super_admin());
create policy profiles_update_self_or_owner on profiles for update using (auth.uid() = id or is_owner() or is_super_admin());

-- ---------- 6) إعادة كتابة RLS لكل الجداول القديمة لتصبح معزولة بالكامل حسب shop_id ----------

alter table customers enable row level security;
alter table products enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table payments enable row level security;
alter table expenses enable row level security;
alter table cash_transactions enable row level security;
alter table audit_log enable row level security;
alter table categories enable row level security;
alter table app_settings enable row level security;

drop policy if exists customers_select on customers;
drop policy if exists customers_insert on customers;
drop policy if exists customers_update on customers;
drop policy if exists customers_delete_owner on customers;
create policy customers_isolated_select on customers for select using (shop_id = my_shop_id() or is_super_admin());
create policy customers_isolated_insert on customers for insert with check (shop_id = my_shop_id());
create policy customers_isolated_update on customers for update using (shop_id = my_shop_id() or is_super_admin());
create policy customers_isolated_delete on customers for delete using ((shop_id = my_shop_id() and is_owner()) or is_super_admin());

drop policy if exists products_select on products;
drop policy if exists products_insert on products;
drop policy if exists products_update on products;
drop policy if exists products_delete_owner on products;
create policy products_isolated_select on products for select using (shop_id = my_shop_id() or is_super_admin());
create policy products_isolated_insert on products for insert with check (shop_id = my_shop_id());
create policy products_isolated_update on products for update using (shop_id = my_shop_id() or is_super_admin());
create policy products_isolated_delete on products for delete using ((shop_id = my_shop_id() and is_owner()) or is_super_admin());

drop policy if exists sales_select on sales;
drop policy if exists sales_insert on sales;
drop policy if exists sales_update_owner on sales;
drop policy if exists sales_delete_owner on sales;
create policy sales_isolated_select on sales for select using (shop_id = my_shop_id() or is_super_admin());
create policy sales_isolated_insert on sales for insert with check (shop_id = my_shop_id());
create policy sales_isolated_update on sales for update using ((shop_id = my_shop_id() and is_owner()) or is_super_admin());
create policy sales_isolated_delete on sales for delete using ((shop_id = my_shop_id() and is_owner()) or is_super_admin());

drop policy if exists sale_items_select on sale_items;
drop policy if exists sale_items_insert on sale_items;
drop policy if exists sale_items_update_owner on sale_items;
drop policy if exists sale_items_delete_owner on sale_items;
create policy sale_items_isolated_select on sale_items for select using (shop_id = my_shop_id() or is_super_admin());
create policy sale_items_isolated_insert on sale_items for insert with check (shop_id = my_shop_id());
create policy sale_items_isolated_update on sale_items for update using ((shop_id = my_shop_id() and is_owner()) or is_super_admin());
create policy sale_items_isolated_delete on sale_items for delete using ((shop_id = my_shop_id() and is_owner()) or is_super_admin());

drop policy if exists payments_select on payments;
drop policy if exists payments_insert on payments;
drop policy if exists payments_update_owner on payments;
drop policy if exists payments_delete_owner on payments;
create policy payments_isolated_select on payments for select using (shop_id = my_shop_id() or is_super_admin());
create policy payments_isolated_insert on payments for insert with check (shop_id = my_shop_id());
create policy payments_isolated_update on payments for update using ((shop_id = my_shop_id() and is_owner()) or is_super_admin());
create policy payments_isolated_delete on payments for delete using ((shop_id = my_shop_id() and is_owner()) or is_super_admin());

drop policy if exists expenses_select_owner on expenses;
drop policy if exists expenses_write_owner on expenses;
create policy expenses_isolated_select on expenses for select using ((shop_id = my_shop_id() and is_owner()) or is_super_admin());
create policy expenses_isolated_write on expenses for all
  using ((shop_id = my_shop_id() and is_owner()) or is_super_admin())
  with check ((shop_id = my_shop_id() and is_owner()) or is_super_admin());

drop policy if exists cash_tx_select_owner on cash_transactions;
drop policy if exists cash_tx_insert on cash_transactions;
create policy cash_tx_isolated_select on cash_transactions for select using ((shop_id = my_shop_id() and is_owner()) or is_super_admin());
create policy cash_tx_isolated_insert on cash_transactions for insert with check (shop_id = my_shop_id());

drop policy if exists audit_select_owner on audit_log;
drop policy if exists audit_insert on audit_log;
create policy audit_isolated_select on audit_log for select using ((shop_id = my_shop_id() and is_owner()) or is_super_admin());
create policy audit_isolated_insert on audit_log for insert with check (shop_id = my_shop_id());

-- categories: تبقى بيانات مرجعية مشتركة لكل المحلات (نفس التصنيفات الستة للجميع)
drop policy if exists categories_select on categories;
drop policy if exists categories_write on categories;
create policy categories_shared_select on categories for select using (auth.role() = 'authenticated');
create policy categories_admin_write on categories for all using (is_super_admin()) with check (is_super_admin());

-- app_settings: صف واحد لكل محل الآن (id = shop_id كنص)
drop policy if exists settings_select on app_settings;
drop policy if exists settings_upsert on app_settings;
drop policy if exists settings_update on app_settings;
create policy settings_isolated_select on app_settings for select using (shop_id = my_shop_id() or is_super_admin());
create policy settings_isolated_insert on app_settings for insert with check (shop_id = my_shop_id());
create policy settings_isolated_update on app_settings for update using (shop_id = my_shop_id() or is_super_admin());

-- ---------- 7) صلاحيات جداول SaaS الجديدة: Super Admin فقط، عدا رؤية محدودة لصاحب المحل لنفسه ----------

alter table shops enable row level security;
alter table subscriptions enable row level security;
alter table subscription_payments enable row level security;
alter table admin_settings enable row level security;
alter table admin_audit_log enable row level security;

drop policy if exists shops_admin_all on shops;
drop policy if exists shops_self_select on shops;
create policy shops_admin_all on shops for all using (is_super_admin()) with check (is_super_admin());
create policy shops_self_select on shops for select using (id = my_shop_id());

drop policy if exists subscriptions_admin_all on subscriptions;
drop policy if exists subscriptions_self_select on subscriptions;
create policy subscriptions_admin_all on subscriptions for all using (is_super_admin()) with check (is_super_admin());
create policy subscriptions_self_select on subscriptions for select using (shop_id = my_shop_id());

drop policy if exists sub_payments_admin_all on subscription_payments;
create policy sub_payments_admin_all on subscription_payments for all using (is_super_admin()) with check (is_super_admin());

drop policy if exists admin_settings_admin_all on admin_settings;
drop policy if exists admin_settings_read_all_auth on admin_settings;
create policy admin_settings_admin_all on admin_settings for all using (is_super_admin()) with check (is_super_admin());
create policy admin_settings_read_all_auth on admin_settings for select using (auth.role() = 'authenticated');

drop policy if exists admin_audit_admin_all on admin_audit_log;
create policy admin_audit_admin_all on admin_audit_log for all using (is_super_admin()) with check (is_super_admin());

-- ---------- 8) حذف محل نهائيًا: نجعل كل الجداول المرتبطة بـ shop_id تُحذف تلقائيًا (Cascade) ----------
-- بدون هذا، حذف صف من جدول shops كان سيُرفض لوجود بيانات مرتبطة به (حماية افتراضية من Postgres)
-- بعد هذا التعديل: حذف المحل من لوحة المدير يحذف معه كل فواتيره وزبائنه ومنتجاته وسجلاته دفعة واحدة ولا يمكن التراجع عنه

do $$
declare
  t text;
begin
  foreach t in array array['customers','products','sales','sale_items','payments','expenses','cash_transactions','audit_log','app_settings']
  loop
    execute format('alter table %I drop constraint if exists %I', t, t || '_shop_id_fkey');
    execute format('alter table %I add constraint %I foreign key (shop_id) references shops(id) on delete cascade', t, t || '_shop_id_fkey');
  end loop;
end $$;

alter table profiles drop constraint if exists profiles_shop_id_fkey;
alter table profiles add constraint profiles_shop_id_fkey foreign key (shop_id) references shops(id) on delete cascade;

-- admin_audit_log استثناء: نريد الاحتفاظ بسجل التدقيق حتى بعد حذف المحل (كدليل أنه كان موجودًا وحُذف)
-- لذلك نفرغ الإشارة فقط (SET NULL) بدل حذف صفوف السجل نفسها
alter table admin_audit_log drop constraint if exists admin_audit_log_target_shop_id_fkey;
alter table admin_audit_log add constraint admin_audit_log_target_shop_id_fkey foreign key (target_shop_id) references shops(id) on delete set null;

-- ============================================================
-- انتهت الترقية. الخطوة التالية: افتح admin/index.html وسجّل دخول بنفس حسابك (أصبح Super Admin تلقائيًا).
-- ============================================================
