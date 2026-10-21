@echo off
chcp 65001 >nul
echo [Liaper Desktop] Запуск десктопного клиента...
start "" msedge --app="http://localhost:5173" --window-size=1360,840
