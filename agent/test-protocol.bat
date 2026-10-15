@echo off
rem ===========================================================================
rem  Check the ZKTeco protocol arithmetic.
rem
rem  Touches no real device and posts nothing. It builds a test program from
rem  the agent's own source, stands up a FAKE TERMINAL on loopback, and holds
rem  a whole conversation with it.
rem
rem  Three kinds of fault it catches, all of which have actually happened:
rem
rem    the packet header     one byte wrong, and the device closes the socket
rem                          saying nothing at all
rem
rem    the record layout     wrong offsets, and the dates look like dates
rem                          and are wrong by months
rem
rem    the packet accounting one unread reply, and every answer after it
rem                          belongs to the command before - which showed up
rem                          as the attendance log being refused when it
rem                          was not
rem
rem  The expected numbers come from the reference implementation everybody
rem  else's ZKTeco integration is built on, and from a packet trace of a real
rem  K50. Not from memory.
rem
rem  Run this after changing Terminal.cs, and once before trusting a build.
rem ===========================================================================

setlocal
cd /d "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo   No C# compiler at %CSC%
  exit /b 1
)

if exist protocol-test.exe del protocol-test.exe

"%CSC%" /nologo /target:exe /main:ProtoTest /out:protocol-test.exe ^
  /reference:System.Web.Extensions.dll ^
  Program.cs Support.cs Zk.cs Terminal.cs Scan.cs FakeDevice.cs ProtoTest.cs AgentTest.cs

if errorlevel 1 (
  echo.
  echo   Build failed. The errors are above.
  exit /b 1
)

rem  .\ so it runs on a shell set not to search the current folder.
.\protocol-test.exe
set RC=%ERRORLEVEL%
del protocol-test.exe
exit /b %RC%
