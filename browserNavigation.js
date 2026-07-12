function navigationErrorMessage(error) {
  return String(error && error.message ? error.message : error);
}

function isResourceExhaustionError(error) {
  return /ERR_INSUFFICIENT_RESOURCES|ERR_OUT_OF_MEMORY|Aw\s*snap|Target crashed|ERR_CONNECTION_RESET|ERR_SOCKET_NOT_CONNECTED|ERR_NETWORK_CHANGED|ERR_HTTP2_PROTOCOL_ERROR/i.test(
    navigationErrorMessage(error)
  );
}

function isTransientNavigationError(error) {
  const msg = navigationErrorMessage(error);
  return (
    isResourceExhaustionError(error) ||
    /ERR_ABORTED|Execution context was destroyed|interrupted by another navigation|Navigation failed because page was closed/i.test(
      msg
    )
  );
}

function navigationRetryDelayMs(attempt, error) {
  if (isResourceExhaustionError(error)) {
    return Math.min(30000, 3000 * 2 ** attempt);
  }
  return 250 + attempt * 250;
}

async function safeGotoWithRetry(page, url, options = {}, retries = 3) {
  const gotoOptions = { waitUntil: "domcontentloaded", timeout: 60000, ...options };
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (!page || page.isClosed()) {
      throw new Error("Session page is currently unavailable.");
    }

    try {
      await page.goto(url, gotoOptions);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientNavigationError(error) || attempt >= retries) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(navigationRetryDelayMs(attempt, error)).catch(() => {});
    }
  }

  if (lastError) {
    throw lastError;
  }
}

module.exports = {
  navigationErrorMessage,
  isResourceExhaustionError,
  isTransientNavigationError,
  navigationRetryDelayMs,
  safeGotoWithRetry
};
