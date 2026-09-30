@echo off
setlocal
set NODE_EXE=D:\node-v22.23.1\node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node
"%NODE_EXE%" "%~dp0mcp.js" %*
