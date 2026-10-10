@echo off
rem ===========================================================================
rem  Build the HMS attendance agent.
rem
rem  Uses the C# compiler that is already inside Windows. Nothing to install:
rem  no Visual Studio, no .NET SDK, no internet. That is the whole reason this
rem  agent is written for .NET Framework rather than .NET 8 — the machine that
rem  needs it is in a hospital with no connection.
rem
rem  /platform:x86 is NOT optional. The ZKFinger DLLs are 32-bit, and a 64-bit
rem  process cannot load them: it fails with BadImageFormatException, which
rem  reads like a corrupt file rather than the architecture mismatch it is.
rem ===========================================================================

setlocal
cd /d "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo.
  echo   Could not find the C# compiler at:
  echo     %CSC%
  echo.
  echo   This Windows has no .NET Framework 4 compiler, which is unusual.
  echo   Install .NET Framework 4.8 and try again.
  echo.
  exit /b 1
)

if exist hms-attendance-agent.exe del hms-attendance-agent.exe

"%CSC%" /nologo /target:exe /platform:x86 /optimize+ ^
  /out:hms-attendance-agent.exe ^
  /reference:System.Web.Extensions.dll ^
  Program.cs Support.cs Zk.cs

if errorlevel 1 (
  echo.
  echo   Build failed. The errors are above.
  echo.
  exit /b 1
)

echo.
echo   Built hms-attendance-agent.exe
echo.
echo   Next:
echo     1. Copy libzkfpcsharp.dll next to the exe
echo        ^(from C:\Windows\SysWOW64 or C:\Windows\System32 after the
echo         ZKFinger SDK 5.x driver is installed^)
echo     2. Run the exe once. It writes agent.ini and stops.
echo     3. Put the reader key from HMS into agent.ini.
echo     4. Run it again.
echo.
endlocal
