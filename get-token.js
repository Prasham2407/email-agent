require("dotenv").config();
const https = require("https");
const http = require("http");
const { URL } = require("url");

// Must match the Redirect URI configured on your OAuth client in Google Cloud Console.
const REDIRECT_URI = "http://localhost:3000";
const PORT = 3000;

// We ONLY request gmail.modify scope.
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

const missing = ["CLIENT_ID", "CLIENT_SECRET"].filter(k => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing env vars:", missing.join(", "));
  process.exit(1);
}

// Build the consent URL.
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", process.env.CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent"); // forces a refresh_token to be returned

// Start a local server to capture the redirect automatically.
const server = http.createServer(async (req, res) => {
  const incoming = new URL(req.url, REDIRECT_URI);
  const code = incoming.searchParams.get("code");
  const errParam = incoming.searchParams.get("error");

  if (errParam) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h1>Authorization failed</h1><p>Google returned error: ${errParam}</p>`);
    console.error("\n❌ Authorization error from Google:", errParam);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(404);
    res.end("No code");
    return;
  }

  // Show a success page in the browser so the user knows they can close it.
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<h1>✅ Authorization received!</h1><p>You can close this tab and return to your terminal.</p>");

  console.log("\n✅ Captured authorization code. Exchanging for refresh token...");

  // Stop listening; we have what we need.
  server.close();

  const postData = new URLSearchParams({
    code,
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code"
  }).toString();

  const tokenReq = https.request({
    hostname: "oauth2.googleapis.com",
    path: "/token",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(postData)
    },
    timeout: 15000
  }, (tokenRes) => {
    let body = "";
    tokenRes.on("data", c => body += c);
    tokenRes.on("end", () => {
      let data;
      try { data = JSON.parse(body); } catch { data = { raw: body }; }
      if (tokenRes.statusCode === 200 && data.refresh_token) {
        console.log("\nSUCCESS! Copy the following REFRESH_TOKEN into your .env file:\n");
        console.log(`REFRESH_TOKEN=${data.refresh_token}`);
        console.log("\n(access_token expires in " + (data.expires_in || "?") + "s — you don't need it, the refresh token is what matters)");
        process.exit(0);
      } else {
        console.error("\nError exchanging code for token (HTTP " + tokenRes.statusCode + "):");
        console.error("  " + body);
        if (/invalid_client/i.test(body)) console.error("  → CLIENT_ID/CLIENT_SECRET wrong, or OAuth app deleted/paused");
        else if (/redirect_uri_mismatch/i.test(body)) console.error("  → Redirect URI '" + REDIRECT_URI + "' is not authorized in Google Cloud Console");
        else if (/invalid_grant/i.test(body)) console.error("  → Code already used or expired. Re-authorize and try again.");
        process.exit(1);
      }
    });
  });

  tokenReq.on("timeout", () => { console.error("\n⌛ Token exchange timed out"); tokenReq.destroy(); process.exit(2); });
  tokenReq.on("error", (e) => { console.error("\nNetwork error during token exchange:", e.message); process.exit(2); });
  tokenReq.write(postData);
  tokenReq.end();
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("❌ Port " + PORT + " is already in use. Close whatever is using it (e.g. another dev server) and re-run.");
  } else {
    console.error("❌ Server error:", e.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log("🔄 Local server listening on " + REDIRECT_URI);
  console.log("\n1. Open this URL in your browser:\n");
  console.log(authUrl.toString());
  console.log("\n------------------------------------------------------------");
  console.log("2. Authorize Google to access Gmail. You'll be redirected back to");
  console.log("   " + REDIRECT_URI + " automatically — no copy-paste needed.");
  console.log("   (If a 'site can't be reached' page shows, that's OK — the code was");
  console.log("    still captured. Just come back to this terminal.)");
  console.log("\nWaiting for authorization...");
});
