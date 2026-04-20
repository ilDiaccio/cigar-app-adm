const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const PDF_FILE = path.join(DATA_DIR, "adm-sigari-latest.pdf");
const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");

const SOURCE_PAGES = [
  "https://www.adm.gov.it/portale/en/monopoli/tabacchi/prezzi/listino/logista-s.p.a",
  "https://www.adm.gov.it/portale/en/monopoli/tabacchi/prezzi/listino/manifatture-sigaro-toscano-spa"
];

const FALLBACK_PDF_URLS = [
  "https://www.adm.gov.it/portale/documents/20182/11067932/CDI+SIGARI.pdf/749d9d8f-8da7-264d-1c65-9f7ae20464a0"
];

let refreshPromise = null;

app.use(express.json());
app.use((req, res, next) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});
app.use(express.static(PUBLIC_DIR));

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readCatalog() {
  try {
    if (!fs.existsSync(CATALOG_FILE)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeCatalog(payload) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function normalizeText(value = "") {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanName(value = "") {
  return value.replace(/\s+/g, " ").replace(/\s+-\s+/g, " - ").trim();
}

function parseItalianNumber(value = "") {
  const normalized = String(value).replace(/\./g, "").replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractPieces(pack = "") {
  const match = pack.match(/(\d{1,3})\s*(?:pezzi|sigari)/i);
  return match ? Number(match[1]) : null;
}

function formatPrice(value) {
  if (value == null) {
    return null;
  }
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR"
  }).format(value);
}

function extractUpdatedAt(text = "") {
  const match = text.match(/aggiornato al\s+(\d{2}\/\d{2}\/\d{4})/i);
  return match ? match[1] : null;
}

function toItalianDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleDateString("it-IT");
}

function toAbsoluteUrl(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

function scoreCandidate(url = "") {
  const lower = url.toLowerCase();
  let score = 0;
  if (lower.includes("sigari")) {
    score += 10;
  }
  if (lower.includes("/documents/")) {
    score += 5;
  }
  if (lower.endsWith(".pdf")) {
    score += 3;
  }
  if (lower.includes("cdi")) {
    score += 1;
  }
  return score;
}

function collectPdfCandidates(pageUrl, html) {
  const $ = cheerio.load(html);
  const candidates = new Set();

  $("a[href]").each((_, element) => {
    const href = ($(element).attr("href") || "").trim();
    const text = ($(element).text() || "").trim().toLowerCase();

    if (!href) {
      return;
    }
    if (!href.toLowerCase().includes(".pdf") && !text.includes("sigari")) {
      return;
    }

    const absolute = toAbsoluteUrl(pageUrl, href);
    if (absolute) {
      candidates.add(absolute);
    }
  });

  const rawMatches = html.match(/(?:https?:\/\/|\/)[^"'<> ]+?\.pdf(?:\?[^"'<> ]*)?/gi) || [];
  for (const match of rawMatches) {
    const absolute = toAbsoluteUrl(pageUrl, match);
    if (absolute) {
      candidates.add(absolute);
    }
  }

  return [...candidates]
    .filter((url) => url.toLowerCase().includes(".pdf"))
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

async function discoverLatestPdfUrl() {
  const headers = {
    "User-Agent": "Mozilla/5.0 CigarApp/1.0",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  };

  for (const pageUrl of SOURCE_PAGES) {
    try {
      const response = await axios.get(pageUrl, { headers, timeout: 15000 });
      const candidates = collectPdfCandidates(pageUrl, response.data);
      const preferred = candidates.find((url) => url.toLowerCase().includes("sigari"));
      if (preferred) {
        return { sourcePage: pageUrl, pdfUrl: preferred };
      }
    } catch {
      continue;
    }
  }

  if (FALLBACK_PDF_URLS[0]) {
    return {
      sourcePage: SOURCE_PAGES[0],
      pdfUrl: FALLBACK_PDF_URLS[0]
    };
  }

  throw new Error("Impossibile trovare il PDF ADM dei sigari.");
}

function parseRowsFromPdfText(text) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/\r/g, " ").replace(/[•·]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const itemLines = [];
  let buffer = "";

  for (const line of lines) {
    if (/^codice\s*sigari/i.test(line)) {
      continue;
    }
    if (/^listino\b/i.test(line)) {
      continue;
    }
    if (!/[a-z]/i.test(line)) {
      continue;
    }

    buffer = buffer ? `${buffer} ${line}` : line;

    if (/\d{1,4},\d{2}\s*$/.test(buffer)) {
      itemLines.push(buffer);
      buffer = "";
    }
  }

  const found = [];

  for (const rawLine of itemLines) {
    const normalizedLine = rawLine
      .replace(/([A-Za-z])da\s+(\d{1,3}\s+(?:pezzi|sigari))/g, "$1 da $2")
      .replace(/\s+/g, " ")
      .trim();

    const match = normalizedLine.match(
      /^(\d{3,5})(.+?)((?:da\s+)?\d{1,3}\s+(?:pezzi|sigari))\s*(\d{1,4},\d{2})$/i
    );

    if (!match) {
      continue;
    }

    const code = match[1].trim();
    const name = cleanName(match[2]);
    const pack = cleanName(match[3]);
    const price = parseItalianNumber(match[4]);
    const pieces = extractPieces(pack);
    const unitPrice = pieces && price ? Number((price / pieces).toFixed(2)) : null;

    found.push({
      code,
      name,
      pack,
      pieces,
      price,
      unitPrice,
      priceLabel: formatPrice(price),
      unitPriceLabel: formatPrice(unitPrice),
      searchText: normalizeText(`${code} ${name} ${pack}`)
    });
  }

  const unique = new Map();
  for (const item of found) {
    if (!unique.has(item.code)) {
      unique.set(item.code, item);
    }
  }

  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "it"));
}

async function refreshCatalog() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    ensureDir(DATA_DIR);

    const { sourcePage, pdfUrl } = await discoverLatestPdfUrl();

    const pdfResponse = await axios.get(pdfUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0 CigarApp/1.0",
        Accept: "application/pdf,*/*"
      }
    });

    fs.writeFileSync(PDF_FILE, Buffer.from(pdfResponse.data));

    const pdfData = await pdfParse(Buffer.from(pdfResponse.data));
    if (!/codice\s*sigari/i.test(pdfData.text)) {
      throw new Error("Il documento ADM trovato non sembra essere un listino sigari.");
    }
    const updatedAt = extractUpdatedAt(pdfData.text) || toItalianDate(pdfResponse.headers["last-modified"]);
    const items = parseRowsFromPdfText(pdfData.text);

    if (!items.length) {
      throw new Error("Il PDF è stato scaricato, ma non sono riuscito a estrarre i sigari.");
    }

    const payload = {
      meta: {
        sourcePage,
        sourceUrl: pdfUrl,
        updatedAt,
        downloadedAt: new Date().toISOString(),
        itemCount: items.length
      },
      items
    };

    writeCatalog(payload);
    return payload;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function sortItems(items, sort, query) {
  const list = [...items];

  const secondarySort = (a, b) => a.name.localeCompare(b.name, "it");

  console.log(`Sorting items with method: "${sort}" for ${list.length} items`);

  if (sort === "price-asc") {
    return list.sort((a, b) => {
      const diff = (Number(a.price) || 0) - (Number(b.price) || 0);
      return diff !== 0 ? diff : secondarySort(a, b);
    });
  }
  if (sort === "price-desc") {
    return list.sort((a, b) => {
      const diff = (Number(b.price) || 0) - (Number(a.price) || 0);
      return diff !== 0 ? diff : secondarySort(a, b);
    });
  }
  if (sort === "code") {
    return list.sort((a, b) => a.code.localeCompare(b.code, "it") || secondarySort(a, b));
  }
  if (sort === "pieces-desc") {
    return list.sort((a, b) => {
      const diff = (Number(b.pieces) || 0) - (Number(a.pieces) || 0);
      return diff !== 0 ? diff : secondarySort(a, b);
    });
  }
  if (sort === "unitPrice-asc") {
    return list.sort((a, b) => {
      const diff = (Number(a.unitPrice) || Infinity) - (Number(b.unitPrice) || Infinity);
      return diff !== 0 ? diff : secondarySort(a, b);
    });
  }
  if (sort === "unitPrice-desc") {
    return list.sort((a, b) => {
      const diff = (Number(b.unitPrice) || 0) - (Number(a.unitPrice) || 0);
      return diff !== 0 ? diff : secondarySort(a, b);
    });
  }

  if (query) {
    return list.sort((a, b) => {
      const aStarts = a.searchText.startsWith(query) ? 1 : 0;
      const bStarts = b.searchText.startsWith(query) ? 1 : 0;
      if (aStarts !== bStarts) {
        return bStarts - aStarts;
      }
      return secondarySort(a, b);
    });
  }

  return list.sort(secondarySort);
}

app.get("/api/status", async (_req, res) => {
  try {
    let catalog = readCatalog();

    if (!catalog) {
      try {
        catalog = await refreshCatalog();
      } catch {
        return res.json({ available: false, meta: null });
      }
    }

    res.json({ available: true, meta: catalog.meta });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/refresh", async (_req, res) => {
  try {
    const catalog = await refreshCatalog();
    res.json({ ok: true, meta: catalog.meta, count: catalog.items.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    let catalog = readCatalog();
    if (!catalog) {
      catalog = await refreshCatalog();
    }

    const q = normalizeText(req.query.q || "");
    const sort = String(req.query.sort || "relevance");
    console.log(`Ricerca: q="${q}", sort="${sort}"`);
    const filtered = q
      ? catalog.items.filter((item) => item.searchText.includes(q))
      : catalog.items;

    const sorted = sortItems(filtered, sort, q);

    res.json({
      meta: catalog.meta,
      total: sorted.length,
      items: sorted
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/downloads/latest.pdf", (_req, res) => {
  if (!fs.existsSync(PDF_FILE)) {
    return res.status(404).json({ error: "PDF non ancora disponibile." });
  }

  res.sendFile(PDF_FILE);
});

app.listen(PORT, () => {
  ensureDir(DATA_DIR);
  console.log(`Cigar App avviata su http://localhost:${PORT}`);
});
