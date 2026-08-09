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

// Needed again for POST /api/sync-status — a real Telegram session's signed
// initData, verified server-side, so the evening-broadcast database knows
// which Telegram user a synced status belongs to. Empty outside Telegram
// (e.g. desktop browser testing), in which case syncing is simply skipped.
const INIT_DATA = tg?.initData || '';

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

// Updates the in-memory cache ONLY — synchronous, instant, no I/O. This is
// the "optimistic" half of a write: call this, then re-render immediately,
// then separately (and without waiting) call persistDayLog() to actually
// write it to storage. Splitting these is the whole point of offline-first:
// the UI must never wait on CloudStorage/localStorage/network to reflect a
// change the user just made.
function setDayLogInMemory(date, log) {
  dayLogCache.set(date, log);
}

// The actual storage write — async, may be slow (especially CloudStorage
// over a poor connection), so this is always called WITHOUT awaiting it at
// the call site. A failure here is logged but never surfaced to the user;
// the in-memory state (already updated via setDayLogInMemory) remains
// correct regardless, and markSyncDirty()/isSyncDirty() below track that
// there's still unpersisted work so it naturally retries next time.
async function persistDayLog(date, log) {
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
// Catalog cache (localStorage — device-only, not per-user data, so this is
// deliberately NOT CloudStorage). Lets the very next app open render
// instantly from cache instead of waiting on GET /api/catalog, which can be
// slow right after a sleeping Render free-tier instance wakes up.
// ---------------------------------------------------------------------------

const CATALOG_CACHE_KEY = 'eatko_catalog_cache_v1';

function loadCachedCatalog() {
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCachedCatalog(catalog) {
  try {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(catalog));
  } catch {
    // Non-fatal — worst case, next load just fetches fresh again.
  }
}

// ---------------------------------------------------------------------------
// Sync "dirty" flag — the retry-queue mechanism. Every sync call already
// sends the FULL current day status (not an incremental diff), so a retry
// is simply "try syncing current state again" — no queue of discrete
// operations is needed. This flag just tracks, durably across app closes,
// whether the last known state has actually made it to the server yet.
// ---------------------------------------------------------------------------

const SYNC_DIRTY_KEY = 'eatko_sync_dirty';

function markSyncDirty() {
  try { localStorage.setItem(SYNC_DIRTY_KEY, '1'); } catch { /* non-fatal */ }
}
function clearSyncDirty() {
  try { localStorage.removeItem(SYNC_DIRTY_KEY); } catch { /* non-fatal */ }
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

// Instant, synchronous placeholder so something visible appears the moment
// the script runs — before any cache read or network call, however fast.
function renderLoadingShell() {
  const container = document.getElementById('categoriesContainer');
  if (container && !container.innerHTML.trim()) {
    container.innerHTML = '<div class="empty-note" style="padding:28px 8px;text-align:center;">Завантаження…</div>';
  }
}

async function init() {
  renderLoadingShell();

  // --- 1. IMMEDIATE RENDER: from local cache, before any network request ---
  const cachedCatalog = loadCachedCatalog();
  if (cachedCatalog) {
    CATALOG = cachedCatalog;
    try {
      await preloadHistory(); // CloudStorage/localStorage only — not a network call to OUR server
      await loadDayLog(TODAY);
      recomputeAndRender();
    } catch (err) {
      console.warn('[init] local-only render failed:', err);
    }
  }

  if (usingLocalFallback) {
    showToast('CloudStorage недоступний — дані зберігаються локально в цьому браузері.');
  }

  // --- 2. BACKGROUND: refresh the catalog from the network, don't block on it ---
  try {
    const fresh = await fetchCatalog();
    CATALOG = fresh;
    saveCachedCatalog(fresh);

    if (!cachedCatalog) {
      // First-ever load on this device — there was nothing to show until now.
      await preloadHistory();
      await loadDayLog(TODAY);
    }
    recomputeAndRender();
  } catch (err) {
    if (!cachedCatalog) {
      // No cache AND the network call failed — genuinely nothing to show.
      showToast('Немає з’єднання, і локальних даних ще немає. Спробуйте пізніше.');
    } else {
      // We already rendered from cache — a failed background refresh is a
      // non-event from the user's point of view, just log it.
      console.warn('[init] background catalog refresh failed, staying on cached catalog:', err);
    }
  }
}

// Pure, synchronous recompute + render — no I/O, no await. Call this
// immediately after any in-memory state change (dayLogCache mutation) to
// reflect it on screen instantly; storage writes and server sync happen
// separately afterward, in the background, without the UI waiting on them.
function recomputeAndRender() {
  const todayLog = dayLogCache.get(TODAY) || {};
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

// Persists the current day's log to CloudStorage/localStorage AND syncs it
// to the server — both fired in the background, in parallel, neither one
// waiting on or blocking the other. Called WITHOUT awaiting at the call
// site (see the confirm handlers below) so it never delays the UI, which
// has already been updated optimistically by the time this runs.
async function persistAndSync() {
  const todayLog = dayLogCache.get(TODAY) || {};
  markSyncDirty();

  const persistPromise = persistDayLog(TODAY, todayLog).catch((err) => {
    console.warn('[persist] local storage write failed (in-memory state is still correct):', err);
  });
  const syncPromise = syncDailyStatus();

  await Promise.allSettled([persistPromise, syncPromise]);
}

// Pushes today's already-computed status to the server, so the evening
// broadcast (GET /api/trigger-evening-summary, run by an external cron
// pinger) has something to send. Always fails silently as far as the user
// is concerned — no toast, no blocking — since CloudStorage/localStorage
// remains the real source of truth for the user's own view of their day
// regardless of whether this succeeds. markSyncDirty()/clearSyncDirty()
// track whether the current state has actually reached the server; since
// this always sends the full current status (not a diff), simply trying
// again on the next log action or app open is a complete, correct retry —
// no separate queue of operations is needed.
//
// IMPORTANT: fetch() only rejects on actual network failures — it resolves
// normally for HTTP error responses like 401/500/502, so this explicitly
// checks res.ok rather than relying on the promise rejecting.
async function syncDailyStatus() {
  if (!INIT_DATA) {
    console.warn('[sync] Skipped — no Telegram initData (not running inside a real Telegram session).');
    return;
  }

  try {
    const res = await fetch('/api/sync-status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': INIT_DATA,
      },
      body: JSON.stringify({
        date: TODAY,
        total_calories: STATE.totals.calories,
        daily_calorie_target: STATE.goals.calories,
        streak: STATE.streak,
        // Category-level summary only (matches what the broadcast message
        // needs) — not the per-item gram breakdown, which stays local.
        categories: STATE.categories.map((c) => ({
          category_key: c.category_key,
          category_name: c.category_name,
          emoji: c.emoji,
          target_calories: c.target_calories,
          usage_percent: c.usage_percent,
          calories_consumed: c.calories_consumed,
          status: c.status,
        })),
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Sync failed with status ${res.status}`);
    }

    clearSyncDirty();
  } catch (err) {
    // Silent by design — logged for developers, never shown to the user.
    // The dirty flag stays set, so the next log action or app open (via
    // persistAndSync -> markSyncDirty -> another attempt) retries it.
    console.error('[sync] Background status sync failed (will retry next action/open):', err.message);
  }
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
// Analytics: weekly/monthly calorie chart + per-day macro breakdown.
// Purely client-side, computed from the same dayLogCache preloaded for
// streak/week (last HISTORY_LOOKBACK_DAYS days) — no extra network calls.
// ---------------------------------------------------------------------------

// Calories + macro totals for an arbitrary day's log (not just today's —
// unlike computeDayStatus, this has no per-item/per-category breakdown,
// just the four numbers the chart and day-detail panel need).
//
// NOTE: this rounds once at the end, whereas computeDayStatus rounds each
// item's percentage first and sums the rounded values — so the two can
// differ by a fraction of a calorie on the same data (confirmed via testing:
// ~0.1 kcal on a real example). Genuinely imperceptible, not worth changing
// computeDayStatus's already-shipped, already-tested logic over — flagging
// it here rather than pretending the two are bit-for-bit identical.
function computeDayMacros(dayLog) {
  let calories = 0, protein = 0, carbs = 0, fat = 0;

  for (const cat of CATALOG.categories) {
    let categoryRatio = 0;
    for (const item of cat.items) {
      const loggedGrams = dayLog[item.product_key] || 0;
      const ratio = item.max_grams ? loggedGrams / item.max_grams : 0;
      categoryRatio += ratio;
      protein += ratio * item.protein;
      carbs += ratio * item.carbs;
      fat += ratio * item.fat;
    }
    calories += cat.target_calories * categoryRatio;
  }

  calories += Math.max(0, Number(dayLog[JUNK_KEY]) || 0);

  return { calories: round1(calories), protein: round1(protein), carbs: round1(carbs), fat: round1(fat) };
}

function getWeekRangeDates(todayDate) {
  const monday = addDaysISO(todayDate, -dayOfWeekMonFirst(todayDate));
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(addDaysISO(monday, i));
  return dates;
}

function getMonthRangeDates(todayDate) {
  const [y, m] = todayDate.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this month
  const dates = [];
  for (let d = 1; d <= daysInMonth; d++) {
    dates.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return dates;
}

function getDayChartInfo(date) {
  if (date > TODAY) return { date, isFuture: true, hasData: false, calories: 0, protein: 0, carbs: 0, fat: 0 };
  const log = dayLogCache.get(date);
  if (!log || !Object.keys(log).length) return { date, isFuture: false, hasData: false, calories: 0, protein: 0, carbs: 0, fat: 0 };
  const macros = computeDayMacros(log);
  return { date, isFuture: false, hasData: true, ...macros };
}

function formatFriendlyDate(date) {
  return new Date(date + 'T00:00:00').toLocaleDateString('uk-UA', { weekday: 'long', month: 'long', day: 'numeric' });
}

let analyticsPeriod = 'week';
let analyticsSelectedDate = null;

function renderAnalytics() {
  const dates = analyticsPeriod === 'week' ? getWeekRangeDates(TODAY) : getMonthRangeDates(TODAY);
  const dayInfos = dates.map(getDayChartInfo);
  const target = CATALOG.daily_calorie_target;

  const maxActual = Math.max(0, ...dayInfos.map((d) => d.calories || 0));
  const maxScale = Math.max(target * 1.25, maxActual * 1.1, 1);
  const baselinePct = Math.min(100, (target / maxScale) * 100);

  document.getElementById('analyticsSub').textContent =
    analyticsPeriod === 'week' ? 'Пн–Нд поточного тижня' : `${dayInfos.length} днів цього місяця`;

  const barsHtml = dayInfos.map((d, i) => {
    const heightPct = d.isFuture ? 0 : Math.min(100, (d.calories / maxScale) * 100);
    const barClass = d.isFuture ? 'future' : !d.hasData ? 'empty' : d.calories > target ? 'over' : 'success';
    const isSelected = d.date === analyticsSelectedDate;
    const label = analyticsPeriod === 'week' ? WEEKDAY_LABELS[i] : '';
    return `
      <div class="chart-bar-col ${isSelected ? 'selected' : ''}" data-date="${d.date}">
        <div class="chart-bar-track"><div class="chart-bar-fill ${barClass}" style="height:${heightPct}%"></div></div>
        ${label ? `<div class="chart-bar-label">${label}</div>` : ''}
      </div>`;
  }).join('');

  const chartEl = document.getElementById('analyticsChart');
  chartEl.innerHTML = `
    <div class="chart-area">
      <div class="chart-baseline" style="bottom:${baselinePct}%"></div>
      <div class="chart-bars">${barsHtml}</div>
    </div>`;

  chartEl.querySelectorAll('.chart-bar-col').forEach((col) => {
    col.addEventListener('click', () => {
      haptic('selection');
      analyticsSelectedDate = col.dataset.date;
      renderAnalytics(); // re-render so the .selected outline moves
    });
  });

  renderAnalyticsDayDetail();
}

function renderAnalyticsDayDetail() {
  const detailEl = document.getElementById('analyticsDayDetail');
  if (!analyticsSelectedDate) {
    detailEl.innerHTML = '<div class="empty-note" style="text-align:center;padding:18px 8px;">Торкніться стовпчика, щоб побачити деталі дня.</div>';
    return;
  }

  const info = getDayChartInfo(analyticsSelectedDate);
  const goals = { protein: CATALOG.protein_goal, carbs: CATALOG.carbs_goal, fat: CATALOG.fat_goal };
  const target = CATALOG.daily_calorie_target;

  if (info.isFuture) {
    detailEl.innerHTML = `<div class="empty-note" style="text-align:center;padding:18px 8px;">${escapeHtml(formatFriendlyDate(analyticsSelectedDate))} ще не настав.</div>`;
    return;
  }
  if (!info.hasData) {
    detailEl.innerHTML = `
      <div class="day-detail-card glass">
        <div class="day-detail-date">${escapeHtml(formatFriendlyDate(analyticsSelectedDate))}</div>
        <div class="empty-note" style="padding:0;">Цього дня нічого не залоговано.</div>
      </div>`;
    return;
  }

  const pct = target ? Math.round((info.calories / target) * 100) : 0;
  const isOver = info.calories > target;

  function macroRow(name, key, value, goal) {
    const p = goal ? Math.max(0, Math.min(100, (value / goal) * 100)) : 0;
    return `
      <div class="macro">
        <div class="macro-top"><span class="macro-name">${name}</span><span class="macro-val mono">${Math.round(value)}/${Math.round(goal)}г</span></div>
        <div class="macro-track"><div class="macro-fill ${key}" style="width:${p}%"></div></div>
      </div>`;
  }

  detailEl.innerHTML = `
    <div class="day-detail-card glass">
      <div class="day-detail-date">${escapeHtml(formatFriendlyDate(analyticsSelectedDate))}</div>
      <div class="day-detail-kcal ${isOver ? 'over' : ''}">${Math.round(info.calories)} / ${Math.round(target)} ккал (${pct}%)</div>
      <div class="macros-row">
        ${macroRow('🍗 Білки', 'protein', info.protein, goals.protein)}
        ${macroRow('🥑 Жири', 'fat', info.fat, goals.fat)}
        ${macroRow('🌾 Вуглеводи', 'carbs', info.carbs, goals.carbs)}
      </div>
    </div>`;
}

const analyticsOverlay = document.getElementById('analyticsOverlay');

function openAnalytics() {
  analyticsPeriod = 'week';
  analyticsSelectedDate = null; // no day pre-selected on open
  document.querySelectorAll('#analyticsPeriodToggle [data-period]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.period === analyticsPeriod);
  });
  renderAnalytics();
  analyticsOverlay.classList.add('show');
}
function closeAnalytics() {
  analyticsOverlay.classList.remove('show');
}

document.getElementById('analyticsBtn')?.addEventListener('click', () => {
  haptic('impact', 'light');
  openAnalytics();
});
document.getElementById('analyticsClose')?.addEventListener('click', () => {
  haptic('impact', 'light');
  closeAnalytics();
});
analyticsOverlay?.addEventListener('click', (e) => { if (e.target === analyticsOverlay) closeAnalytics(); });

document.querySelectorAll('#analyticsPeriodToggle [data-period]').forEach((btn) => {
  btn.addEventListener('click', () => {
    haptic('impact', 'light');
    analyticsPeriod = btn.dataset.period;
    analyticsSelectedDate = null;
    document.querySelectorAll('#analyticsPeriodToggle [data-period]').forEach((b) => b.classList.toggle('active', b === btn));
    renderAnalytics();
  });
});

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
    confirmBtn?.addEventListener('click', () => {
      haptic('impact', 'medium');

      // OPTIMISTIC: mutate in-memory state and re-render instantly — no
      // await, no waiting on storage or network.
      const dayLog = dayLogCache.get(TODAY) || {};
      dayLog[item.product_key] = Math.max(0, (dayLog[item.product_key] || 0) + sheetState.pendingDelta);
      setDayLogInMemory(TODAY, dayLog);
      recomputeAndRender();

      haptic('notification', 'success');
      closeSheet();

      // BACKGROUND: persist locally + sync to the server, without the UI
      // waiting on either.
      persistAndSync();
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
    confirmBtn?.addEventListener('click', () => {
      haptic('impact', 'medium');

      // OPTIMISTIC: mutate in-memory state and re-render instantly.
      const dayLog = dayLogCache.get(TODAY) || {};
      dayLog[JUNK_KEY] = Math.max(0, (Number(dayLog[JUNK_KEY]) || 0) + sheetState.pendingDelta);
      setDayLogInMemory(TODAY, dayLog);
      recomputeAndRender();

      haptic('notification', 'success');
      closeSheet();

      // BACKGROUND: persist locally + sync to the server.
      persistAndSync();
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

// ---------------------------------------------------------------------------
// Invite-code authorization
// ---------------------------------------------------------------------------
// Gates the whole app behind an invite code. Once verified, "authorized" is
// cached locally so every future app open skips straight to the normal
// offline-first boot (consistent with requirement 1 — this check must not
// force a network round-trip on every single open). A lightweight
// background re-check still runs afterward in case access was revoked.

const AUTH_CACHE_KEY = 'eatko_authorized';

function isAuthorizedCached() {
  try { return localStorage.getItem(AUTH_CACHE_KEY) === '1'; } catch { return false; }
}
function setAuthorizedCached() {
  try { localStorage.setItem(AUTH_CACHE_KEY, '1'); } catch { /* non-fatal */ }
}
function clearAuthorizedCached() {
  try { localStorage.removeItem(AUTH_CACHE_KEY); } catch { /* non-fatal */ }
}

function showLockScreen() {
  document.getElementById('lockScreen')?.classList.remove('hidden');
}
function hideLockScreen() {
  document.getElementById('lockScreen')?.classList.add('hidden');
}

function wireUpInviteForm() {
  const input = document.getElementById('inviteCodeInput');
  const btn = document.getElementById('inviteSubmitBtn');
  const errorEl = document.getElementById('inviteError');
  if (!input || !btn || !errorEl) return;

  async function submit() {
    const code = input.value.trim();
    errorEl.textContent = '';

    if (!code) { errorEl.textContent = 'Введіть код запрошення.'; return; }
    if (!INIT_DATA) { errorEl.textContent = 'Відкрийте це через Telegram-бота.'; return; }

    btn.disabled = true;
    haptic('impact', 'medium');

    try {
      const res = await fetch('/api/verify-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': INIT_DATA },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.authorized) {
        throw new Error(body.error || 'Не вдалося перевірити код. Спробуйте ще раз.');
      }

      setAuthorizedCached();
      haptic('notification', 'success');
      hideLockScreen();
      await init();
    } catch (err) {
      haptic('notification', 'error');
      errorEl.textContent = err.message;
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

// Non-blocking: confirms the cached "authorized" flag still holds, in case
// access was revoked since the last check. A failed/unreachable check never
// locks anyone out on its own — only an explicit authorized:false does.
async function checkAuthInBackground() {
  if (!INIT_DATA) return;
  try {
    const res = await fetch('/api/check-auth', { headers: { 'X-Telegram-Init-Data': INIT_DATA } });
    if (!res.ok) return;
    const body = await res.json();
    if (!body.authorized) {
      clearAuthorizedCached();
      showLockScreen();
    }
  } catch (err) {
    console.warn('[auth] background re-check failed (non-fatal):', err);
  }
}

async function boot() {
  wireUpInviteForm();

  if (isAuthorizedCached()) {
    hideLockScreen();
    await init();
    checkAuthInBackground();
  } else {
    showLockScreen();
  }
}

boot();
