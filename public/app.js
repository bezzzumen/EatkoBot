// app.js — frontend logic for the Flexible Daily Grams Budget Tracker.
// One fetch of /api/today gives categories + items + logged amounts in one
// payload; every log/reset action returns the fresh snapshot too, so the UI
// re-renders from a single source of truth after each write.

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  document.documentElement.dataset.theme = tg.colorScheme || 'dark';
  tg.onEvent?.('themeChanged', () => {
    document.documentElement.dataset.theme = tg.colorScheme || 'dark';
  });
} else {
  document.documentElement.dataset.theme = 'dark';
}

function haptic(type, style) {
  const h = tg?.HapticFeedback;
  if (!h) return;
  if (type === 'impact') h.impactOccurred(style || 'light');
  else if (type === 'notification') h.notificationOccurred(style || 'success');
  else if (type === 'selection') h.selectionChanged();
}

const INIT_DATA = tg?.initData || '';

function kyivTodayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
const TODAY = kyivTodayISO();

let STATE = null;
let openCategories = new Set(); // all closed by default; user expands what they need

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': INIT_DATA,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), 2400);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(n) {
  // Trim to at most 1 decimal, drop trailing .0
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : String(r);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  try {
    await loadState();
  } catch (err) {
    showToast(err.message);
  }
}

async function loadState() {
  STATE = await api(`/api/today?date=${TODAY}`);
  renderHero();
  renderCategories();
}

// ---------------------------------------------------------------------------
// Hero: ring + macros
// ---------------------------------------------------------------------------

const RING_CIRCUMFERENCE = 2 * Math.PI * 74;

function renderHero() {
  document.getElementById('dateLabel').textContent = new Date(TODAY + 'T00:00:00')
    .toLocaleDateString('uk-UA', { weekday: 'long', month: 'long', day: 'numeric' });

  const totals = STATE.totals;
  const goals = STATE.goals;

  const rawPct = goals.calories ? totals.calories / goals.calories : 0;
  const visualPct = Math.max(0, Math.min(1, rawPct)); // ring visually caps at 100%
  const offset = RING_CIRCUMFERENCE * (1 - visualPct);
  const ring = document.getElementById('ringFill');
  ring.style.strokeDashoffset = offset;
  ring.classList.toggle('over', rawPct > 1.1);

  document.getElementById('kcalValue').textContent = Math.round(totals.calories);
  document.getElementById('kcalTarget').textContent = `/ ${Math.round(goals.calories)} ккал`;

  const label = document.getElementById('kcalStatusLabel');
  if (rawPct > 1.1) { label.textContent = 'перевищено'; label.style.color = 'var(--danger)'; }
  else if (rawPct >= 0.9) { label.textContent = 'в нормі'; label.style.color = 'var(--success)'; }
  else { label.textContent = 'залишок'; label.style.color = 'var(--tg-hint)'; }

  setMacro('protein', totals.protein, goals.protein);
  setMacro('fat', totals.fat, goals.fat);
  setMacro('carbs', totals.carbs, goals.carbs);
}

function setMacro(key, value, goal) {
  const pct = goal ? Math.max(0, Math.min(100, (value / goal) * 100)) : 0;
  document.getElementById(`${key}Fill`).style.width = pct + '%';
  document.getElementById(`${key}Val`).textContent = `${Math.round(value)}/${Math.round(goal)}г`;
}

// ---------------------------------------------------------------------------
// Category cards
// ---------------------------------------------------------------------------

const STATUS_LABEL = { active: 'Активно', complete: '✅ Виконано', over: '⚠️ Перевищено' };

