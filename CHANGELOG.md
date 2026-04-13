# Changelog

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
