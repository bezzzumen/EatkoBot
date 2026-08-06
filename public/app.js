// app.js — frontend logic for the Flexible Daily Grams Budget Tracker.
//
// Daily logs now live entirely in the browser: Telegram WebApp CloudStorage
// when running inside Telegram (synced across the user's devices via
// Telegram's own servers), or localStorage as a fallback when CloudStorage
// isn't available (e.g. testing in a desktop browser outside Telegram).
// The server only hands out the static product catalog once on load —
// everything else (usage %, calories, streak, weekly history) is computed
// instantly client-side from that catalog plus whatever's in storage.

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

function kyivTodayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
const TODAY = kyivTodayISO();

// ---------------------------------------------------------------------------
// Storage abstraction: Telegram CloudStorage, falling back to localStorage
// either when CloudStorage isn't present at all, or if any call to it
// actually errors at runtime (e.g. running inside a Telegram client build
// that exposes the object but doesn't fully support it) — once that
// happens we stick with localStorage for the rest of the session so reads
// and writes don't end up split across two different stores.
// ---------------------------------------------------------------------------

const LOG_KEY_PREFIX = 'diet_log_';
let usingLocalFallback = !(tg && tg.CloudStorage);

function cloudCall(method, args) {
  return new Promise((resolve, reject) => {
    try {
      tg.CloudStorage[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
    } catch (err) {
      reject(err);
    }
  });
}

async function storageSetItem(key, value) {
  if (!usingLocalFallback) {
    try { await cloudCall('setItem', [key, value]); return; }
    catch (err) { console.warn('CloudStorage.setItem failed, switching to localStorage:', err); usingLocalFallback = true; }
  }
  localStorage.setItem(key, value);
}

async function storageGetItem(key) {
  if (!usingLocalFallback) {
    try { return (await cloudCall('getItem', [key])) || null; }
    catch (err) { console.warn('CloudStorage.getItem failed, switching to localStorage:', err); usingLocalFallback = true; }
  }
  return localStorage.getItem(key);
}

async function storageRemoveItem(key) {
  if (!usingLocalFallback) {
    try { await cloudCall('removeItem', [key]); return; }
    catch (err) { console.warn('CloudStorage.removeItem failed, switching to localStorage:', err); usingLocalFallback = true; }
  }
  localStorage.removeItem(key);
}

async function storageGetKeys() {
  if (!usingLocalFallback) {
    try { return (await cloudCall('getKeys', [])) || []; }
    catch (err) { console.warn('CloudStorage.getKeys failed, switching to localStorage:', err); usingLocalFallback = true; }
  }
  return Object.keys(localStorage);
}

async function storageGetItems(keys) {
  if (!keys.length) return {};
  if (!usingLocalFallback) {
    try { return (await cloudCall('getItems', [keys])) || {}; }
    catch (err) { console.warn('CloudStorage.getItems failed, switching to localStorage:', err); usingLocalFallback = true; }
  }
  const result = {};
  for (const k of keys) {
    const v = localStorage.getItem(k);
    if (v !== null) result[k] = v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Day-log cache: date ('YYYY-MM-DD') -> { [product_key]: grams }
// ---------------------------------------------------------------------------

const dayLogCache = new Map();
const HISTORY_LOOKBACK_DAYS = 60; // bounds how far back streak/week history is fetched

function parseDayLog(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

async function loadDayLog(date) {
  if (dayLogCache.has(date)) return dayLogCache.get(date);
  const raw = await storageGetItem(LOG_KEY_PREFIX + date);
  const log = parseDayLog(raw) || {};
  dayLogCache.set(date, log);
  return log;
}

async function saveDayLog(date, log) {
  dayLogCache.set(date, log);
  await storageSetItem(LOG_KEY_PREFIX + date, JSON.stringify(log));
}

// Pulls every diet_log_* entry from the last HISTORY_LOOKBACK_DAYS into
// dayLogCache in one batch, so streak/week computation never needs to wait
// on storage mid-render.
async function preloadHistory() {
  const allKeys = await storageGetKeys();
  const cutoff = addDaysISO(TODAY, -HISTORY_LOOKBACK_DAYS);
  const relevantKeys = allKeys.filter((k) => {
    if (!k.startsWith(LOG_KEY_PREFIX)) return false;
    const date = k.slice(LOG_KEY_PREFIX.length);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= cutoff && date <= TODAY;
  });

  const values = await storageGetItems(relevantKeys);
  for (const key of relevantKeys) {
    const date = key.slice(LOG_KEY_PREFIX.length);
    dayLogCache.set(date, parseDayLog(values[key]) || {});
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function addDaysISO(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function dayOfWeekMonFirst(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return jsDay === 0 ? 6 : jsDay - 1;
}

const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const round1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Client-side calorie/macro engine (mirrors the logic the server used to
// run against SQLite — now run entirely against the in-memory catalog and
// dayLogCache, so every interaction is instant with no network round trip).
// ---------------------------------------------------------------------------

let CATALOG = null;
let STATE = null;

// Reserved key inside a day-log object for the "Погане ЇДЛО" (junk calories)
// feature — a direct kcal counter, not a product. Safe from collisions since
// real product_key values are always `${category_key}_${index}` and never
// start with double underscores.
const JUNK_KEY = '__junk_kcal';

function totalCaloriesForDay(dayLog) {
  if (!dayLog) return null;
  const junkKcal = Math.max(0, Number(dayLog[JUNK_KEY]) || 0);
  const productKeys = Object.keys(dayLog).filter((k) => k !== JUNK_KEY);
  if (!productKeys.length && junkKcal <= 0) return null; // nothing logged at all that day

  let total = junkKcal;
  for (const cat of CATALOG.categories) {
    let ratio = 0;
    for (const item of cat.items) {
      const g = dayLog[item.product_key];
      if (g) ratio += g / item.max_grams;
    }
    total += cat.target_calories * ratio;
  }
  return total;
}

function computeStreak(todayDate) {
  let streak = 0;

  const todayTotal = totalCaloriesForDay(dayLogCache.get(todayDate) || null);
  if (todayTotal !== null) {
    if (todayTotal > CATALOG.daily_calorie_target) return 0;
    streak += 1;
  }

  let cursor = addDaysISO(todayDate, -1);
  for (let i = 0; i < HISTORY_LOOKBACK_DAYS; i++) {
    const total = totalCaloriesForDay(dayLogCache.get(cursor) || null);
    if (total === null || total > CATALOG.daily_calorie_target) break;
    streak += 1;
    cursor = addDaysISO(cursor, -1);
  }

  return streak;
}

function computeWeek(todayDate) {
  const monday = addDaysISO(todayDate, -dayOfWeekMonFirst(todayDate));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDaysISO(monday, i);
    let status;
    if (date > todayDate) {
      status = 'future';
    } else {
      const total = totalCaloriesForDay(dayLogCache.get(date) || null);
      if (total === null) status = 'unlogged';
      else status = total <= CATALOG.daily_calorie_target ? 'success' : 'over';
    }
    days.push({ date, label: WEEKDAY_LABELS[i], is_today: date === todayDate, status });
  }
  return days;
}

function computeDayStatus(dayLog) {
  let totalCalories = 0, totalProtein = 0, totalCarbs = 0, totalFat = 0;

  const categories = CATALOG.categories.map((catMeta) => {
    const items = catMeta.items.map((p) => {
      const loggedGrams = dayLog[p.product_key] || 0;
      const ratio = p.max_grams ? loggedGrams / p.max_grams : 0;
      return {
        product_key: p.product_key,
        product_name: p.product_name,
        max_grams: p.max_grams,
        unit: p.unit,
        logged_grams: round1(loggedGrams),
        percent: round1(ratio * 100),
        protein: round1(ratio * p.protein),
        carbs: round1(ratio * p.carbs),
        fat: round1(ratio * p.fat),
      };
    });

    const usageRatio = items.reduce((sum, it) => sum + it.percent / 100, 0);
    const caloriesConsumed = catMeta.target_calories * usageRatio;
    const proteinConsumed = items.reduce((sum, it) => sum + it.protein, 0);
    const carbsConsumed = items.reduce((sum, it) => sum + it.carbs, 0);
    const fatConsumed = items.reduce((sum, it) => sum + it.fat, 0);

    totalCalories += caloriesConsumed;
    totalProtein += proteinConsumed;
    totalCarbs += carbsConsumed;
    totalFat += fatConsumed;

    let status = 'active';
    if (usageRatio >= 1.005) status = 'over';
    else if (usageRatio >= 0.995) status = 'complete';

    return {
      category_key: catMeta.key,
      category_name: catMeta.name,
      emoji: catMeta.emoji,
      target_calories: catMeta.target_calories,
      usage_percent: round1(usageRatio * 100),
      calories_consumed: round1(caloriesConsumed),
      status,
      protein: round1(proteinConsumed),
      carbs: round1(carbsConsumed),
      fat: round1(fatConsumed),
      items,
    };
  });

  // "Погане ЇДЛО" — direct kcal entry, added straight to the daily total.
  // Deliberately NOT folded into any category's own calories/usage, and NOT
  // added to macro totals (no macro breakdown exists for arbitrary junk food).
  const junkKcal = round1(Math.max(0, Number(dayLog[JUNK_KEY]) || 0));
  totalCalories += junkKcal;

  return {
    total_calories: round1(totalCalories),
    totals: {
      calories: round1(totalCalories),
      protein: round1(totalProtein),
      carbs: round1(totalCarbs),
      fat: round1(totalFat),
    },
    categories,
    junk: { kcal: junkKcal },
  };
}

// ---------------------------------------------------------------------------
// Fetch helper (catalog only — the one thing still server-provided)
// ---------------------------------------------------------------------------

async function fetchCatalog() {
  const res = await fetch('/api/catalog');
  if (!res.ok) throw new Error(`Не вдалося завантажити каталог (${res.status})`);
  return res.json();
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
  const r = Math.round(n * 10) / 10;
  return String(r);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  try {
    CATALOG = await fetchCatalog();
    if (usingLocalFallback) {
      showToast('CloudStorage недоступний — дані зберігаються локально в цьому браузері.');
    }
    await preloadHistory();
    await refreshState();
  } catch (err) {
    showToast(err.message);
  }
}

async function refreshState() {
  const todayLog = await loadDayLog(TODAY);
  const dayStatus = computeDayStatus(todayLog);

  STATE = {
    date: TODAY,
    daily_calorie_target: CATALOG.daily_calorie_target,
    goals: {
      calories: CATALOG.daily_calorie_target,
      protein: CATALOG.protein_goal,
      carbs: CATALOG.carbs_goal,
      fat: CATALOG.fat_goal,
    },
    ...dayStatus,
    streak: computeStreak(TODAY),
    week: computeWeek(TODAY),
  };

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
  const visualPct = Math.max(0, Math.min(1, rawPct));
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

  renderStreak();
  renderWeek();
}

function setMacro(key, value, goal) {
  const pct = goal ? Math.max(0, Math.min(100, (value / goal) * 100)) : 0;
  document.getElementById(`${key}Fill`).style.width = pct + '%';
  document.getElementById(`${key}Val`).textContent = `${Math.round(value)}/${Math.round(goal)}г`;
}

// ---------------------------------------------------------------------------
// Streak badge + weekly history row
// ---------------------------------------------------------------------------

// Ukrainian noun inflection for "день": 1/21/31... -> ДЕНЬ, 2-4/22-24... -> ДНІ,
// 0/5-9/10/11-14/25... -> ДНІВ. The 11-14 special case must be checked before
// the last-digit rule, since e.g. 12 ends in "2" but still takes ДНІВ.
function pluralizeDays(n) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'ДНІВ';
  if (mod10 === 1) return 'ДЕНЬ';
  if (mod10 >= 2 && mod10 <= 4) return 'ДНІ';
  return 'ДНІВ';
}

function renderStreak() {
  const streak = STATE.streak || 0;
  const badge = document.getElementById('streakBadge');
  const text = document.getElementById('streakText');

  badge.classList.toggle('zero', streak === 0);
  text.textContent = `${streak} ${pluralizeDays(streak)} ПОСПІЛЬ`;
}

const WEEK_STATUS_EMOJI = { success: '🔥', over: '❌', unlogged: '⚪', future: '⚪' };

function renderWeek() {
  const week = STATE.week || [];
  const row = document.getElementById('weekRow');

  row.innerHTML = week
    .map((day) => `
      <div class="week-day status-${day.status} ${day.is_today ? 'is-today' : ''}">
        <div class="week-label">${escapeHtml(day.label)}</div>
        <div class="week-chip">${WEEK_STATUS_EMOJI[day.status] || '⚪'}</div>
      </div>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Category cards
// ---------------------------------------------------------------------------

const STATUS_LABEL = { active: 'Активно', complete: '✅ Виконано', over: '⚠️ Перевищено' };
let openCategories = new Set();

function renderCategories() {
  const container = document.getElementById('categoriesContainer');

  const categoryCardsHtml = STATE.categories
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
          <div class="item-row" data-product="${escapeHtml(item.product_key)}">
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

  // Standalone "Погане ЇДЛО" card — direct kcal entry, no items, no expand;
  // tapping it opens the junk-kcal sheet immediately (see openJunkSheet()).
  const junkKcal = STATE.junk ? STATE.junk.kcal : 0;
  const junkCardHtml = `
    <section class="cat-card glass junk-card" id="junkCard">
      <div class="cat-header">
        <div class="left">
          <div class="cat-emoji">😡</div>
          <div class="titles">
            <h3>Погане ЇДЛО</h3>
            <div class="sub">Мусорні калорії</div>
          </div>
        </div>
        <div class="right">
          <div class="status-pill junk-pill">${Math.round(junkKcal)} ккал</div>
        </div>
      </div>
    </section>`;

  container.innerHTML = categoryCardsHtml + junkCardHtml;

  container.querySelectorAll('.cat-card:not(.junk-card) .cat-header').forEach((header) => {
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
      openLogSheet(row.dataset.product);
    });
  });

  document.getElementById('junkCard')?.addEventListener('click', () => {
    haptic('impact', 'light');
    openJunkSheet();
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

function openLogSheet(productKey) {
  let cat, item;
  for (const c of STATE.categories) {
    const found = c.items.find((i) => i.product_key === productKey);
    if (found) { cat = c; item = found; break; }
  }
  if (!item) return;

  sheetEmoji.textContent = cat.emoji;
  sheetTitle.textContent = item.product_name;
  sheetSub.textContent = cat.category_name;

  // How many more grams of THIS item could still be logged before the
  // CATEGORY as a whole reaches 100% — accounting for whatever's already
  // been logged against every item in the category, not just this one.
  // Every item in a category is calibrated so that logging its own
  // max_grams alone would fully use the category's target_calories, so
  // this item's kcal-per-gram is target_calories / item.max_grams.
  const categoryRemainingKcal = cat.target_calories - cat.calories_consumed;
  const productKcalPerGram = item.max_grams ? cat.target_calories / item.max_grams : 0;
  const remainingGramsFor100 = productKcalPerGram > 0
    ? Math.max(0, Math.floor(categoryRemainingKcal / productKcalPerGram))
    : 0;

  const sheetState = { pendingDelta: 0, source: null };

  function currentStatusClass(logged) {
    const pct = item.max_grams ? (logged / item.max_grams) * 100 : 0;
    if (pct > 100.5) return 'over';
    if (pct >= 99.5) return 'complete';
    return '';
  }

  function render() {
    const remaining = Math.max(0, item.max_grams - item.logged_grams);
    const previewTotal = Math.max(0, item.logged_grams + sheetState.pendingDelta);

    sheetContent.innerHTML = `
      <div class="sheet-scroll">
        <div class="current-logged">
          <span class="label">Зараз залоговано</span>
          <span class="value mono ${currentStatusClass(item.logged_grams)}">${fmtNum(item.logged_grams)}${escapeHtml(item.unit)} / ${fmtNum(item.max_grams)}${escapeHtml(item.unit)}</span>
        </div>

        <div class="remaining-hint">Максимум до 100%: ще <b>${fmtNum(remainingGramsFor100)}${escapeHtml(item.unit)}</b> ${escapeHtml(item.product_name)}</div>

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
      updatePreviewAndButtons();
    });

    const confirmBtn = document.getElementById('confirmBtn');
    confirmBtn?.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      haptic('impact', 'medium');
      try {
        const dayLog = await loadDayLog(TODAY);
        dayLog[item.product_key] = Math.max(0, (dayLog[item.product_key] || 0) + sheetState.pendingDelta);
        await saveDayLog(TODAY, dayLog);

        haptic('notification', 'success');
        await refreshState();
        closeSheet();
      } catch (err) {
        haptic('notification', 'error');
        showToast(err.message);
        confirmBtn.disabled = false;
      }
    });
  }

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

// --- Junk-kcal sheet: "Погане ЇДЛО" — direct kcal entry, no grams, no max ---

const JUNK_QUICK_ADDS = [100, 250, 500];

function openJunkSheet() {
  sheetEmoji.textContent = '😡';
  sheetTitle.textContent = 'Погане ЇДЛО';
  sheetSub.textContent = 'Прямий ввід калорій — не впливає на інші категорії';

  const currentJunk = STATE.junk ? STATE.junk.kcal : 0;
  const sheetState = { pendingDelta: 0, source: null };

  function render() {
    const previewTotal = Math.max(0, currentJunk + sheetState.pendingDelta);

    sheetContent.innerHTML = `
      <div class="sheet-scroll">
        <div class="current-logged">
          <span class="label">Залоговано сьогодні</span>
          <span class="value mono">${fmtNum(currentJunk)} ккал</span>
        </div>

        <div class="quick-add-label">Швидко додати</div>
        <div class="quick-add-row">
          ${JUNK_QUICK_ADDS.map((k) => `
            <button data-quick="${k}" class="${sheetState.source === 'quick' && sheetState.pendingDelta === k ? 'selected' : ''}">+${k} ккал</button>
          `).join('')}
        </div>

        <div class="custom-input-wrap">
          <div class="custom-input-label">Або введіть точну кількість калорій</div>
          <div class="custom-input-row">
            <input type="number" inputmode="decimal" id="customInput" placeholder="напр. 350" value="${sheetState.source === 'custom' && sheetState.pendingDelta ? sheetState.pendingDelta : ''}" />
            <div class="unit-label">ккал</div>
          </div>
        </div>

        ${sheetState.pendingDelta ? `<div class="preview-line">Новий підсумок: <b>${fmtNum(previewTotal)} ккал</b></div>` : ''}
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
        const k = Number(btn.dataset.quick);
        sheetState.pendingDelta = sheetState.source === 'quick' && sheetState.pendingDelta === k ? 0 : k;
        sheetState.source = sheetState.pendingDelta ? 'quick' : null;
        render();
      });
    });

    const customInput = document.getElementById('customInput');
    customInput?.addEventListener('input', () => {
      const val = parseFloat(customInput.value);
      sheetState.pendingDelta = Number.isFinite(val) && val !== 0 ? val : 0;
      sheetState.source = sheetState.pendingDelta ? 'custom' : null;
      updatePreview();
    });

    const confirmBtn = document.getElementById('confirmBtn');
    confirmBtn?.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      haptic('impact', 'medium');
      try {
        const dayLog = await loadDayLog(TODAY);
        dayLog[JUNK_KEY] = Math.max(0, (Number(dayLog[JUNK_KEY]) || 0) + sheetState.pendingDelta);
        await saveDayLog(TODAY, dayLog);

        haptic('notification', 'success');
        await refreshState();
        closeSheet();
      } catch (err) {
        haptic('notification', 'error');
        showToast(err.message);
        confirmBtn.disabled = false;
      }
    });
  }

  function updatePreview() {
    const confirmBtn = document.getElementById('confirmBtn');
    if (confirmBtn) confirmBtn.disabled = !sheetState.pendingDelta;

    sheetContent.querySelectorAll('[data-quick]').forEach((btn) => {
      const k = Number(btn.dataset.quick);
      btn.classList.toggle('selected', sheetState.source === 'quick' && sheetState.pendingDelta === k);
    });

    let previewEl = sheetContent.querySelector('.preview-line');
    const previewTotal = Math.max(0, currentJunk + sheetState.pendingDelta);
    const previewHtml = sheetState.pendingDelta ? `Новий підсумок: <b>${fmtNum(previewTotal)} ккал</b>` : '';
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

init();
