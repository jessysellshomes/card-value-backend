import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- ENV ----------
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

// Optional hardening: set a shared secret so only your GPT can call this
// If you set this in Render + in your GPT Action header, requests without it will be rejected.
const API_KEY = process.env.API_KEY || null;

// ---------- SIMPLE AUTH MIDDLEWARE (optional but recommended) ----------
app.use((req, res, next) => {
  if (!API_KEY) return next(); // not enabled
  const provided = req.header("x-api-key");
  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ error: "unauthorized", message: "Missing/invalid x-api-key" });
  }
  next();
});

// ---------- HEALTH + HOME ----------
app.get("/", (req, res) => res.send("Card Value Backend is running."));
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- OAUTH TOKEN CACHE ----------
let tokenCache = { accessToken: null, expiresAtMs: 0 };

async function getEbayAppToken() {
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET env vars.");
  }

  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAtMs - now > 60_000) {
    return tokenCache.accessToken;
  }

  const basicAuth = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");
  body.append("scope", "https://api.ebay.com/oauth/api_scope");

  const resp = await axios.post(
    "https://api.ebay.com/identity/v1/oauth2/token",
    body.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      timeout: 15000,
    }
  );

  const { access_token, expires_in } = resp.data;
  tokenCache.accessToken = access_token;
  tokenCache.expiresAtMs = Date.now() + (Number(expires_in) * 1000);
  return access_token;
}

// ---------- HELPERS: VALIDATION ----------
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// ---------- BUCKETS ----------
const DEFAULT_BUCKETS_SPORTS = ["RAW", "PSA_10", "PSA_9", "BGS_9_5", "SGC_10"];
const DEFAULT_BUCKETS_POKEMON = ["RAW", "PSA_10", "PSA_9", "BGS_9_5", "SGC_10", "CGC_10"];

function normalizeBucket(b) {
  return String(b || "").toUpperCase();
}

