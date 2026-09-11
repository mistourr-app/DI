@echo off
chcp 65001 >nul
title Blob tileset cutter
if "%~1"=="" (
  echo.
  echo  Drag and drop a PNG with 16x16 tiles here.
  echo  Result: src\assets\obstacles_blob.png
  echo.
  pause
  exit /b 1
)
node "%~dp0build-atlas.cjs" "%~1"
if errorlevel 1 (
  echo.
  echo  Error - see message above.
)
pause