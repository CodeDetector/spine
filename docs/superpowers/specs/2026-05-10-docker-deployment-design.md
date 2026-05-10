# Docker Deployment Design

**Date:** 2026-05-10  
**Scope:** Dockerize 3 backend services (mapMyEmail, mapMyWhatsapp, wa-field-tracker) with GitHub Actions CI and a single docker-compose in wa-field-tracker.

---

## Overview

Each backend service is packaged as an independent Docker image, built and pushed to Docker Hub automatically via GitHub Actions on every push to `main`. The `wa-field-tracker` repo serves as the deployment hub — it contains the `docker-compose.yml` that pulls all 3 images and runs them as a coordinated stack.

`wa-field-tracker-ui` (React/Vite frontend) is deployed separately on Vercel and is out of scope for this design.

---

## Services

| Service | Repo | Docker Hub Image | Exposed Port | Entry Command |
|---|---|---|---|---|
| Email feeder | `CodeDetector/mapMyEmail` | `codedetector/map-my-email:latest` | none (internal) | `npm start` |
| WhatsApp feeder | `CodeDetector/mapMyWhatsapp` | `codedetector/map-my-whatsapp:latest` | `3001` | `npm start` |
| Backend API | `CodeDetector/wa-field-tracker` | `codedetector/wa-field-tracker:latest` | `3000` | `npm start` |

All 3 containers share a Docker bridge network: `omni-network`.

---

## Dependency Fix

`wa-field-tracker/package.json` currently references two services via local `file:` paths which break inside Docker:

| Current | Replace With |
|---|---|
| `"file:../mapMyWhatsapp"` | `"github:CodeDetector/mapMyWhatsapp"` |
| `"file:../mapMyImap"` | `"github:CodeDetector/mapMyImap"` |

`mapMyEmail` is already referenced as `github:CodeDetector/mapMyEmail` — no change needed.

---

## Dockerfile (per service)

Each repo gets a `Dockerfile` at its root:

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
```

Notes:
- `python3 make g++` are needed for native modules (e.g. `@whiskeysockets/baileys` uses native bindings)
- `wa-field-tracker` already has this Dockerfile — it will be updated to use `npm start`

---

## GitHub Actions Workflow (per service)

Each repo gets `.github/workflows/docker.yml`:

```yaml
name: Build and Push Docker Image

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Log in to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: codedetector/<image-name>:latest
```

`<image-name>` is `map-my-email`, `map-my-whatsapp`, or `wa-field-tracker` respectively.

**Required GitHub repo secrets (set on each repo):**
- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

---

## docker-compose.yml (in wa-field-tracker)

```yaml
version: '3.8'

services:
  omni-email:
    image: codedetector/map-my-email:latest
    container_name: omni-email
    env_file: .env
    restart: unless-stopped
    networks:
      - omni-network

  omni-whatsapp:
    image: codedetector/map-my-whatsapp:latest
    container_name: omni-whatsapp
    ports:
      - "3001:3001"
    env_file: .env
    restart: unless-stopped
    networks:
      - omni-network

  omni-backend:
    image: codedetector/wa-field-tracker:latest
    container_name: omni-backend
    ports:
      - "3000:3000"
    env_file: .env
    restart: unless-stopped
    depends_on:
      - omni-email
      - omni-whatsapp
    networks:
      - omni-network

networks:
  omni-network:
    driver: bridge
```

---

## .env.example (in wa-field-tracker)

```env
# Supabase
SUPABASE_URL=
SUPABASE_KEY=

# Gemini
GEMINI_API_KEY=

# Google OAuth (Gmail)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=urn:ietf:wg:oauth:2.0:oob

# WhatsApp Cloud API
WHATSAPP_API_TYPE=cloud
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
WHATSAPP_WEBHOOK_URL=

# App config
ALLOWED_GROUPS=
ALLOW_PRIVATE_CHATS=
```

---

## Deploy Flow (on any server)

```bash
git clone https://github.com/CodeDetector/wa-field-tracker
cd wa-field-tracker
cp .env.example .env        # fill in secrets
docker-compose pull          # pull latest images from Docker Hub
docker-compose up -d         # start all services
```

To redeploy after a code change: push to `main` on any service repo → GitHub Actions builds & pushes new image → `docker-compose pull && docker-compose up -d` on the server.

---

## Files Changed / Created

| Repo | File | Action |
|---|---|---|
| `mapMyEmail` | `Dockerfile` | Create |
| `mapMyEmail` | `.github/workflows/docker.yml` | Create |
| `mapMyWhatsapp` | `Dockerfile` | Create |
| `mapMyWhatsapp` | `.github/workflows/docker.yml` | Create |
| `wa-field-tracker` | `Dockerfile` | Update (use `npm start`) |
| `wa-field-tracker` | `.github/workflows/docker.yml` | Create |
| `wa-field-tracker` | `docker-compose.yml` | Replace existing |
| `wa-field-tracker` | `package.json` | Fix `file:` deps → `github:` |
| `wa-field-tracker` | `.env.example` | Create |
