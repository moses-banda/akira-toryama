// Eva Invisible Audio Engine — Persistent Mic Session
// This document stays alive as long as Eva is active.
// Mic permission is granted ONCE and held until Eva is disabled.
// No window.close() — the background controls our lifecycle.

const { Room, RoomEvent, VideoPresets, Track, createLocalAudioTrack } = window.LivekitClient;

// Load central config (EVA_CONFIG.SERVER_URL)  — set in config.js

let currentRoom = null;
let micAudioTrack = null;     // Persistent mic handle — survives room disconnects
let micCtx = null;            // AudioContext for analyzer
let micAnalyzer = null;
let micBuffer = null;
let analyzerInterval = null;

// ─── Acquire mic ONCE, keep it alive ─────────────────────────────
async function acquireMic() {
  if (micAudioTrack) return micAudioTrack; // Already have it

  try {
    micAudioTrack = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    console.log('[Eva Offscreen] Mic acquired — will not re-request until disabled.');

    // Set up the hardware audio analyzer on this permanent mic reference
    setupAudioAnalyzer(micAudioTrack);

    return micAudioTrack;
  } catch (err) {
    console.error('[Eva Offscreen] Mic acquisition failed:', err);
    if (err.name === 'NotAllowedError' || /permission/i.test(err.message)) {
      chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', text: 'Error: Microphone Denied.' });
      chrome.runtime.sendMessage({ type: 'MIC_DENIED' });
    }
    throw err;
  }
}

// ─── Audio Analyzer (runs continuously while mic is open) ────────
function setupAudioAnalyzer(audioTrack) {
  if (analyzerInterval) return; // Already running

  try {
    const localStream = new MediaStream([audioTrack.mediaStreamTrack]);
    micCtx = new (window.AudioContext || window.webkitAudioContext)();
    const micSource = micCtx.createMediaStreamSource(localStream);
    micAnalyzer = micCtx.createAnalyser();
    micSource.connect(micAnalyzer);
    micBuffer = new Uint8Array(micAnalyzer.frequencyBinCount);

    let isUserTalkingLocally = false;
    let silenceFrames = 0;

    analyzerInterval = setInterval(() => {
      if (micCtx.state === 'suspended') micCtx.resume();
      if (!currentRoom) return; // Only send data when connected to a room

      micAnalyzer.getByteFrequencyData(micBuffer);
      const vol = micBuffer.reduce((a, b) => a + b, 0) / micBuffer.length;

      // Equalizer bins for visual feedback
      const bins = [];
      const step = Math.floor(micBuffer.length / 12);
      for (let i = 0; i < 12; i++) {
        bins.push(Math.round((micBuffer[i * step] / 255) * 20));
      }
      chrome.runtime.sendMessage({ type: 'MIC_DATA', vol, bins }).catch(() => {});

      const currentlyTalking = vol > 2;

      if (currentlyTalking && !isUserTalkingLocally) {
        isUserTalkingLocally = true;
        chrome.runtime.sendMessage({ type: 'USER_TALKING', talking: true }).catch(() => {});
        silenceFrames = 0;
      } else if (!currentlyTalking && isUserTalkingLocally) {
        silenceFrames++;
        if (silenceFrames > 5) {
          isUserTalkingLocally = false;
          chrome.runtime.sendMessage({ type: 'USER_TALKING', talking: false }).catch(() => {});
        }
      } else if (currentlyTalking) {
        silenceFrames = 0;
      }
    }, 50);
  } catch (e) {
    console.warn('[Eva Offscreen] Audio analyzer setup failed:', e);
  }
}

