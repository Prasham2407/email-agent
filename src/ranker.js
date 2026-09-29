const axios = require("axios");
const { withRetry, sleep } = require("./http-utils");

const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const CALL_DELAY = parseInt(process.env.LLM_CALL_DELAY_MS || "500", 10);

/**
 * Scores a single candidate against a Job Description.
 * Extracts structured fields (total experience, current/expected salary)
 * and ranks based on required tech/skills, past experience, and total experience.
 *
 * @param {object} candidate - { name, total_experience, current_company, education, primary_skills, summary, attachments_summary, subject, from }
 * @param {string} jd - the job description text
 * @returns {Promise<object>} { score, match_reasons, gaps, total_experience_years, current_salary, expected_salary, recommended_role_fit }
 */
async function scoreCandidateAgainstJD(candidate, jd) {
  try {
    const candidateText = [
      `Name: ${candidate.name || "N/A"}`,
      `Subject: ${candidate.subject || "N/A"}`,
      `From: ${candidate.from || "N/A"}`,
      `Total Experience (as stated): ${candidate.total_experience || "N/A"}`,
      `Current Company: ${candidate.current_company || "N/A"}`,
      `Education: ${candidate.education || "N/A"}`,
      `Primary Skills: ${candidate.primary_skills || "N/A"}`,
      `Summary: ${candidate.summary || "N/A"}`,
      `Attachments Summary: ${candidate.attachments_summary || "N/A"}`
    ].join("\n");

    await sleep(CALL_DELAY);
    const res = await withRetry(() => axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: MODEL,
        messages: [
          {
            role: "system",
            content: `You are a technical recruiter evaluating a job applicant against a Job Description (JD).
Score the candidate 0-100 based on:
1. Required tech/skills match — how many of the JD's required technologies/skills appear in the candidate's skills, summary, and attachments.
2. Past experience relevance — whether the candidate's prior roles/projects align with what the JD asks for.
3. Total experience — whether the candidate meets or exceeds the JD's experience requirement (if stated).

Also extract these structured fields from the candidate's email/resume if present:
- total_experience_years: a number (in years). If 'since YYYY', count from YYYY to ${new Date().getFullYear()}. If < 1 year, express as a fraction (e.g. 0.58 for 7 months). If unknown, use null.
- total_experience_display: a human-readable string. If >= 1 year, use 'X years' (e.g. '5 years'). If < 1 year, use 'X months' (e.g. '7 months'). If unknown, use null.
- current_salary: the candidate's current CTC/salary as a string (e.g. "12 LPA", "$80k"). If not mentioned, use null.
- expected_salary: the candidate's expected CTC/salary as a string. If not mentioned, use null.

Return STRICT JSON only, no markdown:
{
  "score": <0-100 integer>,
  "match_reasons": ["concrete reason 1", "concrete reason 2", ...],
  "gaps": ["missing skill/requirement 1", ...],
  "total_experience_years": <number or null>,
  "total_experience_display": "<string or null>",
  "current_salary": "<string or null>",
  "expected_salary": "<string or null>",
  "recommended_role_fit": "<one-line role/level fit, e.g. 'Mid-level Backend Engineer'>"
}`
          },
          {
            role: "user",
            content: `JOB DESCRIPTION:\n${jd}\n\n---\n\nCANDIDATE:\n${candidateText}`
          }
        ],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    ));

    const raw = res.data.choices[0].message.content;
    return JSON.parse(raw);
  } catch (err) {
    console.error("❌ Ranker ERROR for", candidate.name || "(unknown)", ":", err.message);
    return {
      score: 0,
      match_reasons: [],
      gaps: ["Scoring failed"],
      total_experience_years: null,
      total_experience_display: null,
      current_salary: null,
      expected_salary: null,
      recommended_role_fit: "Unknown"
    };
  }
}

module.exports = { scoreCandidateAgainstJD };
