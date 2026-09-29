require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const readline = require("readline");
const { getGmailClient, extractEmailData, sendReply } = require("./src/mail");
const { analyzeEmail, generateDraft } = require("./src/llm");
const { scoreCandidateAgainstJD } = require("./src/ranker");

const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || "7", 10);
const REPORT_FILE = path.join(__dirname, "rankings.html");
const DATA_FILE = path.join(__dirname, "candidates-data.json");
const SERVER_PORT = parseInt(process.env.RANKER_PORT || "3001", 10);

console.log("🧑‍💼 Job Application Ranker (local-only)\n");

// --- 1. Read JD from stdin (paste, end with a line containing only "END") ---
function readJD() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("Paste your Job Description below.");
    console.log("Finish by typing END on its own line (or press Ctrl+D):\n");
    let lines = [];
    rl.on("line", (line) => {
      if (line.trim().toUpperCase() === "END") { rl.close(); }
      else lines.push(line);
    });
    rl.on("close", () => resolve(lines.join("\n").trim()));
  });
}

// --- 2. Fetch emails from the last X days (all, not just unread) ---
async function fetchEmailsSince(days) {
  const gmail = getGmailClient();
  const since = new Date(Date.now() - days * 86400 * 1000);
  const yyyy = since.getFullYear();
  const mm = String(since.getMonth() + 1).padStart(2, "0");
  const dd = String(since.getDate()).padStart(2, "0");
  const q = `after:${yyyy}/${mm}/${dd}`;

  console.log(`\n📬 Fetching emails with query: "${q}" ...`);
  const res = await gmail.users.messages.list({ userId: "me", q, maxResults: 100 });
  const messages = res.data.messages || [];
  console.log(`   Found ${messages.length} email(s) in the last ${days} day(s).`);
  return { gmail, messages };
}

// --- 3. Classify + score each job application ---
async function processCandidates(gmail, messages, jd) {
  const candidates = [];
  let processed = 0;

  for (const m of messages) {
    processed++;
    const full = await gmail.users.messages.get({ userId: "me", id: m.id });
    const headers = full.data.payload.headers;
    const subject = headers.find((h) => h.name === "Subject")?.value || "";
    const from = headers.find((h) => h.name === "From")?.value || "";
    const messageIdHeader = headers.find((h) => h.name === "Message-ID")?.value || "";
    const referencesHeader = headers.find((h) => h.name === "References")?.value || "";

    const bodyText = await extractEmailData(gmail, m.id, full.data.payload);
    if (!bodyText) { console.log(`   [${processed}/${messages.length}] Skipped (empty body): ${subject}`); continue; }

    // Classify via existing LLM
    const analysis = await analyzeEmail(`Subject: ${subject}\n\nBody:\n${bodyText}`);
    if (analysis._error) {
      console.log(`   [${processed}/${messages.length}] ⚠️ Classification failed (rate limit/error), skipping: ${subject}`);
      continue;
    }
    if (!analysis.isRelevant || analysis.category !== "Job Application") {
      console.log(`   [${processed}/${messages.length}] Not a job application: ${subject}`);
      continue;
    }

    console.log(`   [${processed}/${messages.length}] Job application: ${analysis.name || subject} — scoring...`);

    const candidate = {
      id: m.id, // use Gmail message ID as candidate ID
      name: analysis.name || "",
      total_experience: analysis.total_experience || "",
      current_company: analysis.current_company || "",
      education: analysis.education || "",
      primary_skills: analysis.primary_skills || "",
      summary: analysis.summary || "",
      attachments_summary: analysis.attachments_summary || "",
      subject,
      from,
      emailId: m.id,
      bodyText, // full email body (needed for draft context)
      messageIdHeader,
      referencesHeader
    };

    const score = await scoreCandidateAgainstJD(candidate, jd);
    candidates.push({ ...candidate, score });
    console.log(`      → Score: ${score.score} | Exp: ${score.total_experience_display ?? score.total_experience_years ?? "?"} | Curr: ${score.current_salary ?? "-"} | Exp(₹): ${score.expected_salary ?? "-"}`);
  }

  return candidates;
}

