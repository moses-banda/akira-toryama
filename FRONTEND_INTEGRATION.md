# Frontend Integration Guide — Eva Backend

Hi team, here is everything you need to connect the frontend to the Eva backend. The backend is fully deployed and live. Please make these changes before we present.

---

## Live Backend URL (Already Deployed)

```
https://web-production-046bb.up.railway.app
```

This is the single URL for all API calls. CORS is fully open — you can call it from any domain.

---

## Step 1: Add the LiveKit Client Library

Add this script tag to your HTML (before your app code):

```html
<script src="https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js"></script>
```

Then destructure what you need:

```javascript
const { Room, RoomEvent, VideoPresets, createLocalAudioTrack } = LivekitClient;
```

---

## Step 2: Start a Session (When User Clicks "Start" or the Eva Orb)

Call the token endpoint, then connect to LiveKit:

```javascript
const BACKEND_URL = "https://web-production-046bb.up.railway.app";

async function startSession(userName = "Learner") {
  // 1. Get a token from the backend
  const resp = await fetch(`${BACKEND_URL}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_name: userName, mode: "passive" })
  });
  const { token, url } = await resp.json();

  // 2. Create a LiveKit room and connect
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    publishDefaults: { audioPreset: VideoPresets.h90 }
  });

  // 3. Listen for real-time data from Eva (see Step 3 below)
  room.on(RoomEvent.DataReceived, (payload) => {
    const data = JSON.parse(new TextDecoder().decode(payload));
    handleEvaMessage(data); // Your handler — see Step 3
  });

  // 4. Listen for Eva's voice (if she speaks back)
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === "audio") {
      const audio = track.attach();
      document.body.appendChild(audio); // This plays Eva's voice automatically
    }
  });

  await room.connect(url, token);

  // 5. Start the microphone and publish to the room
  const micTrack = await createLocalAudioTrack({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  });
  await room.localParticipant.publishTrack(micTrack);

  return room; // Save this reference for stopping later
}
```

---

## Step 3: Handle Real-Time Messages from Eva

Eva sends 4 types of messages through the LiveKit data channel. Use this handler:

```javascript
function handleEvaMessage(data) {
  switch (data.type) {

    case "transcript":
      // Fires every time the user or Eva speaks
      // data.speaker = "user" or "eva"
      // data.name = speaker's name
      // data.text = what was said
      console.log(`${data.name}: ${data.text}`);
      // UPDATE YOUR TRANSCRIPT UI HERE
      break;

    case "analysis":
      // Fires after Groq analyzes each utterance (every few seconds)
      // data.cleaned = cleaned version of what user said
      // data.fluency_score = 1-10
      // data.vocab_level = "basic" | "intermediate" | "advanced"
      // data.grammar_issues = [{ original, corrected, rule }]
      // data.bucket_stats = { total, avg_fluency, issue_count }
      console.log("Fluency:", data.fluency_score, "Vocab:", data.vocab_level);
      console.log("Grammar fixes:", data.grammar_issues);
      // UPDATE YOUR METRICS/DASHBOARD UI HERE
      break;

    case "status":
      // Fires when Eva starts generating final feedback
      // data.message = "analyzing"
      console.log("Eva is analyzing your session...");
      // SHOW A LOADING SPINNER OR "ANALYZING..." MESSAGE
      break;

    case "feedback":
      // Fires once at end of session — the full personalized coaching summary
      // data.text = long coaching feedback text (650-750 words)
      // data.stats = { session_duration_minutes, total_utterances, analyzed,
      //                key_sentences, unique_grammar_issues, avg_fluency_score,
      //                vocabulary_distribution: { basic, intermediate, advanced } }
      console.log("Coaching Feedback:", data.text);
      console.log("Session Stats:", data.stats);
      // DISPLAY THE FINAL FEEDBACK AS A VOICE MESSAGE / CARD
      break;
  }
}
```

---

## Step 4: Stop Session & Trigger Feedback (When User Clicks Stop)

When the user wants to stop and get their feedback:

```javascript
async function stopSession(room) {
  // 1. Tell Eva to generate feedback RIGHT NOW
  const msg = JSON.stringify({ type: "request_feedback" });
  await room.localParticipant.publishData(
    new TextEncoder().encode(msg),
    { reliable: true }
  );

  // 2. Wait for the feedback to arrive (it comes via the "feedback" message above)
  //    Give it about 15-20 seconds — Groq needs time to write the full coaching summary
  //    The "feedback" event will fire in your handleEvaMessage function above

  // 3. Disconnect after a delay (so feedback has time to arrive)
  setTimeout(async () => {
    await room.disconnect();
  }, 20000);
}
```

---

## Step 5: Dashboard Viewer (Optional — For the Stats Page)

If you want a separate dashboard page that passively watches an active session:

```javascript
async function connectDashboard() {
  const resp = await fetch(`${BACKEND_URL}/api/agent_viewer_token`);
  if (!resp.ok) throw new Error("No active session yet — start Eva first");
  const { token, url } = await resp.json();

  const room = new Room({ adaptiveStream: true, dynacast: true });
  room.on(RoomEvent.DataReceived, (payload) => {
    const data = JSON.parse(new TextDecoder().decode(payload));
    handleEvaMessage(data); // Same handler as above
  });

  await room.connect(url, token);
}
```

---

## Quick Reference: What Happens Under the Hood

```
User speaks into mic
    ↓
Audio streams to LiveKit Room (WebRTC)
    ↓
Deepgram (STT) transcribes audio → text
    ↓
Groq (Llama 3.3) analyzes grammar, fluency, vocab → sends "analysis" message
    ↓
InsightBucket stores analysis, DISCARDS raw audio
    ↓
User clicks Stop → "request_feedback" sent
    ↓
Groq reads InsightBucket → writes personalized coaching summary
    ↓
"feedback" message sent to frontend with full text + stats
```

No audio is stored. No database needed. Everything runs in memory and streams in real-time.

---

## Health Check

To verify the backend is alive:

```
GET https://web-production-046bb.up.railway.app/api/health
→ { "status": "ok", "agent": "Eva English Coach" }
```

---

**That's everything. The backend is live and waiting for connections. Just wire up the handlers above and we're good to demo!**
