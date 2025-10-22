@echo off

setlocal

node -v >nul 2>nul

if %errorlevel% neq 0 goto nonode

if not exist node_modules (

  echo Installing dependencies...

  call npm install

  if %errorlevel% neq 0 goto npmfail

)

echo.

echo Starting BBit Reader v.58...

node bbit-reader.js

pause

goto :eof

:nonode

echo Node.js is not installed. Get LTS from https://nodejs.org/

pause

exit /b 1

:npmfail

echo npm install failed.

pause

exit /b 1

