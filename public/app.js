// app.js — frontend logic for the premium Diet Tracker WebApp.
// Vanilla JS: fetches config/catalog once, a state snapshot per date, and
// re-syncs from the server after every write so the UI never drifts from
// the database. Haptics fire on every tap/toggle/confirm per the design brief.

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

// "Today" always means a calendar day in Europe/Kyiv time — matching the
// server's date handling — not the device's local timezone.
function kyivTodayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
const TODAY = kyivTodayISO();

// Display-only mappings — pure presentation, the backend still works in
// meal_number (1-4) and category_letter. Easy to hand-edit once you know
// your real diet plan's category meanings.
const MEAL_META = {
  1: { emoji: '🌅', name: 'Breakfast' },
  2: { emoji: '☀️', name: 'Lunch' },
  3: { emoji: '🍏', name: 'Snack' },
  4: { emoji: '🌙', name: 'Dinner' },
};

// The brief's own examples for a-d and the swap category; e-y cycle through
// a generic food-emoji palette as placeholders until you assign real ones.
const EMOJI_CYCLE = ['🧀','🐟','🥚','🌰','🫘','🍚','🥛','🍞','🍠','🫒','🥩','🍄','🌽','🥔','🍇','🥜','🧈','🍤','🥨','🍯','🫓'];
const CATEGORY_EMOJI = { a: '🌾', b: '🍗', c: '🥦', d: '🥑' };
'efghijklmnopqrstuvwxy'.split('').forEach((letter, i) => {
  CATEGORY_EMOJI[letter] = EMOJI_CYCLE[i % EMOJI_CYCLE.length];
});

function categoryEmoji(letter, isSwap) {
  if (isSwap) return '🍎';
  return CATEGORY_EMOJI[letter] || '🍽️';
}

function displayCategoryName(rawName, letter) {
  if (!rawName || /TODO/i.test(rawName)) return `Category ${letter.toUpperCase()}`;
  return rawName;
}

let CONFIG = null;
let CATALOG = null;
let DISPLAY_CATEGORIES = [];
let STATE = null;
let openMeals = new Set([1]);
let pendingAnimation = null; // { meal, letter, type: 'complete' | 'partial' }

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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  try {
    [CONFIG, CATALOG] = await Promise.all([api('/api/config'), api('/api/catalog')]);
    DISPLAY_CATEGORIES = CATALOG.categories.filter((c) => c.category_letter !== 'fruit');
    await loadState();
  } catch (err) {
    showToast(err.message);
  }
}

async function loadState() {
  STATE = await api(`/api/state?date=${TODAY}`);
  renderHero();
  renderMeals();
}

// ---------------------------------------------------------------------------
// Hero: ring + macros
// ---------------------------------------------------------------------------

const RING_CIRCUMFERENCE = 2 * Math.PI * 74; // r=74

function renderHero() {
  document.getElementById('dateLabel').textContent = new Date(TODAY + 'T00:00:00')
    .toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  const totals = STATE.totals || { calories: STATE.total_calories, protein: 0, carbs: 0, fat: 0 };
  const goals = STATE.goals || { calories: STATE.daily_calorie_target, protein: CONFIG.protein_goal, carbs: CONFIG.carbs_goal, fat: CONFIG.fat_goal };

  const pct = goals.calories ? Math.max(0, Math.min(1, totals.calories / goals.calories)) : 0;
  const offset = RING_CIRCUMFERENCE * (1 - pct);
  document.getElementById('ringFill').style.strokeDashoffset = offset;

  document.getElementById('kcalValue').textContent = Math.round(totals.calories);
  document.getElementById('kcalTarget').textContent = `/ ${Math.round(goals.calories)} kcal`;

  const label = document.getElementById('kcalStatusLabel');
  const ratio = goals.calories ? totals.calories / goals.calories : 0;
  if (ratio > 1.1) { label.textContent = 'over target'; label.style.color = 'var(--danger)'; }
  else if (ratio >= 0.9) { label.textContent = 'on track'; label.style.color = 'var(--success)'; }
  else { label.textContent = 'remaining'; label.style.color = 'var(--tg-hint)'; }

  setMacro('protein', totals.protein, goals.protein);
  setMacro('fat', totals.fat, goals.fat);
  setMacro('carbs', totals.carbs, goals.carbs);
}

function setMacro(key, value, goal) {
  const pct = goal ? Math.max(0, Math.min(100, (value / goal) * 100)) : 0;
  document.getElementById(`${key}Fill`).style.width = pct + '%';
  document.getElementById(`${key}Val`).textContent = `${Math.round(value)}/${Math.round(goal)}g`;
}

