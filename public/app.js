const resultsEl = document.getElementById("results");
const emptyStateEl = document.getElementById("emptyState");
const resultSummaryEl = document.getElementById("resultSummary");
const statusTextEl = document.getElementById("statusText");
const statusSubtextEl = document.getElementById("statusSubtext");
const updatedAtEl = document.getElementById("updatedAt");
const itemCountEl = document.getElementById("itemCount");
const sourceLinkEl = document.getElementById("sourceLink");
const pdfLinkEl = document.getElementById("pdfLink");
const searchInputEl = document.getElementById("searchInput");
const sortSelectEl = document.getElementById("sortSelect");
const refreshBtnEl = document.getElementById("refreshBtn");
const favoritesFilterBtn = document.getElementById("favoritesFilterBtn");

let debounceTimer;
let showOnlyFavorites = false;
let favorites = new Set(JSON.parse(localStorage.getItem("cigarFavorites") || "[]"));

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Richiesta non riuscita.");
  }

  return data;
}

function escapeHtml(value = "") {
  return value
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function highlight(value, query) {
  const safe = escapeHtml(value);
  if (!query) {
    return safe;
  }

  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(`(${escapedQuery})`, "ig"), "<mark>$1</mark>");
}

function setLoading(message) {
  statusTextEl.textContent = message;
  statusSubtextEl.textContent = "Operazione in corso";
}

function renderMeta(meta) {
  const hasMeta = Boolean(meta);

  statusTextEl.textContent = hasMeta ? "Listino disponibile" : "Nessun listino";
  statusSubtextEl.textContent = hasMeta
    ? `Scaricato il ${new Date(meta.downloadedAt).toLocaleString("it-IT")}`
    : "Premi Aggiorna da ADM per iniziare";

  updatedAtEl.textContent = hasMeta ? meta.updatedAt || "Non rilevata" : "-";
  itemCountEl.textContent = hasMeta ? String(meta.itemCount) : "-";

  if (hasMeta && meta.sourceUrl) {
    sourceLinkEl.href = meta.sourceUrl;
    sourceLinkEl.textContent = "PDF ADM";
    pdfLinkEl.classList.remove("hidden");
  } else {
    sourceLinkEl.href = "#";
    sourceLinkEl.textContent = "ADM";
    pdfLinkEl.classList.add("hidden");
  }
}

function toggleFavorite(code) {
  if (favorites.has(code)) {
    favorites.delete(code);
  } else {
    favorites.add(code);
  }
  localStorage.setItem("cigarFavorites", JSON.stringify([...favorites]));
  search();
}

function renderResults(items, query) {
  resultsEl.innerHTML = "";

  const filtered = showOnlyFavorites 
    ? items.filter(item => favorites.has(item.code))
    : items;

  if (!filtered.length) {
    emptyStateEl.classList.remove("hidden");
    resultSummaryEl.textContent = showOnlyFavorites ? "Nessun preferito salvato." : "Nessun risultato trovato.";
    return;
  }

  emptyStateEl.classList.add("hidden");

  for (const item of filtered) {
    const isFav = favorites.has(item.code);
    const article = document.createElement("article");
    article.className = "card result-card";
    article.innerHTML = `
      <div class="result-top">
        <div class="result-actions">
          <span class="result-code">Cod. ${escapeHtml(item.code)}</span>
          <button class="fav-toggle ${isFav ? 'active' : ''}" onclick="toggleFavorite('${escapeHtml(item.code)}')">
            <svg viewBox="0 0 24 24">
              <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"/>
            </svg>
          </button>
        </div>
        ${item.unitPriceLabel ? `<span class="badge">${escapeHtml(item.unitPriceLabel)} / sigaro</span>` : ""}
      </div>

      <h2 class="result-title">${highlight(item.name, query)}</h2>

      <div class="kpis">
        <div class="kpi">
          <span>Confezione</span>
          <strong>${item.pieces ?? highlight(item.pack || "-", query)}</strong>
        </div>
        <div class="kpi">
          <span>Prezzo</span>
          <strong>${escapeHtml(item.priceLabel || "-")}</strong>
        </div>
      </div>
    `;
    resultsEl.appendChild(article);
  }
  resultSummaryEl.textContent = `${filtered.length} risultati trovati`;
}

async function search() {
  const query = searchInputEl.value.trim();
  const sort = sortSelectEl.value;

  try {
    resultSummaryEl.textContent = "Ricerca in corso...";
    const data = await api(`/api/search?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}`);

    renderMeta(data.meta);
    renderResults(data.items, query);
  } catch (error) {
    resultSummaryEl.textContent = error.message;
    emptyStateEl.classList.remove("hidden");
    resultsEl.innerHTML = "";
  }
}

async function refreshCatalog() {
  try {
    refreshBtnEl.disabled = true;
    setLoading("Aggiornamento del listino...");
    await api("/api/refresh", { method: "POST" });
    await search();
  } catch (error) {
    statusTextEl.textContent = "Errore";
    statusSubtextEl.textContent = error.message;
  } finally {
    refreshBtnEl.disabled = false;
  }
}

async function init() {
  console.log("App initialization started");
  console.log("Sort options available:", [...sortSelectEl.options].map(o => o.text));
  try {
    setLoading("Verifica del listino...");
    const status = await api("/api/status");
    renderMeta(status.meta);

    if (!status.available) {
      await refreshCatalog();
      return;
    }

    await search();
  } catch (error) {
    statusTextEl.textContent = "Errore iniziale";
    statusSubtextEl.textContent = error.message;
  }
}

searchInputEl.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(search, 220);
});

sortSelectEl.addEventListener("change", search);
refreshBtnEl.addEventListener("click", refreshCatalog);

favoritesFilterBtn.addEventListener("click", () => {
  showOnlyFavorites = !showOnlyFavorites;
  favoritesFilterBtn.classList.toggle("active", showOnlyFavorites);
  search();
});

// Espone la funzione globalmente per l'attributo onclick
window.toggleFavorite = toggleFavorite;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('ServiceWorker registrato con successo.', reg.scope))
      .catch(err => console.log('Errore ServiceWorker:', err));
  });
}

init();
