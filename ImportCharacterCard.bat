@echo off
chcp 65001 >nul
title RP Engine - Import Character Card

setlocal enabledelayedexpansion

echo ================================
echo   RP Engine - Card Importer
echo ================================
echo.

REM Check argument (drag-and-drop gives full path in %1)
if "%~1"=="" (
    echo Usage: Drag a .png or .json character card onto this file.
    echo.
    echo Or type the path manually:
    echo.
    set /p "FILE_PATH=Enter card path: "
) else (
    set "FILE_PATH=%~1"
)

REM Trim spaces
for /f "tokens=*" %%a in ("!FILE_PATH!") do set "FILE_PATH=%%a"

REM Check if file exists
if not exist "!FILE_PATH!" (
    echo.
    echo [ERROR] File not found: !FILE_PATH!
    echo.
    pause
    exit /b 1
)

REM Check extension
set "EXT=!FILE_PATH:~-4!"
if /i not "!EXT!"==".png" if /i not "!EXT!"==".json" (
    echo.
    echo [ERROR] Only .png and .json files are supported
    echo   File: !FILE_PATH!
    echo.
    pause
    exit /b 1
)

echo Importing: !FILE_PATH!
echo.
node "%~dp0setup.mjs" --import "!FILE_PATH!"

echo.
if %errorlevel% equ 0 (
    echo ================================
    echo   IMPORT COMPLETE
    echo ================================
) else (
    echo ================================
    echo   IMPORT FAILED - check errors above
    echo ================================
)

echo.
pause