// ---------------------------------------------------------------------------
// Meals + category rows
// ---------------------------------------------------------------------------

function getCategoryState(mealNumber, letter) {
  const mealData = STATE.meals[mealNumber - 1];
  const entry = mealData.categories.find((c) => c.category_letter === letter);
  if (!entry) return { state: 'empty', entry: null };
  return { state: entry.is_completed ? 'complete' : 'partial', entry };
}

function renderMeals() {
  const container = document.getElementById('mealsContainer');

  container.innerHTML = STATE.meals
    .map((mealData) => {
      const mealNumber = mealData.meal_number;
      const meta = MEAL_META[mealNumber] || { emoji: '🍽️', name: `Meal ${mealNumber}` };
      const isOpen = openMeals.has(mealNumber);

      const rows = DISPLAY_CATEGORIES.map((cat) => {
        const letter = cat.category_letter;
        const isSwapCat = letter === CONFIG.swap_category_letter;
        const { state, entry } = getCategoryState(mealNumber, letter);
        const emoji = categoryEmoji(letter, isSwapCat);
        const name = isSwapCat ? 'Choice / Fruit Swap' : displayCategoryName(cat.category_name, letter);

        const animate =
          pendingAnimation && pendingAnimation.meal === mealNumber && pendingAnimation.letter === letter;
        const animateClass = animate
          ? (pendingAnimation.type === 'complete' ? 'animate-check' : '')
          : '';

        let subname = '';
        if (entry && entry.entries.length) {
          subname = entry.entries.map((e) => escapeHtml(e.chosen_product)).join(' + ');
        }

        let control;
        if (state === 'complete') {
          control = `<div class="check-badge">✅</div>`;
        } else if (state === 'partial') {
          control = `<div class="fifty-pill">50%</div>`;
        } else {
          control = `<div class="add-pill">+ Add</div>`;
        }

        return `
          <div class="cat-row state-${state} ${animateClass}" data-meal="${mealNumber}" data-letter="${escapeHtml(letter)}">
            <div class="icon">${emoji}</div>
            <div class="info">
              <div class="name">${escapeHtml(name)}<span class="strike-line"></span></div>
              ${subname ? `<div class="subname">${subname}</div>` : ''}
            </div>
            <div class="control">${control}</div>
          </div>`;
      }).join('');

      return `
        <section class="meal-card glass ${isOpen ? 'open' : ''}" data-meal="${mealNumber}">
          <div class="meal-header">
            <div class="left">
              <div class="meal-emoji">${meta.emoji}</div>
              <div class="titles">
                <h3>${meta.name}</h3>
                <div class="sub">Meal ${mealNumber}</div>
              </div>
            </div>
            <div class="right">
              <div class="kcal-badge mono">${Math.round(mealData.calories)} kcal</div>
              <div class="chevron">▾</div>
            </div>
          </div>
          <div class="meal-body">
            <div class="meal-body-inner">
              <div class="cat-list">${rows || '<div class="empty-note">No categories configured yet.</div>'}</div>
            </div>
          </div>
        </section>`;
    })
    .join('');

  pendingAnimation = null;

  container.querySelectorAll('.meal-header').forEach((header) => {
    header.addEventListener('click', () => {
      const section = header.closest('.meal-card');
      const mealNumber = Number(section.dataset.meal);
      haptic('selection');
      if (openMeals.has(mealNumber)) openMeals.delete(mealNumber);
      else openMeals.add(mealNumber);
      section.classList.toggle('open');
    });
  });

  container.querySelectorAll('.cat-row').forEach((row) => {
    row.addEventListener('click', () => {
      haptic('impact', 'light');
      const mealNumber = Number(row.dataset.meal);
      const letter = row.dataset.letter;
      openCategorySheet(mealNumber, letter);
    });
  });
}

// ---------------------------------------------------------------------------
// Bottom sheet (modal)
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

function openCategorySheet(mealNumber, letter) {
  const { state, entry } = getCategoryState(mealNumber, letter);
  if (state === 'complete') openManageSheet(mealNumber, letter, entry);
  else openPickSheet(mealNumber, letter, entry);
}

// --- Pick sheet: choose a product (and, for the swap category, fruit) ------

