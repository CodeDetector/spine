# Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dockerize all 4 services with GitHub Actions CI/CD so the full stack can be deployed on any server with `docker-compose pull && docker-compose up -d`.

**Architecture:** Each repo gets its own `Dockerfile` and a GitHub Actions workflow that builds and pushes the image to Docker Hub on every push to `main`. The `wa-field-tracker` repo is the deployment hub — it contains the `docker-compose.yml` that pulls all 4 pre-built images and runs them on a shared Docker network.

**Tech Stack:** Docker, Docker Hub, GitHub Actions, nginx (for UI), Node 20, Vite (React build)

---

## File Map

| Repo | File | Action |
|---|---|---|
| `mapMyEmail` | `Dockerfile` | Create |
| `mapMyEmail` | `.github/workflows/docker.yml` | Create |
| `mapMyWhatsapp` | `Dockerfile` | Create |
| `mapMyWhatsapp` | `.github/workflows/docker.yml` | Create |
| `wa-field-tracker` | `Dockerfile` | Update CMD to `npm start` |
| `wa-field-tracker` | `.github/workflows/docker.yml` | Create |
| `wa-field-tracker` | `docker-compose.yml` | Replace existing |
| `wa-field-tracker` | `package.json` | Fix `file:` deps → `github:` |
| `wa-field-tracker` | `.env.example` | Create |
| `wa-field-tracker-ui` | `Dockerfile` | Create (multi-stage nginx) |
| `wa-field-tracker-ui` | `nginx.conf` | Create |
| `wa-field-tracker-ui` | `.github/workflows/docker.yml` | Create |

---

## Task 1: Dockerfile + GitHub Actions for `mapMyEmail`

**Files:**
- Create: `C:\Users\HP\mapMyEmail\Dockerfile`
- Create: `C:\Users\HP\mapMyEmail\.github\workflows\docker.yml`

- [ ] **Step 1: Create `Dockerfile`**

Create `C:\Users\HP\mapMyEmail\Dockerfile` with this exact content:

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
```

- [ ] **Step 2: Create `.github/workflows/docker.yml`**

Create `C:\Users\HP\mapMyEmail\.github\workflows\docker.yml`:

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
          tags: codedetector/map-my-email:latest
```

- [ ] **Step 3: Commit**

```powershell
cd C:\Users\HP\mapMyEmail
git add Dockerfile .github/workflows/docker.yml
git commit -m "ci: add Dockerfile and GitHub Actions workflow for Docker Hub"
```

---

## Task 2: Dockerfile + GitHub Actions for `mapMyWhatsapp`

**Files:**
- Create: `C:\Users\HP\mapMyWhatsapp\Dockerfile`
- Create: `C:\Users\HP\mapMyWhatsapp\.github\workflows\docker.yml`

- [ ] **Step 1: Create `Dockerfile`**

Create `C:\Users\HP\mapMyWhatsapp\Dockerfile`:

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
```

- [ ] **Step 2: Create `.github/workflows/docker.yml`**

Create `C:\Users\HP\mapMyWhatsapp\.github\workflows\docker.yml`:

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
          tags: codedetector/map-my-whatsapp:latest
```

- [ ] **Step 3: Commit**

```powershell
cd C:\Users\HP\mapMyWhatsapp
git add Dockerfile .github/workflows/docker.yml
git commit -m "ci: add Dockerfile and GitHub Actions workflow for Docker Hub"
```

---

## Task 3: Dockerfile + GitHub Actions for `wa-field-tracker-ui`

**Files:**
- Create: `C:\Users\HP\wa-field-tracker-ui\Dockerfile`
- Create: `C:\Users\HP\wa-field-tracker-ui\nginx.conf`
- Create: `C:\Users\HP\wa-field-tracker-ui\.github\workflows\docker.yml`

- [ ] **Step 1: Create `nginx.conf`**

Create `C:\Users\HP\wa-field-tracker-ui\nginx.conf`:

```nginx
server {
    listen 80;

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://omni-backend:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

- [ ] **Step 2: Create `Dockerfile`**

Create `C:\Users\HP\wa-field-tracker-ui\Dockerfile`:

```dockerfile
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

- [ ] **Step 3: Create `.github/workflows/docker.yml`**

Create `C:\Users\HP\wa-field-tracker-ui\.github\workflows\docker.yml`:

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
          tags: codedetector/wa-field-tracker-ui:latest
```

- [ ] **Step 4: Commit**

```powershell
cd C:\Users\HP\wa-field-tracker-ui
git add Dockerfile nginx.conf .github/workflows/docker.yml
git commit -m "ci: add Dockerfile, nginx config, and GitHub Actions workflow for Docker Hub"
```

---

## Task 4: Update `wa-field-tracker` — fix deps, Dockerfile, add Actions + compose

**Files:**
- Modify: `C:\Users\HP\wa-field-tracker\package.json`
- Modify: `C:\Users\HP\wa-field-tracker\Dockerfile`
- Create: `C:\Users\HP\wa-field-tracker\.github\workflows\docker.yml`
- Replace: `C:\Users\HP\wa-field-tracker\docker-compose.yml`
- Create: `C:\Users\HP\wa-field-tracker\.env.example`

- [ ] **Step 1: Fix `file:` deps in `package.json`**

In `C:\Users\HP\wa-field-tracker\package.json`, change these two dependency entries:

```json
"wa-field-tracker-feeder-imap": "file:../mapMyImap",
"wa-field-tracker-feeder-whatsapp": "file:../mapMyWhatsapp"
```

to:

```json
"wa-field-tracker-feeder-imap": "github:CodeDetector/mapMyImap",
"wa-field-tracker-feeder-whatsapp": "github:CodeDetector/mapMyWhatsapp"
```

The full `dependencies` block should look like:

```json
"dependencies": {
  "@google/genai": "^2.0.0",
  "cors": "^2.8.6",
  "express": "^5.2.1",
  "imapflow": "^1.0.194",
  "multer": "^2.1.1",
  "pino": "^10.3.1",
  "wa-field-tracker-feeder-email": "github:CodeDetector/mapMyEmail",
  "wa-field-tracker-feeder-imap": "github:CodeDetector/mapMyImap",
  "wa-field-tracker-feeder-whatsapp": "github:CodeDetector/mapMyWhatsapp"
}
```

- [ ] **Step 2: Update `Dockerfile` CMD**

In `C:\Users\HP\wa-field-tracker\Dockerfile`, replace the last two lines:

```dockerfile
# Default command (will be overridden by docker-compose)
CMD ["node", "index.js"]
```

with:

```dockerfile
CMD ["npm", "start"]
```

Also remove the stale comment on line 1 (`# USE ONE IMAGE FOR BOTH TO KEEP IT SIMPLE`). Final file:

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
```

- [ ] **Step 3: Create `.github/workflows/docker.yml`**

Create `C:\Users\HP\wa-field-tracker\.github\workflows\docker.yml`:

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
          tags: codedetector/wa-field-tracker:latest
```

