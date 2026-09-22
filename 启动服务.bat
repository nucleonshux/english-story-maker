@echo off
cd /d "E:\英语角生成器"
start /min node "C:\Users\Adminx\AppData\Local\Temp\wstest\static_server.js"
timeout /t 2 /nobreak >nul
cd /d "E:\英语角生成器\tts-relay"
start /min node index.js
