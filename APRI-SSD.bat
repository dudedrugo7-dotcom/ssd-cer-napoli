@echo off
REM ---------------------------------------------------------------
REM  Apre l'SSD direttamente in Chrome.
REM  Serve perche' su questo computer i file .html sono associati a
REM  un visualizzatore di codice, che ne mostra il sorgente invece
REM  di eseguirli. Qui il browser viene invocato esplicitamente.
REM ---------------------------------------------------------------
set "SSD=%~dp0SSD-v8-Napoli-standalone.html"

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%SSD%"
    exit /b
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%SSD%"
    exit /b
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%SSD%"
    exit /b
)
REM ultima risorsa: programma predefinito del sistema
start "" "%SSD%"
