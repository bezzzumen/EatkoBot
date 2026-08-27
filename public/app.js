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

// Diagnostic-only, sent alongside INIT_DATA so the server can log "this
// telegram_id was claimed but signature verification failed" instead of a
// blind 401 — makes a real misconfiguration (e.g. mismatched BOT_TOKEN)
// actually traceable. NEVER used by the server to grant access on its own —
// initDataUnsafe is, as the name says, unverified, and anyone can fake it
// with a plain fetch() call. INIT_DATA (the signed string above) remains
// the only thing that actually proves who's asking.
const CLIENT_TELEGRAM_ID = tg?.initDataUnsafe?.user?.id != null ? String(tg.initDataUnsafe.user.id) : '';

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

// Returns the 1st of the month `delta` months away from dateStr's month.
// Anchoring to day 1 sidesteps day-overflow issues (e.g. Jan 31 + 1 month)
// and is all getMonthRangeDates() actually needs — it only reads the
// year/month off whatever anchor date it's given.
function addMonthsISO(dateStr, delta) {
  const [y, m] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
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

// "Погане ЇДЛО" (junk calories) has been removed as a feature — quick/custom
// entries (Калькулятор-style КБЖУ-on-100g-and-weight logging, AI Fridge
// recipes, etc.) now all log exclusively through "Будь-чого" below.
//
// junk_food itself is still registered server-side in CATEGORIES_META (so
// old saved logs and the sync/broadcast schema don't break), but it has no
// catalog items and target_calories 0, so it never contributes to any
// total here and is filtered out of the rendered category list —
// JUNK_CATEGORY_KEY exists purely for that rendering filter now.
const JUNK_CATEGORY_KEY = 'junk_food';

// The CATEGORIES_META key (database.js) that "Будь-чого" is registered
// under — a normal catalog category (has its own target_calories and
// seed-data.js items), but ALSO accepts free-form, non-catalog products via
// the custom-item sheet below (openFreebieCustomSheet): a running kcal
// total plus an optional cumulative macros object, both folded into this
// category's usage/consumption alongside its normal catalog items (see
// computeDayStatus).
const FREEBIE_CATEGORY_KEY = 'freebie';
const FREEBIE_CUSTOM_KCAL_KEY = '__freebie_custom_kcal';
const FREEBIE_CUSTOM_MACROS_KEY = '__freebie_custom_macros'; // {protein, fat, carbs} cumulative

// Every reserved (non product-key) slot a day-log object can hold — used
// wherever code needs to tell "a real catalog product_key" apart from one
// of these free-form counters.
const RESERVED_LOG_KEYS = new Set([FREEBIE_CUSTOM_KCAL_KEY, FREEBIE_CUSTOM_MACROS_KEY]);

// Reads one of the {protein, fat, carbs} reserved-key objects above,
// tolerating anything missing/malformed (older saved logs, a corrupted
// CloudStorage value, etc.) by defaulting every field to 0.
function readMacrosObj(dayLog, key) {
  const raw = dayLog ? dayLog[key] : null;
  if (!raw || typeof raw !== 'object') return { protein: 0, fat: 0, carbs: 0 };
  return {
    protein: Math.max(0, Number(raw.protein) || 0),
    fat: Math.max(0, Number(raw.fat) || 0),
    carbs: Math.max(0, Number(raw.carbs) || 0),
  };
}

function totalCaloriesForDay(dayLog) {
  if (!dayLog) return null;
  const freebieCustomKcal = Math.max(0, Number(dayLog[FREEBIE_CUSTOM_KCAL_KEY]) || 0);
  const productKeys = Object.keys(dayLog).filter((k) => !RESERVED_LOG_KEYS.has(k));
  if (!productKeys.length && freebieCustomKcal <= 0) return null; // nothing logged at all that day

  let total = freebieCustomKcal;
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

  // "Будь-чого" custom (non-catalog) items — a direct kcal counter plus an
  // optional macros side, scoped to the freebie category's own budget. See
  // the FREEBIE_* consts above for why.
  const freebieCustomKcal = round1(Math.max(0, Number(dayLog[FREEBIE_CUSTOM_KCAL_KEY]) || 0));
  const freebieCustomMacros = readMacrosObj(dayLog, FREEBIE_CUSTOM_MACROS_KEY);

  const categories = CATALOG.categories.map((catMeta) => {
    const isFreebie = catMeta.key === FREEBIE_CATEGORY_KEY;

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

    // Custom "Будь-чого" entries count toward this category's own budget
    // exactly like its catalog items do — as a fraction of target_calories
    // — so a big custom entry can push it to 'complete'/'over' the same
    // way logging its catalog items would.
    const customRatio = isFreebie && catMeta.target_calories ? freebieCustomKcal / catMeta.target_calories : 0;
    const usageRatio = items.reduce((sum, it) => sum + it.percent / 100, 0) + customRatio;
    const caloriesConsumed = catMeta.target_calories * usageRatio;
    const proteinConsumed = items.reduce((sum, it) => sum + it.protein, 0) + (isFreebie ? freebieCustomMacros.protein : 0);
    const carbsConsumed = items.reduce((sum, it) => sum + it.carbs, 0) + (isFreebie ? freebieCustomMacros.carbs : 0);
    const fatConsumed = items.reduce((sum, it) => sum + it.fat, 0) + (isFreebie ? freebieCustomMacros.fat : 0);

    totalCalories += caloriesConsumed;
    totalProtein += proteinConsumed;
    totalCarbs += carbsConsumed;
    totalFat += fatConsumed;

    // junk_food is uncapped-and-unused now (see JUNK_CATEGORY_KEY comment
    // above) — target_calories 0 and no items means usageRatio is always 0,
    // so it just stays 'active' and contributes nothing to any total.
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
      // Custom (non-catalog) portion of the above, broken out so the UI can
      // show "Власні продукти: …" separately from the catalog items list.
      // Always present (0 for non-freebie categories) so callers don't
      // need an isFreebie check of their own.
      custom_kcal: isFreebie ? freebieCustomKcal : 0,
      custom_protein: isFreebie ? round1(freebieCustomMacros.protein) : 0,
      custom_fat: isFreebie ? round1(freebieCustomMacros.fat) : 0,
      custom_carbs: isFreebie ? round1(freebieCustomMacros.carbs) : 0,
    };
  });

  return {
    total_calories: round1(totalCalories),
    totals: {
      calories: round1(totalCalories),
      protein: round1(totalProtein),
      carbs: round1(totalCarbs),
      fat: round1(totalFat),
    },
    categories,
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

// ---------------------------------------------------------------------------
// Custom daily calorie target — scaling
// ---------------------------------------------------------------------------
// GET /api/catalog always returns the same 2220-kcal BASE catalog (the
// per-category and per-macro limits computed from CATEGORIES_META in
// database.js) — it has no notion of any individual user's custom target.
// BASE_CATALOG holds that raw response; CATALOG (used by every other
// function in this file, unchanged) is always a derived, SCALED copy of
// it — recomputed by scaleCatalog() below whenever either BASE_CATALOG or
// userDailyTarget changes.

const DEFAULT_DAILY_TARGET = 2220; // matches DAILY_CALORIE_TARGET in database.js
const MIN_DAILY_TARGET = 800;
const MAX_DAILY_TARGET = 6000;
const DAILY_TARGET_CACHE_KEY = 'eatko_daily_target_v1';

let BASE_CATALOG = null;
let userDailyTarget = DEFAULT_DAILY_TARGET;

function loadCachedDailyTarget() {
  try {
    const raw = localStorage.getItem(DAILY_TARGET_CACHE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
function saveCachedDailyTarget(target) {
  try { localStorage.setItem(DAILY_TARGET_CACHE_KEY, String(target)); } catch { /* non-fatal */ }
}

// Scales every calorie-denominated limit in the base catalog by
// K = target / base.daily_calorie_target, rounding each to a whole number.
// Works identically for K < 1 (a lower target, e.g. 1800) and K > 1 (a
// higher one, e.g. 2800) — it's just multiplication either way.
//
// BUGFIX: per-item max_grams (and each item's own protein/carbs/fat) used
// to be left untouched, on the theory that scaling target_calories alone
// was enough since logging math uses target_calories / max_grams as the
// per-gram rate. That theory was wrong on two counts:
//   1. Display: a category's calorie limit would double but its listed
//      product weights (e.g. "макс 85g") stayed frozen at the base-2220
//      value, which reads as a bug to the user even though the ratio math
//      technically still balanced.
//   2. Nutrition correctness: computeDayMacros/computeDayCategoryCalories
//      compute ratio = loggedGrams / item.max_grams (loggedGrams being the
//      user's actual real-world grams eaten, independent of K) and then
//      multiply that ratio by item.protein/carbs/fat. If max_grams doesn't
//      scale by K but the physical grams logged doesn't change either,
//      that's fine on its own — but it means "eating the same 85g of
//      chicken" silently means something different in the app depending
//      on what K happens to be, since max_grams no longer represents "how
//      many grams make up target_calories worth of this food" once K != 1.
// The fix: scale max_grams by K too, so max_grams keeps meaning "grams
// that use up this category's (now-scaled) target_calories" — and scale
// each item's protein/carbs/fat by the same K, so kcal-per-gram and
// macro-per-gram both stay the real nutritional constants they're
// supposed to be, regardless of K. (The K's cancel out algebraically in
// every ratio-based computation once max_grams and target_calories scale
// together — see computeDayMacros/computeDayCategoryCalories below.)
function scaleCatalog(base, target) {
  if (!base) return base;
  const k = target / base.daily_calorie_target;
  return {
    ...base,
    daily_calorie_target: target,
    protein_goal: Math.round(base.protein_goal * k),
    carbs_goal: Math.round(base.carbs_goal * k),
    fat_goal: Math.round(base.fat_goal * k),
    categories: base.categories.map((cat) => ({
      ...cat,
      target_calories: Math.round(cat.target_calories * k),
      items: cat.items.map((item) => ({
        ...item,
        max_grams: typeof item.max_grams === 'number' ? Math.round(item.max_grams * k) : item.max_grams,
        protein: typeof item.protein === 'number' ? Math.round(item.protein * k) : item.protein,
        carbs: typeof item.carbs === 'number' ? Math.round(item.carbs * k) : item.carbs,
        fat: typeof item.fat === 'number' ? Math.round(item.fat * k) : item.fat,
      })),
    })),
  };
}

// Applies a newly-known daily_target (from the user's own edit, or from the
// server via check-auth): updates the cached value and, if the catalog has
// already loaded, rescales CATALOG and re-renders. Safe to call before
// BASE_CATALOG/STATE exist yet (e.g. from boot(), before init() has run) —
// it just caches the value for init() to pick up as its starting point.
function applyDailyTarget(target) {
  const rounded = Math.round(target);
  if (!Number.isFinite(rounded) || rounded <= 0) return;
  if (rounded === userDailyTarget && CATALOG) return; // no-op, avoid a pointless re-render
  userDailyTarget = rounded;
  saveCachedDailyTarget(rounded);
  if (BASE_CATALOG) {
    CATALOG = scaleCatalog(BASE_CATALOG, userDailyTarget);
    if (STATE) recomputeAndRender();
  }
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

  // The custom daily_target lives server-side (see database.js), but is
  // cached locally too so it can be applied instantly, offline-first — the
  // same pattern as the catalog cache just below. GET /api/check-auth
  // (called from boot(), after this) fetches the current server value in
  // the background and calls applyDailyTarget() again if it turns out to
  // differ from this cached one (e.g. it was changed on another device).
  userDailyTarget = loadCachedDailyTarget() || DEFAULT_DAILY_TARGET;

  // --- 1. IMMEDIATE RENDER: from local cache, before any network request ---
  const cachedCatalog = loadCachedCatalog();
  if (cachedCatalog) {
    BASE_CATALOG = cachedCatalog;
    CATALOG = scaleCatalog(BASE_CATALOG, userDailyTarget);
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
    BASE_CATALOG = fresh;
    saveCachedCatalog(fresh);
    CATALOG = scaleCatalog(BASE_CATALOG, userDailyTarget);

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

  // Fire-and-forget: renders its own "…" placeholder immediately and fills
  // in once it resolves — never blocks the rest of init().
  loadWeight();
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
// Custom daily calorie target — persistence
// ---------------------------------------------------------------------------

// Persists the user's chosen daily_target to the server (POST
// /api/user/settings, see server.js). Unlike food-log syncing, there's no
// dirty-flag/retry queue here — it's a single explicit save action, not a
// background sync of frequently-changing state — so a failed attempt just
// throws for the caller to handle; the local value (already applied
// optimistically by applyDailyTarget) stays correct either way.
async function saveDailyTargetToServer(target) {
  if (!INIT_DATA) return; // outside Telegram — nothing to sync, local value already applied
  const res = await fetch('/api/user/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': INIT_DATA },
    body: JSON.stringify({ daily_target: target }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Weekly weight tracking
// ---------------------------------------------------------------------------
// Unlike food logs, weight lives server-side (see database.js's
// weekly_weight table) — there's exactly one number per user per week, so
// there's no offline-editing use case that would justify the
// CloudStorage-first approach used for daily logs. week_start itself is
// always computed by the server (Europe/Kyiv Monday), never by this client
// — see mondayOfWeek() in server.js.

// { current_week: {week_start, weight_kg}|null, previous_week: {...}|null }
// while `loading` is true, current_week/previous_week are stale/unset —
// renderWeightWidget() shows a neutral "…" placeholder for that case rather
// than misreporting "no entry yet".
let weightState = { loading: true, current_week: null, previous_week: null };

async function loadWeight() {
  if (!INIT_DATA) { weightState.loading = false; renderWeightWidget(); return; } // outside Telegram — nothing to load
  try {
    const res = await fetch('/api/weight', { headers: { 'X-Telegram-Init-Data': INIT_DATA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    weightState.current_week = body.current_week || null;
    weightState.previous_week = body.previous_week || null;
  } catch (err) {
    console.warn('[weight] load failed (widget will show its empty state):', err.message);
  } finally {
    weightState.loading = false;
    renderWeightWidget();
  }
}

// diff = current - previous. "down" (lost weight) is the good/green case
// here specifically because this app tracks a calorie *deficit* goal —
// unlike calories-in-a-day where over/under has its own meaning, weight
// trend direction only reads as good/bad relative to what the user is
// trying to do, which for this app is consistently "trending down".
function weightTrendClass(diff) {
  if (diff < 0) return 'down';
  if (diff > 0) return 'up';
  return '';
}

// The Вага button is now a compact, statically-labeled bottom-nav button
// (like Калькулятор/Статистика/AI Fridge) rather than a pill showing the
// live weight value — that detail lives only inside the weight sheet
// itself (openWeightSheet's weightHeroValue/weightCompare). It used to also
// pulse amber ("prompt" class) when no weight had been logged yet this
// week; that accent was removed so all four bottom-nav buttons share the
// same unified styling. This function is now a no-op kept only so its
// call sites (openWeightSheet, wireUpWeightForm, init) don't need to change.
function renderWeightWidget() {
  const btn = document.getElementById('weightBtn');
  if (!btn) return;
  btn.classList.remove('prompt');
}

function openWeightSheet() {
  const errorEl = document.getElementById('weightError');
  const input = document.getElementById('weightInput');
  const heroEl = document.getElementById('weightHeroValue');
  const compareEl = document.getElementById('weightCompare');
  const saveBtn = document.getElementById('weightSaveBtn');
  if (!errorEl || !input || !heroEl || !compareEl || !saveBtn) return;

  errorEl.textContent = '';
  saveBtn.disabled = false;
  input.value = weightState.current_week ? weightState.current_week.weight_kg : '';
  heroEl.textContent = weightState.current_week ? `${fmtNum(weightState.current_week.weight_kg)} кг` : '—';

  if (weightState.previous_week) {
    const rows = [`
      <div class="weight-compare-row">
        <span class="label">Минулий тиждень</span>
        <span class="value mono">${fmtNum(weightState.previous_week.weight_kg)} кг</span>
      </div>`];
    if (weightState.current_week) {
      const diff = weightState.current_week.weight_kg - weightState.previous_week.weight_kg;
      const dot = diff < 0 ? '🟢' : diff > 0 ? '🔴' : '⚪';
      const sign = diff > 0 ? '+' : '';
      rows.push(`
      <div class="weight-compare-row">
        <span class="label">Різниця</span>
        <span class="value mono ${weightTrendClass(diff)}">${dot} ${sign}${fmtNum(diff)} кг</span>
      </div>`);
    }
    compareEl.innerHTML = rows.join('');
  } else {
    compareEl.innerHTML = `<div class="empty-note">Ще немає даних за минулий тиждень.</div>`;
  }

  weightOverlay.classList.add('show');
}
function closeWeightSheet() {
  weightOverlay.classList.remove('show');
  clearActiveNavBtn();
}

function wireUpWeightForm() {
  const input = document.getElementById('weightInput');
  const btn = document.getElementById('weightSaveBtn');
  const errorEl = document.getElementById('weightError');
  if (!input || !btn || !errorEl) return;

  async function submit() {
    errorEl.textContent = '';
    const val = parseFloat(input.value);
    if (!Number.isFinite(val) || val < 20 || val > 400) {
      errorEl.textContent = 'Введіть коректне значення ваги (20–400 кг).';
      return;
    }
    if (!INIT_DATA) {
      errorEl.textContent = 'Відкрийте це через Telegram-бота.';
      return;
    }

    btn.disabled = true;
    haptic('impact', 'medium');

    try {
      const res = await fetch('/api/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': INIT_DATA },
        body: JSON.stringify({ weight_kg: val }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Не вдалося зберегти вагу. Спробуйте ще раз.');

      weightState.current_week = body.current_week || null;
      weightState.previous_week = body.previous_week || null;
      renderWeightWidget();

      haptic('notification', 'success');
      showToast('Вагу збережено ⚖️');
      closeWeightSheet();
    } catch (err) {
      haptic('notification', 'error');
      errorEl.textContent = err.message;
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

const weightOverlay = document.getElementById('weightOverlay');
document.getElementById('weightBtn')?.addEventListener('click', () => {
  haptic('impact', 'light');
  setActiveNavBtn('weightBtn');
  openWeightSheet();
});
document.getElementById('weightClose')?.addEventListener('click', () => {
  haptic('impact', 'light');
  closeWeightSheet();
});
weightOverlay?.addEventListener('click', (e) => { if (e.target === weightOverlay) closeWeightSheet(); });
wireUpWeightForm();

// ---------------------------------------------------------------------------
// Custom daily calorie target — UI
// ---------------------------------------------------------------------------

function openTargetSheet() {
  const input = document.getElementById('targetInput');
  const errorEl = document.getElementById('targetError');
  const saveBtn = document.getElementById('targetSaveBtn');
  if (!input || !errorEl || !saveBtn) return;

  errorEl.textContent = '';
  saveBtn.disabled = false;
  input.value = userDailyTarget;
  updateTargetPreview();

  targetOverlay.classList.add('show');
  // Autofocus + select-all, so re-entering a value is a single keystroke away.
  requestAnimationFrame(() => { input.focus(); input.select(); });
}
function closeTargetSheet() {
  targetOverlay.classList.remove('show');
}

// Live preview of the scaled macro goals as the user types a new target —
// same K = target / base.daily_calorie_target math as scaleCatalog(), just
// read-only here (doesn't touch CATALOG/STATE until the user actually saves).
function updateTargetPreview() {
  const input = document.getElementById('targetInput');
  const previewEl = document.getElementById('targetPreview');
  if (!input || !previewEl) return;

  const val = parseInt(input.value, 10);
  if (!Number.isFinite(val) || val <= 0 || !BASE_CATALOG) {
    previewEl.textContent = '';
    return;
  }
  const k = val / BASE_CATALOG.daily_calorie_target;
  const protein = Math.round(BASE_CATALOG.protein_goal * k);
  const fat = Math.round(BASE_CATALOG.fat_goal * k);
  const carbs = Math.round(BASE_CATALOG.carbs_goal * k);
  previewEl.innerHTML = `Білки <b>${protein}г</b> • Жири <b>${fat}г</b> • Вуглеводи <b>${carbs}г</b>`;
}

function wireUpTargetForm() {
  const input = document.getElementById('targetInput');
  const btn = document.getElementById('targetSaveBtn');
  const errorEl = document.getElementById('targetError');
  if (!input || !btn || !errorEl) return;

  input.addEventListener('input', updateTargetPreview);

  async function submit() {
    errorEl.textContent = '';
    const val = parseInt(input.value, 10);
    if (!Number.isFinite(val) || val < MIN_DAILY_TARGET || val > MAX_DAILY_TARGET) {
      errorEl.textContent = `Введіть коректну ціль (${MIN_DAILY_TARGET}–${MAX_DAILY_TARGET} ккал).`;
      return;
    }

    btn.disabled = true;
    haptic('impact', 'medium');

    // OPTIMISTIC: rescale every category/macro limit and re-render
    // instantly, then persist to the server in the background — same
    // pattern as every other write in this app (see persistAndSync()).
    applyDailyTarget(val);
    haptic('notification', 'success');
    showToast('Денну ціль оновлено 🎯');
    closeTargetSheet();

    try {
      await saveDailyTargetToServer(val);
    } catch (err) {
      // Non-fatal from the user's point of view — the local value is
      // already correct (applied above); this just failed to reach the
      // server, so the next check-auth background refresh or another save
      // attempt will pick it up.
      console.warn('[target] failed to persist to server:', err.message);
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

const targetOverlay = document.getElementById('targetOverlay');
document.getElementById('kcalTargetBtn')?.addEventListener('click', () => {
  haptic('impact', 'light');
  openTargetSheet();
});
document.getElementById('targetClose')?.addEventListener('click', () => {
  haptic('impact', 'light');
  closeTargetSheet();
});
targetOverlay?.addEventListener('click', (e) => { if (e.target === targetOverlay) closeTargetSheet(); });
wireUpTargetForm();

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

function renderStreak() {
  const streak = STATE.streak || 0;
  const el = document.getElementById('streakInline');
  if (!el) return;

  // The flame is a static SVG in the pill badge markup now (not emoji
  // text) — only the number needs updating on each render.
  el.classList.toggle('zero', streak === 0);
  const numEl = document.getElementById('streakNum');
  if (numEl) numEl.textContent = streak;
}

const WEEK_STATUS_EMOJI = { success: '🔥', over: '❌', unlogged: '⚪', future: '⚪' };

function renderWeek() {
  const week = STATE.week || [];
  const row = document.getElementById('weekRow');

  row.innerHTML = week
    .map((day, i) => {
      // A day "chains" into the next one when both are logged streak
      // successes — drives the neon connector bar in CSS that visually
      // links consecutive days into one continuous streak strip.
      const next = week[i + 1];
      const chainNext = day.status === 'success' && next && next.status === 'success';
      return `
      <div class="week-day status-${day.status} ${day.is_today ? 'is-today' : ''} ${chainNext ? 'chain-next' : ''}">
        <div class="week-label">${escapeHtml(day.label)}</div>
        <div class="week-chip">${WEEK_STATUS_EMOJI[day.status] || '⚪'}</div>
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Category cards
// ---------------------------------------------------------------------------

const STATUS_LABEL = { active: 'Активно', complete: '✅ Виконано', over: '⚠️ Перевищено' };
let openCategories = new Set();

// Colored SVG badge per category (replaces the plain emoji glyph). Each
// entry's stroke is currentColor — the actual color comes from the matching
// .cat-badge-<key> CSS class (see index.html), so this map only needs to
// carry the artwork. category_key values come straight from CATEGORIES_META
// (database.js): garnish, dairy, freebie, protein, veggies, fats, fruits, nuts.
const CATEGORY_ICON_SVG = {
  garnish: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="21" x2="12" y2="4"/>
    <path d="M12 6c-2.2-0.3-3.6-2-3.6-2"/><path d="M12 6c2.2-0.3 3.6-2 3.6-2"/>
    <path d="M12 10.3c-2.2-0.3-3.6-2-3.6-2"/><path d="M12 10.3c2.2-0.3 3.6-2 3.6-2"/>
    <path d="M12 14.6c-2.2-0.3-3.6-2-3.6-2"/><path d="M12 14.6c2.2-0.3 3.6-2 3.6-2"/>
  </svg>`,
  dairy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 2h6v3.2l2 3.3V21a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8.5l2-3.3z"/>
    <line x1="9" y1="2" x2="15" y2="2"/>
    <line x1="7.3" y1="12" x2="16.7" y2="12"/>
  </svg>`,
  freebie: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="4"/>
    <line x1="8" y1="8" x2="8" y2="8"/><line x1="16" y1="8" x2="16" y2="8"/>
    <line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>
    <line x1="12" y1="12" x2="12" y2="12"/>
  </svg>`,
  protein: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 21c4.4 0 7-3.6 7-8 0-5-4-11-7-11S5 8 5 13c0 4.4 2.6 8 7 8z"/>
  </svg>`,
  veggies: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 20c0-8 6-14 15-15-1 9-7 15-15 15z"/>
    <path d="M6.5 17.5 15 9"/>
  </svg>`,
  fats: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3s6 7.5 6 12a6 6 0 0 1-12 0c0-4.5 6-12 6-12z"/>
  </svg>`,
  fruits: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 9c-4 0-7 3.1-7 7 0 3 2.2 5 4.8 5 0.8 0 1.4-0.3 2.2-0.3s1.4 0.3 2.2 0.3c2.6 0 4.8-2 4.8-5 0-3.9-3-7-7-7z"/>
    <path d="M12 9c0-1.8 0.8-3 2.3-3.6"/>
  </svg>`,
  nuts: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 10c3.3 0 5.5 2.4 5.5 6 0 3-2 5.5-5.5 5.5S6.5 19 6.5 16c0-3.6 2.2-6 5.5-6z"/>
    <path d="M7.2 10.2c0.6-2.6 2.4-4.2 4.8-4.2s4.2 1.6 4.8 4.2"/>
    <line x1="9.5" y1="9.6" x2="9.5" y2="12"/><line x1="14.5" y1="9.6" x2="14.5" y2="12"/>
  </svg>`,
};
// Fallback for any category not in the map above (defensive — e.g. a future
// CATEGORIES_META addition that hasn't gotten a bespoke icon/color yet).
const CATEGORY_ICON_FALLBACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="8.5"/>
</svg>`;

function categoryIconBadgeHtml(categoryKey) {
  const svg = CATEGORY_ICON_SVG[categoryKey] || CATEGORY_ICON_FALLBACK;
  const cls = CATEGORY_ICON_SVG[categoryKey] ? `cat-badge-${categoryKey}` : 'cat-badge-fallback';
  return `<div class="cat-icon-badge ${cls}">${svg}</div>`;
}

function renderCategories() {
  const container = document.getElementById('categoriesContainer');

  const categoryCardsHtml = STATE.categories
    // junk_food is dead weight now (see JUNK_CATEGORY_KEY comment near the
    // top of the file) — still returned by computeDayStatus so old server
    // data keeps working, but it's never rendered.
    .filter((cat) => cat.category_key !== JUNK_CATEGORY_KEY)
    .map((cat) => {
      const isOpen = openCategories.has(cat.category_key);
      const pillClass = cat.status;
      const pillLabel = cat.status === 'over' ? `⚠️ Перевищено (${Math.round(cat.usage_percent)}%)` : STATUS_LABEL[cat.status];
      // Active categories get a minimal "+" affordance instead of a heavy
      // text pill; complete/over states keep the pill since they carry
      // meaningful status info (checkmark / overage %).
      const statusMarkup = cat.status === 'active'
        ? `<div class="status-icon" aria-hidden="true">+</div>`
        : `<div class="status-pill ${pillClass}">${pillLabel}</div>`;
      const barPct = Math.min(100, cat.usage_percent);
      const barClass = cat.status === 'over' ? 'over' : cat.status === 'complete' ? 'complete' : '';

      const isFreebie = cat.category_key === FREEBIE_CATEGORY_KEY;

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

      // "Будь-чого" only: summary of whatever's been logged via the
      // free-form custom-item sheet (openFreebieCustomSheet), plus the
      // entry point to add another one.
      const freebieCustomSummaryHtml = isFreebie && cat.custom_kcal > 0 ? `
        <div class="custom-summary-row">
          <span>Власні продукти</span>
          <span class="mono">${Math.round(cat.custom_kcal)} ккал${(cat.custom_protein || cat.custom_fat || cat.custom_carbs) ? ` · Б ${fmtNum(cat.custom_protein)}г Ж ${fmtNum(cat.custom_fat)}г В ${fmtNum(cat.custom_carbs)}г` : ''}</span>
        </div>` : '';
      const freebieAddBtnHtml = isFreebie
        ? `<button class="add-custom-item-btn" data-add-freebie-custom>+ Додати власний продукт (КБЖУ)</button>`
        : '';

      return `
        <section class="cat-card glass status-${cat.status} ${isOpen ? 'open' : ''}" data-category="${cat.category_key}">
          <div class="cat-header">
            <div class="left">
              ${categoryIconBadgeHtml(cat.category_key)}
              <div class="titles">
                <h3>${escapeHtml(cat.category_name)}</h3>
                <div class="sub">${Math.round(cat.calories_consumed)} / ${cat.target_calories} ккал</div>
              </div>
            </div>
            <div class="right">
              ${statusMarkup}
              <div class="chevron">▾</div>
            </div>
          </div>
          <div class="cat-progress">
            <div class="cat-progress-track"><div class="cat-progress-fill ${barClass}" style="width:${barPct}%"></div></div>
          </div>
          <div class="cat-body">
            <div class="cat-body-inner">
              <div class="item-list">
                ${freebieCustomSummaryHtml}
                ${items || (isFreebie ? '' : '<div class="empty-note">Немає товарів у цій категорії — додайте у seed-data.js.</div>')}
                ${freebieAddBtnHtml}
              </div>
            </div>
          </div>
        </section>`;
    })
    .join('');

  container.innerHTML = categoryCardsHtml;

  container.querySelectorAll('.cat-card .cat-header').forEach((header) => {
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

  container.querySelectorAll('[data-add-freebie-custom]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic('impact', 'light');
      openFreebieCustomSheet();
    });
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

  // "Будь-чого" free-form custom entries — see the FREEBIE_* comments near
  // JUNK_CATEGORY_KEY above. Folded in here the same way computeDayStatus
  // folds them in, so Statistics matches the live dashboard.
  const freebieCustomKcal = Math.max(0, Number(dayLog[FREEBIE_CUSTOM_KCAL_KEY]) || 0);
  calories += freebieCustomKcal;
  const freebieCustomMacros = readMacrosObj(dayLog, FREEBIE_CUSTOM_MACROS_KEY);
  protein += freebieCustomMacros.protein;
  carbs += freebieCustomMacros.carbs;
  fat += freebieCustomMacros.fat;

  return { calories: round1(calories), protein: round1(protein), carbs: round1(carbs), fat: round1(fat), freebieCustom: round1(freebieCustomKcal) };
}

// Per-category calories for an arbitrary day's log — same ratio math as
// computeDayMacros, just keyed by category instead of summed into one
// total. Powers the "top calorie sources" breakdown. junk_food is skipped
// entirely (see JUNK_CATEGORY_KEY comment above — it's a dead, unused
// category kept only so old server data doesn't break).
function computeDayCategoryCalories(dayLog) {
  const byCategory = {};
  for (const cat of CATALOG.categories) {
    if (cat.key === JUNK_CATEGORY_KEY) continue;
    let categoryRatio = 0;
    for (const item of cat.items) {
      const loggedGrams = dayLog[item.product_key] || 0;
      categoryRatio += item.max_grams ? loggedGrams / item.max_grams : 0;
    }
    byCategory[cat.key] = cat.target_calories * categoryRatio;
  }
  // "Будь-чого" custom entries add on top of its catalog-item calories
  // computed above (mirrors computeDayStatus's caloriesConsumed for the
  // same category).
  byCategory[FREEBIE_CATEGORY_KEY] = (byCategory[FREEBIE_CATEGORY_KEY] || 0)
    + Math.max(0, Number(dayLog[FREEBIE_CUSTOM_KCAL_KEY]) || 0);
  return byCategory;
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

// The first date of the week/month period that `anchorDate` falls in —
// used to compare periods (e.g. "is the anchor's period already the
// current one") without generating the full date list.
function getPeriodStart(period, anchorDate) {
  return period === 'week'
    ? addDaysISO(anchorDate, -dayOfWeekMonFirst(anchorDate))
    : `${anchorDate.slice(0, 7)}-01`;
}

function shiftAnchor(period, anchorDate, direction) {
  return period === 'week' ? addDaysISO(anchorDate, direction * 7) : addMonthsISO(anchorDate, direction);
}

function getDayChartInfo(date) {
  if (date > TODAY) return { date, isFuture: true, hasData: false, calories: 0, protein: 0, carbs: 0, fat: 0, freebieCustom: 0 };
  const log = dayLogCache.get(date);
  if (!log || !Object.keys(log).length) return { date, isFuture: false, hasData: false, calories: 0, protein: 0, carbs: 0, fat: 0, freebieCustom: 0 };
  const macros = computeDayMacros(log);
  return { date, isFuture: false, hasData: true, categories: computeDayCategoryCalories(log), ...macros };
}

function formatFriendlyDate(date) {
  return new Date(date + 'T00:00:00').toLocaleDateString('uk-UA', { weekday: 'long', month: 'long', day: 'numeric' });
}

// Compact "Ср, 12 серп" form for the discipline card — formatFriendlyDate's
// full weekday+month is too long for a 2-up metric card.
function formatShortDate(date) {
  const s = new Date(date + 'T00:00:00').toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// "10 серпня – 16 серпня" for a week, "Серпень 2026" for a month — built
// straight from the already-resolved date list, so it always matches
// exactly what the chart is showing.
function formatPeriodNavLabel(period, dates) {
  if (period === 'month') {
    const label = new Date(dates[0] + 'T00:00:00').toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });
    return capitalize(label);
  }
  const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
  return `${capitalize(fmt(dates[0]))} – ${fmt(dates[dates.length - 1])}`;
}

let analyticsPeriod = 'week';
let analyticsSelectedDate = null;
// Any date inside the currently displayed week/month — getPeriodStart()
// derives the actual period boundaries from it. Defaults to TODAY (the
// current period) and moves in whole weeks/months via the nav arrows.
let analyticsAnchorDate = TODAY;

function renderAnalytics() {
  const dates = analyticsPeriod === 'week' ? getWeekRangeDates(analyticsAnchorDate) : getMonthRangeDates(analyticsAnchorDate);
  const dayInfos = dates.map(getDayChartInfo);
  const target = CATALOG.daily_calorie_target;

  const maxActual = Math.max(0, ...dayInfos.map((d) => d.calories || 0));
  const maxScale = Math.max(target * 1.25, maxActual * 1.1, 1);
  const baselinePct = Math.min(100, (target / maxScale) * 100);

  // Per-bar calorie values are only rendered in week mode — with ~31 narrow
  // columns in month mode there isn't room for readable labels, so month
  // relies on tap-to-select (renderAnalyticsDayDetail) for exact numbers.
  const showValues = analyticsPeriod === 'week';

  const barsHtml = dayInfos.map((d, i) => {
    const heightPct = d.isFuture ? 0 : Math.min(100, (d.calories / maxScale) * 100);
    const barClass = d.isFuture ? 'future' : !d.hasData ? 'empty' : d.calories > target ? 'over' : 'success';
    const isSelected = d.date === analyticsSelectedDate;
    const label = analyticsPeriod === 'week' ? WEEKDAY_LABELS[i] : '';
    const valueLabel = (showValues && !d.isFuture && d.hasData)
      ? `<div class="chart-bar-value" style="bottom:${heightPct}%">${Math.round(d.calories)}</div>` : '';
    return `
      <div class="chart-bar-col ${isSelected ? 'selected' : ''}" data-date="${d.date}">
        <div class="chart-bar-track">
          ${valueLabel}
          <div class="chart-bar-fill ${barClass}" style="height:${heightPct}%"></div>
        </div>
        ${label ? `<div class="chart-bar-label">${label}</div>` : ''}
      </div>`;
  }).join('');

  const chartEl = document.getElementById('analyticsChart');
  chartEl.innerHTML = `
    <div class="chart-area">
      <div class="chart-baseline" style="bottom:${baselinePct}%">
        <span class="chart-baseline-label">Ціль · ${Math.round(target)} ккал</span>
      </div>
      <div class="chart-bars ${analyticsPeriod === 'month' ? 'is-month' : ''}">${barsHtml}</div>
    </div>`;

  chartEl.querySelectorAll('.chart-bar-col').forEach((col) => {
    col.addEventListener('click', () => {
      haptic('selection');
      analyticsSelectedDate = col.dataset.date;
      renderAnalytics(); // re-render so the .selected outline moves
    });
  });

  const loggedDays = dayInfos.filter((d) => d.hasData);
  renderAnalyticsInsight(loggedDays, target);
  renderAnalyticsMacros(loggedDays);
  renderAnalyticsCategories(loggedDays);
  renderAnalyticsDiscipline(loggedDays, target);
  renderAnalyticsDayDetail();
  renderPeriodNav(dates);
  positionPeriodToggleThumb();
}

// Formats a calorie count with a thousands separator (e.g. 1980 -> "1,980"),
// purely cosmetic — never fed back into logic.
function fmtKcal(n) {
  return Math.round(n).toLocaleString('en-US');
}

// Dynamic smart-advice banner: green when the period's average calories sit
// within the daily limit, amber when they don't — and the amber copy calls
// out ad-hoc "Будь-чого" custom entries by name specifically when they're
// the main driver of the overage (>=20% of period calories), otherwise
// gives a generic overage message rather than misattributing the cause.
function renderAnalyticsInsight(loggedDays, target) {
  const el = document.getElementById('analyticsInsight');
  if (!loggedDays.length) { el.innerHTML = ''; return; }

  const totalCalories = loggedDays.reduce((sum, d) => sum + d.calories, 0);
  const totalFreebieCustom = loggedDays.reduce((sum, d) => sum + (d.freebieCustom || 0), 0);
  const avgCalories = totalCalories / loggedDays.length;
  const freebieCustomPct = totalCalories > 0 ? (totalFreebieCustom / totalCalories) * 100 : 0;

  let tone, icon, text;
  if (avgCalories <= target) {
    tone = 'good'; icon = '✅';
    text = `Чудова робота! Ви дотримуєтесь норми, середній залишок: ${fmtKcal(target - avgCalories)} ккал/день.`;
  } else {
    tone = 'warn'; icon = '⚠️';
    const overBy = fmtKcal(avgCalories - target);
    text = freebieCustomPct >= 20
      ? `Зверніть увагу: спостерігається систематичний перебір калорій (в середньому на ${overBy} ккал/день) за рахунок доданих вручну продуктів у «Будь-чого».`
      : `Зверніть увагу: середній перебір становить ${overBy} ккал/день понад денну норму.`;
  }

  el.innerHTML = `
    <div class="insight-card ${tone}">
      <div class="insight-icon">${icon}</div>
      <div>${text}</div>
    </div>`;
}

// Average daily protein/carbs/fat for the period vs the same daily goals
// used elsewhere in the app (CATALOG.protein_goal etc.) — reuses the
// .macro-row/.macro-track markup pattern from the hero dashboard.
function renderAnalyticsMacros(loggedDays) {
  const el = document.getElementById('analyticsMacros');
  if (!loggedDays.length) { el.innerHTML = ''; return; }

  const n = loggedDays.length;
  const avg = {
    protein: loggedDays.reduce((s, d) => s + d.protein, 0) / n,
    carbs: loggedDays.reduce((s, d) => s + d.carbs, 0) / n,
    fat: loggedDays.reduce((s, d) => s + d.fat, 0) / n,
  };
  const goals = { protein: CATALOG.protein_goal, carbs: CATALOG.carbs_goal, fat: CATALOG.fat_goal };
  const rows = [
    { key: 'protein', label: 'Білки' },
    { key: 'carbs', label: 'Вуглеводи' },
    { key: 'fat', label: 'Жири' },
  ];

  const rowsHtml = rows.map((r) => {
    const pct = goals[r.key] ? Math.min(100, (avg[r.key] / goals[r.key]) * 100) : 0;
    return `
      <div class="macro">
        <div class="macro-top">
          <span class="macro-name">${r.label}</span>
          <span class="macro-val mono">${Math.round(avg[r.key])} / ${Math.round(goals[r.key])} г</span>
        </div>
        <div class="macro-track"><div class="macro-fill ${r.key}" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="section-title">Середнє БЖВ / день</div>
    <div class="macros-card macros-list">${rowsHtml}</div>`;
}

// Top calorie sources for the period, ranked by their share of total
// calories logged — answers "where do my calories actually go", not just
// "how many". Skips categories with zero contribution.
function renderAnalyticsCategories(loggedDays) {
  const el = document.getElementById('analyticsCategories');
  if (!loggedDays.length) { el.innerHTML = ''; return; }

  const totals = {};
  for (const day of loggedDays) {
    for (const [key, kcal] of Object.entries(day.categories || {})) {
      totals[key] = (totals[key] || 0) + kcal;
    }
  }
  const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);
  if (grandTotal <= 0) { el.innerHTML = ''; return; }

  const catMetaByKey = {};
  for (const cat of CATALOG.categories) catMetaByKey[cat.key] = cat;

  const ranked = Object.entries(totals)
    .filter(([, kcal]) => kcal > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const rowsHtml = ranked.map(([key, kcal]) => {
    const meta = catMetaByKey[key];
    const pct = Math.round((kcal / grandTotal) * 100);
    return `
      <div class="category-row">
        <div class="category-top">
          <span class="category-name">${meta ? meta.emoji : '🍽️'} ${meta ? meta.name : key}</span>
          <span class="category-pct">${pct}%</span>
        </div>
        <div class="category-bar-track"><div class="category-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="section-title">Топ джерел калорій</div>
    <div class="category-breakdown">${rowsHtml}</div>`;
}

// Two quick discipline metrics: how many logged days stayed within target,
// and the single best day — the one whose total calories landed closest to
// the target (whether slightly under or over).
function renderAnalyticsDiscipline(loggedDays, target) {
  const el = document.getElementById('analyticsDiscipline');
  if (!loggedDays.length) { el.innerHTML = ''; return; }

  const daysInNorm = loggedDays.filter((d) => d.calories <= target).length;
  const normClass = daysInNorm / loggedDays.length >= 0.7 ? 'good' : '';

  const bestDay = loggedDays.reduce((best, d) =>
    Math.abs(d.calories - target) < Math.abs(best.calories - target) ? d : best
  );

  el.innerHTML = `
    <div class="discipline-grid">
      <div class="summary-card">
        <div class="summary-value mono ${normClass}">${daysInNorm} з ${loggedDays.length}</div>
        <div class="summary-label">Днів у нормі</div>
      </div>
      <div class="summary-card">
        <div class="summary-value mono">${fmtKcal(bestDay.calories)}</div>
        <div class="summary-label">Кращий день · ${formatShortDate(bestDay.date)}</div>
      </div>
    </div>`;
}

// Slides the segmented-control thumb under the active button. Reads real
// layout (offsetLeft/offsetWidth) rather than hardcoding 50%, so it stays
// correct if the button copy or container width ever changes.
function positionPeriodToggleThumb() {
  const toggle = document.getElementById('analyticsPeriodToggle');
  const thumb = document.getElementById('periodToggleThumb');
  const activeBtn = toggle?.querySelector('[data-period].active');
  if (!toggle || !thumb || !activeBtn) return;
  thumb.style.width = `${activeBtn.offsetWidth}px`;
  thumb.style.transform = `translateX(${activeBtn.offsetLeft - 4}px)`;
}

// Updates the "‹ 10 Серпня – 16 Серпня ›" label and enables/disables the
// nav arrows. "Next" is disabled once the anchor's period is already the
// real current one (no future periods to show). "Prev" is disabled once
// going back further would leave the HISTORY_LOOKBACK_DAYS window that
// preloadHistory() actually populated — beyond that, days would render as
// "empty" even if the user did log them, which would be misleading rather
// than genuinely showing "no data".
function renderPeriodNav(dates) {
  const label = document.getElementById('periodNavLabel');
  const prevBtn = document.getElementById('periodPrevBtn');
  const nextBtn = document.getElementById('periodNextBtn');
  if (!label || !prevBtn || !nextBtn) return;

  label.textContent = formatPeriodNavLabel(analyticsPeriod, dates);

  const currentPeriodStart = getPeriodStart(analyticsPeriod, TODAY);
  const anchorPeriodStart = getPeriodStart(analyticsPeriod, analyticsAnchorDate);
  nextBtn.disabled = anchorPeriodStart >= currentPeriodStart;

  const cutoff = addDaysISO(TODAY, -HISTORY_LOOKBACK_DAYS);
  const prevAnchor = shiftAnchor(analyticsPeriod, analyticsAnchorDate, -1);
  const prevPeriodStart = getPeriodStart(analyticsPeriod, prevAnchor);
  prevBtn.disabled = prevPeriodStart < cutoff;
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
  analyticsAnchorDate = TODAY; // always open on the current period
  document.querySelectorAll('#analyticsPeriodToggle [data-period]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.period === analyticsPeriod);
  });
  renderAnalytics();
  analyticsOverlay.classList.add('show');
}
function closeAnalytics() {
  analyticsOverlay.classList.remove('show');
  clearActiveNavBtn();
}

document.getElementById('analyticsBtn')?.addEventListener('click', () => {
  haptic('impact', 'light');
  setActiveNavBtn('analyticsBtn');
  openAnalytics();
});
document.getElementById('analyticsClose')?.addEventListener('click', () => {
  haptic('impact', 'light');
  closeAnalytics();
});
analyticsOverlay?.addEventListener('click', (e) => { if (e.target === analyticsOverlay) closeAnalytics(); });
window.addEventListener('resize', () => { if (analyticsOverlay?.classList.contains('show')) positionPeriodToggleThumb(); });

document.querySelectorAll('#analyticsPeriodToggle [data-period]').forEach((btn) => {
  btn.addEventListener('click', () => {
    haptic('impact', 'light');
    analyticsPeriod = btn.dataset.period;
    analyticsSelectedDate = null;
    analyticsAnchorDate = TODAY; // switching tabs jumps back to the current period
    document.querySelectorAll('#analyticsPeriodToggle [data-period]').forEach((b) => b.classList.toggle('active', b === btn));
    renderAnalytics();
  });
});

document.getElementById('periodPrevBtn')?.addEventListener('click', () => {
  haptic('impact', 'light');
  analyticsAnchorDate = shiftAnchor(analyticsPeriod, analyticsAnchorDate, -1);
  analyticsSelectedDate = null;
  renderAnalytics();
});
document.getElementById('periodNextBtn')?.addEventListener('click', () => {
  haptic('impact', 'light');
  analyticsAnchorDate = shiftAnchor(analyticsPeriod, analyticsAnchorDate, 1);
  analyticsSelectedDate = null;
  renderAnalytics();
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
function closeSheet() { overlay.classList.remove('show'); clearActiveNavBtn(); }

// Bottom-nav "active tab" glow (see .bottom-nav-btn.nav-active in
// index.html). These are modals, not routed views, so "active" just means
// "this button's own sheet/overlay is currently open" — set right before
// opening it, cleared from that sheet's own close function.
const NAV_BTN_IDS = ['calcBtn', 'weightBtn', 'aiFridgeBtn', 'analyticsBtn'];
function setActiveNavBtn(id) {
  NAV_BTN_IDS.forEach((navId) => {
    document.getElementById(navId)?.classList.toggle('nav-active', navId === id);
  });
}
function clearActiveNavBtn() {
  NAV_BTN_IDS.forEach((navId) => document.getElementById(navId)?.classList.remove('nav-active'));
}

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

// --- Калькулятор sheet: КБЖУ-on-100g × portion-weight, same math as the
// "Будь-чого" custom-item sheet below. Logs through the exact same two
// reserved keys (FREEBIE_CUSTOM_KCAL_KEY / FREEBIE_CUSTOM_MACROS_KEY) —
// every quick/custom entry in the app shares this one destination now that
// "Погане ЇДЛО" is gone, so a Калькулятор entry counts toward "Будь-чого"'s
// own progress bar as well as the top macro bars and Statistics, exactly
// like adding a custom item from that category's card would. ---

function openCalculatorSheet() {
  const freebieCat = STATE?.categories.find((c) => c.category_key === FREEBIE_CATEGORY_KEY);

  sheetEmoji.textContent = '🧮';
  sheetTitle.textContent = 'Калькулятор';
  sheetSub.textContent = 'КБЖУ на 100г × вага порції';

  const calcState = { per100: null, grams: null, protein100: null, fat100: null, carbs100: null };

  function computedTotalKcal() {
    if (!Number.isFinite(calcState.per100) || !Number.isFinite(calcState.grams)) return 0;
    return Math.max(0, (calcState.per100 * calcState.grams) / 100);
  }

  function computedMacros() {
    if (!Number.isFinite(calcState.grams) || calcState.grams <= 0) return { protein: 0, fat: 0, carbs: 0 };
    const g = calcState.grams;
    const p = Number.isFinite(calcState.protein100) ? calcState.protein100 : 0;
    const f = Number.isFinite(calcState.fat100) ? calcState.fat100 : 0;
    const c = Number.isFinite(calcState.carbs100) ? calcState.carbs100 : 0;
    return {
      protein: round1(Math.max(0, (p * g) / 100)),
      fat: round1(Math.max(0, (f * g) / 100)),
      carbs: round1(Math.max(0, (c * g) / 100)),
    };
  }

  function render() {
    const total = computedTotalKcal();
    const macros = computedMacros();
    const hasMacros = macros.protein || macros.fat || macros.carbs;
    const remaining = freebieCat ? Math.max(0, round1(freebieCat.target_calories - freebieCat.calories_consumed)) : null;

    sheetContent.innerHTML = `
      <div class="sheet-scroll">
        ${remaining !== null ? `<div class="remaining-hint">Залишок бюджету «Будь-чого»: <b>${fmtNum(remaining)} ккал</b></div>` : ''}

        <div class="calc-result">
          <div class="calc-result-value mono" id="calcResultValue">${fmtNum(round1(total))}</div>
          <div class="calc-result-label">ккал загалом</div>
          ${hasMacros ? `<div class="calc-result-macros" id="calcResultMacros">Б ${fmtNum(macros.protein)}г • Ж ${fmtNum(macros.fat)}г • В ${fmtNum(macros.carbs)}г</div>` : ''}
        </div>

        <div class="custom-input-wrap">
          <div class="custom-input-label">Калорійність на 100г (ккал)</div>
          <div class="custom-input-row">
            <input type="number" inputmode="decimal" id="calcPer100Input" placeholder="напр. 250" value="${calcState.per100 ?? ''}" />
            <div class="unit-label">ккал</div>
          </div>
        </div>

        <div class="custom-input-wrap">
          <div class="custom-input-label">Вага порції (г)</div>
          <div class="custom-input-row">
            <input type="number" inputmode="decimal" id="calcGramsInput" placeholder="напр. 150" value="${calcState.grams ?? ''}" />
            <div class="unit-label">г</div>
          </div>
        </div>

        <div class="custom-input-wrap">
          <div class="custom-input-label">КБЖУ на 100г (необов'язково)</div>
          <div class="calc-macro-grid">
            <div class="calc-macro-field">
              <input type="number" inputmode="decimal" id="calcProteinInput" placeholder="0" value="${calcState.protein100 ?? ''}" />
              <span class="calc-macro-label">Білки</span>
            </div>
            <div class="calc-macro-field">
              <input type="number" inputmode="decimal" id="calcFatInput" placeholder="0" value="${calcState.fat100 ?? ''}" />
              <span class="calc-macro-label">Жири</span>
            </div>
            <div class="calc-macro-field">
              <input type="number" inputmode="decimal" id="calcCarbsInput" placeholder="0" value="${calcState.carbs100 ?? ''}" />
              <span class="calc-macro-label">Вуглев.</span>
            </div>
          </div>
        </div>
      </div>
      <div class="sheet-footer">
        <button class="confirm-btn" id="calcSubmitBtn" ${total > 0 ? '' : 'disabled'}>Додати до «Будь-чого»</button>
      </div>
    `;

    bind();
  }

  function bind() {
    const per100Input = document.getElementById('calcPer100Input');
    per100Input?.addEventListener('input', () => {
      const val = parseFloat(per100Input.value);
      calcState.per100 = Number.isFinite(val) ? val : null;
      updateResult();
    });

    const gramsInput = document.getElementById('calcGramsInput');
    gramsInput?.addEventListener('input', () => {
      const val = parseFloat(gramsInput.value);
      calcState.grams = Number.isFinite(val) ? val : null;
      updateResult();
    });

    const proteinInput = document.getElementById('calcProteinInput');
    proteinInput?.addEventListener('input', () => {
      const val = parseFloat(proteinInput.value);
      calcState.protein100 = Number.isFinite(val) ? val : null;
      updateResult();
    });

    const fatInput = document.getElementById('calcFatInput');
    fatInput?.addEventListener('input', () => {
      const val = parseFloat(fatInput.value);
      calcState.fat100 = Number.isFinite(val) ? val : null;
      updateResult();
    });

    const carbsInput = document.getElementById('calcCarbsInput');
    carbsInput?.addEventListener('input', () => {
      const val = parseFloat(carbsInput.value);
      calcState.carbs100 = Number.isFinite(val) ? val : null;
      updateResult();
    });

    const submitBtn = document.getElementById('calcSubmitBtn');
    submitBtn?.addEventListener('click', () => {
      const total = round1(computedTotalKcal());
      if (total <= 0) return;
      haptic('impact', 'medium');

      const macros = computedMacros();

      // OPTIMISTIC: same pattern as every other log sheet — mutate
      // in-memory state and re-render instantly, then persist in the
      // background without the UI waiting on it. Logs into the SAME
      // reserved keys openFreebieCustomSheet uses (not a separate
      // Калькулятор-only counter), so both entry points feed one shared
      // "Будь-чого" custom total.
      const dayLog = dayLogCache.get(TODAY) || {};
      dayLog[FREEBIE_CUSTOM_KCAL_KEY] = Math.max(0, (Number(dayLog[FREEBIE_CUSTOM_KCAL_KEY]) || 0) + total);
      if (macros.protein || macros.fat || macros.carbs) {
        const prev = readMacrosObj(dayLog, FREEBIE_CUSTOM_MACROS_KEY);
        dayLog[FREEBIE_CUSTOM_MACROS_KEY] = {
          protein: round1(prev.protein + macros.protein),
          fat: round1(prev.fat + macros.fat),
          carbs: round1(prev.carbs + macros.carbs),
        };
      }
      setDayLogInMemory(TODAY, dayLog);
      recomputeAndRender();

      haptic('notification', 'success');
      closeSheet();

      persistAndSync();
    });
  }

  function updateResult() {
    const total = computedTotalKcal();
    const macros = computedMacros();
    const hasMacros = macros.protein || macros.fat || macros.carbs;

    const resultEl = document.getElementById('calcResultValue');
    if (resultEl) resultEl.textContent = fmtNum(round1(total));

    let macrosEl = document.getElementById('calcResultMacros');
    const macrosHtml = hasMacros ? `Б ${fmtNum(macros.protein)}г • Ж ${fmtNum(macros.fat)}г • В ${fmtNum(macros.carbs)}г` : '';
    if (macrosEl) {
      if (macrosHtml) macrosEl.textContent = macrosHtml;
      else macrosEl.remove();
    } else if (macrosHtml) {
      const div = document.createElement('div');
      div.className = 'calc-result-macros';
      div.id = 'calcResultMacros';
      div.textContent = macrosHtml;
      document.querySelector('.calc-result')?.appendChild(div);
    }

    const submitBtn = document.getElementById('calcSubmitBtn');
    if (submitBtn) submitBtn.disabled = !(total > 0);
  }

  render();
  openSheet();
}

document.getElementById('calcBtn')?.addEventListener('click', () => {
  haptic('impact', 'light');
  setActiveNavBtn('calcBtn');
  openCalculatorSheet();
});

// --- "Будь-чого" custom item sheet: a free-form product not in the
// catalog. Per-100g × portion-weight math (calories, plus optional
// protein/fat/carbs), scoped to the "Будь-чого" category's own budget
// (FREEBIE_CUSTOM_KCAL_KEY / FREEBIE_CUSTOM_MACROS_KEY) — every quick/custom
// entry in the app (this sheet, the Калькулятор above, AI Fridge recipes)
// logs through these same two keys, so it counts toward that category's
// progress bar as well as the top macro bars and Statistics — see
// computeDayStatus/computeDayMacros. ---

function openFreebieCustomSheet() {
  const freebieCat = STATE?.categories.find((c) => c.category_key === FREEBIE_CATEGORY_KEY);

  sheetEmoji.textContent = '🍫';
  sheetTitle.textContent = 'Будь-чого — власний продукт';
  sheetSub.textContent = 'КБЖУ на 100г × вага порції';

  const calcState = { per100: null, grams: null, protein100: null, fat100: null, carbs100: null };

  function computedTotalKcal() {
    if (!Number.isFinite(calcState.per100) || !Number.isFinite(calcState.grams)) return 0;
    return Math.max(0, (calcState.per100 * calcState.grams) / 100);
  }

  function computedMacros() {
    if (!Number.isFinite(calcState.grams) || calcState.grams <= 0) return { protein: 0, fat: 0, carbs: 0 };
    const g = calcState.grams;
    const p = Number.isFinite(calcState.protein100) ? calcState.protein100 : 0;
    const f = Number.isFinite(calcState.fat100) ? calcState.fat100 : 0;
    const c = Number.isFinite(calcState.carbs100) ? calcState.carbs100 : 0;
    return {
      protein: round1(Math.max(0, (p * g) / 100)),
      fat: round1(Math.max(0, (f * g) / 100)),
      carbs: round1(Math.max(0, (c * g) / 100)),
    };
  }

  function render() {
    const total = computedTotalKcal();
    const macros = computedMacros();
    const hasMacros = macros.protein || macros.fat || macros.carbs;
    const remaining = freebieCat ? Math.max(0, round1(freebieCat.target_calories - freebieCat.calories_consumed)) : null;

    sheetContent.innerHTML = `
      <div class="sheet-scroll">
        ${remaining !== null ? `<div class="remaining-hint">Залишок бюджету «Будь-чого»: <b>${fmtNum(remaining)} ккал</b></div>` : ''}

        <div class="calc-result">
          <div class="calc-result-value mono" id="freebieResultValue">${fmtNum(round1(total))}</div>
          <div class="calc-result-label">ккал загалом</div>
          ${hasMacros ? `<div class="calc-result-macros" id="freebieResultMacros">Б ${fmtNum(macros.protein)}г • Ж ${fmtNum(macros.fat)}г • В ${fmtNum(macros.carbs)}г</div>` : ''}
        </div>

        <div class="custom-input-wrap">
          <div class="custom-input-label">Калорійність на 100г (ккал)</div>
          <div class="custom-input-row">
            <input type="number" inputmode="decimal" id="freebiePer100Input" placeholder="напр. 250" value="${calcState.per100 ?? ''}" />
            <div class="unit-label">ккал</div>
          </div>
        </div>

        <div class="custom-input-wrap">
          <div class="custom-input-label">Вага порції (г)</div>
          <div class="custom-input-row">
            <input type="number" inputmode="decimal" id="freebieGramsInput" placeholder="напр. 150" value="${calcState.grams ?? ''}" />
            <div class="unit-label">г</div>
          </div>
        </div>

        <div class="custom-input-wrap">
          <div class="custom-input-label">КБЖУ на 100г (необов'язково)</div>
          <div class="calc-macro-grid">
            <div class="calc-macro-field">
              <input type="number" inputmode="decimal" id="freebieProteinInput" placeholder="0" value="${calcState.protein100 ?? ''}" />
              <span class="calc-macro-label">Білки</span>
            </div>
            <div class="calc-macro-field">
              <input type="number" inputmode="decimal" id="freebieFatInput" placeholder="0" value="${calcState.fat100 ?? ''}" />
              <span class="calc-macro-label">Жири</span>
            </div>
            <div class="calc-macro-field">
              <input type="number" inputmode="decimal" id="freebieCarbsInput" placeholder="0" value="${calcState.carbs100 ?? ''}" />
              <span class="calc-macro-label">Вуглев.</span>
            </div>
          </div>
        </div>
      </div>
      <div class="sheet-footer">
        <button class="confirm-btn" id="freebieSubmitBtn" ${total > 0 ? '' : 'disabled'}>Додати до «Будь-чого»</button>
      </div>
    `;

    bind();
  }

  function bind() {
    const per100Input = document.getElementById('freebiePer100Input');
    per100Input?.addEventListener('input', () => {
      const val = parseFloat(per100Input.value);
      calcState.per100 = Number.isFinite(val) ? val : null;
      updateResult();
    });

    const gramsInput = document.getElementById('freebieGramsInput');
    gramsInput?.addEventListener('input', () => {
      const val = parseFloat(gramsInput.value);
      calcState.grams = Number.isFinite(val) ? val : null;
      updateResult();
    });

    const proteinInput = document.getElementById('freebieProteinInput');
    proteinInput?.addEventListener('input', () => {
      const val = parseFloat(proteinInput.value);
      calcState.protein100 = Number.isFinite(val) ? val : null;
      updateResult();
    });

    const fatInput = document.getElementById('freebieFatInput');
    fatInput?.addEventListener('input', () => {
      const val = parseFloat(fatInput.value);
      calcState.fat100 = Number.isFinite(val) ? val : null;
      updateResult();
    });

    const carbsInput = document.getElementById('freebieCarbsInput');
    carbsInput?.addEventListener('input', () => {
      const val = parseFloat(carbsInput.value);
      calcState.carbs100 = Number.isFinite(val) ? val : null;
      updateResult();
    });

    const submitBtn = document.getElementById('freebieSubmitBtn');
    submitBtn?.addEventListener('click', () => {
      const total = round1(computedTotalKcal());
      if (total <= 0) return;
      haptic('impact', 'medium');

      const macros = computedMacros();

      // OPTIMISTIC: same pattern as every other log sheet — mutate
      // in-memory state and re-render instantly, then persist in the
      // background without the UI waiting on it.
      const dayLog = dayLogCache.get(TODAY) || {};
      dayLog[FREEBIE_CUSTOM_KCAL_KEY] = Math.max(0, (Number(dayLog[FREEBIE_CUSTOM_KCAL_KEY]) || 0) + total);
      if (macros.protein || macros.fat || macros.carbs) {
        const prev = readMacrosObj(dayLog, FREEBIE_CUSTOM_MACROS_KEY);
        dayLog[FREEBIE_CUSTOM_MACROS_KEY] = {
          protein: round1(prev.protein + macros.protein),
          fat: round1(prev.fat + macros.fat),
          carbs: round1(prev.carbs + macros.carbs),
        };
      }
      setDayLogInMemory(TODAY, dayLog);
      recomputeAndRender();

      haptic('notification', 'success');
      closeSheet();

      persistAndSync();
    });
  }

  function updateResult() {
    const total = computedTotalKcal();
    const macros = computedMacros();
    const hasMacros = macros.protein || macros.fat || macros.carbs;

    const resultEl = document.getElementById('freebieResultValue');
    if (resultEl) resultEl.textContent = fmtNum(round1(total));

    let macrosEl = document.getElementById('freebieResultMacros');
    const macrosHtml = hasMacros ? `Б ${fmtNum(macros.protein)}г • Ж ${fmtNum(macros.fat)}г • В ${fmtNum(macros.carbs)}г` : '';
    if (macrosEl) {
      if (macrosHtml) macrosEl.textContent = macrosHtml;
      else macrosEl.remove();
    } else if (macrosHtml) {
      const div = document.createElement('div');
      div.className = 'calc-result-macros';
      div.id = 'freebieResultMacros';
      div.textContent = macrosHtml;
      document.querySelector('.calc-result')?.appendChild(div);
    }

    const submitBtn = document.getElementById('freebieSubmitBtn');
    if (submitBtn) submitBtn.disabled = !(total > 0);
  }

  render();
  openSheet();
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AI Fridge: Gemini-generated recipe from whatever ingredients the user has
// ---------------------------------------------------------------------------
// Three-view modal (form -> loading -> result) built the same way the
// calculator sheet builds its content: raw innerHTML from a JS render
// function, rather than static markup in index.html, since the result view
// (variable-length ingredient list, variable-length steps) can't be
// pre-authored. aiFridgeState.view drives which render*() runs; the footer
// button also changes per view, so it's rendered separately from the
// scrollable content above it.

const aiFridgeOverlay = document.getElementById('aiFridgeOverlay');
const aiFridgeContent = document.getElementById('aiFridgeContent');
const aiFridgeFooter = document.getElementById('aiFridgeFooter');

const AI_FRIDGE_MEAL_TYPES = ['Сніданок', 'Обід', 'Перекус', 'Вечеря'];

let aiFridgeState = { view: 'form', recipe: null, lastIngredients: '', mealType: '', lastMaxCalories: '' };

function openAiFridgeSheet() {
  // Deliberately keeps lastIngredients/mealType at their current values
  // (not reset here) so reopening after a closed/failed attempt doesn't
  // lose what the user already typed — only a fresh page load or a
  // successfully logged recipe clears them.
  aiFridgeState.view = 'form';
  aiFridgeState.recipe = null;
  renderAiFridge();
  aiFridgeOverlay.classList.add('show');
}
function closeAiFridgeSheet() {
  aiFridgeOverlay.classList.remove('show');
  clearActiveNavBtn();
}

// Today's remaining calories/macros = today's (possibly custom-scaled, see
// scaleCatalog) goal minus what's already logged. STATE is recomputed by
// recomputeAndRender() after every log action, so this always reflects the
// live remainder at the moment the user opens/submits this form — not a
// stale snapshot from when the app first loaded.
function getRemainingTargets() {
  if (!STATE) return null;
  return {
    remainingCalories: Math.max(0, round1(STATE.goals.calories - STATE.totals.calories)),
    remainingProteins: Math.max(0, round1(STATE.goals.protein - STATE.totals.protein)),
    remainingFats: Math.max(0, round1(STATE.goals.fat - STATE.totals.fat)),
    remainingCarbs: Math.max(0, round1(STATE.goals.carbs - STATE.totals.carbs)),
  };
}

function renderAiFridge() {
  if (aiFridgeState.view === 'loading') renderAiFridgeLoading();
  else if (aiFridgeState.view === 'result') renderAiFridgeResult();
  else renderAiFridgeForm();
}

function renderAiFridgeForm() {
  const remaining = getRemainingTargets();
  const mealOptions = AI_FRIDGE_MEAL_TYPES
    .map((m) => `<option value="${escapeHtml(m)}" ${aiFridgeState.mealType === m ? 'selected' : ''}>${escapeHtml(m)}</option>`)
    .join('');

  aiFridgeContent.innerHTML = `
    <div class="custom-input-wrap">
      <div class="custom-input-label">Що є в холодильнику?</div>
      <textarea class="ai-fridge-textarea" id="aiFridgeIngredients" placeholder="напр. куряче філе, 2 яйця, помідор">${escapeHtml(aiFridgeState.lastIngredients)}</textarea>
    </div>
    <div class="custom-input-wrap">
      <div class="custom-input-label">Тип страви (необов'язково)</div>
      <select class="ai-fridge-select" id="aiFridgeMealType">
        <option value="" ${aiFridgeState.mealType ? '' : 'selected'}>Будь-який</option>
        ${mealOptions}
      </select>
    </div>
    <div class="custom-input-wrap">
      <div class="custom-input-label">Бажаний ліміт калорій (ккал)</div>
      <div class="custom-input-row">
        <input type="number" inputmode="numeric" min="1" step="1" id="aiFridgeMaxCalories"
          placeholder="наприклад: 350 (необов'язково)" value="${escapeHtml(aiFridgeState.lastMaxCalories)}" />
      </div>
    </div>
    ${remaining ? `
      <div class="remaining-hint">
        Залишок на сьогодні: <b>${fmtNum(remaining.remainingCalories)} ккал</b> ·
        Б ${fmtNum(remaining.remainingProteins)}г · Ж ${fmtNum(remaining.remainingFats)}г · В ${fmtNum(remaining.remainingCarbs)}г
      </div>
    ` : ''}
    <div class="ai-fridge-error" id="aiFridgeError"></div>
  `;

  aiFridgeFooter.innerHTML = `<button class="confirm-btn" id="aiFridgeSubmitBtn">✨ Згенерувати рецепт</button>`;
  document.getElementById('aiFridgeSubmitBtn')?.addEventListener('click', submitAiFridgeRequest);
}

function renderAiFridgeLoading() {
  aiFridgeContent.innerHTML = `
    <div class="ai-fridge-loading">
      <div class="ai-fridge-spinner"></div>
      <div class="ai-fridge-loading-text">Готуємо рецепт... 🍳</div>
    </div>
  `;
  aiFridgeFooter.innerHTML = '';
}

function renderAiFridgeResult() {
  const r = aiFridgeState.recipe;
  if (!r) { aiFridgeState.view = 'form'; renderAiFridgeForm(); return; }

  const ingredientsHtml = Array.isArray(r.ingredients_list) && r.ingredients_list.length
    ? `<div class="recipe-section-label">Інгредієнти</div><ul class="recipe-ingredients">${
        r.ingredients_list.map((ing) => `
          <li><span class="ing-name">${escapeHtml(ing?.name || '')}</span><span class="ing-amount">${escapeHtml(ing?.amount || '')}</span></li>
        `).join('')
      }</ul>`
    : '';

  const stepsHtml = Array.isArray(r.steps) && r.steps.length
    ? `<div class="recipe-section-label">Приготування</div><ol class="recipe-steps">${
        r.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')
      }</ol>`
    : '';

  aiFridgeContent.innerHTML = `
    <div class="recipe-title">${escapeHtml(r.title || '')}</div>
    ${r.description ? `<div class="recipe-description">${escapeHtml(r.description)}</div>` : ''}
    <div class="recipe-macros">
      <div class="recipe-macro-chip"><div class="val mono">${fmtNum(Number(r.total_calories) || 0)}</div><div class="lbl">ккал</div></div>
      <div class="recipe-macro-chip"><div class="val mono">${fmtNum(Number(r.proteins) || 0)}г</div><div class="lbl">Білки</div></div>
      <div class="recipe-macro-chip"><div class="val mono">${fmtNum(Number(r.fats) || 0)}г</div><div class="lbl">Жири</div></div>
      <div class="recipe-macro-chip"><div class="val mono">${fmtNum(Number(r.carbs) || 0)}г</div><div class="lbl">Вуглев.</div></div>
    </div>
    ${ingredientsHtml}
    ${stepsHtml}
    <div class="ai-fridge-error" id="aiFridgeError"></div>
  `;

  aiFridgeFooter.innerHTML = `<button class="log-meal-btn" id="aiFridgeLogBtn">📥 Зарахувати страву в раціон</button>`;
  document.getElementById('aiFridgeLogBtn')?.addEventListener('click', logAiFridgeRecipe);
}

async function submitAiFridgeRequest() {
  const ingredientsInput = document.getElementById('aiFridgeIngredients');
  const mealSelect = document.getElementById('aiFridgeMealType');
  const maxCaloriesInput = document.getElementById('aiFridgeMaxCalories');
  const errorEl = document.getElementById('aiFridgeError');

  const ingredients = (ingredientsInput?.value || '').trim();
  const mealType = mealSelect?.value || '';
  const maxCaloriesRaw = (maxCaloriesInput?.value || '').trim();

  // Remembered up front (before any validation return) so a failed
  // attempt still leaves the textarea/select/input exactly as the user
  // left them when the form re-renders.
  aiFridgeState.lastIngredients = ingredientsInput?.value || '';
  aiFridgeState.mealType = mealType;
  aiFridgeState.lastMaxCalories = maxCaloriesRaw;

  if (!ingredients) {
    if (errorEl) errorEl.textContent = 'Вкажіть, що є в холодильнику.';
    return;
  }
  if (!INIT_DATA) {
    if (errorEl) errorEl.textContent = 'Відкрийте це через Telegram-бота.';
    return;
  }

  // Optional — an empty field means "no cap" and is simply omitted from
  // the request (server treats missing/null the same way). Only validated
  // when the user actually typed something.
  let maxCalories;
  if (maxCaloriesRaw) {
    const parsed = Number(maxCaloriesRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      if (errorEl) errorEl.textContent = 'Ліміт калорій має бути додатним числом.';
      return;
    }
    maxCalories = parsed;
  }

  const remaining = getRemainingTargets();
  if (!remaining) {
    if (errorEl) errorEl.textContent = 'Дані ще завантажуються. Спробуйте за мить.';
    return;
  }

  haptic('impact', 'medium');
  aiFridgeState.view = 'loading';
  renderAiFridge();

  try {
    const res = await fetch('/api/ai-fridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': INIT_DATA },
      body: JSON.stringify({
        ingredients,
        mealType: mealType || undefined,
        maxCalories,
        ...remaining,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Не вдалося згенерувати рецепт. Спробуйте ще раз.');

    aiFridgeState.recipe = body;
    aiFridgeState.view = 'result';
    haptic('notification', 'success');
    renderAiFridge();
  } catch (err) {
    haptic('notification', 'error');
    aiFridgeState.view = 'form';
    renderAiFridge();
    const errEl = document.getElementById('aiFridgeError');
    if (errEl) errEl.textContent = err.message;
  }
}

// Adds the recipe straight into "Будь-чого"'s custom-entry keys
// (FREEBIE_CUSTOM_KCAL_KEY / FREEBIE_CUSTOM_MACROS_KEY) — the same two keys
// every other quick/custom entry in the app writes to (see
// openFreebieCustomSheet's submit handler above, which this mirrors):
// optimistic in-memory update + instant re-render, then persist/sync to the
// server in the background without the UI waiting on it. The recipe's own
// protein/fats/carbs (already shown in the result view) are logged here
// too, not just total_calories.
function logAiFridgeRecipe() {
  const r = aiFridgeState.recipe;
  if (!r) return;
  const kcal = Math.max(0, Number(r.total_calories) || 0);
  if (kcal <= 0) { closeAiFridgeSheet(); return; }

  haptic('impact', 'medium');

  const macros = {
    protein: Math.max(0, Number(r.proteins) || 0),
    fat: Math.max(0, Number(r.fats) || 0),
    carbs: Math.max(0, Number(r.carbs) || 0),
  };

  const dayLog = dayLogCache.get(TODAY) || {};
  dayLog[FREEBIE_CUSTOM_KCAL_KEY] = Math.max(0, (Number(dayLog[FREEBIE_CUSTOM_KCAL_KEY]) || 0) + kcal);
  if (macros.protein || macros.fat || macros.carbs) {
    const prev = readMacrosObj(dayLog, FREEBIE_CUSTOM_MACROS_KEY);
    dayLog[FREEBIE_CUSTOM_MACROS_KEY] = {
      protein: round1(prev.protein + macros.protein),
      fat: round1(prev.fat + macros.fat),
      carbs: round1(prev.carbs + macros.carbs),
    };
  }
  setDayLogInMemory(TODAY, dayLog);
  recomputeAndRender();

  haptic('notification', 'success');
  showToast(`Рецепт «${r.title || 'Страву'}» зараховано 📥`);

  aiFridgeState.recipe = null;
  aiFridgeState.lastIngredients = '';
  aiFridgeState.mealType = '';
  aiFridgeState.lastMaxCalories = '';
  closeAiFridgeSheet();

  persistAndSync();
}

document.getElementById('aiFridgeBtn')?.addEventListener('click', () => {
  haptic('impact', 'light');
  setActiveNavBtn('aiFridgeBtn');
  openAiFridgeSheet();
});
document.getElementById('aiFridgeClose')?.addEventListener('click', () => {
  haptic('impact', 'light');
  closeAiFridgeSheet();
});
aiFridgeOverlay?.addEventListener('click', (e) => { if (e.target === aiFridgeOverlay) closeAiFridgeSheet(); });

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
        body: JSON.stringify({ code, telegram_id: CLIENT_TELEGRAM_ID }),
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
    const res = await fetch(`/api/check-auth?telegram_id=${encodeURIComponent(CLIENT_TELEGRAM_ID)}`, {
      headers: { 'X-Telegram-Init-Data': INIT_DATA },
    });
    if (!res.ok) return;
    const body = await res.json();
    if (!body.authorized) {
      clearAuthorizedCached();
      showLockScreen();
      return;
    }
    // Picks up a daily_target changed on another device since this device
    // last opened the app — no-ops (see applyDailyTarget) if it matches
    // what's already applied here.
    applyDailyTarget(body.daily_target);
  } catch (err) {
    console.warn('[auth] background re-check failed (non-fatal):', err);
  }
}

async function boot() {
  wireUpInviteForm();

  if (isAuthorizedCached()) {
    // Fast path: this device has already proven authorized before — trust
    // it immediately (offline-first), and re-verify quietly in the background.
    hideLockScreen();
    await init();
    checkAuthInBackground();
    return;
  }

  // No local cache — this does NOT mean "not authorized". It could just be
  // a brand-new device (or cleared browser storage) for a Telegram account
  // that's already authorized on another device. Since Telegram's user ID
  // is the same everywhere, ask the server before assuming this person
  // needs to enter an invite code again — this is the one deliberate
  // exception to "never block the first render on network" (see
  // requirement 1 elsewhere): authorization genuinely can't be known
  // without asking, the first time on any given device.
  if (INIT_DATA) {
    try {
      const res = await fetch(`/api/check-auth?telegram_id=${encodeURIComponent(CLIENT_TELEGRAM_ID)}`, {
        headers: { 'X-Telegram-Init-Data': INIT_DATA },
      });
      if (res.ok) {
        const body = await res.json();
        if (body.authorized) {
          setAuthorizedCached();
          // Cache the server's daily_target now so init() (below) picks it
          // up as its starting value instead of the 2220 default —
          // BASE_CATALOG doesn't exist yet at this point, so a full
          // applyDailyTarget() rescale would be a no-op anyway.
          if (Number.isFinite(body.daily_target) && body.daily_target > 0) {
            saveCachedDailyTarget(Math.round(body.daily_target));
          }
          hideLockScreen();
          await init();
          return;
        }
      }
    } catch (err) {
      console.warn('[auth] initial check-auth failed, falling back to the lock screen:', err);
    }
  }

  showLockScreen();
}

boot();
