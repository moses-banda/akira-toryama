# Eva: The Always-On Contextual Language Coach

Eva re-imagines how people learn spoken language. Traditional language learning apps lock users into rigid textbook scenarios, while AI language bots constantly interrupt natural conversation flow with awkward, robotic corrections. 

Eva is different. She acts as a **Passive Daily Listener** and an **Active Sparring Coach**, seamlessly adapting to the user's actual life.

## How it Works

Powered by **LiveKit WSS** technology, the entire architecture runs on an incredibly low-latency real-time dual-agent system. 

### Phase 1: The Passive Listener (Data Harvesting)
When a user launches Eva (typically via the hidden Chrome Extension), she runs entirely in the background. 
*   **Deepgram STT** catches their daily conversations on their laptop, securely transcribing them in real-time.
*   The raw transcripts stream into our Python backend where **Groq (Llama-3.3-70b)** instantly analyzes them for grammar issues, vocabulary levels, and key phrasing patterns.
*   To prevent infinite memory bloat, we designed a hyper-optimized `InsightBucket` that actively deletes the raw text "junk" the second the analytical payload is extracted!
*   Once the session ends, Groq synthesizes a highly personalized daily review script. Our backend directly hits the **Cartesia** AI Voice API to asynchronously generate a high-quality (16kHz), 5-minute `.wav` podcast review that drops into the user's UI dashboard for them to listen to on their own time!

### Phase 2: The Active Coach (Real-Time Sparring)
When the student is ready to actually practice those mistakes, they hit the "Practice Mode" button on our Web UI.
*   The backend triggers our second agent mode, switching LiveKit to an active duplex.
*   Eva awakens using **ElevenLabs** to become a hyper-critical, real-time sparring partner. She actively forces the user into a conversational roleplay expressly designed to drill the exact grammar rules she detected they failed at earlier in the day.

## Tech Stack Overview
*   **Networking:** LiveKit Cloud (WebRTC)
*   **Backend Glue:** FastAPI & Python
*   **The Ears (STT):** Deepgram Nova-2
*   **The Brain (LLM):** Groq (llama-3.3-70b-versatile)
*   **The Voice (Active):** ElevenLabs Turbo v2.5
*   **The Podcast (Async):** Cartesia Sonic English API
*   **The Client:** Chrome Extension manifest v3 + HTML/Javascript UI Dashboard

## Getting Started (Local Dev)

**1. Create your Environment**
Ensure you have Python installed, then build your virtual environment:
```bash
python -m venv venv
# Windows:
.\venv\Scripts\activate
# Mac/Linux:
source venv/bin/activate
```

**2. Install Dependencies**
```bash
pip install -r requirements.txt
# Ensure you also have the necessary Cartesia and ElevenLabs pip packages:
pip install livekit-plugins-elevenlabs cartesia httpx
```

**3. Configure your API Keys**
You must create a `.env` file in the root directory. This file is intentionally `.gitignore`'d to protect our massive array of underlying APIs. Add the following keys:
```env
LIVEKIT_URL=wss://your-host.livekit.cloud
LIVEKIT_API_KEY=your_key
LIVEKIT_API_SECRET=your_secret
DEEPGRAM_API_KEY=your_key
GROQ_API_KEY=your_key
ELEVEN_API_KEY=your_key
CARTESIA_API_KEY=your_key
```

**4. Run the Architecture**
Because the system is fully distributed, you must run the token server and the real-time agent processor simultaneously:

Start the Token Server (Terminal 1):
```bash
python server.py
```
Start the LiveKit Agent (Terminal 2):
```bash
python agent.py dev
```

**5. Connect the UI**
Navigate securely to `http://localhost:8080/` to test the visual dashboard, or hit `http://localhost:8080/docs` to see the FastAPI Swagger UI and retrieve your locally generated asynchronous Cartesia podcasts!
