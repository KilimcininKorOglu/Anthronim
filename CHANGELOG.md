# Changelog

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
