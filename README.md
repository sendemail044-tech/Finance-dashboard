# My Finances - local dashboard

Everything runs on your computer. Data is stored in one file: `finance.db` (SQLite). Nothing is sent anywhere.

## Run
1. Install Python 3.10+ (python.org). On Windows tick "Add Python to PATH".
2. Windows: double-click `run.bat`. Mac/Linux: `./run.sh`.
3. Open http://localhost:8000 and create a password.

First run installs the libraries (needs internet once). After that it works offline.

## Forgot password
`python app.py --reset-password` (your data is not touched).

## Backups
Settings -> Download backup. Or just copy `finance.db`.

## Notes
- Statement parsing is rule-based. Always check the review screen before importing.
- If a statement format isn't read well, you can add the entries manually.
