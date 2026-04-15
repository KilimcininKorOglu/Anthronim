# Changelog

## [1.4.0] - 2026-04-15

### Added
- Configurable admin panel path via `ADMIN_PATH` environment variable
- Timezone support for stats display (`TZ` env var, default `Europe/Istanbul`)
- Descriptive error when model not found on NVIDIA (404 → model name in message)
- Descriptive error for non-multimodal model image requests (400 → model name)

### Fixed
- SSE keepalive heartbeat prevents reverse proxy idle timeout on long requests
- Server timeout configuration (`timeout=0`) for streaming and non-streaming

## [1.3.2] - 2026-04-14

### Added
- Public stats endpoint (`/stats`) with total requests, today count, active users, hourly chart, and model usage
- Landing page statistics section with bar chart and top model ranking
- Token editing via PATCH endpoint (label and token value)
- Full plaintext token display in admin UI with click-to-edit
- Plaintext column for lazy hash-to-plaintext token migration
- Key and token labels in logs table instead of numeric IDs
- Map upstream context limit errors to Anthropic `invalid_request_error`

### Fixed
- Remove brute-force protection from proxy auth gate to prevent API client lockout

## [1.3.1] - 2026-04-14

### Changed
- Update README with all configurable env vars and new features

### Fixed
- Make NVIDIA base URL configurable via NVIDIA_BASE_URL env var
- Make cleanup intervals configurable via environment variables
- Make hardcoded limits configurable via environment variables

## [1.3.0] - 2026-04-14

### Added
- Auto-deactivate API keys on 403 auth failure from NVIDIA
- Brute-force protection on proxy auth gate (shared lockout with admin)
- Exponential backoff for brute-force lockout (doubles per trigger, max 4h)
- HEALTHCHECK directive in Dockerfile and docker-compose
- Request log retention policy with periodic cleanup (LOG_RETENTION_DAYS)
- TRUST_PROXY env var to control X-Forwarded-For trust
- Open Graph and Twitter Card meta tags to landing page
- Standard meta tags across all HTML pages
- Upstream error logs page and admin logs API endpoint
- Error detail capture in request log

### Changed
- Auth tokens now stored as SHA-256 hashes instead of plaintext
- hasTokens() counts only active tokens to prevent self-lockout
- Upstream error bodies parsed and filtered before storage
- Dev compose service uses runtime stage instead of builder
- Console error logs sanitized (message only, no stack traces or raw data)
- Prepared statements for modelStats and tokenStats cached at init
- Docker base image pinned to SHA256 digest

### Fixed
- X-Forwarded-For spoofing bypass on brute-force lockout
- Dev compose service missing security hardening directives
- Package-lock.json version mismatch with package.json
- Parse think tags in non-streaming responses
- Create data directory in Dockerfile and add logs.html to image

## [1.2.0] - 2026-04-13

### Fixed
- Add clickjacking protection headers to HTML responses
- Check active token count in deletion guard instead of total count
- Add periodic cleanup for expired brute-force tracking entries
- Exclude secret file patterns from Docker build context
- Add security hardening directives to production compose service
- Run dev docker service as non-root user
- Prevent deactivating last active auth token
- Use rightmost X-Forwarded-For value for rate limiter IP
- Return 400 for malformed request bodies
- Prevent deleting last auth token when no env fallback
- Add brute-force protection to admin auth
- Sanitize upstream error responses
- Disable CORS preflight for admin routes
- Handle malformed tool_call arguments gracefully
- Use constant-time comparison for auth credentials
- Add request body size limit to prevent memory exhaustion
- Run container as non-root user
- Match token input width to key input in admin forms
- Add curl to runtime image for health check

## [1.1.0] - 2026-04-13

### Added
- SQLite database layer with API key pool and round-robin distribution
- Admin dashboard with HTTP Basic Auth and key/token CRUD endpoints
- Admin dashboard HTML with dark terminal aesthetic UI
- Auth token management (DB-backed, replaces single AUTH_TOKEN env var)
- Token generation button with `hermes-` prefix in admin UI
- Public landing page with model list and Claude Code configuration guide
- NVIDIA model catalog proxy with 1-hour in-memory cache
- `/v1/models` endpoint converted to Anthropic ModelInfo format
- `/v1/models/:id` endpoint for single model lookup
- Model list with request count column in admin dashboard
- Available models section in admin panel (NVIDIA NIM catalog)
- Docker support with multi-stage Dockerfile and docker-compose
- `MODEL_CACHE_TTL` and `DB_PATH` configurable via environment variables

### Changed
- `NVIDIA_API_KEY` now optional when API keys exist in database
- `AUTH_TOKEN` now serves as env fallback; tokens managed via admin panel
- Route order: public routes (`/`, `/health`, `/v1/models`) moved before auth gate
- CORS methods expanded to include PATCH and DELETE
- Code comments converted to English
- Turkish localization improved with proper characters across all files

### Fixed
- Model provider extracted from ID instead of removed `owned_by` field
- Foreign key ON DELETE SET NULL for request_log to prevent key deletion failures
