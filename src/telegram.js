const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const { generateDraft } = require("./llm");
const { getGmailClient, sendReply } = require("./mail");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.on("polling_error", (err) => console.error("❌ TELEGRAM ERROR:", err.message));

const CHATS_FILE = path.join(__dirname, "../chats.json");
const memoryMap = new Map();
const MAX_MEMORY_MESSAGES = parseInt(process.env.MAX_MEMORY_MESSAGES || "50", 10);

// Helper to load subscribers from chats.json
function getSubscribers() {
  try {
    if (fs.existsSync(CHATS_FILE)) {
      const data = fs.readFileSync(CHATS_FILE, "utf8");
      const list = JSON.parse(data);
      if (Array.isArray(list)) return list;
    }
  } catch (e) {
    console.error("Error reading chats.json:", e.message);
  }
  const defaultChat = process.env.CHAT_ID;
  return defaultChat ? [{ id: parseInt(defaultChat, 10), firstName: "Default Admin", lastName: "", username: "admin", status: "approved" }] : [];
}

// Helper to save a new subscriber with name and username (defaults to pending approval)
async function addSubscriber(msg) {
  try {
    const chatId = msg.chat.id;
    const from = msg.from || {};
    const subscribers = getSubscribers();
    const defaultAdmin = process.env.CHAT_ID;
    
    // Check if already exists in chats.json
    const exists = subscribers.some(sub => {
      const subId = (sub && typeof sub === "object") ? sub.id : sub;
      return subId === chatId;
    });

    if (!exists) {
      // Admin is automatically approved. Anyone else is pending.
      const isSelfAdmin = defaultAdmin && chatId === parseInt(defaultAdmin, 10);
      const newSub = {
        id: chatId,
        firstName: from.first_name || "",
        lastName: from.last_name || "",
        username: from.username || "",
        status: isSelfAdmin ? "approved" : "pending",
        subscribedAt: new Date().toISOString()
      };
      
      subscribers.push(newSub);
      fs.writeFileSync(CHATS_FILE, JSON.stringify(subscribers, null, 2), "utf8");
      console.log(`➕ Added new subscriber (Status: ${newSub.status}): ${newSub.firstName} ${newSub.lastName} [ID: ${chatId}]`);

      if (isSelfAdmin) {
        await bot.sendMessage(chatId, "👋 <b>Welcome Admin!</b> You have been automatically subscribed and approved.", { parse_mode: "HTML" });
        return;
      }

      // Notify the user they are pending approval
      await bot.sendMessage(chatId, "⏳ <b>Your request to join this agent has been sent to the Admin.</b>\nYou will be notified once approved.", { parse_mode: "HTML" }).catch(() => {});

      // Notify Admin with Action Buttons
      if (defaultAdmin) {
        const notifyText = `
🔔 <b>New Access Request:</b>
• <b>Name:</b> ${escapeHTML(newSub.firstName)} ${escapeHTML(newSub.lastName)}
• <b>Username:</b> @${escapeHTML(newSub.username) || "N/A"}
• <b>Chat ID:</b> <code>${chatId}</code>
        `.trim();

        await bot.sendMessage(defaultAdmin, notifyText, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Approve", callback_data: `approve_${chatId}` },
                { text: "❌ Decline", callback_data: `decline_${chatId}` }
              ]
            ]
          }
        }).catch(err => {
          console.error("❌ Failed to notify admin of new subscriber:", err.message);
        });
      }
    }
  } catch (e) {
    console.error("Error saving subscriber to chats.json:", e.message);
  }
}

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
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  // Automatically register and check subscription status
  await addSubscriber(msg);

  // If not replying to a bot message, ignore it
  if (!msg.reply_to_message) return;

  const repliedToId = msg.reply_to_message.message_id;
  const contextData = memoryMap.get(repliedToId);

  if (!contextData) {
    await bot.sendMessage(chatId, "❌ I couldn't find the context for this reply. Is it older than the memory limit?");
    return;
  }

  // Check if sender is approved before allowing interaction
  const subscribers = getSubscribers();
  const subRecord = subscribers.find(sub => {
    const subId = (sub && typeof sub === "object") ? sub.id : sub;
    return subId === chatId;
  });
  const isApproved = !subRecord || (typeof subRecord !== "object") || subRecord.status === "approved" || !subRecord.status;
  if (!isApproved) {
    await bot.sendMessage(chatId, "❌ You cannot reply. Your subscription is still pending approval.");
    return;
  }

  // 1. User replies to the summary -> Time to draft an email response
  if (contextData.type === "email") {
    const loaderMsg = await bot.sendMessage(chatId, "⏳ Analyzing instruction and drafting reply...");
    
    // Call OpenRouter with Instruction
    const draftText = await generateDraft(
      `Subject: ${contextData.emailDetails.subject}\n\nBody: ${contextData.emailDetails.body}`,
      msg.text
    );

    await bot.deleteMessage(chatId, loaderMsg.message_id);

    const draftMsg = await bot.sendMessage(
      chatId,
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
      const loaderMsg = await bot.sendMessage(chatId, "🚀 Sending...");
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
          chat_id: chatId,
          message_id: loaderMsg.message_id,
          parse_mode: "HTML"
        });

      } catch (err) {
        await bot.editMessageText(`❌ Failed to send: ${escapeHTML(err.message)}`, {
          chat_id: chatId,
          message_id: loaderMsg.message_id
        });
      }
    } else {
      // User did not say yes, implies they want to edit the draft.
      const loaderMsg = await bot.sendMessage(chatId, "⏳ Re-drafting...");
      const newDraftText = await generateDraft(
        `Original Email Context:\n${contextData.emailDetails.body}\n\nPrevious bad draft:\n${contextData.draftText}`,
        msg.text
      );

      await bot.deleteMessage(chatId, loaderMsg.message_id);

      const draftMsg = await bot.sendMessage(
        chatId,
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

// Callback queries for Approve / Decline buttons
bot.on("callback_query", async (query) => {
  const adminId = process.env.CHAT_ID;
  if (!adminId || query.from.id !== parseInt(adminId, 10)) {
    await bot.answerCallbackQuery(query.id, { text: "❌ You are not authorized to perform this action." });
    return;
  }

  const data = query.data;
  const match = data.match(/^(approve|decline)_(\d+)$/);
  if (!match) return;

  const action = match[1];
  const targetChatId = parseInt(match[2], 10);
  const subscribers = getSubscribers();

  const targetIndex = subscribers.findIndex(sub => {
    const subId = (sub && typeof sub === "object") ? sub.id : sub;
    return subId === targetChatId;
  });

  if (targetIndex === -1) {
    await bot.answerCallbackQuery(query.id, { text: "⚠️ Subscriber not found." });
    return;
  }

  if (action === "approve") {
    // Approve user
    if (typeof subscribers[targetIndex] === "object") {
      subscribers[targetIndex].status = "approved";
    } else {
      subscribers[targetIndex] = { id: targetChatId, status: "approved" };
    }
    fs.writeFileSync(CHATS_FILE, JSON.stringify(subscribers, null, 2), "utf8");

    // Edit Admin message status
    await bot.editMessageText(
      `${query.message.text}\n\n✅ <b>Approved</b>`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "HTML" }
    ).catch(() => {});

    // Notify approved user
    await bot.sendMessage(targetChatId, "🎉 <b>Your request has been approved!</b> You will now receive email summaries.", { parse_mode: "HTML" }).catch(() => {});
    await bot.answerCallbackQuery(query.id, { text: "User Approved!" });

  } else if (action === "decline") {
    // Decline user (remove from subscribers)
    subscribers.splice(targetIndex, 1);
    fs.writeFileSync(CHATS_FILE, JSON.stringify(subscribers, null, 2), "utf8");

    // Edit Admin message status
    await bot.editMessageText(
      `${query.message.text}\n\n❌ <b>Declined</b>`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "HTML" }
    ).catch(() => {});

    // Notify declined user
    await bot.sendMessage(targetChatId, "❌ Your request to join the agent has been declined by the Admin.").catch(() => {});
    await bot.answerCallbackQuery(query.id, { text: "User Declined!" });
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

  // Load subscribers list & filter only approved ones
  const subscribers = getSubscribers();
  const approvedSubscribers = subscribers.filter(sub => {
    if (sub && typeof sub === "object") {
      return sub.status === "approved" || !sub.status;
    }
    return true; // Legacy numbers are automatically approved
  });

  console.log(`📢 Broadcasting alert to ${approvedSubscribers.length} approved chat subscriber(s)...`);

  for (let sub of approvedSubscribers) {
    const chatId = (sub && typeof sub === "object") ? sub.id : sub;
    try {
      const msg = await bot.sendMessage(chatId, textToClient, {
        parse_mode: "HTML"
      });

      // Save context under this specific chat's message ID
      saveToMemoryMap(msg.message_id, {
        type: "email",
        emailDetails
      });
    } catch (err) {
      console.error(`❌ Failed to send broadcast to ${chatId}:`, err.message);
    }
  }
}

module.exports = {
  sendSummaryToTelegram
};