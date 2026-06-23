require("dotenv").config();
const { google } = require("googleapis");
const readline = require("readline");

const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  "http://localhost:3000" // Make sure this matches the Redirect URI in Google Cloud Console
);

// We ONLY request gmail.modify scope.
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

async function getNewToken() {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent" // Forces Google to show the consent screen and return a refresh_token
  });

  console.log("1. Open this URL in your browser:\n");
  console.log(authUrl);
  console.log("\n------------------------------------------------------------");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question("2. After authorizing, copy the 'code=...' value from the address bar URL and paste it here: ", async (code) => {
    rl.close();
    try {
      // Decode the code if it was copied with URL-encoding
      const decodedCode = decodeURIComponent(code.trim());
      const { tokens } = await oauth2Client.getToken(decodedCode);
      console.log("\nSUCCESS! Copy the following REFRESH_TOKEN into your .env file:\n");
      console.log(`REFRESH_TOKEN=${tokens.refresh_token}`);
    } catch (err) {
      console.error("\nError exchanging code for token:", err.message);
    }
  });
}

getNewToken();