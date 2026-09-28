// Verifies Gmail OAuth credentials (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN)
// without relying on the googleapis library, so it runs anywhere with node.
// Usage: node verify-gmail.js
const https = require("https");
const fs = require("fs");
require("dotenv").config();

const LOG = "/tmp/verify-gmail.log";
const log = (s) => { const line = `[${new Date().toISOString()}] ${s}`; console.log(line); fs.appendFileSync(LOG, line + "\n"); };

const missing = ["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN"].filter(k => !process.env[k]);
if (missing.length) { console.error("❌ Missing env vars:", missing.join(", ")); process.exit(1); }

log("CLIENT_ID     : " + process.env.CLIENT_ID.slice(0, 16) + "...");
log("CLIENT_SECRET : " + process.env.CLIENT_SECRET.slice(0, 4) + "...");
log("REFRESH_TOKEN: " + process.env.REFRESH_TOKEN.slice(0, 10) + "...");
log("");

// Step 1: Refresh the access token via raw HTTPS (no googleapis needed)
const postData = new URLSearchParams({
  client_id: process.env.CLIENT_ID,
  client_secret: process.env.CLIENT_SECRET,
  refresh_token: process.env.REFRESH_TOKEN,
  grant_type: "refresh_token"
}).toString();

const req = https.request({
  hostname: "oauth2.googleapis.com",
  path: "/token",
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) },
  timeout: 15000
}, (res) => {
  let body = "";
  res.on("data", c => body += c);
  res.on("end", () => {
    let data;
    try { data = JSON.parse(body); } catch { data = { raw: body }; }
    if (res.statusCode === 200 && data.access_token) {
      log("✅ Token refresh OK — CLIENT_ID/SECRET + REFRESH_TOKEN are valid");
      log("   access_token: " + data.access_token.slice(0, 12) + "... (expires in " + (data.expires_in || "?") + "s)");
      log("   scope: " + (data.scope || "(none returned)"));
      checkGmail(data.access_token);
    } else {
      log("❌ Token refresh FAILED (HTTP " + res.statusCode + ")");
      log("   " + body);
      if (/invalid_client/i.test(body)) log("   → CLIENT_ID/CLIENT_SECRET wrong, or OAuth app deleted/paused/under review");
      else if (/invalid_grant/i.test(body)) log("   → REFRESH_TOKEN invalid or revoked. Re-run: node get-token.js");
      process.exit(1);
    }
  });
});

req.on("timeout", () => { log("⌛ Request to oauth2.googleapis.com timed out (network issue)"); req.destroy(); process.exit(2); });
req.on("error", (e) => { log("❌ Network error: " + e.message); process.exit(2); });
req.write(postData);
req.end();

// Step 2: Use the access token to call Gmail profile (confirms scope + account)
function checkGmail(accessToken) {
  const g = https.request({
    hostname: "gmail.googleapis.com",
    path: "/gmail/v1/users/me/profile",
    method: "GET",
    headers: { Authorization: "Bearer " + accessToken },
    timeout: 15000
  }, (res) => {
    let body = "";
    res.on("data", c => body += c);
    res.on("end", () => {
      if (res.statusCode === 200) {
        const p = JSON.parse(body);
        log("✅ Gmail API call OK — scope works");
        log("   Connected account : " + p.emailAddress);
        log("   Messages total    : " + p.messagesTotal);
        log("   Unread threads    : " + p.threadsUnread);
        log("");
        log("🎉 All Gmail credentials are working correctly.");
        process.exit(0);
      } else {
        log("❌ Gmail API call FAILED (HTTP " + res.statusCode + ")");
        log("   " + body);
        if (/insufficient|scope/i.test(body)) log("   → Scope missing. Required: https://www.googleapis.com/auth/gmail.modify");
        process.exit(1);
      }
    });
  });
  g.on("timeout", () => { log("⌛ Gmail API call timed out"); g.destroy(); process.exit(2); });
  g.on("error", (e) => { log("❌ Gmail API error: " + e.message); process.exit(2); });
  g.end();
}
