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
  "name": "Candidate's full name (if mentioned, otherwise 'Not mentioned')",
  "total_experience": "Briefly state total experience if mentioned (e.g. '3 years', 'Fresher', 'Not mentioned')",
  "current_company": "Briefly state current company name if mentioned (e.g. 'Infosys', 'Freelance', 'Not mentioned')",
  "education": "Highest degree and college (e.g. 'B.Tech IT, Hindustan College', 'Not mentioned')",
  "primary_skills": "Top 3-5 keywords/technologies separated by commas (e.g. 'Python, React.js, AWS', 'Not mentioned')",
  "summary": "Detailed summary structured as bullet points (using bullet character •) about the email body",
  "attachments_summary": "If present, a detailed summary of the attachments structured as bullet points (using bullet character •). If none, leave empty string."
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
