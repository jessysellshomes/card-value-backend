const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

// Node 18+ has fetch globally. If Render runs Node 18+ (it should), this is fine.
// If you ever see "fetch is not defined", tell me and I’ll give you a 1-line fix.

const app = express();

app.use(helmet());
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

// -------------------------
// Config (ENV VARS)
// -------------------------
const PORT = process.env.PORT || 10000;

// eBay keys must be set in Render → Environment
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

// Set marketplace to EBAY_US by default
const EBAY_MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";

// If you want sandbox later: set EBAY_API_ENV=sandbox
const EBAY_API_ENV = (process.env.EBAY_API_ENV || "production").toLowerCase();

const EBAY_OAUTH_BASE =
  EBAY_API_ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

const EBAY_BROWSE_BASE =
  EBAY_API_ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

// -------------------------
// Token cache
// -------------------------
let tokenCache = {
  accessToken: null,
  expiresAtMs: 0
};

function nowMs() {
  return Date.now();
}

function requireEbayKeys() {
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    const err = new Error(
      "Missing eBay credentials. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in Render environment variables."
    );
    err.code = "MISSING_EBAY_KEYS";
    throw err;
  }
}

function toBase64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

async function getEbayAccessToken() {
  requireEbayKeys();

  // If we have a valid token (with 60s buffer), reuse it
  if (tokenCache.accessToken && tokenCache.expiresAtMs - nowMs() > 60_000) {
    return tokenCache.accessToken;
  }

  const credentials = toBase64(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`);

  // Client Credentials flow (Application token)
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("scope", "https://api.ebay.com/oauth/api_scope");

  const resp = await fetch(`${EBAY_OAUTH_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`eBay token request failed (${resp.status}): ${text}`);
    err.code = "EBAY_TOKEN_FAILED";
    throw err;
  }

  const data = await resp.json();

  // Cache token
  const expiresInSec = Number(data.expires_in || 0);
  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAtMs = nowMs() + expiresInSec * 1000;

  return tokenCache.accessToken;
}

// -------------------------
// Helpers: query building
// -------------------------
function normalizeBuyingOptions(includeBuyingOptions) {
  // eBay Browse expects values like "FIXED_PRICE" and "AUCTION"
  if (!Array.isArray(includeBuyingOptions) || includeBuyingOptions.length === 0) return null;
  const allowed = new Set(["FIXED_PRICE", "AUCTION"]);
  const cleaned = includeBuyingOptions.filter((x) => allowed.has(String(x).toUpperCase()));
  return cleaned.length ? cleaned : null;
}

function bucketToQuerySuffix(bucket) {
  // Simple mapping: you can tune later
  const b = String(bucket || "").toUpperCase();

  if (b === "RAW") return ""; // raw = base query only
  if (b.startsWith("PSA_")) return ` PSA ${b.replace("PSA_", "")}`;
  if (b.startsWith("BGS_")) return ` BGS ${b.replace("BGS_", "").replace("_", ".")}`;
  if (b.startsWith("SGC_")) return ` SGC ${b.replace("SGC_", "")}`;
  if (b.startsWith("CGC_")) return ` CGC ${b.replace("CGC_", "")}`;

  // Fallback: pass through
  return ` ${bucket}`;
}

