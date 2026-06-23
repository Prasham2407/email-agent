const TelegramBot = require("node-telegram-bot-api");
const { generateDraft } = require("./llm");
const { getGmailClient, sendReply } = require("./mail");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.on("polling_error", (err) => console.error("❌ TELEGRAM ERROR:", err.message));

// Temporary memory map mimicking a DB structure. 
// Uses max memory limit from ENV to not eat up RAM.
const memoryMap = new Map();
const MAX_MEMORY_MESSAGES = parseInt(process.env.MAX_MEMORY_MESSAGES || "20", 10);

function saveToMemoryMap(messageId, payloadData) {
  memoryMap.set(messageId, payloadData);

  // Evict oldest elements if we exceed limit
  if (memoryMap.size > MAX_MEMORY_MESSAGES) {
    const firstKey = memoryMap.keys().next().value;
    memoryMap.delete(firstKey);
  }
}

// Helper to escape HTML characters in dynamic user/email data
function escapeHTML(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

bot.on("message", async (msg) => {
  // If not replying to a bot message, ignore it
  if (!msg.reply_to_message) return;

  const repliedToId = msg.reply_to_message.message_id;
  const contextData = memoryMap.get(repliedToId);

  if (!contextData) {
    await bot.sendMessage(msg.chat.id, "❌ I couldn't find the context for this reply. Is it older than the memory limit?");
    return;
  }

  // 1. User replies to the summary -> Time to draft an email response
  if (contextData.type === "email") {
    const loaderMsg = await bot.sendMessage(msg.chat.id, "⏳ Analyzing instruction and drafting reply...");
    
    // Call OpenRouter with Instruction
    const draftText = await generateDraft(
      `Subject: ${contextData.emailDetails.subject}\n\nBody: ${contextData.emailDetails.body}`,
      msg.text
    );

    await bot.deleteMessage(msg.chat.id, loaderMsg.message_id);

    const draftMsg = await bot.sendMessage(
      msg.chat.id,
      `📝 <b>Draft Generated:</b>\n\n<pre>${escapeHTML(draftText)}</pre>\n\n<i>Reply with 'Yes' to send it, or provide new instructions to edit.</i>`,
      { parse_mode: "HTML" }
    );

    // Save draft context waiting for final "Yes" explicitly linked to the draft message bubble
    saveToMemoryMap(draftMsg.message_id, {
      type: "draft",
      emailDetails: contextData.emailDetails,
      draftText: draftText
    });
  }

  // 2. User replies "Yes" to a draft -> Send Email
  else if (contextData.type === "draft") {
    if (msg.text.trim().toLowerCase() === "yes") {
      const loaderMsg = await bot.sendMessage(msg.chat.id, "🚀 Sending...");
      const gmail = getGmailClient();

      try {
        await sendReply(
          gmail,
          contextData.emailDetails.sender,
          contextData.emailDetails.subject,
          contextData.draftText,
          contextData.emailDetails.messageIdHeader,
          contextData.emailDetails.referencesHeader
        );

        await bot.editMessageText("✅ <b>Replied Successfully!</b>", {
          chat_id: msg.chat.id,
          message_id: loaderMsg.message_id,
          parse_mode: "HTML"
        });

      } catch (err) {
        await bot.editMessageText(`❌ Failed to send: ${escapeHTML(err.message)}`, {
          chat_id: msg.chat.id,
          message_id: loaderMsg.message_id
        });
      }
    } else {
      // User did not say yes, implies they want to edit the draft.
      const loaderMsg = await bot.sendMessage(msg.chat.id, "⏳ Re-drafting...");
      const newDraftText = await generateDraft(
        `Original Email Context:\n${contextData.emailDetails.body}\n\nPrevious bad draft:\n${contextData.draftText}`,
        msg.text
      );

      await bot.deleteMessage(msg.chat.id, loaderMsg.message_id);

      const draftMsg = await bot.sendMessage(
        msg.chat.id,
        `📝 <b>Revised Draft:</b>\n\n<pre>${escapeHTML(newDraftText)}</pre>\n\n<i>Reply with 'Yes' to send it, or provide new instructions.</i>`,
        { parse_mode: "HTML" }
      );

      saveToMemoryMap(draftMsg.message_id, {
        ...contextData,
        draftText: newDraftText
      });
    }
  }
});

async function sendSummaryToTelegram(emailDetails) {
  const category = escapeHTML(emailDetails.category);
  const sender = escapeHTML(emailDetails.sender);
  const subject = escapeHTML(emailDetails.subject);
  const summary = escapeHTML(emailDetails.summary);
  const attachmentsBlock = emailDetails.attachments_summary
    ? `\n📎 <b>Attachments:</b>\n${escapeHTML(emailDetails.attachments_summary)}`
    : "";

  const textToClient = `
📧 <b>${category}</b>

👤 <b>From:</b> ${sender}
📑 <b>Subject:</b> ${subject}

📝 <b>Summary:</b>
${summary}${attachmentsBlock}

<i>(Reply to this message with instructions to draft a response)</i>
  `.trim();

  const msg = await bot.sendMessage(process.env.CHAT_ID, textToClient, {
    parse_mode: "HTML"
  });

  saveToMemoryMap(msg.message_id, {
    type: "email",
    emailDetails
  });
}

module.exports = {
  sendSummaryToTelegram
};