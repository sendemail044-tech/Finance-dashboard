#!/usr/bin/env bash
# Mac / Linux launcher: creates a virtual environment on first run, then starts the dashboard.
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements.txt
python app.py "$@"