function openPickSheet(mealNumber, letter, existingEntry) {
  const cat = CATALOG.categories.find((c) => c.category_letter === letter);
  const isSwapCategory = letter === CONFIG.swap_category_letter;
  const usedPct = existingEntry ? existingEntry.portion_used : 0;
  const alreadyPickedIds = existingEntry ? existingEntry.entries.map((e) => e.product_id) : [];
  const meta = MEAL_META[mealNumber] || { name: `Meal ${mealNumber}` };

  sheetEmoji.textContent = categoryEmoji(letter, isSwapCategory);
  sheetTitle.textContent = isSwapCategory ? 'Choice / Fruit Swap' : displayCategoryName(cat?.category_name, letter);
  sheetSub.textContent = `${meta.name}${usedPct ? ` · ${usedPct}% already picked` : ''}`;

  const sheetState = {
    tab: 'regular',
    productId: null,
    portion: usedPct ? 50 : 100,
    fruitId: null,
    fruitPortion: usedPct ? 50 : 100,
  };

  function renderBody() {
    const regularProducts = CATALOG.productsByCategory[letter] || [];
    const fruits = CATALOG.productsByCategory.fruit || [];

    const tabsHtml = isSwapCategory
      ? `<div class="mode-toggle">
           <button data-tab="regular" class="${sheetState.tab === 'regular' ? 'active' : ''}">Regular items</button>
           <button data-tab="swap" class="${sheetState.tab === 'swap' ? 'active' : ''}">🍎 Swap for fruit</button>
         </div>`
      : '';

    let listHtml = '';
    let portionHtml = '';
    let canConfirm = false;

    if (sheetState.tab === 'regular') {
      listHtml = regularProducts.map((p) => {
        const disabled = alreadyPickedIds.includes(p.id);
        const selected = sheetState.productId === p.id;
        return `
          <div class="product-row ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}" data-product="${p.id}">
            <div>
              <div class="name">${escapeHtml(p.product_name)}</div>
            </div>
            <div class="cal mono">${p.calories} kcal</div>
            <div class="radio"></div>
          </div>`;
      }).join('') || '<div class="empty-note">No products in this category yet — add some in seed-data.js.</div>';

      portionHtml = `
        <div class="portion-toggle">
          <button data-portion="100" class="${sheetState.portion === 100 ? 'active' : ''}" ${usedPct ? 'disabled' : ''}>Full (100%)</button>
          <button data-portion="50" class="${sheetState.portion === 50 ? 'active' : ''}">Half (50%)</button>
        </div>`;

      canConfirm = !!sheetState.productId;
    } else {
      listHtml = fruits.map((f) => {
        const selected = sheetState.fruitId === f.id;
        return `
          <div class="product-row ${selected ? 'selected' : ''}" data-fruit="${f.id}">
            <div>
              <div class="name">${escapeHtml(f.product_name)}${f.is_high_sugar ? '<span class="tag">High sugar</span>' : ''}</div>
            </div>
            <div class="cal mono">${f.calories} kcal</div>
            <div class="radio"></div>
          </div>`;
      }).join('') || '<div class="empty-note">No fruits configured yet — add some in seed-data.js.</div>';

      portionHtml = `
        <div class="portion-toggle">
          <button data-fruit-portion="100" class="${sheetState.fruitPortion === 100 ? 'active' : ''}" ${usedPct ? 'disabled' : ''}>Full budget</button>
          <button data-fruit-portion="50" class="${sheetState.fruitPortion === 50 ? 'active' : ''}">Half budget</button>
        </div>
        <div class="swap-note">10g of the swap budget = 100g standard fruit, or 50g high-sugar fruit.</div>`;

      canConfirm = !!sheetState.fruitId;
    }

    sheetContent.innerHTML = `
      ${tabsHtml}
      <div class="sheet-scroll">
        ${listHtml}
        ${portionHtml}
      </div>
      <div class="sheet-footer">
        <button class="confirm-btn" id="confirmBtn" ${canConfirm ? '' : 'disabled'}>
          ${sheetState.tab === 'swap' ? '🍎 Swap for fruit' : `Add to ${meta.name}`}
        </button>
      </div>
    `;

    bindBody();
  }

  function bindBody() {
    sheetContent.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => { haptic('impact', 'light'); sheetState.tab = btn.dataset.tab; renderBody(); });
    });
    sheetContent.querySelectorAll('[data-product]').forEach((row) => {
      row.addEventListener('click', () => {
        if (row.classList.contains('disabled')) return;
        haptic('selection');
        sheetState.productId = Number(row.dataset.product);
        renderBody();
      });
    });
    sheetContent.querySelectorAll('[data-fruit]').forEach((row) => {
      row.addEventListener('click', () => {
        haptic('selection');
        sheetState.fruitId = Number(row.dataset.fruit);
        renderBody();
      });
    });
    sheetContent.querySelectorAll('[data-portion]').forEach((btn) => {
      btn.addEventListener('click', () => { haptic('impact', 'light'); sheetState.portion = Number(btn.dataset.portion); renderBody(); });
    });
    sheetContent.querySelectorAll('[data-fruit-portion]').forEach((btn) => {
      btn.addEventListener('click', () => { haptic('impact', 'light'); sheetState.fruitPortion = Number(btn.dataset.fruitPortion); renderBody(); });
    });

    const confirmBtn = document.getElementById('confirmBtn');
    confirmBtn?.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      haptic('impact', 'medium');
      try {
        if (sheetState.tab === 'swap') {
          const originalGrams = (sheetState.fruitPortion / 100) * CONFIG.swap_category_total_grams;
          await api('/api/logs/swap', {
            method: 'POST',
            body: JSON.stringify({
              date: TODAY,
              meal_number: mealNumber,
              fruit_product_id: sheetState.fruitId,
              original_grams: originalGrams,
            }),
          });
        } else {
          await api('/api/logs', {
            method: 'POST',
            body: JSON.stringify({
              date: TODAY,
              meal_number: mealNumber,
              category_letter: letter,
              product_id: sheetState.productId,
              portion_percentage: sheetState.portion,
            }),
          });
        }

        haptic('notification', 'success');
        const finalPortion = sheetState.tab === 'regular' ? sheetState.portion : sheetState.fruitPortion;
        pendingAnimation = { meal: mealNumber, letter, type: (usedPct + finalPortion >= 100) ? 'complete' : 'partial' };
        closeSheet();
        await loadState();
      } catch (err) {
        haptic('notification', 'error');
        showToast(err.message);
        confirmBtn.disabled = false;
      }
    });
  }

  renderBody();
  openSheet();
}

