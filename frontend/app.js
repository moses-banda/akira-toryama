// Eva — Siri Orb logic
const { Room, RoomEvent, VideoPresets, Track, createLocalAudioTrack } = LivekitClient;

let currentRoom = null;
const orb = document.getElementById('evaOrb');
const statusText = document.getElementById('statusText');
const transcriptArea = document.getElementById('transcript');
const wakeBtn = document.getElementById('wakeBtn');
const sessionTimerEl = document.getElementById('session-timer');
let sessionStartTime = null;
let sessionInterval = null;

const analysisPanel = document.getElementById('analysis-panel');
const fluencyScoreEl = document.getElementById('fluencyScore');
const grammarContentEl = document.getElementById('grammarContent');
const bucketStatsEl = document.getElementById('bucketStats');
let panelTimeout = null;

function setStatus(text, color = null) {
  statusText.textContent = text;
  if (color) statusText.style.color = color;
}

function updateTranscript(text) {
  transcriptArea.style.opacity = '1';
  transcriptArea.textContent = `"${text}"`;
  setTimeout(() => {
    transcriptArea.style.opacity = '0.4';
  }, 4000);
}

function updateAnalysis(data) {
  if (!analysisPanel) return;
  
  // Show panel
  analysisPanel.classList.add('active');
  
  // Update fluency score
  fluencyScoreEl.textContent = `${data.fluency_score}/10 ${data.vocab_level}`;
  if (data.fluency_score >= 8) fluencyScoreEl.style.color = "#34d399";
  else if (data.fluency_score >= 5) fluencyScoreEl.style.color = "#fbbf24";
  else fluencyScoreEl.style.color = "#f87171";

  // Update grammar
  if (data.grammar_issues && data.grammar_issues.length > 0) {
    grammarContentEl.innerHTML = data.grammar_issues.map(iss => `
      <div class="grammar-item">
        <span class="grammar-wrong">${iss.original}</span> ➔ 
        <span class="grammar-correct">${iss.corrected}</span>
      </div>
    `).join("");
  } else {
    grammarContentEl.innerHTML = `<div style="color: #4ade80; font-size: 14px;">Perfect grammar!</div>`;
  }

  // Update stats
  if (data.bucket_stats) {
    bucketStatsEl.innerHTML = `
      <span>💬 ${data.bucket_stats.total} total</span>
      <span>⭐ ${data.bucket_stats.key_count} key</span>
      <span>⚠️ ${data.bucket_stats.issue_count} fixes</span>
    `;
  }

  // Auto-hide panel after 8 seconds
  if (panelTimeout) clearTimeout(panelTimeout);
  panelTimeout = setTimeout(() => {
    analysisPanel.classList.remove('active');
  }, 8000);
}

async function startEva() {
  try {
    wakeBtn.disabled = true;
    wakeBtn.textContent = "Connecting...";
    setStatus("Waking Eva...");

    const resp = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_name: "Friend" })
    });
    
    if (!resp.ok) throw new Error("Connection failed. Is server running?");
    const { token, url } = await resp.json();

    currentRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
        publishDefaults: { audioPreset: VideoPresets.h90 }
    });

    // Handle incoming data
    currentRoom.on(RoomEvent.DataReceived, (payload) => {
      const data = JSON.parse(new TextDecoder().decode(payload));
      
      if (data.type === 'transcript') {
          updateTranscript(data.text);
      } else if (data.type === 'analysis') {
          updateAnalysis(data);
      } else if (data.type === 'feedback') {
          setStatus("Coaching Result", "#4ade80");
          updateTranscript(data.text);
      } else if (data.type === 'status' && data.message === 'analyzing') {
          setStatus("Analyzing Style...", "#a855f7");
      }
    });

    // Animate orb when Eva talks (Cartesia TTS track)
    currentRoom.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'audio') {
        const audio = track.attach();
        document.body.appendChild(audio);
        
        // Ripple effect start/stop based on actual audio data
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(audio.srcObject);
        const analyzer = ctx.createAnalyser();
        source.connect(analyzer);
        
        const dataArray = new Uint8Array(analyzer.frequencyBinCount);
        function checkAudio() {
          analyzer.getByteFrequencyData(dataArray);
          const volume = dataArray.reduce((p, c) => p + c, 0) / dataArray.length;
          if (volume > 5) {
            orb.classList.add('talking');
          } else {
            orb.classList.remove('talking');
          }
          requestAnimationFrame(checkAudio);
        }
        checkAudio();
      }
    });

    await currentRoom.connect(url, token);
    
    // START RECORDING IMMEDIATELY (Contiguous)
    const audioTrack = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    });
    
    await currentRoom.localParticipant.publishTrack(audioTrack);
    
    setStatus("Listening Always", "#6366f1");
    wakeBtn.textContent = "Eva is Awake";
    wakeBtn.classList.add('active');
    
    // Start Session Timer
    sessionStartTime = Date.now();
    sessionTimerEl.classList.add('active');
    if (sessionInterval) clearInterval(sessionInterval);
    sessionInterval = setInterval(() => {
      const e = Math.floor((Date.now() - sessionStartTime) / 1000);
      sessionTimerEl.textContent = 
        `${String(Math.floor(e/3600)).padStart(2,'0')}:${String(Math.floor((e%3600)/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
    }, 1000);
    
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, "#ef4444");
    wakeBtn.disabled = false;
    wakeBtn.textContent = "Wake Eva";
  }
}

wakeBtn.addEventListener('click', () => {
    if (!currentRoom) startEva();
});
