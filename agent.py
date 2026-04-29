"""
Eva — AI English Speaking Coach Agent
Pipeline: Deepgram (STT) → Groq/Llama 3.3 (Brain) → ElevenLabs (Voice)

Real-Time Processing:
  1. Every utterance is analyzed by Groq for grammar, key sentences, filler removal
  2. Insights accumulate in the Insight Bucket (per-session memory)
  3. On demand or periodically, Groq generates coaching feedback from the bucket
  4. ElevenLabs speaks the feedback back in a premium voice
"""

import asyncio
import json
import logging
import re
import time
import datetime
import httpx
import os
from typing import Dict, List, Optional
from dataclasses import dataclass, field
from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import AgentSession, Agent, WorkerOptions, cli, llm
from livekit.plugins import deepgram, groq, elevenlabs, silero

load_dotenv()
logger = logging.getLogger("eva-agent")

# ────────────────────────────────────────────────────────────────
# Groq Analyzer — processes each utterance in real-time
# ────────────────────────────────────────────────────────────────

ANALYSIS_SYSTEM_PROMPT = """You are a precise English language analyzer. For the given spoken utterance, return ONLY valid JSON with these fields:

{
  "cleaned_text": "the utterance with filler words (um, uh, like, you know, basically, I mean) removed and light grammar corrections applied",
  "key_sentence": true or false (is this a substantive sentence worth keeping, vs. filler/small talk?),
  "grammar_issues": [
    {"original": "exact wrong phrase", "corrected": "corrected version", "rule": "brief grammar rule name"}
  ],
  "vocabulary_level": "basic" | "intermediate" | "advanced",
  "fluency_score": 1-10 (based on complexity, coherence, and naturalness)
}

Rules:
- If the utterance is too short or pure filler (e.g., "um", "yeah"), return key_sentence: false and empty grammar_issues.
- Be strict about grammar but encouraging in tone.
- Do NOT add any text outside the JSON object."""


async def analyze_utterance(llm_instance, text: str) -> dict | None:
    """Send a single utterance to Groq for real-time grammar analysis."""
    if not text or len(text.strip()) < 3:
        return None

    try:
        chat_ctx = llm.ChatContext()
        chat_ctx.append(role="system", text=ANALYSIS_SYSTEM_PROMPT)
        chat_ctx.append(role="user", text=text)

        result_text = ""
        async for chunk in llm_instance.chat(chat_ctx=chat_ctx):
            if chunk.choices and chunk.choices[0].delta.content:
                result_text += chunk.choices[0].delta.content

        # Parse the JSON response
        # Strip markdown code fences if present
        cleaned = result_text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()

        return json.loads(cleaned)
    except Exception as e:
        logger.warning(f"[ANALYZER] Failed to analyze: {e}")
        return None


# ────────────────────────────────────────────────────────────────
# Insight Bucket — accumulates all processed data per session
# ────────────────────────────────────────────────────────────────