- [ ] **Step 4: Replace `docker-compose.yml`**

Overwrite `C:\Users\HP\wa-field-tracker\docker-compose.yml` with:

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

  omni-ui:
    image: codedetector/wa-field-tracker-ui:latest
    container_name: omni-ui
    ports:
      - "80:80"
    restart: unless-stopped
    depends_on:
      - omni-backend
    networks:
      - omni-network

networks:
  omni-network:
    driver: bridge
```

- [ ] **Step 5: Create `.env.example`**

Create `C:\Users\HP\wa-field-tracker\.env.example`:

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

# App config
ALLOWED_GROUPS=
ALLOW_PRIVATE_CHATS=
```

- [ ] **Step 6: Commit all wa-field-tracker changes**

```powershell
cd C:\Users\HP\wa-field-tracker
git add package.json Dockerfile .github/workflows/docker.yml docker-compose.yml .env.example
git commit -m "ci: add Docker + GitHub Actions; fix file: deps to github: refs"
```

---

## Task 5: Set GitHub Secrets on Docker Hub + each repo

These are manual steps done in the browser — no code changes.

- [ ] **Step 1: Create Docker Hub access token**

  1. Log in to [hub.docker.com](https://hub.docker.com)
  2. Go to Account Settings → Security → New Access Token
  3. Name it `github-actions`, permission: Read & Write
  4. Copy the token — you won't see it again

- [ ] **Step 2: Add secrets to each GitHub repo**

Repeat for all 4 repos: `CodeDetector/mapMyEmail`, `CodeDetector/mapMyWhatsapp`, `CodeDetector/wa-field-tracker`, `CodeDetector/wa-field-tracker-ui`

  1. Go to repo → Settings → Secrets and variables → Actions → New repository secret
  2. Add `DOCKERHUB_USERNAME` = your Docker Hub username (e.g. `codedetector`)
  3. Add `DOCKERHUB_TOKEN` = the token from Step 1

---

## Task 6: Push all branches to trigger GitHub Actions

- [ ] **Step 1: Push `mapMyEmail`**

```powershell
cd C:\Users\HP\mapMyEmail
git push origin master:main
```

Expected: GitHub Actions triggers, builds image, pushes `codedetector/map-my-email:latest` to Docker Hub. Check Actions tab on GitHub to confirm green.

- [ ] **Step 2: Push `mapMyWhatsapp`**

```powershell
cd C:\Users\HP\mapMyWhatsapp
git push origin master:main
```

Expected: `codedetector/map-my-whatsapp:latest` appears on Docker Hub.

- [ ] **Step 3: Push `wa-field-tracker-ui`**

```powershell
cd C:\Users\HP\wa-field-tracker-ui
git push origin master:main
```

Expected: `codedetector/wa-field-tracker-ui:latest` appears on Docker Hub.

- [ ] **Step 4: Push `wa-field-tracker`**

```powershell
cd C:\Users\HP\wa-field-tracker
git push origin master:main
```

Expected: `codedetector/wa-field-tracker:latest` appears on Docker Hub.

---

## Task 7: Smoke test locally with docker-compose

- [ ] **Step 1: Create local `.env`**

```powershell
cd C:\Users\HP\wa-field-tracker
cp .env.example .env
```

Fill in the actual values from the existing `wa-field-tracker\.env` and `mapMyWhatsapp\.env`.

- [ ] **Step 2: Pull images and start stack**

```powershell
cd C:\Users\HP\wa-field-tracker
docker-compose pull
docker-compose up -d
```

Expected output: 4 containers start — `omni-email`, `omni-whatsapp`, `omni-backend`, `omni-ui`.

- [ ] **Step 3: Verify containers are running**

```powershell
docker ps
```

Expected: all 4 containers show `Up` status.

- [ ] **Step 4: Verify UI is reachable**

Open `http://localhost` in a browser. Expected: the React frontend loads.

- [ ] **Step 5: Verify backend API is reachable**

```powershell
curl http://localhost:3000
```

Expected: HTTP 200 or JSON response (not connection refused).

- [ ] **Step 6: Verify UI proxies API correctly**

```powershell
curl http://localhost/api/
```

Expected: response proxied from `omni-backend:3000` (not an nginx 502).

- [ ] **Step 7: Check logs for errors**

```powershell
docker-compose logs --tail=50
```

Expected: no crash logs or unhandled errors in any container.

- [ ] **Step 8: Tear down**

```powershell
docker-compose down
```
