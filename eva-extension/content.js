// Eva Universal Content Script — Bulletproof Orb
// Persists across navigations, SPA route changes, and DOM mutations.
// Self-heals if removed. Polls background for state on every page load.

let orbRoot = null;
let overlay = null;
let timerEl = null;
let freqBars = null;
let analysisPanel = null;
let fluencyBadge = null;
let bars = [];
let localSessionInterval = null;
let localSessionStart = null;
let orbObserver = null; // MutationObserver to detect orb removal
let analysisTimeout = null;

// ─── Save & restore orb position via chrome.storage.local ──────
async function saveOrbPosition(x, y) {
  try {
    await chrome.storage.local.set({ evaOrbX: x, evaOrbY: y });
  } catch (_) {}
}

async function restoreOrbPosition() {
  try {
    const data = await chrome.storage.local.get(['evaOrbX', 'evaOrbY']);
    if (data.evaOrbX != null && data.evaOrbY != null) {
      orbRoot.style.position = 'fixed';
      orbRoot.style.right = 'auto';
      orbRoot.style.bottom = 'auto';
      orbRoot.style.left = data.evaOrbX + 'px';
      orbRoot.style.top = data.evaOrbY + 'px';
    }
  } catch (_) {}
}

// ─── Inject the orb into the page ───────────────────────────────
function injectEva() {
  // Remove any stale orb if it somehow exists
  const existing = document.getElementById('eva-siri-orb-root');
  if (existing) existing.remove();
  const existingOverlay = document.getElementById('eva-transcript-overlay');
  if (existingOverlay) existingOverlay.remove();
  const existingAnalysis = document.getElementById('eva-analysis-panel');
  if (existingAnalysis) existingAnalysis.remove();

  // Reset references
  orbRoot = null;
  overlay = null;
  timerEl = null;
  freqBars = null;
  analysisPanel = null;
  fluencyBadge = null;
  bars = [];

  orbRoot = document.createElement('div');
  orbRoot.id = 'eva-siri-orb-root';
  orbRoot.className = 'eva-sleeping'; // Sleeping by default

  const glow = document.createElement('div');
  glow.className = 'eva-orb-glow';

  const orb = document.createElement('div');
  orb.className = 'eva-orb';

  overlay = document.createElement('div');
  overlay.id = 'eva-transcript-overlay';
  overlay.textContent = 'Eva is listening...';

  timerEl = document.createElement('div');
  timerEl.id = 'eva-session-timer';
  timerEl.textContent = '00:00:00';

  freqBars = document.createElement('div');
  freqBars.id = 'eva-freq-bars';
  for (let i = 0; i < 12; i++) {
    const b = document.createElement('div');
    b.className = 'eva-bar';
    freqBars.appendChild(b);
    bars.push(b);
  }

  // Fluency badge on the orb
  fluencyBadge = document.createElement('div');
  fluencyBadge.id = 'eva-fluency-badge';
  fluencyBadge.textContent = '';

  // Analysis panel (grammar corrections, stats)
  analysisPanel = document.createElement('div');
  analysisPanel.id = 'eva-analysis-panel';

  orbRoot.appendChild(timerEl);
  orbRoot.appendChild(glow);
  orbRoot.appendChild(orb);
  orbRoot.appendChild(fluencyBadge);
  orbRoot.appendChild(freqBars);
  document.body.appendChild(orbRoot);
  document.body.appendChild(overlay);
  document.body.appendChild(analysisPanel);

  // Restore saved position
  restoreOrbPosition();

  // ─── Draggable Logic ─────────────────────────────────────────
  let isDragging = false;
  let offsetX, offsetY;
  let hasDragged = false;
  let startX, startY;

  orbRoot.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    isDragging = true;
    hasDragged = false;
    startX = e.clientX;
    startY = e.clientY;

    const rect = orbRoot.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    orbRoot.style.transition = 'none';
    orbRoot.style.position = 'fixed';
    orbRoot.style.right = 'auto';
    orbRoot.style.bottom = 'auto';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    if (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5) {
      hasDragged = true;
    }
    orbRoot.style.left = (e.clientX - offsetX) + 'px';
    orbRoot.style.top = (e.clientY - offsetY) + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      orbRoot.style.transition = '0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';

      // Persist the drag position
      const rect = orbRoot.getBoundingClientRect();
      saveOrbPosition(rect.left, rect.top);
    }
  });

  orbRoot.onclick = (e) => {
    if (hasDragged) return;
    chrome.runtime.sendMessage({ type: 'TOGGLE_EVA' });
  };

  // ─── Self-Healing: watch for DOM removal ─────────────────────
  setupOrbWatcher();
}

