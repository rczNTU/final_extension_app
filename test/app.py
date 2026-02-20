from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from datetime import datetime
import time
import json
import os

DATA_DIR = "data"
os.makedirs(DATA_DIR, exist_ok=True)
app = Flask(__name__)
CORS(app)  # not strictly needed anymore, but harmless

collecting = False
current_block = []

# 🔵 Serve the HTML page
@app.route("/")
def home():
    return render_template("index.html")


# 🔵 Start block
@app.route("/start", methods=["POST"])
def start():
    global collecting, current_block
    collecting = True
    current_block = []
    print("🟢 Block started")
    return jsonify({"status": "started"})


@app.route("/stop", methods=["POST"])
def stop():
    global collecting
    collecting = False
    print("🔴 Block stopped")

    data = request.json or {}

    # -----------------------
    # Extract
    # -----------------------
    filename = data.get("filename", "block")
    logs = data.get("logs", [])
    meta = data.get("meta", {})

    # -----------------------
    # Validate
    # -----------------------
    if not isinstance(logs, list):
        return jsonify({"error": "logs must be a list"}), 400

    # -----------------------
    # Sanitize filename
    # -----------------------
    filename = filename.replace("/", "").replace("\\", "").strip()
    if not filename:
        filename = "block"

    # timestamp to avoid overwrite
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")

    filename = f"{filename}_{timestamp}.json"

    filepath = os.path.join(DATA_DIR, filename)

    # -----------------------
    # Save
    # -----------------------
    payload = {
        "meta": {
            "server_received": datetime.utcnow().isoformat(),
            **meta
        },
        "logs": logs
    }

    with open(filepath, "w") as f:
        json.dump(payload, f, indent=2)

    print(f"💾 Saved {filepath} ({len(logs)} trials)")

    return jsonify({
        "status": "saved",
        "file": filepath,
        "total_trials": len(logs)
    })


# 🔵 Log trial
@app.route("/log", methods=["POST"])
def log():
    global collecting, current_block

    if not collecting:
        return jsonify({"error": "not collecting"}), 400

    data = request.json
    data["server_time"] = datetime.utcnow().isoformat()

    current_block.append(data)

    print("📊", data)

    return jsonify({"status": "logged"})


if __name__ == "__main__":
    app.run(debug=True)
