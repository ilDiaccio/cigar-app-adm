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
  "https://www.adm.gov.it/portale/monopoli/tabacchi/prezzi/prezzi_pubblico"
];

const FALLBACK_PDF_URLS = [
  "https://www.adm.gov.it/portale/documents/20182/1106899/2-LIST-22-07-2026.pdf/bd227503-9779-bf56-c817-c19cfb853a64"
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
  
  // IMPORTANTE: Distinguere tra "sigari" e "sigarette"
  if (lower.includes("sigari") && !lower.includes("sigarette") && !lower.includes("sigaretti")) {
    score += 20; // Priorità massima per "sigari" puri
  }
  if (lower.includes("sigarette")) {
    score -= 10; // Penalizza le sigarette
  }
  if (lower.includes("sigaretti")) {
    score -= 10; // Penalizza i sigaretti
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
  if (lower.includes("list")) {
    score += 2;
  }
  
  return score;
}

function collectPdfCandidates(pageUrl, html) {
  const $ = cheerio.load(html);
  const candidates = [];

  $("a[href]").each((_, element) => {
    const href = ($(element).attr("href") || "").trim();
    const text = ($(element).text() || "").trim().toLowerCase();

    if (!href) {
      return;
    }
    if (!href.toLowerCase().includes(".pdf")) {
      return;
    }

    const absolute = toAbsoluteUrl(pageUrl, href);
    if (absolute) {
      candidates.push({
        url: absolute,
        text: text,
        isSigari: text.includes("sigari") && !text.includes("sigarette") && !text.includes("sigaretti")
      });
    }
  });

  return candidates
    .sort((a, b) => {
      // Priorità: prima i sigari, poi per score
      if (a.isSigari && !b.isSigari) return -1;
      if (!a.isSigari && b.isSigari) return 1;
      return scoreCandidate(b.url) - scoreCandidate(a.url);
    })
    .map(c => c.url);
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
      
      // Il primo candidato dovrebbe essere quello dei sigari (grazie al sort)
      if (candidates.length > 0) {
        return { sourcePage: pageUrl, pdfUrl: candidates[0] };
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

  const items = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Salta righe di intestazione
    if (/^codice\s*sigari/i.test(line)) {
      continue;
    }
    if (/^listino\b/i.test(line)) {
      continue;
    }
    
    // Se la riga contiene "da X pezzi/pezzo/sigari", prova ad estrarre i dati
    if (/da\s+\d+\s+(pezzi|pezzo|sigari)/i.test(line)) {
      const packMatch = line.match(/da\s+(\d+)\s+(pezzi|pezzo|sigari)/i);
      const priceMatches = line.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/g);
      
      if (!packMatch || !priceMatches || priceMatches.length < 2) {
        continue;
      }
      
      const priceStr = priceMatches[priceMatches.length - 1];
      const price = parseItalianNumber(priceStr);
      const pieces = parseInt(packMatch[1]);
      const unitPrice = pieces && price ? Number((price / pieces).toFixed(2)) : null;
      
      let code = "";
      let name = "";
      
      // PATTERN 1: Nome prima di "da X pezzi" sulla stessa riga
      const packStart = line.indexOf(packMatch[0]);
      if (packStart > 0) {
        const beforePack = line.substring(0, packStart).trim();
        
        // Controlla se c'è un codice all'inizio (3-5 cifre)
        const codeMatch = beforePack.match(/^(\d{3,5})/);
        if (codeMatch) {
          code = codeMatch[1];
          name = beforePack.substring(codeMatch[0].length).trim();
        } else {
          name = beforePack;
        }
      }
      
      // PATTERN 2: Codice sulla riga precedente (3-5 cifre)
      if (!code && i > 0) {
        const prevLine = lines[i - 1];
        if (/^\d{3,5}$/.test(prevLine)) {
          code = prevLine;
        }
      }
      
      // PATTERN 3: Codice+Nome sulla riga precedente (3-5 cifre)
      if (!code && !name && i > 0) {
        const prevLine = lines[i - 1];
        const codeMatch = prevLine.match(/^(\d{3,5})(.+)/);
        if (codeMatch) {
          code = codeMatch[1];
          name = codeMatch[2].trim();
        }
      }
      
      // PATTERN 4: Codice su riga -2, Nome su riga -1 (3-5 cifre)
      if (!code && !name && i > 1) {
        const prevLine1 = lines[i - 1];
        const prevLine2 = lines[i - 2];
        
        if (/^\d{3,5}$/.test(prevLine2) && /^[A-Z]/.test(prevLine1) && !/da\s+\d+/i.test(prevLine1)) {
          code = prevLine2;
          name = prevLine1.trim();
        }
      }
      
      // Se abbiamo trovato dati validi, aggiungi l'item
      if (code || name) {
        items.push({
          code: code,
          name: cleanName(name),
          pack: `da ${packMatch[1]} ${packMatch[2]}`,
          pieces: pieces,
          price: price,
          unitPrice: unitPrice,
          priceLabel: formatPrice(price),
          unitPriceLabel: formatPrice(unitPrice),
          searchText: normalizeText(`${code} ${name} da ${packMatch[1]} ${packMatch[2]}`)
        });
      }
    }
  }
  
  // Rimuovi duplicati per codice
  const unique = new Map();
  for (const item of items) {
    // Usa il codice come chiave, o un ID unico se manca il codice
    const key = item.code || `no-code-${items.indexOf(item)}`;
    if (!unique.has(key)) {
      unique.set(key, item);
    }
  }
  
  // Filtra solo items con almeno un codice o un nome valido
  const validItems = [...unique.values()].filter(item => {
    return (item.code && item.code.length > 0) || (item.name && item.name.trim().length > 0);
  });
  
  return validItems.sort((a, b) => a.name.localeCompare(b.name, "it"));
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
    // Disabilita il caching per le API
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    
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
    // Disabilita il caching per le API
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    
    const catalog = await refreshCatalog();
    res.json({ ok: true, meta: catalog.meta, count: catalog.items.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    // Disabilita il caching per le API
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    
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
