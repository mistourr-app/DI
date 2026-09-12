@echo off
chcp 65001 >nul
title Blob tileset cutter (inferno)
if "%~1"=="" (
  echo.
  echo  Drag and drop a PNG with 16x16 inferno tiles here.
  echo  Result: src\assets\obstacles_blob_inferno.png
  echo.
  pause
  exit /b 1
)
node "%~dp0build-atlas.cjs" "%~1" "%~dp0..\src\assets\obstacles_blob_inferno.png"
if errorlevel 1 (
  echo.
  echo  Error - see message above.
)
pause