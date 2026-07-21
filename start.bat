@echo off
echo ==================================================
echo  LeadPilot Ad Manager + BI Research Agent Launcher
echo ==================================================
echo.

echo [1/2] Starting Research Engine (FastAPI) on http://localhost:8000 ...
start "Research Engine" cmd /k "cd /d %~dp0 && python -m uvicorn api:app --host 127.0.0.1 --port 8000 --reload"

timeout /t 2 /nobreak > nul

echo [2/2] Starting LeadPilot Ad Manager on http://localhost:3001 ...
start "LeadPilot Ad Manager" cmd /k "cd /d %~dp0 && npm start"

echo.
echo Both servers starting up!
echo   Ad Manager UI:      http://localhost:3001
echo   Research Engine:    http://localhost:8000
echo   Research API Docs:  http://localhost:8000/docs
echo.
pause
