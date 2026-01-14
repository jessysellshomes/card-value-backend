import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

async function getEbayToken() {
  const auth = Buffer.from(
    `${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope"
  });

  const response = await axios.post(
    "https://api.ebay.com/identity/v1/oauth2/token",
    body.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${auth}`
      }
    }
  );

  return response.data.access_token;
}

app.post("/comps/ebay/multi", async (req, res) => {
  try {
    const token = await getEbayToken();
    res.json({
      message: "Backend is live and authenticated with eBay",
      tokenPreview: token.slice(0, 10) + "..."
    });
  } catch (err) {
    res.status(500).json({
      error: "eBay auth failed",
      details: err?.response?.data || err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
