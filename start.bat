@echo off
rem Lance tout le projet sous Windows (double-clic ou "start.bat -Test").
rem Passe par PowerShell sans changer la politique d execution du poste.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
