@echo off
setlocal
chcp 65001 >nul

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0InstallFeature.ps1" %*
set "INSTALL_EXIT_CODE=%ERRORLEVEL%"

if not "%INSTALL_EXIT_CODE%"=="0" (
  echo.
  echo [安装失败] 删除元素 Feature 没有安装成功。请保留上方错误信息。
  if "%~1"=="" pause
  exit /b %INSTALL_EXIT_CODE%
)

echo.
echo [安装成功] 可以重新打开 Omnia Agent v5。
if "%~1"=="" pause
exit /b 0
