require("dotenv").config();
const { getGmailClient, extractEmailData, markAsRead } = require("./src/mail");
const { analyzeEmail } = require("./src/llm");
const { sendSummaryToTelegram } = require("./src/telegram");

console.log("🚀 Starting Agent in Modular (No-DB) Mode...");

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MINUTES || "5", 10) * 60 * 1000;

async function checkEmails() {
  try {
    const gmail = getGmailClient();
    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread",
      maxResults: 10
    });

    const messages = res.data.messages || [];

    for (let m of messages) {
      const full = await gmail.users.messages.get({ userId: "me", id: m.id });
      const headers = full.data.payload.headers;

      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const from = headers.find((h) => h.name === "From")?.value || "";
      const messageIdHeader = headers.find((h) => h.name === "Message-ID")?.value || "";
      const referencesHeader = headers.find((h) => h.name === "References")?.value || "";

      const emailMatch = from.match(/<(.+?)>/);
      const senderEmail = emailMatch ? emailMatch[1] : from;

      const bodyText = await extractEmailData(gmail, m.id, full.data.payload);

      if (!bodyText) {
        await markAsRead(gmail, m.id);
        continue;
      }

      // Fast pre-filter (optional) to save LLM tokens. If you want LLM to judge everything, remove this.
      const rawContext = bodyText.toLowerCase() + subject.toLowerCase();
      const probablyUseful = rawContext.includes("application") || rawContext.includes("project") || rawContext.includes("client");

      const analysis = await analyzeEmail(`Subject: ${subject}\n\nBody:\n${bodyText}`);

      if (analysis.isRelevant) {
        console.log(`✅ Identified Relevant Email: ${subject}`);
        await sendSummaryToTelegram({
          id: m.id,
          sender: senderEmail,
          subject: subject,
          body: bodyText,
          category: analysis.category,
          summary: analysis.summary,
          attachments_summary: analysis.attachments_summary,
          messageIdHeader,
          referencesHeader,
        });
      } else {
        console.log(`❌ Skipped irrelevant email: ${subject}`);
      }

      // Important: Always mark fetched unread emails as read to avoid infinite fetch loops
      await markAsRead(gmail, m.id);
    }
  } catch (err) {
    console.error("❌ Process Emails Error:", err.message);
  }
}

// First check immediately
checkEmails();

// Then run on interval
setInterval(checkEmails, POLL_INTERVAL);

console.log("⏳ Listening for new emails...");
