const axios = require("axios");

async function analyzeEmail(text) {
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        // Using deepseek as it is very cheap, but you can swap to mistral or gpt-4o-mini
        model: "nvidia/nemotron-3-super-120b-a12b:free",
        messages: [
          {
            role: "system",
            content: `You are an expert AI filtering assistant. 
Analyze the email content and determine if it is a "Job Application" or a "Client Message". 
Ignore promotional emails, newsletters, spam, and un-important notifications.
Return STRICT JSON format:
{
  "isRelevant": true or false,
  "category": "Job Application" or "Client Message" or "Other",
  "summary": "Detailed summary in bullet points about the email body",
  "attachments_summary": "If present, a detailed summary of the attachments structured as bullet points (not a paragraph). If none, leave empty string."
}`
          },
          { role: "user", content: text }
        ],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const raw = res.data.choices[0].message.content;
    return JSON.parse(raw);
  } catch (err) {
    console.error("❌ LLM Analyze ERROR:", err.message);
    return { isRelevant: false };
  }
}

async function generateDraft(emailContext, userInstruction) {
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "nvidia/nemotron-3-super-120b-a12b:free",
        messages: [
          {
            role: "system",
            content: "You are an AI assistant drafting professional email replies. Draft the reply strictly based on the user's instructions and the original email context. Return ONLY the drafted text of the reply. Do not include introductory notes."
          },
          { 
            role: "user", 
            content: `Original Email Context:\n${emailContext}\n\nUser's Instruction for the Reply:\n${userInstruction}\n\nDraft the email now:` 
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("❌ LLM Draft ERROR:", err.message);
    return "Failed to generate draft. Please try again.";
  }
}

module.exports = { analyzeEmail, generateDraft };
