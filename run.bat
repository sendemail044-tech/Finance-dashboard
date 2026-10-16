@echo off
rem Windows launcher: creates a virtual environment on first run, then starts the dashboard.
cd /d "%~dp0"
if not exist .venv ( python -m venv .venv )
call .venv\Scripts\activate
pip install -q -r requirements.txt
python app.py %*
pause
