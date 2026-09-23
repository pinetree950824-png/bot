@echo off
title Matrix Music Bot (Docker)
echo [INFO] Starting Matrix Music Bot via Docker Compose...
docker compose up -d
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Failed to start Docker container. Please make sure Docker Desktop is running!
    pause
    exit /b %ERRORLEVEL%
)
echo.
echo [SUCCESS] Bot container started in background.
echo Run logs.bat to view live logs or run stop.bat to stop.
pause
