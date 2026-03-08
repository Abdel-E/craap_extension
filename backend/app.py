"""
CRAAP Checker — Flask Backend
Exposes /api/analyze for the Chrome extension.
"""

import os
import json
import logging

from dotenv import load_dotenv
load_dotenv()  # Load .env before anything reads env vars

from flask import Flask, request, jsonify, Response
from flask_cors import CORS

from agent_orchestrator import run_pipeline, run_pipeline_streaming, chat_with_article

# ——— App Setup ———
app = Flask(__name__)
CORS(app)  # Allow cross-origin requests from the Chrome extension

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@app.route("/api/analyze", methods=["POST"])
def analyze():
    """Accept scraped page text + URL and return CRAAP scores."""
    body = request.get_json(silent=True)

    if not body or not body.get("text"):
        return jsonify({"error": "Missing required field: text"}), 400

    text = body["text"]
    url = body.get("url", "")

    logger.info("Analyze request — URL: %s | Text length: %d", url, len(text))

    try:
        result = run_pipeline(text=text, url=url)
        return jsonify(result)
    except Exception:
        logger.exception("Pipeline failed")
        return jsonify({"error": "Analysis failed. Please try again."}), 500


@app.route("/api/analyze/stream", methods=["POST"])
def analyze_stream():
    """SSE streaming endpoint — sends progress events as each agent finishes."""
    body = request.get_json(silent=True)

    if not body or not body.get("text"):
        return jsonify({"error": "Missing required field: text"}), 400

    text = body["text"]
    url = body.get("url", "")

    logger.info("Analyze/stream request — URL: %s | Text length: %d", url, len(text))

    def generate():
        try:
            for event in run_pipeline_streaming(text=text, url=url):
                yield f"event: {event['event']}\ndata: {json.dumps(event['data'])}\n\n"
        except Exception:
            logger.exception("Streaming pipeline failed")
            yield f"event: error\ndata: {json.dumps({'error': 'Analysis failed. Please try again.'})}\n\n"

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/tts", methods=["POST"])
def tts():
    """
    Mock TTS endpoint — placeholder for ElevenLabs integration.
    """
    body = request.get_json(silent=True)
    text = (body or {}).get("text", "")
    if not text:
        return jsonify({"error": "Missing required field: text"}), 400
    return jsonify({"status": "ok", "message": "TTS endpoint ready."})


@app.route("/api/chat", methods=["POST"])
def chat():
    """Interactive chat about the analyzed article."""
    body = request.get_json(silent=True)
    if not body or not body.get("question"):
        return jsonify({"error": "Missing required field: question"}), 400

    text = body.get("text", "")
    url = body.get("url", "")
    question = body["question"]
    history = body.get("history", [])

    logger.info("Chat request — question: %s", question[:100])

    try:
        result = chat_with_article(text=text, url=url, question=question, history=history)
        return jsonify(result)
    except Exception:
        logger.exception("Chat failed")
        return jsonify({"error": "Chat failed. Please try again."}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
