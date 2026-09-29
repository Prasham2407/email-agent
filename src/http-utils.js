/**
 * Wraps an async function with retry logic for 429 (rate limit) and 5xx errors.
 * Uses exponential backoff: waits 2s, 4s, 8s between retries.
 *
 * @param {Function} fn - async function to execute
 * @param {number} maxRetries - default 3
 * @returns {Promise<any>} result of fn
 */
async function withRetry(fn, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status || err.status;
      const is429 = status === 429;
      const is5xx = status && status >= 500 && status < 600;

      if (!is429 && !is5xx) throw err; // non-retryable error, fail fast

      if (attempt < maxRetries) {
        // Check for Retry-After header on 429
        const retryAfter = err.response?.headers?.["retry-after"];
        let waitMs;
        if (retryAfter) {
          waitMs = parseInt(retryAfter, 10) * 1000;
        } else {
          waitMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
        }
        console.log(`   ⏳ Rate limited (429/5xx), retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Simple delay helper to space out API calls.
 * @param {number} ms - milliseconds to sleep
 */
async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { withRetry, sleep };
