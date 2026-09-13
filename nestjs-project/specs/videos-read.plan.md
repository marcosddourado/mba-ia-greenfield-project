---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-read.e2e-spec.ts
---

# Video Read & Live Status Test Plan

## Application Overview

`GET /videos/:publicId` returns the public video DTO (`publicId`, `title`, `status`, `progress`, `durationSeconds`, `metadata`, `thumbnailUrl`, `createdAt`) with status-driven visibility: anonymous and non-owner callers see only `ready` videos, while the owner sees a video in any status (`draft`/`uploading`/`processing`/`ready`/`failed`). A non-`ready` video requested by a non-owner returns 404 `VIDEO_NOT_FOUND` (existence is hidden rather than exposed via 403). `GET /videos/:publicId/status` is an owner-only Server-Sent Events channel (`@Sse()` returning `Observable<MessageEvent>`, driven by BullMQ `QueueEvents`) that pushes `{ status, progress }` events during processing and closes the stream when the video reaches `ready`/`failed` or the client disconnects.

## Test Scenarios

### 1. Read with visibility rules (GET /videos/:publicId)

**Setup:** `beforeEach` truncates `videos`, `channels`, `users` (reverse-FK order); bootstrap the app via `Test.createTestingModule({ imports: [AppModule] }).compile()` and re-apply `main.ts` global config. Seed one confirmed owner user with a channel plus an access token, and directly insert videos in specific statuses (`ready`, `processing`) owned by that channel.

#### 1.1. anonymous-reads-ready-video-returns-public-dto

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. Seed a `ready` video (with `duration_seconds`, `metadata`, `thumbnail_key` populated) owned by the seeded channel
  2. GET /videos/:publicId with NO Authorization header
    - expect: HTTP 200
    - expect: response body `publicId` matches the seeded video
    - expect: response body `status` equals `"ready"`
    - expect: response body exposes `title`, `durationSeconds`, `metadata`, `thumbnailUrl`, `createdAt`
    - expect: response body does NOT expose the internal uuid `id`, `storageKey`, or `channelId`

#### 1.2. hides-processing-video-from-non-owner-as-404

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. Seed a `processing` video owned by the primary channel
  2. GET /videos/:publicId with NO Authorization header (anonymous / non-owner)
    - expect: HTTP 404
    - expect: response body `error` equals `"VIDEO_NOT_FOUND"`
    - expect: response body does not leak that the video exists in a non-ready state

#### 1.3. owner-reads-own-processing-video-returns-dto

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. Seed a `processing` video owned by the primary channel
  2. GET /videos/:publicId with the OWNER's Bearer access token
    - expect: HTTP 200
    - expect: response body `status` equals `"processing"`
    - expect: response body `progress` is present (number or null)

### 2. Live status stream (GET /videos/:publicId/status, SSE)

**Setup:** same bootstrap as group 1. Seed a `processing` video owned by the primary channel and ensure the BullMQ `QueueEvents` for `video-processing` is available (real Redis). For the unauthenticated scenario, no seeding of tokens is required.

#### 2.1. streams-live-status-events-and-closes-on-terminal-state

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. Open GET /videos/:publicId/status with the OWNER's access token and `Accept: text/event-stream`
    - expect: HTTP 200 with `Content-Type: text/event-stream`
    - expect: the first received event `data` is JSON parseable to `{ status, progress }`
  2. Drive the job to a terminal state (`ready` or `failed`) via the queue
    - expect: the stream emits the terminal `{ status }` and then completes (closes) rather than staying open indefinitely

#### 2.2. rejects-status-stream-without-token

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. Open GET /videos/:publicId/status with NO Authorization header and `Accept: text/event-stream`
    - expect: HTTP 401
    - expect: no `text/event-stream` response is established
