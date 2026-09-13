---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-delivery.e2e-spec.ts
---

# Video Delivery (Stream & Download) Test Plan

## Application Overview

`GET /videos/:publicId/stream` and `GET /videos/:publicId/download` deliver `ready` videos while keeping the API out of the byte path: each resolves a presigned GET URL on the **masked gateway** and issues a 302 redirect to it. The browser's subsequent Range requests (stream) hit the gateway directly. `stream` returns a Range-capable presigned URL; `download` returns a presigned URL carrying `content-disposition: attachment`. Both are first-class anonymous endpoints but only for `ready` videos — a non-`ready` video returns 409 `VIDEO_NOT_READY`, and an unknown `publicId` returns 404 `VIDEO_NOT_FOUND`. Presigned URLs always target the public gateway host, never the internal `minio:9000`.

## Test Scenarios

### 1. Streaming redirect (GET /videos/:publicId/stream)

**Setup:** `beforeEach` truncates `videos`, `channels`, `users` (reverse-FK order); bootstrap the app via `Test.createTestingModule({ imports: [AppModule] }).compile()` and re-apply `main.ts` global config. Seed one confirmed user with a channel, then directly insert videos in specific statuses (`ready`, `processing`) with a populated `storage_key`. Use `.redirects(0)` so the 302 + `Location` can be asserted without following the redirect.

#### 1.1. redirects-ready-video-stream-to-public-gateway-url

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. Seed a `ready` video with a `storage_key`, owned by the seeded channel
  2. GET /videos/:publicId/stream with NO Authorization header (anonymous watch)
    - expect: HTTP 302
    - expect: the `Location` header is a presigned GET URL whose host is the public gateway (`STORAGE_PUBLIC_HOST`)
    - expect: the `Location` header does NOT contain `minio:9000`
    - expect: no response body

#### 1.2. rejects-stream-for-non-ready-video

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. Seed a `processing` video owned by the seeded channel
  2. GET /videos/:publicId/stream (anonymous)
    - expect: HTTP 409
    - expect: response body `error` equals `"VIDEO_NOT_READY"`
    - expect: no `Location` redirect header

#### 1.3. returns-404-for-unknown-public-id-on-stream

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. GET /videos/does-not-exist/stream (a syntactically valid but non-resolving `publicId`)
    - expect: HTTP 404
    - expect: response body `error` equals `"VIDEO_NOT_FOUND"`

### 2. Download redirect (GET /videos/:publicId/download)

**Setup:** same bootstrap as group 1; seed `ready` and `processing` videos with `storage_key` and `original_filename` populated. Use `.redirects(0)`.

#### 2.1. redirects-ready-video-download-with-attachment-disposition

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. Seed a `ready` video with `storage_key` and `original_filename`, owned by the seeded channel
  2. GET /videos/:publicId/download (anonymous)
    - expect: HTTP 302
    - expect: the `Location` header is a presigned GET URL on the public gateway host (not `minio:9000`)
    - expect: the presigned URL encodes `response-content-disposition` = `attachment` (with the original filename)

#### 2.2. rejects-download-for-non-ready-video

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. Seed a `processing` video owned by the seeded channel
  2. GET /videos/:publicId/download (anonymous)
    - expect: HTTP 409
    - expect: response body `error` equals `"VIDEO_NOT_READY"`
