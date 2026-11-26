// Background service worker for the Claude File Manager browser extension.
// Handles browser-level actions that content scripts can't do alone:
//   - captureVisibleTab (screenshot of the current tab)
//
// Content scripts send messages here via chrome.runtime.sendMessage.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "captureVisibleTab") {
    chrome.tabs.captureVisibleTab(
      null,
      { format: "png", quality: 90 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, data: dataUrl });
        }
      },
    );
    return true; // keep channel open for async response
  }
  return false;
});