// Watch for the orb being removed from the DOM (e.g., aggressive page JS clearing body)
function setupOrbWatcher() {
  if (orbObserver) orbObserver.disconnect();

  orbObserver = new MutationObserver(() => {
    if (!document.getElementById('eva-siri-orb-root') && document.body) {
      // Orb was removed! Re-inject immediately.
      console.log('[Eva] Orb removed from DOM — re-injecting...');
      injectEva();
      // Re-sync state from background
      requestStateSync();
    }
  });

  orbObserver.observe(document.body, { childList: true, subtree: false });
}

// ─── State Application ─────────────────────────────────────────
function applyState(msg) {
  if (!orbRoot) return;

  if (msg.active) {
    orbRoot.classList.remove('eva-sleeping');

    if (msg.talking) orbRoot.classList.add('eva-talking');
    else orbRoot.classList.remove('eva-talking');

    if (msg.userTalking) orbRoot.classList.add('user-talking');
    else orbRoot.classList.remove('user-talking');

    if (msg.sessionStart) {
      localSessionStart = msg.sessionStart;
      if (!localSessionInterval) {
        localSessionInterval = setInterval(() => {
          const e = Math.floor((Date.now() - localSessionStart) / 1000);
          timerEl.textContent =
            `${String(Math.floor(e / 3600)).padStart(2, '0')}:${String(Math.floor((e % 3600) / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
        }, 1000);
      }
    }
  } else {
    orbRoot.classList.add('eva-sleeping');
    orbRoot.classList.remove('eva-talking');
    orbRoot.classList.remove('user-talking');
    overlay.classList.remove('active');
    if (localSessionInterval) {
      clearInterval(localSessionInterval);
      localSessionInterval = null;
    }
    if (timerEl) timerEl.textContent = '00:00:00';
  }
}

// ─── Ask background for current state (on page load / re-inject) ─
function requestStateSync() {
  try {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
      if (chrome.runtime.lastError) return; // Extension context may not be ready yet
      if (response) {
        applyState(response);
      }
    });
  } catch (_) {}
}

// ─── Message Listener (background pushes updates here) ─────────
chrome.runtime.onMessage.addListener((msg) => {
  // Ensure orb exists before processing any visual state
  if (!orbRoot || !document.getElementById('eva-siri-orb-root')) {
    injectEva();
  }

  if (msg.type === 'STATE_UPDATE') {
    applyState(msg);
  }

  if (msg.type === 'MIC_DATA' && bars.length === 12) {
    msg.bins.forEach((val, i) => {
      bars[i].style.height = Math.max(3, val) + 'px';
    });
  }

  if (msg.type === 'TRANSCRIPT') {
    overlay.textContent = `"${msg.text}"`;
    overlay.classList.add('active');
    setTimeout(() => {
      overlay.classList.remove('active');
    }, 5000);
  }

  // ─── Real-time Grammar Analysis Display ──────────────────────
  if (msg.type === 'ANALYSIS' && msg.analysis && analysisPanel) {
    const a = msg.analysis;
    let html = '';

    // Grammar corrections
    if (a.grammar_issues && a.grammar_issues.length > 0) {
      html += '<div class="eva-analysis-section">';
      html += '<span class="eva-analysis-label">✏️ Grammar</span>';
      a.grammar_issues.forEach(issue => {
        html += `<div class="eva-grammar-fix">`;
        html += `<span class="eva-wrong">${issue.original}</span>`;
        html += `<span class="eva-arrow">→</span>`;
        html += `<span class="eva-correct">${issue.corrected}</span>`;
        html += `</div>`;
      });
      html += '</div>';
    }

    // Bucket stats bar
    if (a.bucket_stats) {
      html += '<div class="eva-analysis-stats">';
      html += `<span>🎯 ${a.bucket_stats.avg_fluency}/10</span>`;
      html += `<span>💬 ${a.bucket_stats.total} utterances</span>`;
      html += `<span>⭐ ${a.bucket_stats.key_count} key</span>`;
      if (a.bucket_stats.issue_count > 0) {
        html += `<span>⚠️ ${a.bucket_stats.issue_count} fixes</span>`;
      }
      html += '</div>';
    }

    // Update fluency badge on orb
    if (a.fluency_score && fluencyBadge) {
      fluencyBadge.textContent = a.fluency_score;
      fluencyBadge.className = 'eva-fluency-show';
      if (a.fluency_score >= 8) fluencyBadge.classList.add('eva-fluency-high');
      else if (a.fluency_score >= 5) fluencyBadge.classList.add('eva-fluency-mid');
      else fluencyBadge.classList.add('eva-fluency-low');
    }

    if (html) {
      analysisPanel.innerHTML = html;
      analysisPanel.classList.add('active');
      // Position near the orb
      const orbRect = orbRoot.getBoundingClientRect();
      analysisPanel.style.right = (window.innerWidth - orbRect.left + 10) + 'px';
      analysisPanel.style.bottom = (window.innerHeight - orbRect.bottom) + 'px';

      if (analysisTimeout) clearTimeout(analysisTimeout);
      analysisTimeout = setTimeout(() => {
        analysisPanel.classList.remove('active');
      }, 6000);
    }
  }

  // ─── Full Feedback Display ────────────────────────────────────
  if (msg.type === 'FEEDBACK' && msg.stats) {
    const s = msg.stats;
    let html = '<div class="eva-feedback-header">📊 Session Report</div>';
    html += '<div class="eva-analysis-stats">';
    html += `<span>⏱️ ${s.duration_min} min</span>`;
    html += `<span>💬 ${s.utterances} spoken</span>`;
    html += `<span>⭐ ${s.key_sentences} key</span>`;
    html += `<span>🎯 ${s.avg_fluency}/10 fluency</span>`;
    html += `<span>⚠️ ${s.grammar_issues} corrections</span>`;
    html += '</div>';

    analysisPanel.innerHTML = html;
    analysisPanel.classList.add('active');
    analysisPanel.classList.add('eva-feedback-mode');

    const orbRect = orbRoot.getBoundingClientRect();
    analysisPanel.style.right = (window.innerWidth - orbRect.left + 10) + 'px';
    analysisPanel.style.bottom = (window.innerHeight - orbRect.bottom) + 'px';

    // Keep feedback visible longer
    if (analysisTimeout) clearTimeout(analysisTimeout);
    analysisTimeout = setTimeout(() => {
      analysisPanel.classList.remove('active');
      analysisPanel.classList.remove('eva-feedback-mode');
    }, 15000);
  }
});

// ─── SPA Navigation Detection ──────────────────────────────────
// Many modern sites use pushState/replaceState for navigation.
// The orb stays in the DOM since those don't reload the page,
// but we should still re-sync state in case the SW woke up fresh.
let lastUrl = location.href;
const urlWatcher = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    // Small delay to let the new page DOM settle
    setTimeout(() => {
      if (!document.getElementById('eva-siri-orb-root') && document.body) {
        injectEva();
      }
      requestStateSync();
    }, 300);
  }
});
urlWatcher.observe(document.documentElement, { subtree: true, childList: true });

// Also intercept History API directly for comprehensive SPA coverage
const origPushState = history.pushState;
const origReplaceState = history.replaceState;

history.pushState = function () {
  origPushState.apply(this, arguments);
  window.dispatchEvent(new Event('eva-navigation'));
};

history.replaceState = function () {
  origReplaceState.apply(this, arguments);
  window.dispatchEvent(new Event('eva-navigation'));
};

window.addEventListener('popstate', () => {
  window.dispatchEvent(new Event('eva-navigation'));
});

window.addEventListener('eva-navigation', () => {
  setTimeout(() => {
    if (!document.getElementById('eva-siri-orb-root') && document.body) {
      injectEva();
    }
    requestStateSync();
  }, 300);
});

// ─── Focus Sync: when tab becomes visible again, sync state ────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!document.getElementById('eva-siri-orb-root') && document.body) {
      injectEva();
    }
    requestStateSync();
  }
});

// ─── Initial Bootstrap ─────────────────────────────────────────
function bootstrap() {
  if (document.body) {
    injectEva();
    requestStateSync();
  } else {
    // Body doesn't exist yet (very early injection), wait for it
    const wait = new MutationObserver(() => {
      if (document.body) {
        wait.disconnect();
        injectEva();
        requestStateSync();
      }
    });
    wait.observe(document.documentElement, { childList: true });
  }
}

bootstrap();
