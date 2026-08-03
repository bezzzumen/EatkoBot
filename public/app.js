const tg = window.Telegram?.WebApp;
if (tg) tg.expand();

let currentData = null;
let activeProduct = null;

async function loadData() {
  const userId = tg?.initDataUnsafe?.user?.id || 'default_user';
  const res = await fetch(`/api/today?user_id=${userId}`);
  currentData = await res.json();
  render();
}

function render() {
  if (!currentData) return;

  // Оновлення кільця калорій
  const consumedEl = document.getElementById('consumedKcal');
  const targetEl = document.getElementById('targetKcal');
  const ring = document.getElementById('progressRing');

  consumedEl.innerText = currentData.totalConsumedCalories;
  targetEl.innerText = `/ ${currentData.totalTargetCalories} kcal`;

  const circumference = 2 * Math.PI * 65; // ~408
  const pct = Math.min(1.5, currentData.totalConsumedCalories / currentData.totalTargetCalories);
  const offset = circumference - (pct * circumference);
  ring.style.strokeDashoffset = Math.max(0, offset);

  if (currentData.totalConsumedCalories > currentData.totalTargetCalories) {
    ring.style.stroke = '#ef4444';
  } else {
    ring.style.stroke = '#10b981';
  }

  // Оновлення категорій
  const container = document.getElementById('categoriesList');
  container.innerHTML = '';

  currentData.categories.forEach(cat => {
    const card = document.createElement('div');
    card.className = `category-card ${cat.isCompleted ? 'completed' : ''}`;

    let badgeClass = 'badge-active';
    let badgeText = `${cat.usagePercentage}%`;
    if (cat.isOverconsumed) {
      badgeClass = 'badge-over';
      badgeText = `⚠️ ${cat.usagePercentage}%`;
    } else if (cat.isCompleted) {
      badgeClass = 'badge-complete';
      badgeText = '✅ Виконано';
    }

    card.innerHTML = `
      <div class="category-header" onclick="toggleCategory(${cat.id})">
        <div class="category-title">
          <span>${cat.emoji}</span>
          <span>${cat.name}</span>
        </div>
        <div class="badge ${badgeClass}">${badgeText}</div>
      </div>
      <div class="product-list" id="cat-list-${cat.id}">
        ${cat.products.map(p => `
          <div class="product-item">
            <div class="product-info">
              <div class="name">${p.name}</div>
              <div class="sub">Спожито: ${p.loggedGrams} / ${p.maxGrams}${p.unit}</div>
            </div>
            <button class="add-btn" onclick="openModal(${p.id})">+ Внести</button>
          </div>
        `).join('')}
      </div>
    `;
    container.appendChild(card);
  });
}

function toggleCategory(catId) {
  const list = document.getElementById(`cat-list-${catId}`);
  const card = list.parentElement;
  card.classList.toggle('open');
  tg?.HapticFeedback?.impactOccurred('light');
}

function openModal(productId) {
  let found = null;
  currentData.categories.forEach(c => {
    const p = c.products.find(item => item.id === productId);
    if (p) found = p;
  });

  if (!found) return;
  activeProduct = found;

  document.getElementById('modalTitle').innerText = found.name;
  document.getElementById('modalSub').innerText = `Добова норма: ${found.maxGrams}${found.unit} (Вже спожито: ${found.loggedGrams}${found.unit})`;
  document.getElementById('gramsInput').value = '';
  document.getElementById('modal').style.display = 'flex';

  tg?.HapticFeedback?.impactOccurred('medium');
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
  activeProduct = null;
}

function addQuick(val) {
  const input = document.getElementById('gramsInput');
  const current = Number(input.value) || 0;
  input.value = current + val;
  tg?.HapticFeedback?.impactOccurred('light');
}

function fillRemaining() {
  if (!activeProduct) return;
  const rem = Math.max(0, activeProduct.maxGrams - activeProduct.loggedGrams);
  document.getElementById('gramsInput').value = rem;
  tg?.HapticFeedback?.impactOccurred('light');
}

async function submitGrams() {
  if (!activeProduct) return;
  const inputVal = Number(document.getElementById('gramsInput').value);
  if (!inputVal || inputVal <= 0) return closeModal();

  const userId = tg?.initDataUnsafe?.user?.id || 'default_user';
  const res = await fetch('/api/log-grams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, productId: activeProduct.id, grams: inputVal })
  });

  currentData = await res.json();
  tg?.HapticFeedback?.notificationOccurred('success');
  closeModal();
  render();
}

// Закриття модалки при кліку на фон
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

loadData();