function buildBrowseSearchUrl({ q, limit, buyingOptions }) {
  // eBay Browse Search:
  // GET /buy/browse/v1/item_summary/search?q=...&limit=...
  // Optional filter for buyingOptions. Example:
  // filter=buyingOptions:{FIXED_PRICE|AUCTION}

  const url = new URL(`${EBAY_BROWSE_BASE}/buy/browse/v1/item_summary/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));

  if (buyingOptions && buyingOptions.length) {
    // eBay expects a filter format; this works for many accounts:
    // filter=buyingOptions:{FIXED_PRICE|AUCTION}
    url.searchParams.set("filter", `buyingOptions:{${buyingOptions.join("|")}}`);
  }

  return url.toString();
}

async function searchEbayBrowse({ query, limit, includeBuyingOptions }) {
  const accessToken = await getEbayAccessToken();
  const buyingOptions = normalizeBuyingOptions(includeBuyingOptions);

  const url = buildBrowseSearchUrl({
    q: query,
    limit,
    buyingOptions
  });

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-EBAY-C-MARKETPLACE-ID": EBAY_MARKETPLACE_ID
    }
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`eBay Browse search failed (${resp.status}): ${text}`);
    err.code = "EBAY_BROWSE_FAILED";
    throw err;
  }

  const data = await resp.json();
  const items = Array.isArray(data.itemSummaries) ? data.itemSummaries : [];

  // Normalize results
  const normalized = items
    .map((it) => {
      const priceValue = it?.price?.value != null ? Number(it.price.value) : null;
      const currency = it?.price?.currency || "USD";

      return {
        title: it?.title || null,
        itemWebUrl: it?.itemWebUrl || null,
        itemId: it?.itemId || null,
        legacyItemId: it?.legacyItemId || null,
        price: priceValue,
        currency,
        condition: it?.condition || null,
        conditionId: it?.conditionId || null
      };
    })
    .filter((x) => typeof x.price === "number" && Number.isFinite(x.price));

  return normalized;
}

function statsFromPrices(prices) {
  if (!prices.length) {
    return { count: 0, min: null, max: null, avg: null, median: null };
  }
  const sorted = [...prices].sort((a, b) => a - b);
  const count = sorted.length;
  const min = sorted[0];
  const max = sorted[count - 1];
  const avg = sorted.reduce((s, v) => s + v, 0) / count;

  const median =
    count % 2 === 1
      ? sorted[Math.floor(count / 2)]
      : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;

  return { count, min, max, avg, median };
}

// -------------------------
// Routes
// -------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "card-value-backend",
    env: EBAY_API_ENV,
    marketplace: EBAY_MARKETPLACE_ID
  });
});

// A plain URL you can put into GPT Builder as "Privacy Policy URL"
app.get("/privacy-policy", (req, res) => {
  res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Privacy Policy</title></head>
<body style="font-family: Arial, sans-serif; max-width: 900px; margin: 40px auto; line-height: 1.5;">
  <h1>Privacy Policy</h1>
  <p><strong>Master Card Grader</strong> uses this backend solely to fetch publicly available marketplace listing data for price comparison and analytics.</p>
  <h2>Data We Process</h2>
  <ul>
    <li>Request payloads (e.g., search terms and grading bucket inputs) sent by the GPT Action.</li>
    <li>Public listing data returned from eBay APIs (title, price, URL, condition).</li>
  </ul>
  <h2>What We Do Not Do</h2>
  <ul>
    <li>We do not store or sell personal data.</li>
    <li>We do not authenticate or track end users.</li>
    <li>We do not access private eBay account data.</li>
  </ul>
  <h2>Retention</h2>
  <p>This service does not intentionally persist request or response data. Basic operational logs may be captured by the hosting provider for debugging.</p>
  <h2>Contact</h2>
  <p>If you have questions, contact the service operator.</p>
</body>
</html>`);
});

// Convenience JSON endpoint if you ever need it
app.get("/privacy", (req, res) => {
  res.json({
    ok: true,
    summary:
      "This backend fetches publicly available listing data from eBay APIs for price comparison. It does not store personal data or access private account data."
  });
});

/**
 * POST /comps/ebay/multi
 * Body example:
 * {
 *   "query": "2020 prizm joe burrow rookie",
 *   "buckets": ["RAW","PSA_10","PSA_9"],
 *   "includeBuyingOptions": ["FIXED_PRICE","AUCTION"],
 *   "maxResultsPerBucket": 40
 * }
 */
app.post("/comps/ebay/multi", async (req, res) => {
  try {
    // Validate keys early with a clean error
    requireEbayKeys();

    const {
      query,
      buckets = ["RAW"],
      includeBuyingOptions = ["FIXED_PRICE", "AUCTION"],
      maxResultsPerBucket = 40
    } = req.body || {};

    if (!query || typeof query !== "string" || query.trim().length < 3) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_QUERY",
        message: "Body must include a 'query' string with at least 3 characters."
      });
    }

    if (!Array.isArray(buckets) || buckets.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_BUCKETS",
        message: "Body must include 'buckets' as a non-empty array."
      });
    }

    const limit = Math.max(1, Math.min(Number(maxResultsPerBucket) || 40, 200));

    const results = [];

    for (const bucket of buckets) {
      const suffix = bucketToQuerySuffix(bucket);
      const bucketQuery = `${query}${suffix}`.trim();

      const items = await searchEbayBrowse({
        query: bucketQuery,
        limit,
        includeBuyingOptions
      });

      const prices = items.map((x) => x.price);
      const stats = statsFromPrices(prices);

      results.push({
        bucket,
        queryUsed: bucketQuery,
        currency: items[0]?.currency || "USD",
        stats,
        sample: items.slice(0, 10) // keep response small; adjust later if you want
      });
    }

    return res.json({
      ok: true,
      source: "ebay_browse_active_listings",
      note:
        "These comps are from active listings (asks). For true sold comps, additional sources/permissions may be needed.",
      query,
      bucketsRequested: buckets,
      results
    });
  } catch (err) {
    const code = err.code || "SERVER_ERROR";
    return res.status(500).json({
      ok: false,
      error: code,
      message: err.message
    });
  }
});

// -------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