function renderCategories() {
  const container = document.getElementById('categoriesContainer');

  container.innerHTML = STATE.categories
    .map((cat) => {
      const isOpen = openCategories.has(cat.category_key);
      const pillClass = cat.status;
      const pillLabel = cat.status === 'over' ? `⚠️ Перевищено (${Math.round(cat.usage_percent)}%)` : STATUS_LABEL[cat.status];
      const barPct = Math.min(100, cat.usage_percent);
      const barClass = cat.status === 'over' ? 'over' : cat.status === 'complete' ? 'complete' : '';

      const items = cat.items.map((item) => {
        const itemBarPct = Math.min(100, item.percent);
        const itemBarClass = item.percent > 100 ? 'over' : '';
        return `
          <div class="item-row" data-product="${item.product_id}">
            <div class="info">
              <div class="name">${escapeHtml(item.product_name)}<span class="max-tag">макс ${fmtNum(item.max_grams)}${escapeHtml(item.unit)}</span></div>
              <div class="item-progress-track"><div class="item-progress-fill ${itemBarClass}" style="width:${itemBarPct}%"></div></div>
              <div class="logged-text">${fmtNum(item.logged_grams)}${escapeHtml(item.unit)} / ${fmtNum(item.max_grams)}${escapeHtml(item.unit)} (${Math.round(item.percent)}%)</div>
            </div>
            <div class="chev">›</div>
          </div>`;
      }).join('');

      return `
        <section class="cat-card glass status-${cat.status} ${isOpen ? 'open' : ''}" data-category="${cat.category_key}">
          <div class="cat-header">
            <div class="left">
              <div class="cat-emoji">${cat.emoji}</div>
              <div class="titles">
                <h3>${escapeHtml(cat.category_name)}</h3>
                <div class="sub">${Math.round(cat.calories_consumed)} / ${cat.target_calories} ккал</div>
              </div>
            </div>
            <div class="right">
              <div class="status-pill ${pillClass}">${pillLabel}</div>
              <div class="chevron">▾</div>
            </div>
          </div>
          <div class="cat-progress">
            <div class="cat-progress-track"><div class="cat-progress-fill ${barClass}" style="width:${barPct}%"></div></div>
          </div>
          <div class="cat-body">
            <div class="cat-body-inner">
              <div class="item-list">${items || '<div class="empty-note">Немає товарів у цій категорії — додайте у seed-data.js.</div>'}</div>
            </div>
          </div>
        </section>`;
    })
    .join('');

  container.querySelectorAll('.cat-header').forEach((header) => {
    header.addEventListener('click', () => {
      const card = header.closest('.cat-card');
      const key = card.dataset.category;
      haptic('selection');
      if (openCategories.has(key)) openCategories.delete(key);
      else openCategories.add(key);
      card.classList.toggle('open');
    });
  });

  container.querySelectorAll('.item-row').forEach((row) => {
    row.addEventListener('click', () => {
      haptic('impact', 'light');
      openLogSheet(Number(row.dataset.product));
    });
  });
}

// ---------------------------------------------------------------------------
// Bottom sheet: log grams against a product
// ---------------------------------------------------------------------------

const overlay = document.getElementById('overlay');
const sheetEmoji = document.getElementById('sheetEmoji');
const sheetTitle = document.getElementById('sheetTitle');
const sheetSub = document.getElementById('sheetSub');
const sheetContent = document.getElementById('sheetContent');

document.getElementById('sheetClose').addEventListener('click', () => { haptic('impact', 'light'); closeSheet(); });
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });

function openSheet() { overlay.classList.add('show'); }
function closeSheet() { overlay.classList.remove('show'); }

const QUICK_ADDS = [5, 10, 50, 100];

