# Eva (Akira) Deployment Strategy

This document outlines the deployment strategy to transition the Eva AI English Coaching platform from a local development environment to a stable, production-ready system. 

The architecture consists of a FastAPI web server, a LiveKit background worker, a static frontend dashboard, a Chrome Extension, and various third-party integrations (Supabase, Twilio, LiveKit Cloud, Groq, Deepgram, ElevenLabs, Cartesia).

---

## 1. System Components & Hosting Targets

To achieve a resilient and scalable deployment, the system should be distributed across the following hosting solutions:

| Component | Target Environment | Purpose |
| :--- | :--- | :--- |
| **Backend (Web & Worker)** | Render / Railway / Heroku (PaaS) | Hosts the `uvicorn` FastAPI token server and the `agent.py` LiveKit process. |
| **Frontend Web UI** | Vercel / Netlify OR PaaS | Currently served statically via FastAPI, but ideally decoupled to an Edge CDN for lower latency. |
| **Chrome Extension** | Google Chrome Web Store | The primary user-facing client for the "Passive Listener" and background integrations. |
| **Auth & Database** | Supabase (Cloud) | Manages user data, OTP authentication, pg_cron tasks, and Edge Functions. |
| **Telephony** | Twilio | SIP Trunking & Outbound call management. |
| **WebRTC & Media** | LiveKit Cloud | Manages real-time audio/video WSS rooms. |

---

## 2. Environment Variables & Secrets Management

Before deploying, ensure all production environment variables are securely added to your PaaS and Supabase Edge Functions. **Never commit the `.env` file.**

Required Production Secrets:
- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`
- `DEEPGRAM_API_KEY` (STT transcription)
- `GROQ_API_KEY` (Llama-3.3 brain)
- `ELEVEN_API_KEY` (Real-time TTS)
- `CARTESIA_API_KEY` (Async podcast generation)
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER`

---

## 3. Step-by-Step Deployment Phases

### Phase 1: Infrastructure & Third-Party Configuration
1. **Supabase Setup**: 
   - Apply production database migrations.
   - Deploy Supabase Edge Functions using the Supabase CLI (`supabase functions deploy`).
   - Configure Twilio Verify API webhooks inside Supabase for mobile OTP auth.
2. **LiveKit Cloud**:
   - Ensure you have a production LiveKit project created. 
   - Note the connection URLs and keys for backend injection.

### Phase 2: Deploying the Python Backend (PaaS)
Your project is already structured with a `Procfile`, making PaaS deployment straightforward.
1. **Connect Repository**: Link your GitHub repository to Render, Railway, or Heroku.
2. **Configure Processes**: Ensure the platform picks up both processes defined in the `Procfile`:
   - `web`: The FastAPI server (`uvicorn server:app --host 0.0.0.0 --port $PORT`)
   - `worker`: The LiveKit agent (`python agent.py start`)
3. **⚠️ Critical Volume Storage Setup**: 
   - Currently, `agent.py` saves Cartesia podcast audio files directly to `frontend/audio/`. 
   - Most PaaS systems have **ephemeral filesystems** (files are deleted on restart). 
   - **Action**: You must either attach a persistent disk volume to your PaaS *or* refactor the podcast generation to upload the `.wav` files directly to an AWS S3 bucket or Supabase Storage bucket.

### Phase 3: Frontend Dashboard Deployment
- **Option A (Coupled)**: Keep the frontend inside the `frontend/` directory and let FastAPI serve it via `app.mount("/static")`. This is easiest but less performant globally.
- **Option B (Decoupled)**: Deploy the `frontend/` folder to Vercel or Netlify. Update all fetch requests in `app.js` to point to the production backend URL (e.g., `https://api.yourdomain.com/api/token`) instead of relative paths.

### Phase 4: Publishing the Chrome Extension
1. **Update API Endpoints**: Modify `eva-extension/config.js` or background scripts so that all HTTP requests and WebSocket connections point to your new production PaaS backend URL instead of `localhost:8080`.
2. **Package the Extension**: Zip the `eva-extension` directory.
3. **Chrome Web Store Submission**: 
   - Create a developer account on the Chrome Web Store Dashboard.
   - Upload the `.zip`, fill out store listing details, provide a privacy policy, and submit for review. 
   - *Note: Extension reviews can take a few days, so do this early.*

---

## 4. CI/CD Integration (Optional but heavily recommended)

Set up **GitHub Actions** to automate future deployments:
- **Linting & Validation**: Setup a workflow to run `mypy` or `flake8` on your Python code.
- **Auto-Deploy Backend**: Configure your PaaS to automatically build and deploy the `web` and `worker` processes whenever code is pushed and merged into the `main` branch.
- **Auto-Deploy Edge Functions**: Create an action to run `supabase functions deploy` sequentially on merge.
