const { google } = require("googleapis");
const { convert } = require("html-to-text");
const pdfParse = require("pdf-parse");

function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.REFRESH_TOKEN
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

async function extractEmailData(gmail, messageId, payload) {
  let body = "";
  let attachments = [];

  async function traverse(parts) {
    if (!parts) return;
    for (let part of parts) {
      if ((part.mimeType === "text/plain" || part.mimeType === "text/html") && part.body?.data) {
        if (!body) body = Buffer.from(part.body.data, "base64").toString();
      }

      if (part.filename && part.body?.attachmentId) {
        attachments.push(part);
      }

      if (part.parts) await traverse(part.parts);
    }
  }

  if (payload.parts) {
    await traverse(payload.parts);
  } else if (!body && payload.body?.data) {
    body = Buffer.from(payload.body.data, "base64").toString();
  }

  for (let att of attachments) {
    if (att.mimeType === "application/pdf") {
      try {
        const res = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: att.body.attachmentId
        });

        const buffer = Buffer.from(res.data.data, "base64");
        const pdf = await pdfParse(buffer);

        body += `\n\n[ATTACHMENT: ${att.filename}]\n` + pdf.text;
      } catch (e) {
        console.error("PDF Parsing Failed for ", att.filename);
      }
    }
  }

  return convert(body);
}

async function markAsRead(gmail, messageId) {
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["UNREAD"] }
    });
  } catch (err) {
    console.error("❌ Failed to mark as read:", err.message);
  }
}

async function sendReply(gmail, to, subject, message, inReplyTo, references) {
  // Strip 'Re: ' to avoid 'Re: Re: '
  const cleanSubject = subject.replace(/^Re:\s*/i, '');
  
  const rawMessage = [
    `To: ${to}`,
    `Subject: Re: ${cleanSubject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references || inReplyTo}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    message
  ].join("\n");

  const encodedMessage = Buffer.from(rawMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encodedMessage }
  });
}

module.exports = {
  getGmailClient,
  extractEmailData,
  markAsRead,
  sendReply
};