// --- Manage sheet: view what's logged, delete, or move between meals ------

function openManageSheet(mealNumber, letter, entry) {
  const cat = CATALOG.categories.find((c) => c.category_letter === letter);
  const isSwapCategory = letter === CONFIG.swap_category_letter;
  const meta = MEAL_META[mealNumber] || { name: `Meal ${mealNumber}` };

  sheetEmoji.textContent = categoryEmoji(letter, isSwapCategory);
  sheetTitle.textContent = isSwapCategory ? 'Choice / Fruit Swap' : displayCategoryName(cat?.category_name, letter);
  sheetSub.textContent = `${meta.name} · Completed`;

  function render() {
    const rows = entry.entries.map((e) => `
      <div class="entry-row" data-id="${e.id}">
        <div>
          <div class="name">${escapeHtml(e.chosen_product)}</div>
          <div class="meta">${e.portion_percentage}% · ${Math.round(e.calories)} kcal${e.is_swap ? ' · 🍎 fruit swap' : ''}</div>
        </div>
        <button class="del" data-del="${e.id}">✕</button>
      </div>
    `).join('');

    const moveButtons = [1, 2, 3, 4].map((n) => {
      const targetHasEntry = STATE.meals[n - 1].categories.some((c) => c.category_letter === letter);
      const disabled = n === mealNumber || targetHasEntry;
      const label = MEAL_META[n]?.emoji || n;
      return `<button data-move="${n}" ${disabled ? 'disabled' : ''}>${label}</button>`;
    }).join('');

    sheetContent.innerHTML = `
      <div class="sheet-scroll">
        ${rows}
        <div class="move-label">↔ Move this category to another meal</div>
        <div class="move-row">${moveButtons}</div>
      </div>
    `;

    sheetContent.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        haptic('impact', 'medium');
        try {
          await api(`/api/logs/${btn.dataset.del}`, { method: 'DELETE' });
          haptic('notification', 'success');
          closeSheet();
          await loadState();
        } catch (err) {
          haptic('notification', 'error');
          showToast(err.message);
        }
      });
    });

    sheetContent.querySelectorAll('[data-move]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        haptic('impact', 'light');
        try {
          await api('/api/logs/move', {
            method: 'POST',
            body: JSON.stringify({
              date: TODAY,
              category_letter: letter,
              from_meal: mealNumber,
              to_meal: Number(btn.dataset.move),
            }),
          });
          haptic('notification', 'success');
          closeSheet();
          await loadState();
        } catch (err) {
          haptic('notification', 'error');
          showToast(err.message);
        }
      });
    });
  }

  render();
  openSheet();
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

document.getElementById('resetBtn').addEventListener('click', async () => {
  haptic('impact', 'medium');
  if (!confirm("Clear everything logged today? This can't be undone.")) return;
  try {
    await api('/api/reset', { method: 'POST', body: JSON.stringify({ date: TODAY }) });
    haptic('notification', 'warning');
    await loadState();
  } catch (err) {
    haptic('notification', 'error');
    showToast(err.message);
  }
});

// ---------------------------------------------------------------------------

if (!INIT_DATA) {
  showToast('Open this from the Telegram bot for it to work correctly.');
}

init();
