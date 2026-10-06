@echo off
setlocal
rem node 解析顺序：DTS_NODE_EXE 环境变量 → PATH 里的 node。
rem （以前这里写死了开发机的 D:\node-v22.23.1\node.exe，换机器上就找不到）
set NODE_EXE=%DTS_NODE_EXE%
if not defined NODE_EXE set NODE_EXE=node
"%NODE_EXE%" "%~dp0mcp.js" %*
