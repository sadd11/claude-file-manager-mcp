@echo off
chcp 65001 >nul
title Claude File Manager - Setup
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"

"%NODE%" ui\server.js

if errorlevel 1 pause
