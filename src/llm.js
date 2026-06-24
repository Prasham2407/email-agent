const axios = require("axios");

async function analyzeEmail(text) {
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        // Using deepseek as it is very cheap, but you can swap to mistral or gpt-4o-mini
        model: process.env.OPENROUTER_MODEL || "qwen/qwen-2.5-72b-instruct",
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
  "name": "Candidate's full name. Look in the subject line, email address, body, or signature (do not default to 'Not mentioned' if you can find it)",
  "total_experience": "Infer total experience. If they worked since a specific date (e.g. 2016), calculate years of experience relative to 2026 (e.g. '10 years')",
  "current_company": "Current or most recent company name. Look in body and attachments.",
  "education": "Highest degree and college. Look in body and attachments.",
  "primary_skills": "Top 3-5 keywords/technologies separated by commas.",
  "summary": "Detailed summary structured as bullet points. You MUST separate each bullet point with a newline character (\\n).",
  "attachments_summary": "If present, extract and summarize the detailed content of the attachments (such as specific education degrees/colleges, concrete projects built and their descriptions, full technical skills listed, and detailed employment history with roles/dates). Do NOT write overview descriptions like 'Includes education section' or 'lists projects'; instead, write the actual projects, skills, and education details. Structure as a detailed bullet-pointed list, separating each bullet point with a newline (\\n). If none, leave empty string."
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
        model: process.env.OPENROUTER_MODEL || "qwen/qwen-2.5-72b-instruct",
        messages: [
          {
            role: "system",
            content: "You are an AI assistant drafting professional email replies. Draft the reply strictly based on the user's instructions and the original email context. Ensure standard professional formatting, including proper spacing (e.g., 'Dear Deepak,' with spaces), paragraphs, and line breaks. Return ONLY the drafted text of the reply. Do not include introductory notes."
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
