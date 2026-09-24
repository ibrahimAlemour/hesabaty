// لوحة تحكم المدير العام: إحصائيات شاملة
import * as adb from './admin-db.js';
import { formatMoney, escapeHtml, computeShopStatus, statusLabel, daysUntil } from './admin-utils.js';
import { emptyState } from '../../js/ui.js';

export async function renderAdminDashboard(container) {
  container.innerHTML = `<div class="skeleton" style="height:300px;"></div>`;

  adb.runAutoSuspendCheck().catch(() => {});

  const [shops, latestSubs, payments, adminSettings] = await Promise.all([
    adb.listShops(), adb.getAllLatestSubscriptions(), adb.getAllPayments(), adb.getAdminSettings()
  ]);
  const grace = (adminSettings && adminSettings.grace_period_days) || 7;
  const reminderDays = (adminSettings && adminSettings.reminder_days_before) || 7;

  const shopsWithStatus = shops.map(s => ({ ...s, sub: latestSubs.get(s.id) || null, computedStatus: computeShopStatus(s, latestSubs.get(s.id), grace) }));

  const activeCount = shopsWithStatus.filter(s => s.computedStatus === 'active').length;
  const suspendedCount = shopsWithStatus.filter(s => s.computedStatus === 'suspended').length;
  const overdueCount = shopsWithStatus.filter(s => s.computedStatus === 'expired' || s.computedStatus === 'overdue').length;
  const expiringSoon = shopsWithStatus.filter(s => s.sub && daysUntil(s.sub.end_date) >= 0 && daysUntil(s.sub.end_date) <= reminderDays);

  const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
  const totalOutstanding = shopsWithStatus
    .filter(s => ['expired', 'overdue', 'suspended'].includes(s.computedStatus) && s.sub)
    .reduce((sum, s) => sum + (s.sub.monthly_price || 0), 0);
  const totalSmsSent = shops.reduce((sum, s) => sum + (s.sms_segments_total || 0), 0);

  const now = new Date();
  const monthlyBuckets = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthlyBuckets.push({ key, label: d.toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' }), total: 0 });
  }
  for (const p of payments) {
    const key = (p.paid_at || '').slice(0, 7);
    const bucket = monthlyBuckets.find(b => b.key === key);
    if (bucket) bucket.total += p.amount;
  }

  container.innerHTML = `
    <div class="kpi-row" style="margin-bottom:14px;">
      <div class="stat-card"><div class="stat-label">🏪 إجمالي المحلات</div><div class="stat-value">${shops.length}</div></div>
      <div class="stat-card cash"><div class="stat-label">✅ محلات نشطة</div><div class="stat-value">${activeCount}</div></div>
      <div class="stat-card debt"><div class="stat-label">🔒 محلات معلّقة</div><div class="stat-value">${suspendedCount}</div></div>
      <div class="stat-card"><div class="stat-label">⚠️ متأخرة/منتهية</div><div class="stat-value" style="color:var(--warning);">${overdueCount}</div></div>
      <div class="stat-card profit wide"><div class="stat-label">💰 إجمالي الإيرادات المحصّلة</div><div class="stat-value">${formatMoney(totalRevenue)}</div></div>
      <div class="stat-card debt wide"><div class="stat-label">📝 إجمالي المبالغ المستحقة</div><div class="stat-value">${formatMoney(totalOutstanding)}</div></div>
      <div class="stat-card wide"><div class="stat-label">✉️ إجمالي الرسائل المرسلة لجميع المحلات</div><div class="stat-value">${totalSmsSent} رسالة</div></div>
    </div>

    <div class="section-title">ملخص الإيرادات الشهرية</div>
    <div class="card">
      <table class="simple-table">
        <tbody>
          ${monthlyBuckets.map(b => `<tr><td>${b.label}</td><td style="text-align:left;font-weight:700;">${formatMoney(b.total)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="section-title">اشتراكات تقترب من الانتهاء (خلال ${reminderDays} أيام)</div>
    <div class="card" style="padding:6px 10px;">
      ${expiringSoon.length ? expiringSoon.map(s => `
        <div class="admin-table-row" data-open="${s.id}">
          <div class="avatar">${escapeHtml(s.name[0])}</div>
          <div class="info" style="flex:1;">
            <div class="shop-name">${escapeHtml(s.name)}</div>
            <div class="shop-meta">ينتهي خلال ${daysUntil(s.sub.end_date)} يوم - ${s.sub.end_date}</div>
          </div>
          <span class="badge status-${s.computedStatus}">${statusLabel(s.computedStatus)}</span>
        </div>`).join('') : emptyState('✅', 'لا توجد اشتراكات تقترب من الانتهاء حاليًا')}
    </div>
  `;

  container.querySelectorAll('[data-open]').forEach(el => el.onclick = () => window.location.hash = `#/shops/${el.dataset.open}`);
}