function openLogSheet(productId) {
  let cat, item;
  for (const c of STATE.categories) {
    const found = c.items.find((i) => i.product_id === productId);
    if (found) { cat = c; item = found; break; }
  }
  if (!item) return;

  sheetEmoji.textContent = cat.emoji;
  sheetTitle.textContent = item.product_name;
  sheetSub.textContent = cat.category_name;

  const sheetState = { pendingDelta: 0, source: null }; // source: 'quick' | 'fill' | 'custom'

  function currentStatusClass(logged) {
    const pct = item.max_grams ? (logged / item.max_grams) * 100 : 0;
    if (pct > 100.5) return 'over';
    if (pct >= 99.5) return 'complete';
    return '';
  }

  function render() {
    const remaining = Math.max(0, item.max_grams - item.logged_grams);
    const previewTotal = Math.max(0, item.logged_grams + sheetState.pendingDelta);
    const previewClass = currentStatusClass(previewTotal);

    sheetContent.innerHTML = `
      <div class="sheet-scroll">
        <div class="current-logged">
          <span class="label">Зараз залоговано</span>
          <span class="value mono ${currentStatusClass(item.logged_grams)}">${fmtNum(item.logged_grams)}${escapeHtml(item.unit)} / ${fmtNum(item.max_grams)}${escapeHtml(item.unit)}</span>
        </div>

        <div class="quick-add-label">Швидко додати</div>
        <div class="quick-add-row">
          ${QUICK_ADDS.map((g) => `
            <button data-quick="${g}" class="${sheetState.source === 'quick' && sheetState.pendingDelta === g ? 'selected' : ''}">+${g}${escapeHtml(item.unit)}</button>
          `).join('')}
        </div>

        <button class="fill-remaining-btn ${sheetState.source === 'fill' ? 'selected' : ''}" id="fillRemainingBtn" ${remaining <= 0 ? 'disabled' : ''}>
          Заповнити залишок (+${fmtNum(remaining)}${escapeHtml(item.unit)})
        </button>

        <div class="custom-input-wrap">
          <div class="custom-input-label">Або введіть точну кількість</div>
          <div class="custom-input-row">
            <input type="number" inputmode="decimal" id="customInput" placeholder="напр. 50" value="${sheetState.source === 'custom' && sheetState.pendingDelta ? sheetState.pendingDelta : ''}" />
            <div class="unit-label">${escapeHtml(item.unit)}</div>
          </div>
        </div>

        ${sheetState.pendingDelta ? `<div class="preview-line">Новий підсумок: <b>${fmtNum(previewTotal)}${escapeHtml(item.unit)}</b> (${Math.round(item.max_grams ? (previewTotal / item.max_grams) * 100 : 0)}%)</div>` : ''}
      </div>
      <div class="sheet-footer">
        <button class="confirm-btn" id="confirmBtn" ${sheetState.pendingDelta ? '' : 'disabled'}>Підтвердити</button>
      </div>
    `;

    bind();
  }

  function bind() {
    sheetContent.querySelectorAll('[data-quick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        haptic('impact', 'light');
        const g = Number(btn.dataset.quick);
        sheetState.pendingDelta = sheetState.source === 'quick' && sheetState.pendingDelta === g ? 0 : g;
        sheetState.source = sheetState.pendingDelta ? 'quick' : null;
        render();
      });
    });

    const fillBtn = document.getElementById('fillRemainingBtn');
    fillBtn?.addEventListener('click', () => {
      if (fillBtn.disabled) return;
      haptic('impact', 'light');
      const remaining = Math.max(0, item.max_grams - item.logged_grams);
      if (sheetState.source === 'fill') {
        sheetState.pendingDelta = 0;
        sheetState.source = null;
      } else {
        sheetState.pendingDelta = remaining;
        sheetState.source = 'fill';
      }
      render();
    });

    const customInput = document.getElementById('customInput');
    customInput?.addEventListener('input', () => {
      const val = parseFloat(customInput.value);
      sheetState.pendingDelta = Number.isFinite(val) && val !== 0 ? val : 0;
      sheetState.source = sheetState.pendingDelta ? 'custom' : null;
      // Re-render footer/preview without losing input focus: only patch what changed
      updatePreviewAndButtons();
    });

    const confirmBtn = document.getElementById('confirmBtn');
    confirmBtn?.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      haptic('impact', 'medium');
      try {
        STATE = await api('/api/log-grams', {
          method: 'POST',
          body: JSON.stringify({ date: TODAY, productId, grams: sheetState.pendingDelta }),
        });
        haptic('notification', 'success');
        renderHero();
        renderCategories();
        closeSheet();
      } catch (err) {
        haptic('notification', 'error');
        showToast(err.message);
        confirmBtn.disabled = false;
      }
    });
  }

  // Lightweight in-place update so typing in the custom input doesn't lose focus
  function updatePreviewAndButtons() {
    const confirmBtn = document.getElementById('confirmBtn');
    if (confirmBtn) confirmBtn.disabled = !sheetState.pendingDelta;

    sheetContent.querySelectorAll('[data-quick]').forEach((btn) => {
      const g = Number(btn.dataset.quick);
      btn.classList.toggle('selected', sheetState.source === 'quick' && sheetState.pendingDelta === g);
    });
    const fillBtn = document.getElementById('fillRemainingBtn');
    fillBtn?.classList.toggle('selected', sheetState.source === 'fill');

    let previewEl = sheetContent.querySelector('.preview-line');
    const previewTotal = Math.max(0, item.logged_grams + sheetState.pendingDelta);
    const previewHtml = sheetState.pendingDelta
      ? `Новий підсумок: <b>${fmtNum(previewTotal)}${escapeHtml(item.unit)}</b> (${Math.round(item.max_grams ? (previewTotal / item.max_grams) * 100 : 0)}%)`
      : '';
    if (previewEl) {
      if (previewHtml) previewEl.innerHTML = previewHtml;
      else previewEl.remove();
    } else if (previewHtml) {
      const div = document.createElement('div');
      div.className = 'preview-line';
      div.innerHTML = previewHtml;
      sheetContent.querySelector('.sheet-scroll').appendChild(div);
    }
  }

  render();
  openSheet();
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

document.getElementById('resetBtn').addEventListener('click', async () => {
  haptic('impact', 'medium');
  if (!confirm("Очистити весь сьогоднішній прогрес? Це не можна скасувати.")) return;
  try {
    STATE = await api('/api/reset', { method: 'POST', body: JSON.stringify({ date: TODAY }) });
    haptic('notification', 'warning');
    renderHero();
    renderCategories();
  } catch (err) {
    haptic('notification', 'error');
    showToast(err.message);
  }
});

// ---------------------------------------------------------------------------

if (!INIT_DATA) {
  showToast('Відкрийте це через Telegram-бота, щоб усе працювало коректно.');
}

init();
