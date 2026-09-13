# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with three main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express) plus the video worker entrypoint. Modules: auth, users, channels, mail, storage, queue, videos. See `nestjs-project/CLAUDE.md`.
- `next-frontend/` — Frontend (Next.js 16, React 19). See `next-frontend/CLAUDE.md`.
- `docs/` — Project documentation, architecture diagrams, and planning (`docs/decisions/`, `docs/phases/`).

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams/downloads videos through presigned storage URLs
- **API** (Nest.js) → business rules, auth, reads/writes DB, issues presigned storage URLs (never proxies video bytes), publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → dedicated `video-worker` container; consumes jobs from queue, extracts metadata + thumbnail, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3 API; MinIO in dev) → video files and thumbnails, reachable from the browser only through the `storage-gateway` reverse proxy
- **Message Queue** (Redis + BullMQ) → `video-processing` job queue
- **Email Service** (SMTP; Mailpit in dev) → account confirmation and password recovery

## Video Pipeline (Phase 03)

Upload and processing of videos up to 10 GB, designed so no app server ever carries the file bytes. Full contracts in `docs/phases/phase-03-videos/phase-03-videos.md`; decisions in `docs/decisions/technical-decisions-phase-03-videos.md`; implementation details in `nestjs-project/CLAUDE.md` → "Videos Module".

1. `POST /videos` pre-registers the video as `draft` (unique short `publicId`) and opens an S3 multipart upload.
2. The client asks for presigned part URLs and `PUT`s each part **directly to the storage gateway**, then calls `/upload/complete` with the part ETags.
3. The API completes the multipart upload, sets the status to `processing`, and enqueues a `video-processing` job.
4. The worker runs `ffprobe` (duration + metadata) and `ffmpeg` (thumbnail), then sets `ready` — or `failed` on error.
5. `ready` videos are streamed (HTTP Range) and downloaded via 302 redirects to presigned gateway URLs.

Status lifecycle stored in `videos.status`: `draft → uploading → processing → ready | failed`.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

**One deliberate exception — URLs handed to the browser.** Presigned storage URLs are consumed by the browser, so they are signed against a browser-reachable public host (`STORAGE_PUBLIC_HOST`, e.g. `http://localhost:9000` = the `storage-gateway`), while server-side storage calls use the internal service name (`STORAGE_ENDPOINT=http://minio:9000`). Never sign presigned URLs against `minio:9000`, and never use the public host for server-to-server calls.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.