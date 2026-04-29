// Eva Background Service Worker — Persistent & Immortal
// Uses chrome.storage.session to survive service worker restarts.
// Mic permission is managed in the offscreen document — requested ONCE,
// kept alive across page navigations, only released when Eva is disabled.

let isEvaActive = false;
let isTalking = false;
let isUserTalkingLocally = false;
let sessionStart = null;

// ─── Persistence Layer ─────────────────────────────────────────
async function saveState() {
  await chrome.storage.session.set({
    isEvaActive,
    isTalking,
    isUserTalkingLocally,
    sessionStart,
  });
}

async function restoreState() {
  const data = await chrome.storage.session.get([
    'isEvaActive', 'isTalking', 'isUserTalkingLocally', 'sessionStart',
  ]);
  isEvaActive = data.isEvaActive ?? false;
  isTalking = data.isTalking ?? false;
  isUserTalkingLocally = data.isUserTalkingLocally ?? false;
  sessionStart = data.sessionStart ?? null;
}

// ─── Keepalive Alarm ────────────────────────────────────────────
const KEEPALIVE_ALARM = 'eva-keepalive';

async function startKeepalive() {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
}

async function stopKeepalive() {
  await chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Wakes the SW to keep it alive.
    // If Eva is active, ensure the offscreen doc + session are running.
    await restoreState();
    if (isEvaActive) {
      const hadToCreate = await ensureOffscreenDocument();
      if (hadToCreate) {
        // The offscreen doc was killed by Chrome — restart the session.
        // The persistent mic in the NEW doc will re-acquire (one-time prompt
        // only if Chrome revoked the extension's mic permission).
        console.log('[Eva BG] Offscreen doc was recreated by keepalive — restarting session.');
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_START' }).catch(() => {});
      }
    }
  }
});

// ─── Offscreen Document ─────────────────────────────────────────
// Returns true if a NEW document was created, false if one already existed.
async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) return false;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Continuously listen to microphone and play voice replies securely in background.',
  });

  return true;
}

async function destroyOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) {
    // Tell the offscreen doc to release mic + cleanup before we close it
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_DESTROY' }).catch(() => {});
    // Give it a moment to clean up, then close
    await new Promise((r) => setTimeout(r, 300));
    await chrome.offscreen.closeDocument();
  }
}

// ─── Toggle ─────────────────────────────────────────────────────
async function toggleEva() {
  isEvaActive = !isEvaActive;

  if (isEvaActive) {
    sessionStart = Date.now();
    await startKeepalive();
    await ensureOffscreenDocument();
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_START' }).catch(() => {});
  } else {
    sessionStart = null;
    isTalking = false;
    isUserTalkingLocally = false;
    await saveState();
    updateAllTabs();
    // Tell offscreen to request feedback and wait, then tear down
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
    // Wait for feedback to finish (offscreen waits 20s, we wait 22s)
    await new Promise(r => setTimeout(r, 22000));
    await stopKeepalive();
    await destroyOffscreenDocument();
  }

  await saveState();
  updateAllTabs();
}

// ─── Toolbar Icon Click ─────────────────────────────────────────
chrome.action.onClicked.addListener(() => {
  toggleEva();
});

// ─── Message Router ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    sendResponse({
      active: isEvaActive,
      talking: isTalking,
      userTalking: isUserTalkingLocally,
      sessionStart,
    });
    return true;
  }

  if (msg.type === 'TOGGLE_EVA') {
    toggleEva().then(() => {
      sendResponse({
        active: isEvaActive,
        talking: isTalking,
        userTalking: isUserTalkingLocally,
        sessionStart,
      });
    });
    return true;
  }

  if (msg.type === 'MIC_DENIED') {
    isEvaActive = false;
    saveState();
    stopKeepalive();
    destroyOffscreenDocument();
    updateAllTabs();
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?auto=true') });
    return;
  }

  if (msg.type === 'STATE_DATA') {
    isTalking = msg.talking;
    saveState();
    updateAllTabs();
    return;
  }

  if (msg.type === 'USER_TALKING') {
    isUserTalkingLocally = msg.talking;
    saveState();
    updateAllTabs();
    return;
  }

  if (msg.type === 'MIC_DATA') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'MIC_DATA', vol: msg.vol, bins: msg.bins,
        }).catch(() => {});
      }
    });
    chrome.runtime.sendMessage({ type: 'MIC_DATA', vol: msg.vol, bins: msg.bins }).catch(() => {});
    return;
  }

  if (msg.type === 'TRANSCRIPT_DATA') {
    broadcastTranscript(msg.text);
    return;
  }

  // Forward real-time grammar analysis to the active tab
  if (msg.type === 'ANALYSIS_DATA') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'ANALYSIS', analysis: msg.analysis,
        }).catch(() => {});
      }
    });
    return;
  }

  // Forward full feedback data to the active tab
  if (msg.type === 'FEEDBACK_DATA') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'FEEDBACK', stats: msg.stats, text: msg.text,
        }).catch(() => {});
      }
    });
    return;
  }
});

// ─── Broadcast Helpers ──────────────────────────────────────────
function updateAllTabs() {
  chrome.tabs.query({}, (tabs) => {
    const payload = {
      type: 'STATE_UPDATE',
      active: isEvaActive,
      talking: isTalking,
      userTalking: isUserTalkingLocally,
      sessionStart,
    };
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
    });
  });
}

function broadcastTranscript(text) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'TRANSCRIPT',
        text,
      }).catch(() => {});
    }
  });
}

// ─── Tab Lifecycle: push state to every new / navigated tab ─────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    chrome.tabs.sendMessage(tabId, {
      type: 'STATE_UPDATE',
      active: isEvaActive,
      talking: isTalking,
      userTalking: isUserTalkingLocally,
      sessionStart,
    }).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.sendMessage(tabId, {
    type: 'STATE_UPDATE',
    active: isEvaActive,
    talking: isTalking,
    userTalking: isUserTalkingLocally,
    sessionStart,
  }).catch(() => {});
});

// ─── Startup & Install: restore state ───────────────────────────
async function resumeIfActive() {
  await restoreState();
  if (isEvaActive) {
    await startKeepalive();
    const hadToCreate = await ensureOffscreenDocument();
    // Always send OFFSCREEN_START on resume — the offscreen doc's
    // startSession() is idempotent (returns immediately if already running)
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_START' }).catch(() => {});
    updateAllTabs();
  }
}

chrome.runtime.onStartup.addListener(resumeIfActive);
chrome.runtime.onInstalled.addListener(resumeIfActive);

// Also restore immediately when this script loads (covers SW wakeups mid-session)
resumeIfActive();
