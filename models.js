// Shared NVIDIA /models fetch + cache. Both the proxy (/v1/models, mapped to
// Anthropic shape) and the admin panel (/admin/api/models, raw NVIDIA shape)
// read from this single module-level cache instead of maintaining their own.

const API_BASE = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const MODEL_CACHE_TTL = parseInt(process.env.MODEL_CACHE_TTL || '3600000', 10);

let rawCache = null;      // raw NVIDIA payload: { object: 'list', data: [...] }
let rawCacheTime = 0;

// Fetch the raw NVIDIA model list, cached for MODEL_CACHE_TTL. An empty list is
// never cached (it would pin "no models" for the full TTL even after upstream
// recovers) and every failure mode logs a warning. Returns the raw payload, or
// the stale cache, or an empty { object:'list', data:[] } on cold failure.
export async function fetchRawModels() {
  const now = Date.now();
  if (rawCache && (now - rawCacheTime) < MODEL_CACHE_TTL) {
    return rawCache;
  }
  try {
    const res = await fetch(`${API_BASE}/models`);
    if (res.ok) {
      const json = await res.json();
      if (json && Array.isArray(json.data) && json.data.length > 0) {
        rawCache = json;
        rawCacheTime = now;
      } else {
        console.warn('[NVIDIA] /models returned an empty list; not caching');
      }
    } else {
      console.warn(`[NVIDIA] /models fetch failed with HTTP ${res.status}; serving stale/empty list`);
    }
  } catch (e) {
    console.warn(`[NVIDIA] /models fetch error: ${e.message || e}; serving stale/empty list`);
  }
  return rawCache || { object: 'list', data: [] };
}
