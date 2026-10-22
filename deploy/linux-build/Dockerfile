# Сборка Linux-пакетов десктопа (.deb, .AppImage) в одноразовом контейнере.
# docker build -f deploy/linux-build/Dockerfile -t liaper-linux-build . && docker run --rm \
#   -e TAURI_SIGNING_PRIVATE_KEY -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD -v "$PWD/out:/out" liaper-linux-build
FROM rust:1.95-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
      libssl-dev patchelf file xdg-utils curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
ENV APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true VITE_CONTROL_URL=https://liaper.ru
WORKDIR /src/clients/web-desktop
COPY clients/web-desktop/package.json clients/web-desktop/package-lock.json ./
RUN npm ci
COPY clients/web-desktop ./
CMD npx tauri build --bundles deb,appimage \
    && mkdir -p /out \
    && cp src-tauri/target/release/bundle/deb/*.deb /out/ \
    && cp src-tauri/target/release/bundle/appimage/*.AppImage* /out/
