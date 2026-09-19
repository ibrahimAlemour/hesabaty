// لوحة التحكم الرئيسية
import { getTodayStats, getRecentSales, getSettings, getTotalOutstandingDebt } from './database.js';
import { getCurrentUser, canViewProfit } from './auth.js';
import { formatMoney, todayLabel, formatTime, escapeHtml } from './utils.js';
import { emptyState } from './ui.js';
import { onSyncStatusChange, getPendingIds } from './sync.js';

export async function renderDashboard(container) {
  container.innerHTML = `<div class="skeleton" style="height:300px;"></div>`;
  const [stats, sales, settings, user, totalDebt, pendingSaleIds] = await Promise.all([
    getTodayStats(), getRecentSales(10), getSettings(), getCurrentUser(), getTotalOutstandingDebt(), getPendingIds('sales')
  ]);
  const showProfit = canViewProfit(user);

  container.innerHTML = `
    <div style="margin-bottom:14px;">
      <div style="font-size:14px;color:var(--text-muted);font-weight:600;">${escapeHtml(settings.shopName)}</div>
      <div style="font-size:13px;color:var(--text-muted);">اليوم: ${todayLabel()}</div>
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">💰 إجمالي المبيعات اليوم</div>
        <div class="stat-value">${formatMoney(stats.totalSales)}</div>
      </div>
      ${showProfit ? `
      <div class="stat-card profit">
        <div class="stat-label">📈 صافي الربح اليوم</div>
        <div class="stat-value">${formatMoney(stats.netProfit)}</div>
      </div>` : `
      <div class="stat-card">
        <div class="stat-label">🧾 عدد الفواتير</div>
        <div class="stat-value">${stats.invoiceCount}</div>
      </div>`}
      <div class="stat-card cash">
        <div class="stat-label">💵 المبالغ النقدية</div>
        <div class="stat-value">${formatMoney(stats.cash)}</div>
      </div>
      <div class="stat-card transfer">
        <div class="stat-label">📱 التحويلات</div>
        <div class="stat-value">${formatMoney(stats.transfer)}</div>
      </div>
      <div class="stat-card debt wide">
        <div class="stat-label">📝 المبيعات الآجلة اليوم / إجمالي الديون المستحقة</div>
        <div class="stat-value">${formatMoney(stats.debt)} <span style="font-size:13px;color:var(--text-muted);font-weight:600;">(الإجمالي: ${formatMoney(totalDebt)})</span></div>
      </div>
    </div>

    <button class="big-cta" id="db-new-sale">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>
      بيع جديد
    </button>

    <div class="quick-grid">
      <div class="quick-btn" data-nav="#/customers"><span class="emoji">👥</span>الزبائن</div>
      <div class="quick-btn" data-nav="#/debts"><span class="emoji">💳</span>الديون</div>
      <div class="quick-btn" data-nav="#/transfers"><span class="emoji">📱</span>التحويلات</div>
      <div class="quick-btn" data-nav="#/products"><span class="emoji">📦</span>المنتجات</div>
      <div class="quick-btn" data-nav="#/reports"><span class="emoji">📊</span>التقارير</div>
      <div class="quick-btn" data-nav="#/cash"><span class="emoji">💰</span>الصندوق</div>
    </div>

    <div class="section-title">آخر العمليات <span class="link" data-nav="#/reports">عرض الكل</span></div>
    <div class="card" style="padding:6px 10px;">
      ${sales.length ? sales.map(s => saleRow(s, pendingSaleIds)).join('') : emptyState('🧾', 'لا توجد عمليات بيع بعد', 'ابدأ بتسجيل أول عملية بيع')}
    </div>
  `;

  container.querySelector('#db-new-sale').onclick = () => window.location.hash = '#/sale/new';
  container.querySelectorAll('[data-nav]').forEach(el => el.onclick = () => window.location.hash = el.dataset.nav);

  if (settings.backendMode === 'supabase') bindDashboardSyncRefresh(container);
}

// نعيد رسم اللوحة تلقائيًا عند تغيّر حالة المزامنة (مثلاً بعد رفع عمليات كانت محفوظة أوف لاين)
// حتى تختفي شارة "غير متزامن" فورًا دون ما يحتاج المستخدم يعمل تحديث يدوي
function bindDashboardSyncRefresh(container) {
  const unsubscribe = onSyncStatusChange((status) => {
    const onDashboard = !window.location.hash || window.location.hash === '#/' || window.location.hash === '#/dashboard';
    if (!onDashboard) { unsubscribe(); return; }
    if (status === 'synced') renderDashboard(container);
  });
}

function saleRow(sale, pendingIds) {
  const methodBadge = sale.payment_status === 'paid'
    ? (sale.paid_transfer > 0 && sale.paid_cash === 0 ? 'transfer' : 'cash')
    : (sale.payment_status === 'debt' ? 'debt' : 'partial');
  const methodLabel = { cash: 'نقدي', transfer: 'تحويل', debt: 'دين', partial: 'مختلط' }[methodBadge];
  const notSynced = pendingIds && pendingIds.has(sale.id);
  return `
    <div class="list-item" style="cursor:pointer;" data-nav="#/invoice/${sale.id}">
      <div class="avatar">${escapeHtml((sale.customer_name_snapshot || 'ز')[0])}</div>
      <div class="info">
        <div class="title">${escapeHtml(sale.customer_name_snapshot || 'زبون نقدي')}</div>
        <div class="subtitle">${sale.invoice_number}</div>
      </div>
      <div style="text-align:left;">
        <div class="amount">${formatMoney(sale.total_amount)}</div>
        <div class="meta">
          <span class="badge ${methodBadge}">${methodLabel}</span>
          ${notSynced ? '<span class="badge unsynced" title="محفوظة على الجهاز، بانتظار الرفع للخادم">⏳ غير متزامن</span>' : ''}
          ${formatTime(sale.created_at)}
        </div>
      </div>
    </div>`;
}
