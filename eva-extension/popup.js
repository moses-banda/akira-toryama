const statusEl = document.getElementById('status');
const orbRoot = document.getElementById('orbRoot');
const grantBtn = document.getElementById('grantBtn');
const timerEl = document.getElementById('eva-session-timer');
const bars = document.querySelectorAll('.eva-bar');
let localSessionInterval = null;

// Send message to background and ask for the current state to populate options
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (response) {
      updateUI(response.active, response.talking, response.userTalking, response.sessionStart);
    }
});

grantBtn.addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop()); // Stop immediately
        grantBtn.textContent = "Mic Granted ✓";
        grantBtn.style.background = "#059669";
    } catch (err) {
        grantBtn.textContent = "Denied! Check Chrome Settings";
        grantBtn.style.background = "#dc2626";
    }
});

orbRoot.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_EVA' }, (res) => {
       if (res) updateUI(res.active, res.talking, res.userTalking, res.sessionStart);
    });
});

// Auto-Prompt Logic
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('auto')) {
    setTimeout(() => grantBtn.click(), 500);
}

function updateUI(active, talking, userTalking, sessionStart) {
    if (active) {
        statusEl.textContent = "Eva is Listening...";
        statusEl.style.color = "#a855f7"; // purple
        orbRoot.classList.remove('eva-sleeping');
        if (userTalking) orbRoot.classList.add('user-talking');
        else orbRoot.classList.remove('user-talking');

        if (sessionStart && !localSessionInterval) {
            localSessionInterval = setInterval(() => {
                const e = Math.floor((Date.now() - sessionStart) / 1000);
                timerEl.textContent = `${String(Math.floor(e/3600)).padStart(2,'0')}:${String(Math.floor(e%3600/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
            }, 1000);
        }
    } else {
        statusEl.textContent = "Eva is Asleep";
        statusEl.style.color = "#94a3b8"; // grey
        orbRoot.classList.add('eva-sleeping');
        orbRoot.classList.remove('user-talking');
        if (localSessionInterval) {
            clearInterval(localSessionInterval);
            localSessionInterval = null;
        }
    }
}

// Keep popup natively reactive while open
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_UPDATE') {
        updateUI(msg.active, msg.talking, msg.userTalking, msg.sessionStart);
    }
    if (msg.type === 'MIC_DATA' && bars.length === 12) {
        msg.bins.forEach((val, i) => {
            bars[i].style.height = Math.max(3, val) + 'px';
        });
    }
});
