# Скрипт запуска локального кластера Liaper:
# 1. Центральный сервер управления и реестра обновлений (порт 4000)
# 2. Медиа-нода SFU #1 (порт 4101, регион RU-Central)
# 3. Медиа-нода SFU #2 (порт 4102, регион RU-West)
# 4. Клиентское приложение (порт 5173)

Write-Host "Запуск центрального сервера liaper-control на http://127.0.0.1:4000 ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cargo run -p liaper-control-server"

Start-Sleep -Seconds 2

Write-Host "Запуск Медиа-ноды SFU #1 (порт 4101) ..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:NODE_PORT='4101'; `$env:NODE_ID='node-ru-1'; `$env:NODE_NAME='SFU Node #1 (Москва)'; `$env:NODE_REGION='RU-Central'; cargo run -p liaper-media-node"

Write-Host "Запуск Медиа-ноды SFU #2 (порт 4102) ..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:NODE_PORT='4102'; `$env:NODE_ID='node-ru-2'; `$env:NODE_NAME='SFU Node #2 (Сибирь)'; `$env:NODE_REGION='RU-East'; cargo run -p liaper-media-node"

Write-Host "Запуск веб/десктоп клиента на http://localhost:5173 ..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location clients\web-desktop; npm.cmd run dev"
