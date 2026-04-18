# USE ONE IMAGE FOR BOTH TO KEEP IT SIMPLE
FROM node:20-slim

# Install necessary tools for canvas/media if needed
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Default command (will be overridden by docker-compose)
CMD ["node", "index.js"]