// ---------- QUERY BUILDING ----------
function buildBaseKeywords(identity) {
  const parts = [];

  // Sports + Pokemon common fields
  if (isNonEmptyString(identity.year)) parts.push(identity.year);
  if (isNonEmptyString(identity.set)) parts.push(identity.set);
  if (isNonEmptyString(identity.subject)) parts.push(identity.subject);

  // Strong matchers
  if (isNonEmptyString(identity.cardNumber)) parts.push(identity.cardNumber);
  if (isNonEmptyString(identity.variant)) parts.push(identity.variant);

  if (isNonEmptyString(identity.serialNumbered)) parts.push(identity.serialNumbered);
  if (Array.isArray(identity.extraKeywords)) {
    for (const k of identity.extraKeywords) {
      if (isNonEmptyString(k)) parts.push(k);
    }
  }

  // Pokemon-specific hints
  if (isNonEmptyString(identity.language)) parts.push(identity.language);

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function bucketKeywords(bucket) {
  // RAW = add raw, exclude graders via negatives later
  if (bucket === "RAW") return ["raw"];

  // PSA_10 -> ["PSA", "10"]
  if (bucket.startsWith("PSA_")) return ["PSA", bucket.replace("PSA_", "").replace("_", ".")];
  if (bucket.startsWith("BGS_")) return ["BGS", bucket.replace("BGS_", "").replace("_", ".")];
  if (bucket.startsWith("SGC_")) return ["SGC", bucket.replace("SGC_", "").replace("_", ".")];
  if (bucket.startsWith("CGC_")) return ["CGC", bucket.replace("CGC_", "").replace("_", ".")];

  return [];
}

function buildNegatives(identity, bucket, queryTightness = "NORMAL") {
  const negatives = new Set();

  // Global junk reducers
  ["lot", "reprint", "proxy", "custom", "digital", "case", "break"].forEach(x => negatives.add(x));

  // Raw bucket: aggressively exclude graders
  if (bucket === "RAW") {
    ["PSA", "BGS", "SGC", "CGC", "graded", "slab"].forEach(x => negatives.add(x));
  }

  // If not auto/patch, exclude them
  if (identity.isAuto === false) ["auto", "autograph"].forEach(x => negatives.add(x));
  if (identity.isPatch === false) ["patch", "relic", "jersey"].forEach(x => negatives.add(x));

  // Tightness: if STRICT, also exclude "or best offer" noise? (skip; too aggressive)
  // Instead, add a few more Pokemon junk terms when strict/normal
  const domain = String(identity.domain || "").toLowerCase();
  if (domain === "pokemon") {
    ["online code", "energy"].forEach(x => {
      if (queryTightness !== "LOOSE") negatives.add(x);
    });
  }

  return Array.from(negatives);
}

function buildQuery(identity, bucket, queryTightness = "NORMAL") {
  const base = buildBaseKeywords(identity);
  const bkw = bucketKeywords(bucket).join(" ");

  // In STRICT mode, we prefer stronger matching by requiring cardNumber if provided.
  // (We do not "require" at API level; we just include it when present.)
  // In LOOSE mode, we omit cardNumber/variant if comps are too thin; we implement that fallback later.

  return `${base} ${bkw}`.replace(/\s+/g, " ").trim();
}

// ---------- EBAY BROWSE SEARCH ----------
async function ebaySearch({ token, keywords, negatives, includeBuyingOptions, limit = 50 }) {
  // Compose q: "keywords -neg1 -neg2 ..."
  const q = `${keywords} ${negatives.map(n => `-${n}`).join(" ")}`.trim();

  const params = new URLSearchParams();
  params.set("q", q);
  params.set("limit", String(Math.max(5, Math.min(limit, 200))));

  // buyingOptions filter, e.g. buyingOptions:{FIXED_PRICE|AUCTION}
  if (Array.isArray(includeBuyingOptions) && includeBuyingOptions.length) {
    const allowed = includeBuyingOptions
      .map(x => String(x).toUpperCase())
      .filter(x => x === "FIXED_PRICE" || x === "AUCTION");

    if (allowed.length) {
      params.set("filter", `buyingOptions:{${allowed.join("|")}}`);
    }
  }

  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`;

  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    timeout: 15000,
  });

  return resp.data?.itemSummaries ?? [];
}

function normalizeComps(items) {
  return (items || [])
    .map(it => {
      const price = Number(it.price?.value ?? 0);
      const shipping = Number(it.shippingOptions?.[0]?.shippingCost?.value ?? 0);
      const allIn = price + (Number.isFinite(shipping) ? shipping : 0);

      const buyingOption = Array.isArray(it.buyingOptions) && it.buyingOptions.includes("AUCTION")
        ? "AUCTION"
        : "FIXED_PRICE";

      return {
        title: it.title ?? "",
        price,
        shipping: Number.isFinite(shipping) ? shipping : null,
        allIn,
        currency: it.price?.currency ?? "USD",
        buyingOption,
        condition: it.condition ?? null,
        endTime: it.itemEndDate ?? null,
        url: it.itemWebUrl ?? null,
        itemId: it.itemId ?? null,
      };
    })
    .filter(c => c.url && Number.isFinite(c.allIn) && c.allIn > 0);
}

function median(nums) {
  const arr = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function trimmedRange(nums, trimPct = 0.15) {
  const arr = [...nums].sort((a, b) => a - b);
  if (arr.length === 0) return [0, 0];
  if (arr.length < 6) return [arr[0], arr[arr.length - 1]];
  const trim = Math.floor(arr.length * trimPct);
  const sliced = arr.slice(trim, arr.length - trim);
  return [sliced[0], sliced[sliced.length - 1]];
}

function confidenceFromSample(n) {
  if (n >= 25) return "high";
  if (n >= 10) return "medium";
  return "low";
}

// If comps are thin, loosen query by removing cardNumber/variant and re-search once.
function loosenIdentity(identity) {
  return {
    ...identity,
    cardNumber: null,
    variant: null,
    serialNumbered: identity.serialNumbered ?? null,
  };
}

// ---------- CORE: GET ONE BUCKET ----------
async function getBucketComps({ identity, bucket, queryTightness, includeBuyingOptions, maxResults }) {
  const token = await getEbayAppToken();
  const negatives = buildNegatives(identity, bucket, queryTightness);
  let keywords = buildQuery(identity, bucket, queryTightness);

  let items = await ebaySearch({
    token,
    keywords,
    negatives,
    includeBuyingOptions,
    limit: maxResults,
  });

  let comps = normalizeComps(items);
  let loosened = false;

  // One fallback pass if too few comps and not already loose
  if (comps.length < 6 && queryTightness !== "LOOSE") {
    const looser = loosenIdentity(identity);
    const negatives2 = buildNegatives(looser, bucket, "LOOSE");
    const keywords2 = buildQuery(looser, bucket, "LOOSE");

    items = await ebaySearch({
      token,
      keywords: keywords2,
      negatives: negatives2,
      includeBuyingOptions,
      limit: maxResults,
    });

    comps = normalizeComps(items);
    keywords = keywords2;
    loosened = true;
  }

  // Summaries
  const allIns = comps.map(c => c.allIn);
  const sampleSize = comps.length;
  const currency = sampleSize ? comps[0].currency : "USD";

  const summary = sampleSize
    ? {
        bucket,
        currency,
        sampleSize,
        medianAllIn: median(allIns),
        rangeAllIn: trimmedRange(allIns),
        confidence: confidenceFromSample(sampleSize),
        source: "EBAY_ACTIVE_LISTINGS",
        notes: loosened ? ["Search was broadened due to limited comps."] : [],
      }
    : {
        bucket,
        currency,
        sampleSize: 0,
        medianAllIn: 0,
        rangeAllIn: [0, 0],
        confidence: "low",
        source: "EBAY_ACTIVE_LISTINGS",
        notes: ["Insufficient comps returned for this bucket."],
      };

  return {
    summary,
    comps: comps.slice(0, 12), // return top 12 comps
    queryUsed: {
      keywords,
      negatives,
      buyingOptions: includeBuyingOptions,
      loosened,
    },
  };
}

// ---------- ROUTES ----------
app.post("/comps/ebay", async (req, res) => {
  try {
    const { identity, bucket, queryTightness, includeBuyingOptions, maxResults } = req.body || {};
    if (!identity || !bucket) {
      return res.status(400).json({ error: "bad_request", message: "identity and bucket are required" });
    }

    const result = await getBucketComps({
      identity: { isAuto: false, isPatch: false, ...identity },
      bucket: normalizeBucket(bucket),
      queryTightness: (queryTightness || "NORMAL").toUpperCase(),
      includeBuyingOptions: includeBuyingOptions || ["FIXED_PRICE", "AUCTION"],
      maxResults: maxResults || 60,
    });

    res.json(result);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(502).json({
      error: "upstream_error",
      message: "Failed to fetch eBay comps. Check credentials, keyset status, and request shape.",
      details: err?.response?.data || { message: err.message },
    });
  }
});

app.post("/comps/ebay/multi", async (req, res) => {
  try {
    const { identity, buckets, queryTightness, includeBuyingOptions, maxResultsPerBucket } = req.body || {};

    if (!identity) {
      return res.status(400).json({ error: "bad_request", message: "identity is required" });
    }

    // If caller didn't provide buckets, choose defaults based on domain
    let finalBuckets = Array.isArray(buckets) && buckets.length
      ? buckets.map(normalizeBucket)
      : null;

    const domain = String(identity.domain || "").toLowerCase();
    if (!finalBuckets) {
      finalBuckets = domain === "pokemon" ? DEFAULT_BUCKETS_POKEMON : DEFAULT_BUCKETS_SPORTS;
    }

    // Guardrail: avoid excessive cost
    finalBuckets = finalBuckets.slice(0, 12);

    const results = {};
    for (const b of finalBuckets) {
      results[b] = await getBucketComps({
        identity: { isAuto: false, isPatch: false, ...identity },
        bucket: b,
        queryTightness: (queryTightness || "NORMAL").toUpperCase(),
        includeBuyingOptions: includeBuyingOptions || ["FIXED_PRICE", "AUCTION"],
        maxResults: maxResultsPerBucket || 50,
      });
    }

    res.json({ results });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(502).json({
      error: "upstream_error",
      message: "Failed to fetch eBay comps. Check credentials, keyset status, and request shape.",
      details: err?.response?.data || { message: err.message },
    });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