// ─── Start LiveKit Session (uses persistent mic) ─────────────────
async function startSession() {
  if (currentRoom) return; // Already connected

  try {
    // 1. Acquire mic (no-op if already acquired)
    const track = await acquireMic();

    // 2. Get LiveKit token
    const resp = await fetch(`${EVA_CONFIG.SERVER_URL}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_name: 'Sidekick User' }),
    });
    if (!resp.ok) throw new Error('Failed to get token.');
    const { token, url } = await resp.json();

    // 3. Create room and connect
    currentRoom = new Room({
      adaptiveStream: true,
      dynacast: true,
      publishDefaults: { audioPreset: VideoPresets.h90 },
    });

    currentRoom.on(RoomEvent.DataReceived, (payload) => {
      const data = JSON.parse(new TextDecoder().decode(payload));
      console.log(`[LIVEKIT] Received ${payload.byteLength} bytes ->`, data);

      if (data.type === 'transcript') {
        chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', text: `${data.name}: ${data.text}` });
      } else if (data.type === 'analysis') {
        // Real-time grammar analysis from Groq
        chrome.runtime.sendMessage({ type: 'ANALYSIS_DATA', analysis: data }).catch(() => {});
      } else if (data.type === 'feedback') {
        chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', text: `Insights: ${data.text}` });
        // Also send structured feedback stats
        if (data.stats) {
          chrome.runtime.sendMessage({ type: 'FEEDBACK_DATA', stats: data.stats, text: data.text }).catch(() => {});
        }
      } else if (data.type === 'status' && data.message === 'analyzing') {
        chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', text: 'Eva is analyzing your style...' });
      }
    });

    currentRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      let evaTalking = false;
      speakers.forEach((p) => {
        if (p !== currentRoom.localParticipant) {
          evaTalking = true;
        }
      });
      chrome.runtime.sendMessage({ type: 'STATE_DATA', talking: evaTalking }).catch(() => {});
    });

    currentRoom.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'audio') {
        const audio = track.attach();
        document.body.appendChild(audio);
      }
    });

    await currentRoom.connect(url, token);

    // 4. Publish the SAME persistent mic track (no new permission prompt)
    await currentRoom.localParticipant.publishTrack(track);
    chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', text: 'Eva is listening... ✨' });

  } catch (err) {
    console.error('[Eva Offscreen] Session error:', err);
    // Only send MIC_DENIED for actual permission errors — not network failures
    if (err.name === 'NotAllowedError' || /permission/i.test(err.message)) {
      chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', text: 'Error: Microphone Denied.' });
      chrome.runtime.sendMessage({ type: 'MIC_DENIED' });
    } else {
      chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', text: 'Connection error. Is Server running?' });
    }
    // Clean up partial room if connection failed
    if (currentRoom) {
      try { await currentRoom.disconnect(); } catch (_) {}
      currentRoom = null;
    }
  }
}

// ─── Stop Session (request feedback FIRST, then disconnect) ──────
async function stopSession() {
  if (currentRoom) {
    chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', text: 'Eva is generating your feedback...' }).catch(() => {});

    // Tell the agent to generate feedback NOW, before we disconnect
    try {
      const msg = JSON.stringify({ type: 'request_feedback' });
      await currentRoom.localParticipant.publishData(new TextEncoder().encode(msg), { reliable: true });
    } catch (e) {
      console.warn('[Eva Offscreen] Failed to request feedback:', e);
    }

    // Wait up to 20 seconds for the feedback to arrive, then disconnect
    await new Promise(resolve => setTimeout(resolve, 20000));

    await currentRoom.disconnect();
    currentRoom = null;
    chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', text: 'Session complete.' }).catch(() => {});
  }
}

// ─── Release everything (only when background explicitly kills us) ─
function fullShutdown() {
  if (analyzerInterval) {
    clearInterval(analyzerInterval);
    analyzerInterval = null;
  }
  if (micCtx) {
    micCtx.close().catch(() => {});
    micCtx = null;
  }
  if (micAudioTrack) {
    micAudioTrack.stop();
    micAudioTrack = null;
  }
  if (currentRoom) {
    currentRoom.disconnect().catch(() => {});
    currentRoom = null;
  }
}

// ─── Message Listener ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OFFSCREEN_START') {
    startSession();
  }
  if (msg.type === 'OFFSCREEN_STOP') {
    stopSession();
  }
  if (msg.type === 'OFFSCREEN_DESTROY') {
    // Full teardown — only sent when Eva is toggled OFF
    fullShutdown();
  }
});