@dataclass
class InsightBucket:
    """Per-session accumulator for all real-time analysis results. Highly memory optimized."""
    session_start: float = field(default_factory=time.time)
    
    # We perfectly discard raw strings after extracting useful info!
    total_raw_utterances_count: int = 0
    total_analysis_count: int = 0
    
    key_sentences: list[str] = field(default_factory=list)
    grammar_issues: list[dict] = field(default_factory=list)
    vocabulary_levels: list[str] = field(default_factory=list)
    fluency_scores: list[int] = field(default_factory=list)
    eva_responses: list[str] = field(default_factory=list)

    @property
    def raw_utterances(self):
        # Fallback for old properties that check len(raw_utterances) implicitly
        return [""] * self.total_raw_utterances_count
    
    @property
    def analysis_count(self):
        return self.total_analysis_count

    def ingest(self, raw_text: str, analysis: dict | None):
        """Add a processed utterance to the bucket. Discared the raw recording!"""
        self.total_raw_utterances_count += 1

        if not analysis:
            return

        self.total_analysis_count += 1

        if analysis.get("key_sentence"):
            # Only keep max 30 key sentences
            self.key_sentences.append(analysis.get("cleaned_text", raw_text))
            self.key_sentences = self.key_sentences[-30:]

        for issue in analysis.get("grammar_issues", []):
            # Only keep max 30 unique grammar issues
            self.grammar_issues.append(issue)
            self.grammar_issues = self.grammar_issues[-30:]

        # Maintain rolling window limits for fluency & vocab so they don't grow infinitely
        level = analysis.get("vocabulary_level", "basic")
        self.vocabulary_levels.append(level)
        self.vocabulary_levels = self.vocabulary_levels[-500:]

        score = analysis.get("fluency_score", 5)
        self.fluency_scores.append(score)
        self.fluency_scores = self.fluency_scores[-500:]

    @property
    def avg_fluency(self) -> float:
        if not self.fluency_scores:
            return 0.0
        return sum(self.fluency_scores) / len(self.fluency_scores)

    @property
    def duration_minutes(self) -> float:
        return (time.time() - self.session_start) / 60

    def to_summary(self) -> str:
        """Generate a text summary of all accumulated insights for Groq feedback."""
        unique_issues = []
        seen = set()
        for issue in self.grammar_issues:
            key = issue.get("original", "")
            if key not in seen:
                seen.add(key)
                unique_issues.append(issue)

        return json.dumps({
            "session_duration_minutes": round(self.duration_minutes, 1),
            "total_utterances": self.total_raw_utterances_count,
            "analyzed": self.total_analysis_count,
            "key_sentences": self.key_sentences[-20:],  # Last 20 key sentences
            "unique_grammar_issues": unique_issues[-15:],  # Last 15 unique issues
            "avg_fluency_score": round(self.avg_fluency, 1),
            "vocabulary_distribution": {
                "basic": self.vocabulary_levels.count("basic"),
                "intermediate": self.vocabulary_levels.count("intermediate"),
                "advanced": self.vocabulary_levels.count("advanced"),
            },
        }, indent=2)


# ────────────────────────────────────────────────────────────────
# Feedback Generator — reads the bucket, produces coaching text
# ────────────────────────────────────────────────────────────────

FEEDBACK_SYSTEM_PROMPT = """You are Eva, an incredibly strict, "real," and sharp English speaking coach.
You've been silently analyzing the learner's speech in real-time.
Now deliver a comprehensive, heavily detailed coaching summary based on the analysis data provided.

Your feedback MUST be essential for improvement and hold nothing back:
1. Be brutally honest and direct about exactly what they are doing wrong with their grammar, phrasing, or vocabulary.
2. Provide an extensive, deep-dive analysis of their flawed sentence structures and explicitly explain the corrections.
3. Offer strict, highly specific, and actionable tips for improvement. Do not sugarcoat errors.
4. Your response MUST be extremely detailed—write approximately 650 to 750 words so that when spoken at a normal pace, the audio spans exactly 5 minutes.
5. Use natural speaking cadence, but maintain a serious, authoritative coaching tone."""


async def generate_feedback(llm_instance, bucket: InsightBucket) -> str:
    """Generate coaching feedback from the insight bucket."""
    chat_ctx = llm.ChatContext()
    chat_ctx.append(role="system", text=FEEDBACK_SYSTEM_PROMPT)
    chat_ctx.append(role="user", text=f"Session Analysis Data:\n{bucket.to_summary()}")

    feedback = ""
    async for chunk in llm_instance.chat(chat_ctx=chat_ctx):
        if chunk.choices and chunk.choices[0].delta.content:
            feedback += chunk.choices[0].delta.content

    return feedback.strip()


# ────────────────────────────────────────────────────────────────
# Eva Agent Definition
# ────────────────────────────────────────────────────────────────

