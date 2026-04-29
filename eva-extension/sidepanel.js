// Eva Sidekick Extension Logic
const { Room, RoomEvent, VideoPresets, Track, createLocalAudioTrack } = LivekitClient;

let currentRoom = null;
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const feedbackEl = document.getElementById('feedback');
const startBtn = document.getElementById('startBtn');
const grantBtn = document.getElementById('grantBtn');
const stopBtn = document.getElementById('stopBtn');

function log(msg, speaker = 'system') {
  const line = document.createElement('div');
  line.className = `transcript-line speaker-${speaker}`;
  line.textContent = msg;
  transcriptEl.appendChild(line);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function startSession() {
  try {
    startBtn.disabled = true;
    startBtn.textContent = "Connecting...";
    log("Connecting to Eva...", "system");

    // Fetch token from local server
    const resp = await fetch(`${EVA_CONFIG.SERVER_URL}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_name: "Sidekick User" })
    });
    
    if (!resp.ok) throw new Error("Failed to get token. Is server.py running?");
    const { token, url } = await resp.json();

    currentRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
        publishDefaults: { audioPreset: VideoPresets.h90 }
    });

    // Handle incoming data (transcripts and feedback)
    currentRoom.on(RoomEvent.DataReceived, (payload, participant) => {
      const data = JSON.parse(new TextDecoder().decode(payload));
      
      if (data.type === 'transcript') {
        log(`${data.name}: ${data.text}`, data.speaker);
        chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', text: data.text });
      } else if (data.type === 'feedback') {
          feedbackEl.style.display = 'block';
          feedbackEl.textContent = `Insights: ${data.text}`;
          log(`[EVA]: ${data.text}`, 'eva');
          chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', text: data.text });
      } else if (data.type === 'status' && data.message === 'analyzing') {
          feedbackEl.style.display = 'block';
          feedbackEl.textContent = "Eva is analyzing your style...";
      }
    });

    // Handle agent audio attachment for Cartesia TTS
    currentRoom.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'audio') {
        const audio = track.attach();
        document.body.appendChild(audio);
        log("Eva's voice connected.", "system");

        // Analyze audio to pulse the Siri Orb across all tabs
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(audio.srcObject);
        const analyzer = ctx.createAnalyser();
        source.connect(analyzer);
        const buffer = new Uint8Array(analyzer.frequencyBinCount);
        function monitor() {
            analyzer.getByteFrequencyData(buffer);
            const vol = buffer.reduce((a, b) => a + b, 0) / buffer.length;
            chrome.runtime.sendMessage({ type: 'STATE_DATA', talking: vol > 5 });
            requestAnimationFrame(monitor);
        }
        monitor();
      }
    });

    await currentRoom.connect(url, token);
    
    // Contiguous recording: capture microphone indefinitely
    const audioTrack = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    });
    
    await currentRoom.localParticipant.publishTrack(audioTrack);
    
    statusEl.textContent = "Online";
    statusEl.className = "status-badge status-online";
    startBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    log("Continuous recording active. Enjoy your browsing! ✨", "system");

  } catch (err) {
    log(`Error: ${err.message}`, "system");
    
    // Chrome blocks mic prompts in Side Panels. Open a full tab to request it.
    if (err.message.includes('Permission dismissed') || err.message.includes('Permission denied') || err.message.includes('permission')) {
        log("Click 'Grant Mic Access' to fix Permissions.", "system");
        grantBtn.style.display = 'block';
        startBtn.style.display = 'none';
    } else {
        startBtn.disabled = false;
        startBtn.textContent = "Start Recording";
    }
  }
}

async function stopSession() {
  if (currentRoom) {
    // Request final feedback before closing
    const data = new TextEncoder().encode(JSON.stringify({ type: 'request_feedback' }));
    await currentRoom.localParticipant.publishData(data, { reliable: true });
    
    log("Final feedback requested...", "system");
    
    setTimeout(async () => {
        await currentRoom.disconnect();
        window.location.reload();
    }, 5000); // 5s wait for feedback audio to play
  }
}

startBtn.addEventListener('click', startSession);
grantBtn.addEventListener('click', () => {
    window.open(chrome.runtime.getURL("sidepanel.html"), "_blank");
});
stopBtn.addEventListener('click', stopSession);
