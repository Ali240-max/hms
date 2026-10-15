@echo off
rem ===========================================================================
rem  Build the HMS attendance agent.
rem
rem  Uses the C# compiler that is already inside Windows. Nothing to install:
rem  no Visual Studio, no .NET SDK, no internet. That is the whole reason this
rem  agent is written for .NET Framework rather than .NET 8 — the machine that
rem  needs it is in a hospital with no connection.
rem
rem  /platform:x86 is NOT optional FOR READER MODE. The ZKFinger DLLs are
rem  32-bit, and a 64-bit process cannot load them: it fails with
rem  BadImageFormatException, which reads like a corrupt file rather than the
rem  architecture mismatch it is.
rem
rem  Terminal mode (a ZKTeco K50 or similar on the network) loads no DLL at
rem  all and would run just as well 64-bit. The build stays x86 anyway so
rem  that ONE executable serves both modes: a hospital with a reader at one
rem  door and a terminal at another should not be running two different
rem  builds and wondering which is which.
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
  Program.cs Support.cs Zk.cs Terminal.cs FakeDevice.cs

if errorlevel 1 (
  echo.
  echo   Build failed. The errors are above.
  echo.
  exit /b 1
)

echo.
echo   Built hms-attendance-agent.exe
echo.
echo   Next, for a USB READER (Live20R / SLK20R / ZK9500):
echo     1. Copy libzkfpcsharp.dll next to the exe
echo        ^(from C:\Windows\SysWOW64 or C:\Windows\System32 after the
echo         ZKFinger SDK 5.x driver is installed^)
echo     2. Run the exe once. It writes agent.ini and stops.
echo     3. Put the reader key from HMS into agent.ini.
echo     4. Run it again.
echo.
echo   Or, for a NETWORK TERMINAL (K50 and similar) - no DLL needed:
echo     1. Run the exe once. It writes agent.ini and stops.
echo     2. In agent.ini set:  Mode=terminal
echo        and DeviceIp to the address under Menu ^> Comm ^> Ethernet,
echo        and DeviceKey to the key from HMS.
echo     3. Check it before trusting it:
echo          hms-attendance-agent.exe --probe
echo        That lists the people on the device, who they map to in HMS,
echo        and the last ten punches. It posts nothing.
echo     4. Run it with no arguments to start forwarding.
echo.
echo   To check the protocol at any time:  test-protocol.bat
echo   ^(it runs a fake device on loopback - connects to nothing real^)
echo.
endlocal