class Eva(Agent):
    def __init__(self, name: str = "there") -> None:
        super().__init__(
            instructions=(
                f"You are Eva, a cool, seductive, and sharp English speaking coach. You are talking to {name}. "
                "CRITICAL: Keep your responses short, snappy, and human. Use frequent backchanneling (like 'mhm', 'yeah', 'right') "
                "to show you're listening without interrupting. "
                "Do NOT monologue. Use one or two sentences maximum for your responses. "
                "Maintain a cool, relaxed, and smooth conversational tone. "
                "Your goal is to get the learner to speak as much as possible while you act as their 'goated' listener and coach."
            ),
        )


# ────────────────────────────────────────────────────────────────
# Entrypoint
# ────────────────────────────────────────────────────────────────

async def generate_cartesia_podcast(text: str, user_name: str):
    logger.info("[PODCAST] Generating Cartesia asynchronous audio...")
    api_key = os.getenv("CARTESIA_API_KEY")
    if not api_key:
        logger.error("[PODCAST] No CARTESIA_API_KEY found.")
        return
        
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                "https://api.cartesia.ai/tts/bytes",
                headers={
                    "X-API-Key": api_key,
                    "Cartesia-Version": "2024-06-10",
                    "Content-Type": "application/json"
                },
                json={
                    "transcript": text,
                    "model_id": "sonic-english",
                    "voice": {
                        "mode": "id",
                        "id": "a0e99841-438c-4a64-b679-ae501e7d6091"
                    },
                    "output_format": {
                        "container": "wav",
                        "encoding": "pcm_s16le",
                        "sample_rate": 16000
                    }
                }
            )
            resp.raise_for_status()
            
            os.makedirs("frontend/audio", exist_ok=True)
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"frontend/audio/feedback_{user_name}_{timestamp}.wav"
            
            with open(filename, "wb") as f:
                f.write(resp.content)
            logger.info(f"[PODCAST] Successfully saved feedback to {filename}")
    except Exception as e:
        logger.error(f"[PODCAST] Failed to generate Cartesia audio: {e}")


