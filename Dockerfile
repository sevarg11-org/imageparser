FROM node:22-slim

# Install system dependencies, a window manager (Openbox), VNC server, and web client
RUN apt-get update && apt-get install -y \
    libgtk-3-0 libnss3 libatk-bridge2.0-0 libxss1 libasound2 libatk1.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 \
    xvfb x11vnc openbox python3-xdg novnc websockify \
    exiftool \
    && rm -rf /var/lib/apt/lists/*

COPY --from=pkking/immich-go:latest /immich-go /usr/local/bin/immich-go

WORKDIR /app

# Copy application files
COPY package*.json ./
RUN npm install \
    && npx install-electron
COPY . .

# Build the React UI into dist/ so Electron loads it instead of the Vite dev server
RUN npm run build

# Expose port 8080 for the browser interface
EXPOSE 8080

# Create a startup script to launch the virtual screen, window manager, and the web proxy
RUN echo '#!/bin/bash\n\
Xvfb :1 -screen 0 1280x720x24 &\n\
export DISPLAY=:1\n\
sleep 1\n\
openbox-session &\n\
# Run Electron with --no-sandbox since we are operating inside a root container environment\n\
npm start -- --no-sandbox &\n\
x11vnc -display :1 -nopw -forever -shared &\n\
/usr/share/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 8080\n\
' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]