// --- 4. Generate self-contained HTML report ---
function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  // Use \x26 (=&) in source to avoid HTML-entity stripping by tooling
  const AMP = "\x26amp;";
  const LT = "\x26lt;";
  const GT = "\x26gt;";
  const QUOT = "\x26quot;";
  const APOS = "\x26#39;";
  return String(s)
    .replace(/&/g, AMP)
    .replace(/</g, LT)
    .replace(/>/g, GT)
    .replace(/"/g, QUOT)
    .replace(/'/g, APOS);
}

function generateHTML(jd, candidates) {
  const sorted = [...candidates].sort((a, b) => b.score.score - a.score.score);
  const rows = sorted.map((c, i) => {
    const s = c.score;
    const scoreColor = s.score >= 75 ? "#16a34a" : s.score >= 50 ? "#ca8a04" : "#dc2626";
    return `
      <tr data-score="${s.score}" data-name="${escapeHtml(c.name.toLowerCase())}" data-skills="${escapeHtml(c.primary_skills.toLowerCase())}" data-exp="${s.total_experience_years ?? ""}" data-cid="${escapeHtml(c.id)}">
        <td>${i + 1}</td>
        <td><strong>${escapeHtml(c.name || "Unknown")}</strong><br><span class="muted">${escapeHtml(c.from)}</span></td>
        <td>${escapeHtml(c.subject)}</td>
        <td>${escapeHtml(s.total_experience_display) || (s.total_experience_years != null ? s.total_experience_years + "y" : escapeHtml(c.total_experience)) || "-"}</td>
        <td>${escapeHtml(s.current_salary) || "-"}</td>
        <td>${escapeHtml(s.expected_salary) || "-"}</td>
        <td><span class="score-badge" style="background:${scoreColor}">${s.score}</span></td>
        <td>${escapeHtml(s.recommended_role_fit) || "-"}</td>
        <td>
          <details><summary>View</summary>
            <div class="detail-block">
              <p><strong>Skills:</strong> ${escapeHtml(c.primary_skills) || "-"}</p>
              <p><strong>Current Company:</strong> ${escapeHtml(c.current_company) || "-"}</p>
              <p><strong>Education:</strong> ${escapeHtml(c.education) || "-"}</p>
              <p><strong>Match Reasons:</strong></p>
              <ul>${(s.match_reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
              <p><strong>Gaps:</strong></p>
              <ul>${(s.gaps || []).map(r => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
              <p><strong>Summary:</strong> ${escapeHtml(c.summary) || "-"}</p>
              <p><strong>Attachments:</strong> ${escapeHtml(c.attachments_summary) || "-"}</p>
            </div>
          </details>
        </td>
        <td><button class="draft-btn" data-cid="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name || c.from)}">Draft Reply</button></td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Job Application Rankings</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; background: #f8fafc; color: #0f172a; }
  h1 { margin-bottom: 4px; }
  .muted { color: #64748b; font-size: 0.85em; }
  .jd-box { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin: 12px 0 20px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; font-size: 0.9em; }
  .controls { display: flex; gap: 16px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .controls label { font-size: 0.9em; }
  input[type="range"] { width: 200px; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th, td { border: 1px solid #e2e8f0; padding: 10px 12px; text-align: left; vertical-align: top; font-size: 0.9em; }
  th { background: #1e293b; color: #fff; position: sticky; top: 0; }
  tr:nth-child(even) { background: #f1f5f9; }
  .score-badge { color: #fff; padding: 3px 10px; border-radius: 12px; font-weight: 600; }
  .detail-block { max-width: 500px; }
  .detail-block ul { margin: 4px 0; padding-left: 18px; }
  details summary { cursor: pointer; color: #2563eb; }
  .stats { margin: 8px 0; color: #475569; font-size: 0.9em; }
  .draft-btn { background: #2563eb; color: #fff; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.85em; }
  .draft-btn:hover { background: #1d4ed8; }
  .draft-btn:disabled { background: #94a3b8; cursor: not-allowed; }
  .draft-btn.sent { background: #16a34a; }

  /* Modal */
  .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; justify-content: center; align-items: flex-start; padding-top: 40px; }
  .modal-overlay.active { display: flex; }
  .modal { background: #fff; border-radius: 12px; padding: 24px; max-width: 700px; width: 90%; max-height: 85vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.2); }
  .modal h2 { margin: 0 0 4px; }
  .modal .modal-info { color: #64748b; font-size: 0.9em; margin-bottom: 16px; }
  .modal textarea { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px; font-family: inherit; font-size: 0.9em; resize: vertical; }
  .modal textarea.instructions { min-height: 80px; margin-bottom: 12px; }
  .modal textarea.draft-preview { min-height: 200px; margin-bottom: 12px; font-family: monospace; }
  .modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
  .modal-actions button { padding: 8px 18px; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9em; }
  .btn-generate { background: #2563eb; color: #fff; }
  .btn-generate:hover { background: #1d4ed8; }
  .btn-send { background: #16a34a; color: #fff; }
  .btn-send:hover { background: #15803d; }
  .btn-cancel { background: #e2e8f0; color: #0f172a; }
  .btn-cancel:hover { background: #cbd5e1; }
  .btn-loading { opacity: 0.6; pointer-events: none; }
  .status-msg { font-size: 0.85em; margin: 8px 0; padding: 6px 10px; border-radius: 4px; }
  .status-msg.info { background: #dbeafe; color: #1e40af; }
  .status-msg.error { background: #fee2e2; color: #991b1b; }
  .status-msg.success { background: #dcfce7; color: #166534; }
</style>
</head>
<body>
<h1>Job Application Rankings</h1>
<div class="stats">${candidates.length} candidate(s) scored against the provided JD.</div>

<h3>Job Description</h3>
<div class="jd-box">${escapeHtml(jd)}</div>

<div class="controls">
  <label>Min score: <span id="scoreVal">0</span>
    <input type="range" id="scoreFilter" min="0" max="100" value="0">
  </label>
  <label>Search: <input type="text" id="searchFilter" placeholder="name or skill..."></label>
  <label>Sort:
    <select id="sortBy">
      <option value="score">Score (high to low)</option>
      <option value="exp">Experience (high to low)</option>
      <option value="name">Name (A to Z)</option>
    </select>
  </label>
  <span class="muted" id="visibleCount"></span>
</div>

<table id="rankTable">
  <thead>
    <tr>
      <th>#</th><th>Candidate</th><th>Subject</th><th>Total Exp</th><th>Current Salary</th><th>Expected Salary</th><th>Score</th><th>Role Fit</th><th>Details</th><th>Action</th>
    </tr>
  </thead>
  <tbody>${rows}
  </tbody>
</table>

<!-- Draft Reply Modal -->
<div class="modal-overlay" id="draftModal">
  <div class="modal">
    <h2 id="modalTitle">Draft Reply</h2>
    <div class="modal-info" id="modalInfo"></div>
    <label><strong>Your Instructions:</strong></label>
    <textarea class="instructions" id="instructionsInput" placeholder="e.g. Schedule an interview next Tuesday at 3pm. Ask them to confirm."></textarea>
    <button class="btn-generate" id="generateBtn">Generate Draft</button>
    <div id="statusMsg"></div>
    <label><strong>Draft (editable):</strong></label>
    <textarea class="draft-preview" id="draftPreview" placeholder="Draft will appear here after you click Generate..."></textarea>
    <div class="modal-actions">
      <button class="btn-cancel" id="cancelBtn">Cancel</button>
      <button class="btn-send" id="sendBtn" disabled>Send Reply</button>
    </div>
  </div>
</div>

<script>
  // --- Filters ---
  const scoreFilter = document.getElementById('scoreFilter');
  const scoreVal = document.getElementById('scoreVal');
  const searchFilter = document.getElementById('searchFilter');
  const sortBy = document.getElementById('sortBy');
  const visibleCount = document.getElementById('visibleCount');
  const tbody = document.querySelector('#rankTable tbody');
  const tableRows = Array.from(tbody.querySelectorAll('tr'));

  function applyFilters() {
    const minScore = parseInt(scoreFilter.value, 10);
    const q = searchFilter.value.toLowerCase().trim();
    let shown = 0;
    let visibleRows = [];
    tableRows.forEach(r => {
      const score = parseInt(r.dataset.score, 10);
      const name = r.dataset.name || '';
      const skills = r.dataset.skills || '';
      const matchesScore = score >= minScore;
      const matchesQuery = !q || name.includes(q) || skills.includes(q);
      if (matchesScore && matchesQuery) { visibleRows.push(r); shown++; }
      else { r.style.display = 'none'; }
    });
    visibleRows.sort((a, b) => {
      if (sortBy.value === 'score') return parseInt(b.dataset.score,10) - parseInt(a.dataset.score,10);
      if (sortBy.value === 'exp') return (parseFloat(b.dataset.exp) || -1) - (parseFloat(a.dataset.exp) || -1);
      if (sortBy.value === 'name') return (a.dataset.name || '').localeCompare(b.dataset.name || '');
      return 0;
    });
    visibleRows.forEach((r, i) => {
      r.style.display = '';
      r.querySelector('td').textContent = i + 1;
    });
    visibleCount.textContent = shown + ' of ' + tableRows.length + ' shown';
  }

  scoreFilter.addEventListener('input', () => { scoreVal.textContent = scoreFilter.value; applyFilters(); });
  searchFilter.addEventListener('input', applyFilters);
  sortBy.addEventListener('change', applyFilters);
  applyFilters();

  // --- Draft Modal ---
  const modal = document.getElementById('draftModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalInfo = document.getElementById('modalInfo');
  const instructionsInput = document.getElementById('instructionsInput');
  const generateBtn = document.getElementById('generateBtn');
  const draftPreview = document.getElementById('draftPreview');
  const sendBtn = document.getElementById('sendBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const statusMsg = document.getElementById('statusMsg');
  let currentCid = null;

  function showStatus(msg, type) {
    statusMsg.textContent = msg;
    statusMsg.className = 'status-msg ' + type;
  }

  function openModal(cid, name) {
    currentCid = cid;
    modalTitle.textContent = 'Draft Reply to ' + name;
    modalInfo.textContent = 'Candidate ID: ' + cid;
    instructionsInput.value = '';
    draftPreview.value = '';
    sendBtn.disabled = true;
    showStatus('', '');
    modal.classList.add('active');
  }

  function closeModal() {
    modal.classList.remove('active');
    currentCid = null;
  }

  // Attach Draft Reply buttons
  document.querySelectorAll('.draft-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openModal(btn.dataset.cid, btn.dataset.name);
    });
  });

  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  // Generate Draft
  generateBtn.addEventListener('click', async () => {
    const instructions = instructionsInput.value.trim();
    if (!instructions) { showStatus('Please enter instructions for the draft.', 'error'); return; }
    generateBtn.classList.add('btn-loading');
    generateBtn.textContent = 'Generating...';
    showStatus('Generating draft via LLM...', 'info');
    try {
      const res = await fetch('http://localhost:' + ${SERVER_PORT} + '/api/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: currentCid, instructions })
      });
      const data = await res.json();
      if (data.success) {
        draftPreview.value = data.draftText;
        sendBtn.disabled = false;
        showStatus('Draft generated. Review and edit above, then click Send.', 'success');
      } else {
        showStatus('Error: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      showStatus('Network error: ' + err.message, 'error');
    }
    generateBtn.classList.remove('btn-loading');
    generateBtn.textContent = 'Generate Draft';
  });

  // Send Reply
  sendBtn.addEventListener('click', async () => {
    const draftText = draftPreview.value.trim();
    if (!draftText) { showStatus('Draft is empty.', 'error'); return; }
    sendBtn.classList.add('btn-loading');
    sendBtn.textContent = 'Sending...';
    showStatus('Sending email via Gmail...', 'info');
    try {
      const res = await fetch('http://localhost:' + ${SERVER_PORT} + '/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: currentCid, draftText })
      });
      const data = await res.json();
      if (data.success) {
        showStatus('Email sent successfully!', 'success');
        // Mark button as sent
        const btn = document.querySelector('.draft-btn[data-cid="' + currentCid + '"]');
        if (btn) { btn.textContent = 'Sent'; btn.classList.add('sent'); btn.disabled = true; }
        setTimeout(closeModal, 1500);
      } else {
        showStatus('Error: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      showStatus('Network error: ' + err.message, 'error');
    }
    sendBtn.classList.remove('btn-loading');
    sendBtn.textContent = 'Send Reply';
  });
</script>
</body>
</html>`;
}

// --- 5. Local HTTP server for draft + send ---
function startServer(candidates) {
  // Save candidate data for server lookup
  const candidateMap = {};
  for (const c of candidates) {
    candidateMap[c.id] = {
      id: c.id,
      name: c.name,
      from: c.from,
      subject: c.subject,
      bodyText: c.bodyText,
      messageIdHeader: c.messageIdHeader,
      referencesHeader: c.referencesHeader
    };
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(candidateMap, null, 2), "utf8");

  const server = http.createServer(async (req, res) => {
    // CORS + JSON helpers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // Serve the HTML report at /
    if (req.method === "GET" && req.url === "/") {
      const html = fs.readFileSync(REPORT_FILE, "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    // API endpoints
    if (req.method === "POST" && (req.url === "/api/draft" || req.url === "/api/send")) {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
          const candidate = data[payload.candidateId];
          if (!candidate) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Candidate not found" }));
            return;
          }

          if (req.url === "/api/draft") {
            // Generate draft via LLM
            const emailContext = `Subject: ${candidate.subject}\n\nBody:\n${candidate.bodyText}`;
            const draftText = await generateDraft(emailContext, payload.instructions);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, draftText }));
          } else if (req.url === "/api/send") {
            // Send reply via Gmail
            const gmail = getGmailClient();
            const emailMatch = candidate.from.match(/<(.+?)>/);
            const toEmail = emailMatch ? emailMatch[1] : candidate.from;
            await sendReply(
              gmail,
              toEmail,
              candidate.subject,
              payload.draftText,
              candidate.messageIdHeader,
              candidate.referencesHeader
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          }
        } catch (err) {
          console.error("Server error:", err.message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(SERVER_PORT, () => {
    console.log(`\n🌐 Local server running at http://localhost:${SERVER_PORT}`);
    console.log("   Draft & Send API available at /api/draft and /api/send");
    console.log("   Press Ctrl+C to stop.\n");
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`\n❌ Port ${SERVER_PORT} is already in use. Set RANKER_PORT in .env to a different port.`);
    } else {
      console.error("\n❌ Server error:", e.message);
    }
    process.exit(1);
  });
}

// --- Main ---
(async () => {
  const jd = await readJD();
  if (!jd) { console.error("❌ No JD provided. Exiting."); process.exit(1); }
  console.log(`\n✅ JD received (${jd.length} chars). Lookback: ${LOOKBACK_DAYS} days.`);

  const { gmail, messages } = await fetchEmailsSince(LOOKBACK_DAYS);
  if (messages.length === 0) { console.log("No emails found in the window."); process.exit(0); }

  console.log("\n🔍 Classifying & scoring candidates...\n");
  const candidates = await processCandidates(gmail, messages, jd);

  if (candidates.length === 0) {
    console.log("\n⚠️ No job applications found in the last " + LOOKBACK_DAYS + " days.");
    process.exit(0);
  }

  // Generate + write HTML
  const html = generateHTML(jd, candidates);
  fs.writeFileSync(REPORT_FILE, html, "utf8");
  console.log(`\n📊 Report written to ${REPORT_FILE}`);
  console.log(`   ${candidates.length} candidate(s) ranked.`);

  // Start local server (serves HTML + API for draft/send)
  startServer(candidates);

  // Open in default browser (macOS) — use server URL so API calls work
  const { exec } = require("child_process");
  exec(`open "http://localhost:${SERVER_PORT}"`);
  console.log(`   Opening http://localhost:${SERVER_PORT} in browser...`);
})();