async def entrypoint(ctx: agents.JobContext):
    logger.info(f"--- [NEW JOB] {ctx.job.id} ---")

    user_name = "there"
    mode = "passive"
    if ctx.job.metadata:
        try:
            metadata = json.loads(ctx.job.metadata)
            user_name = metadata.get("customer_name", "there")
            mode = metadata.get("mode", "passive")
        except Exception:
            pass
            
    logger.info(f"[AGENT] Connection for: {user_name} (Mode: {mode})")

    analyzer_llm = groq.LLM(model="llama-3.3-70b-versatile")
    feedback_llm = groq.LLM(model="llama-3.3-70b-versatile")
    bucket = InsightBucket()
    await ctx.connect()
    
    # Base Voice Activity Detection + STT
    stt_plugin = deepgram.STT(model="nova-2", language="en")
    vad_plugin = silero.VAD.load(
        min_speech_duration=0.1,
        min_silence_duration=0.5,
        prefix_padding_duration=0.2,
    )

    if mode == "passive":
        # PASSIVE LISTENER MODE
        session = AgentSession(
            stt=stt_plugin,
            llm=groq.LLM(model="llama-3.3-70b-versatile"),
            tts=None, # Absolutely no speaking out loud
            vad=vad_plugin,
        )
    else:
        # ACTIVE COACH MODE (Using ElevenLabs API for Real-time constraint, or Cartesia LiveKit plugin if installed. We use ElevenLabs here for active voice)
        session = AgentSession(
            stt=stt_plugin,
            llm=groq.LLM(model="llama-3.3-70b-versatile"),
            tts=elevenlabs.TTS(
                model_id="eleven_turbo_v2_5",
                sample_rate=16000,
                voice=elevenlabs.Voice(
                    id="21m00Tcm4TlvDq8ikWAM",
                    settings=elevenlabs.VoiceSettings(
                        stability=0.5, similarity_boost=0.75, style=0.3, use_speaker_boost=True,
                    ),
                ),
            ),
            vad=vad_plugin,
        )

    # Analyzes users text silently
    @session.on("user_speech_committed")
    def on_user_speech(msg):
        text = msg.content if hasattr(msg, "content") else str(msg)
        if not text.strip(): return
        logger.info(f"[USER] {user_name}: {text}")

        # Send raw transcript to frontend
        try:
            asyncio.ensure_future(ctx.room.local_participant.publish_data(
                json.dumps({"type": "transcript", "speaker": "user", "name": user_name, "text": text}).encode(),
                reliable=True
            ))
        except Exception: pass

        # Fire-and-forget real-time analysis
        asyncio.ensure_future(_analyze_and_store(text))

    async def _analyze_and_store(text: str):
        analysis = await analyze_utterance(analyzer_llm, text)
        bucket.ingest(text, analysis)
        if analysis:
            try:
                payload = json.dumps({
                    "type": "analysis",
                    "cleaned": analysis.get("cleaned_text", text),
                    "grammar_issues": analysis.get("grammar_issues", []),
                    "fluency_score": analysis.get("fluency_score", 5),
                    "vocab_level": analysis.get("vocabulary_level", "basic"),
                    "bucket_stats": {
                        "total": len(bucket.raw_utterances),
                        "avg_fluency": round(bucket.avg_fluency, 1),
                        "issue_count": len(bucket.grammar_issues),
                    },
                }).encode()
                await ctx.room.local_participant.publish_data(payload, reliable=True)
            except Exception: pass

    if mode == "coach":
        @session.on("agent_speech_committed")
        def on_agent_speech(msg):
            text = msg.content if hasattr(msg, "content") else str(msg)
            if not text.strip(): return
            bucket.eva_responses.append(text)
            try:
                asyncio.ensure_future(ctx.room.local_participant.publish_data(
                    json.dumps({"type": "transcript", "speaker": "eva", "name": "Eva", "text": text}).encode(),
                    reliable=True
                ))
            except Exception: pass

    # Start session
    if mode == "passive":
        await session.start(room=ctx.room, agent=Agent(instructions="You are a silent listener logging data. Do not speak."))
        logger.info("[AGENT] Passive Listener started.")
    else:
        instructions = f"You are Eva, a strict real-time language coach for {user_name}. Drill them on their grammar errors actively. Keep replies very short."
        await session.start(room=ctx.room, agent=Agent(instructions=instructions))
        await session.say("I'm ready when you are. Let's practice.")
        logger.info("[AGENT] Active Coach started.")

    async def finalize_session():
        logger.info("[COACH] Finalizing session feedback.")
        if bucket.analysis_count < 2: return
        try:
            await ctx.room.local_participant.publish_data(json.dumps({"type": "status", "message": "analyzing"}).encode(), reliable=True)
        except Exception: pass

        feedback_text = await generate_feedback(feedback_llm, bucket)
        
        # Publish feedback data to the frontend so it can display the UI
        try:
            stats_dict = json.loads(bucket.to_summary())
            payload = json.dumps({"type": "feedback", "text": feedback_text, "stats": stats_dict}).encode()
            await ctx.room.local_participant.publish_data(payload, reliable=True)
        except Exception as e:
            logger.warning(f"Failed to send feedback data: {e}")
        
        if mode == "passive":
            # Generate the Asynchronous Audio Podcast file using Cartesia REST API
            await generate_cartesia_podcast(feedback_text, user_name)
        else:
            # Speak it directly in active mode
            await session.say(feedback_text, allow_interruptions=False)

    @ctx.room.on("data_received")
    def on_data_received(data: rtc.DataPacket):
        try:
            msg = json.loads(data.data.decode())
            if msg.get("type") == "request_feedback":
                logger.info("[AGENT] Frontend explicitly requested feedback generation!")
                asyncio.create_task(finalize_session())
        except Exception: pass

    @ctx.room.on("participant_disconnected")
    def on_participant_disconnected(participant: rtc.Participant):
        logger.info(f"[AGENT] Participant {participant.identity} left.")
        asyncio.create_task(finalize_session())

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name="eva-expert"))