@echo off
title Matrix Music Bot

set "CONDA_DIR=C:\Users\dding\miniconda3"
set "NODE_DIR=C:\Program Files\nodejs"
set "FFMPEG_DIR=C:\Users\dding\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin"

set "PATH=%CONDA_DIR%;%CONDA_DIR%\Scripts;%NODE_DIR%;%FFMPEG_DIR%;%PATH%"

echo ========================================================
echo       Starting Matrix Element Call Music Bot
echo ========================================================
echo.
echo Press Ctrl + C to stop the bot.
echo.

"%CONDA_DIR%\python.exe" main.py

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Bot exited with error code %ERRORLEVEL%.
    pause
)
