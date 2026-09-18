// التقارير: ملخص، أكثر المنتجات مبيعًا، رسم بياني للأرباح
import * as db from './database.js';
import { getCurrentUser, canViewProfit } from './auth.js';
import { formatMoney, formatNumber, dateRangeFor, startOfDay, endOfDay, escapeHtml } from './utils.js';
import { emptyState } from './ui.js';

let currentPreset = 'today';
let customFrom = null, customTo = null;
let chartInstance = null;

const PRESETS = [
  ['today', 'اليوم'], ['yesterday', 'أمس'], ['last7', 'آخر 7 أيام'],
  ['month', 'هذا الشهر'], ['prevMonth', 'الشهر السابق'], ['custom', 'فترة مخصصة']
];

export async function renderReports(container) {
  container.innerHTML = `<div class="skeleton" style="height:300px;"></div>`;
  await renderForPreset(container, currentPreset);
}

function getRange(preset) {
  if (preset === 'custom' && customFrom && customTo) return { from: startOfDay(new Date(customFrom)), to: endOfDay(new Date(customTo)) };
  return dateRangeFor(preset === 'custom' ? 'today' : preset);
}

async function renderForPreset(container, preset) {
  currentPreset = preset;
  const range = getRange(preset);
  const [summary, topProducts, profitByDay, user] = await Promise.all([
    db.getReportSummary(range), db.getTopProducts({ ...range, limit: 8 }), db.getProfitByDay(range), getCurrentUser()
  ]);
  const showProfit = canViewProfit(user);

  container.innerHTML = `
    <div class="tabs">
      ${PRESETS.map(([k, l]) => `<button class="tab-btn ${preset === k ? 'active' : ''}" data-preset="${k}">${l}</button>`).join('')}
    </div>
    ${preset === 'custom' ? `
    <div class="card" style="display:flex;gap:8px;align-items:end;">
      <div class="form-group" style="flex:1;margin-bottom:0;"><label>من</label><input type="date" id="custom-from" value="${customFrom || ''}"></div>
      <div class="form-group" style="flex:1;margin-bottom:0;"><label>إلى</label><input type="date" id="custom-to" value="${customTo || ''}"></div>
      <button class="btn btn-primary" id="apply-custom">تطبيق</button>
    </div>` : ''}

    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">🧾 إجمالي المبيعات</div><div class="stat-value">${formatMoney(summary.totalSales)}</div></div>
      ${showProfit ? `<div class="stat-card profit"><div class="stat-label">📈 صافي الربح</div><div class="stat-value">${formatMoney(summary.netProfit)}</div></div>` : ''}
      <div class="stat-card cash"><div class="stat-label">💵 النقد</div><div class="stat-value">${formatMoney(summary.totalCash)}</div></div>
      <div class="stat-card transfer"><div class="stat-label">📱 التحويلات</div><div class="stat-value">${formatMoney(summary.totalTransfer)}</div></div>
      <div class="stat-card debt"><div class="stat-label">📝 مبيعات آجلة</div><div class="stat-value">${formatMoney(summary.totalDebtNew)}</div></div>
      <div class="stat-card"><div class="stat-label">✅ محصّل من الديون</div><div class="stat-value">${formatMoney(summary.debtCollected)}</div></div>
      ${showProfit ? `<div class="stat-card"><div class="stat-label">💲 إجمالي التكلفة</div><div class="stat-value">${formatMoney(summary.totalCost)}</div></div>
      <div class="stat-card"><div class="stat-label">💸 المصروفات</div><div class="stat-value">${formatMoney(summary.totalExpenses)}</div></div>` : ''}
      <div class="stat-card"><div class="stat-label">🧮 عدد الفواتير</div><div class="stat-value">${summary.invoiceCount}</div></div>
      <div class="stat-card"><div class="stat-label">📊 متوسط الفاتورة</div><div class="stat-value">${formatMoney(summary.avgSale)}</div></div>
    </div>

    ${showProfit ? `
    <div class="section-title">الأرباح حسب الأيام</div>
    <div class="card"><canvas id="profit-chart" height="180"></canvas></div>` : ''}

    <div class="section-title">أكثر المنتجات مبيعًا</div>
    <div class="card" style="padding:6px 10px;">
      ${topProducts.length ? topProducts.map((p, i) => topProductRow(p, i, showProfit)).join('') : emptyState('📦', 'لا توجد مبيعات في هذه الفترة')}
    </div>
  `;

  container.querySelectorAll('[data-preset]').forEach(btn => btn.onclick = () => renderForPreset(container, btn.dataset.preset));
  const applyBtn = container.querySelector('#apply-custom');
  if (applyBtn) applyBtn.onclick = () => {
    customFrom = container.querySelector('#custom-from').value;
    customTo = container.querySelector('#custom-to').value;
    if (!customFrom || !customTo) return;
    renderForPreset(container, 'custom');
  };

  if (showProfit) await drawChart(container, profitByDay);
}

function topProductRow(p, index, showProfit) {
  return `
    <div class="list-item">
      <div class="avatar">${index + 1}</div>
      <div class="info">
        <div class="title">${escapeHtml(p.name)}</div>
        <div class="subtitle">${formatNumber(p.quantity)} ${p.unit}</div>
      </div>
      <div style="text-align:left;">
        <div class="amount">${formatMoney(p.sales)}</div>
        ${showProfit ? `<div class="meta" style="color:var(--success);">ربح ${formatMoney(p.profit)}</div>` : ''}
      </div>
    </div>`;
}

async function ensureChartJs() {
  if (window.Chart) return window.Chart;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
    script.onload = () => resolve(window.Chart);
    script.onerror = () => reject(new Error('فشل تحميل مكتبة الرسم البياني'));
    document.head.appendChild(script);
  });
}

async function drawChart(container, profitByDay) {
  const canvas = container.querySelector('#profit-chart');
  if (!canvas) return;
  try {
    const Chart = await ensureChartJs();
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    const labels = profitByDay.map(d => new Date(d.day).toLocaleDateString('ar-EG', { weekday: 'short', day: 'numeric' }));
    const data = profitByDay.map(d => d.profit / 100);
    chartInstance = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'الربح (₪)', data, backgroundColor: '#0d9488', borderRadius: 6 }] },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  } catch (err) {
    canvas.replaceWith(document.createTextNode('تعذر تحميل الرسم البياني (بدون إنترنت لأول مرة)'));
  }
}
