# Simple Deployment Plan (Only Working Features)

Take a deep breath. You only need to deploy the code that is already in your folder today. We can ignore Supabase and Twilio completely for your presentation.

Here is the simple, 3-step plan:

## 1. Deploy the Backend (Using Render or Heroku)
Your project is already 100% ready to deploy. You don't need to change any code.
- Go to Render.com or Heroku and connect your GitHub repository.
- The platform will automatically read your `Procfile` and start two things:
  - **Web Site:** `server.py` (This hosts your frontend dashboard and creates tokens).
  - **AI Worker:** `agent.py` (This runs the Eva voice agent).

## 2. Copy Your API Keys
In your Render or Heroku dashboard, go to "Environment Variables" and paste the exact keys from your local `.env` file:
- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`
- `DEEPGRAM_API_KEY`
- `GROQ_API_KEY`
- `ELEVEN_API_KEY`
- `CARTESIA_API_KEY`

## 3. Update the Chrome Extension
- Open your `eva-extension` folder.
- Find `http://localhost:8080` (in `background.js` or `config.js`) and replace it with your new Render/Heroku website link.
- Zip the `eva-extension` folder. You can load this zip into Chrome to show it working.

**That's it.** 
- Your dashboard will perfectly load at your new web link.
- Eva will successfully connect and talk to you through LiveKit. 
You are ready to present!
