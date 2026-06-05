FROM node:20-slim

# Install ffmpeg + rubberband
RUN apt-get update && apt-get install -y \
    ffmpeg \
    librubberband-dev \
    rubberband-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
