"""
FC Push Tracker - Free Edition
- No database: all data stored in device localStorage
- No Anthropic key: uses Google Gemini (free tier) for image scan
- Run: python app.py
"""

from flask import Flask, request, jsonify, render_template
import os, json, re, requests, logging, sys
from datetime import datetime

app = Flask(__name__)

# ── Logging setup — prints to terminal with timestamps ────────────────────────
logging.basicConfig(
    stream=sys.stdout,
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("fctracker")

# ── Gemini Config ─────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "AIzaSyCyZebuYyI8MNfRD2_UV1-245DNLYqYJcU")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"

# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")
@app.route("/timings")
def timings():
    return render_template("cpt-tracker.html")

@app.route("/api/scan", methods=["POST"])
def scan_image():
    log.info("=" * 55)
    log.info("SCAN REQUEST received")

    if not GEMINI_API_KEY:
        log.error("GEMINI_API_KEY is not set!")
        return jsonify({
            "error": "GEMINI_API_KEY not set. Get a free key at https://aistudio.google.com/app/apikey"
        }), 500

    data       = request.json or {}
    image_b64  = data.get("image")
    media_type = data.get("mediaType", "image/jpeg")

    if not image_b64:
        log.error("No image data in request")
        return jsonify({"error": "No image provided"}), 400

    log.info(f"Image received — mediaType={media_type}, base64 length={len(image_b64)}")

    prompt = """You are looking at an Amazon Fulfillment Center screen called "CPT Priorizer".
It shows a table with columns: Dropzone | Container Id | Urgent Items | Dwell | CPT.

For each visible data row (skip the header row), extract:
- station: last 4 digits of the Dropzone code. Example: "k-A-03-3342" -> "3342"
- tote: full Container ID in UPPERCASE. Example: "X18uirgwh" -> "X18UIRGWH"

Return ONLY valid JSON — no markdown, no explanation, no code fences.
Format: {"rows":[{"station":"3342","tote":"X18UIRGWH"},{"station":"3324","tote":"X1KM4QXK1"}]}"""

    # ── Call Gemini API ───────────────────────────────────────────────────────
    log.info(f"Calling Gemini API: {GEMINI_URL}")
    try:
        resp = requests.post(
            GEMINI_URL,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": GEMINI_API_KEY,
            },
            json={
                "contents": [{
                    "parts": [
                        {"inline_data": {"mime_type": media_type, "data": image_b64}},
                        {"text": prompt}
                    ]
                }],
                "generationConfig": {
                    "temperature": 0,
                    "maxOutputTokens": 1024,
                    "responseMimeType": "application/json"
                }
            },
            timeout=30
        )

        log.info(f"Gemini HTTP status: {resp.status_code}")

        if not resp.ok:
            log.error(f"Gemini API error body: {resp.text[:500]}")
            return jsonify({"error": f"Gemini API returned {resp.status_code}: {resp.text[:300]}"}), 502

        result = resp.json()

    except requests.exceptions.Timeout:
        log.error("Gemini API request timed out after 30s")
        return jsonify({"error": "Gemini API timed out — try again"}), 502
    except requests.exceptions.RequestException as e:
        log.error(f"Gemini API request failed: {e}")
        return jsonify({"error": f"Gemini API call failed: {str(e)}"}), 502

    # ── Extract text from Gemini response ─────────────────────────────────────
    log.debug(f"Raw Gemini response: {json.dumps(result, indent=2)[:1000]}")

    try:
        txt = result["candidates"][0]["content"]["parts"][0]["text"].strip()
        log.info(f"Gemini raw text output: {txt[:500]}")
    except (KeyError, IndexError) as e:
        log.error(f"Could not find text in Gemini response. Keys present: {list(result.keys())}")
        log.error(f"Full response: {json.dumps(result)[:800]}")

        # Check for prompt/safety blocks
        if result.get("promptFeedback"):
            log.error(f"Prompt feedback: {result['promptFeedback']}")
        candidates = result.get("candidates", [])
        if candidates and candidates[0].get("finishReason"):
            log.error(f"Finish reason: {candidates[0]['finishReason']}")

        return jsonify({"error": "Unexpected Gemini response — check terminal for details"}), 502

    # ── Parse JSON from Gemini text ───────────────────────────────────────────
    rows = None
    parse_errors = []

    # Strategy 1: direct JSON parse (works when responseMimeType=application/json)
    try:
        clean = txt.replace("```json", "").replace("```", "").strip()
        obj = json.loads(clean)
        rows = obj.get("rows") if isinstance(obj, dict) else obj
        if rows:
            log.info(f"Strategy 1 (direct JSON) succeeded — {len(rows)} rows")
    except Exception as e:
        parse_errors.append(f"Strategy 1 failed: {e}")

    # Strategy 2: find {"rows":[...]} block anywhere in text
    if not rows:
        m = re.search(r'\{[^{}]*"rows"\s*:\s*\[.*?\]\s*\}', txt, re.DOTALL)
        if m:
            try:
                rows = json.loads(m.group())["rows"]
                if rows:
                    log.info(f"Strategy 2 (regex rows block) succeeded — {len(rows)} rows")
            except Exception as e:
                parse_errors.append(f"Strategy 2 failed: {e}")
        else:
            parse_errors.append("Strategy 2: no 'rows' block found in text")

    # Strategy 3: find any [...] array in text
    if not rows:
        m = re.search(r'\[.*?\]', txt, re.DOTALL)
        if m:
            try:
                rows = json.loads(m.group())
                if rows:
                    log.info(f"Strategy 3 (bare array) succeeded — {len(rows)} rows")
            except Exception as e:
                parse_errors.append(f"Strategy 3 failed: {e}")
        else:
            parse_errors.append("Strategy 3: no array found in text")

    if not rows:
        log.error("ALL parse strategies failed!")
        for err in parse_errors:
            log.error(f"  {err}")
        log.error(f"Full Gemini text was: {txt}")
        return jsonify({
            "error": "Could not parse AI response. Try a clearer photo.",
            "raw": txt[:500],
            "parse_errors": parse_errors
        }), 422

    # ── Group by station ───────────────────────────────────────────────────────
    grouped = {}
    for r in rows:
        st   = re.sub(r'\D', '', str(r.get("station", "")))[-4:]
        tote = str(r.get("tote", "")).strip().upper()
        if not st or not tote:
            log.warning(f"Skipping row with missing data: {r}")
            continue
        grouped.setdefault(st, [])
        if tote not in grouped[st]:
            grouped[st].append(tote)

    if not grouped:
        log.error(f"Rows were parsed but no valid station/tote pairs. Rows: {rows}")
        return jsonify({"error": "No valid station/tote pairs found"}), 422

    log.info(f"SUCCESS — {len(grouped)} stations: { {k: len(v) for k,v in grouped.items()} }")
    log.info("=" * 55)

    return jsonify({"stations": [{"st": st, "totes": t} for st, t in grouped.items()]})


# ── Run ────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("\n" + "="*55)
    print("  FC Push Tracker - Free Edition")
    print("="*55)
    print(f"  Local:    http://localhost:5000")
    print(f"  Network:  http://0.0.0.0:5000")
    print(f"  Storage:  localStorage (per device, no server DB)")
    print(f"  AI Scan:  {'Gemini 2.5 Flash FREE ✓' if GEMINI_API_KEY else 'NOT SET — scan will fail'}")
    print("="*55)
    if not GEMINI_API_KEY:
        print()
        print("  ⚠  To enable Scan tab:")
        print("     1. Go to https://aistudio.google.com/app/apikey")
        print("     2. Create a free API key")
        print("     3. Run: export GEMINI_API_KEY=\"your-key-here\"")
        print()
    print("  Logs will appear below when you use the app.")
    print()
    app.run(host="0.0.0.0", port=5000, debug=True)
