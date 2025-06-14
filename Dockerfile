FROM node:20-slim

# Install alsa-utils for arecord
RUN apt-get update && apt-get install -y alsa-utils && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Make main app executable
RUN chmod +x src/app.js

# Default environment variables
ENV MQTT_HOST=localhost
ENV AUDIO_DEVICE=default
ENV SAMPLE_RATE=48000
ENV DEVICE_NAME="Docker Noise Meter"

CMD ["npm", "start"]