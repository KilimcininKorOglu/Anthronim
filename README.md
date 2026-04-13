# Anthronim

NVIDIA NIM'in OpenAI uyumlu uç noktasını Anthropic Messages API olarak sunan bir Node.js proxy'sidir. Claude Code ve Anthropic formatını konuşan diğer istemciler, herhangi bir kod değişikliği olmadan NVIDIA tarafında barındırılan açık kaynak modelleri (Minimax, GLM, Llama, DeepSeek, Qwen vb.) bu sunucu üzerinden çağırabilir.

## Özellikler

- Node.js 20+, tek dış bağımlılık (`better-sqlite3`), framework yok.
- Çift kanallı akıl yürütme desteği: hem yerel `reasoning_content` delta'ları hem de satır içi `<think>...</think>` etiketleri Anthropic `thinking` bloklarına çevrilir.
- Araç kullanım döngüsü uçtan uca. `tool_use` ↔ `tool_calls` dönüşümü, akışta aşamalı `input_json_delta` olayları dahil tam olarak desteklenir.
- Anthropic `image` blokları OpenAI `image_url` data URL biçimine çevrilir.
- API anahtarı havuzu: birden fazla NVIDIA anahtarını yönetim panelinden ekleyin, round-robin ile dağıtın.
- Erişim anahtarı (token) yönetimi: DB'den veya ortam değişkeninden. SHA-256 hash olarak saklanır.
- Yönetim paneli: anahtar/token CRUD, istek istatistikleri, saatlik grafik, upstream log görüntüleyici, model listesi (`/admin`).
- NVIDIA model kataloğu otomatik çekilir ve Anthropic formatında sunulur (`/v1/models`).
- Otomatik anahtar deaktivasyonu: NVIDIA 403 "Authorization failed" döndüğünde ölü anahtarlar havuzdan düşer.
- Brute-force koruması: hem yönetim paneli hem proxy erişim noktasında IP bazlı kilitleme, üstel geri çekilme (exponential backoff).
- Docker desteği: multi-stage build, SHA256 digest ile sabitlenmiş base image, HEALTHCHECK, dev/prod profilleri.

## Gereksinimler

- Node.js 20 veya üzeri.
- NVIDIA NIM API anahtarı (`build.nvidia.com` üzerinden) veya yönetim panelinden eklenmiş anahtarlar.

## Kurulum

### 1. Depoyu klonlayın

```bash
git clone https://github.com/kilimcininkoroglu/anthronim.git
cd anthronim
```

### 2. Bağımlılıkları kurun

```bash
npm install
```

### 3. Ortam değişkenlerini hazırlayın

```bash
cp .env.example .env
chmod 600 .env
```

`.env` dosyasını açın ve ihtiyacınıza göre doldurun:

```
# NVIDIA anahtarı (yönetim panelinden de eklenebilir)
# NVIDIA_API_KEY=nvapi-...

# Yönetim paneli (opsiyonel)
ADMIN_USER=admin
ADMIN_PASS=degistir-beni

PORT=8787
HOST=0.0.0.0
```

`.env` yüklemesi `index.js` içine gömülüdür; harici bir paket gerekmez. Aynı değişkenleri doğrudan shell ortamına `export` ederek de kullanabilirsiniz.

### 4. Sunucuyu başlatın

```bash
npm start        # node index.js
npm run dev      # node --watch index.js (geliştirme)
```

Başarılı açılışta:

```
Anthronim http://0.0.0.0:8787 adresinde dinliyor.
```

Hızlı sağlık kontrolü:

```bash
curl http://localhost:8787/health
```

### Docker ile Kurulum

```bash
npm run docker:build   # Image oluştur
npm run docker:up      # Prod container başlat
npm run docker:dev     # Dev mode (watch + source mount)
npm run docker:down    # Durdur
```

DB dosyaları `./docker-data/` dizininde saklanır. İlk çalıştırmada DB boşsa ve `.env`'de `NVIDIA_API_KEY` yoksa `docker compose run -e NVIDIA_API_KEY=dummy` ile başlatıp yönetim panelinden anahtar ekleyin.

Üretim konteyneri şu güvenlik önlemleriyle çalışır:
- Salt okunur dosya sistemi (`read_only: true`)
- Tüm yetenekler düşürülmüş (`cap_drop: ALL`)
- Ayrıcalık yükseltme engellenmiş (`no-new-privileges`)
- Root olmayan kullanıcı (`USER node`)
- HEALTHCHECK (`/health` uç noktası, 30sn aralık)

## Claude Code Yapılandırması

`~/.claude/settings.json` dosyasına ekleyin:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8787",
    "ANTHROPIC_API_KEY": "<erişim anahtarınız>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL":   "minimaxai/minimax-m2.5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "minimaxai/minimax-m2.5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL":  "z-ai/glm5"
  }
}
```

Erişim anahtarı yönetim panelinden veya `AUTH_TOKEN` ortam değişkeninden ayarlanır. Erişim anahtarı tanımlı değilse `ANTHROPIC_API_KEY` satırını kaldırabilirsiniz.

Oturum içinde model geçişi `/model opus`, `/model sonnet` veya `/model haiku` komutlarıyla yapılır.

## Yapılandırma Referansı

| Ortam değişkeni            | Zorunlu | Varsayılan                            | Amaç                                                            |
|----------------------------|---------|---------------------------------------|-----------------------------------------------------------------|
| `NVIDIA_BASE_URL`          | Hayır   | `https://integrate.api.nvidia.com/v1` | NVIDIA NIM API temel URL'si                                     |
| `NVIDIA_API_KEY`           | Koşullu | —                                     | NVIDIA NIM uç noktasına iletilir. DB'de anahtar varsa opsiyonel |
| `AUTH_TOKEN`               | Hayır   | —                                     | Erişim anahtarı (yedek). DB'de token varsa opsiyonel            |
| `PORT`                     | Hayır   | `8787`                                | HTTP sunucusunun dinleyeceği port                               |
| `HOST`                     | Hayır   | `0.0.0.0`                             | HTTP sunucusunun bağlanacağı arayüz                             |
| `ADMIN_USER`               | Hayır   | —                                     | Yönetim paneli kullanıcı adı (`ADMIN_PASS` ile birlikte)        |
| `ADMIN_PASS`               | Hayır   | —                                     | Yönetim paneli şifresi (`ADMIN_USER` ile birlikte)              |
| `DB_PATH`                  | Hayır   | `./anthronim.db`                      | SQLite dosya yolu (Docker'da `/app/data/anthronim.db`)          |
| `MODEL_CACHE_TTL`          | Hayır   | `3600000` (1 sa)                      | NVIDIA model listesi önbellek süresi (ms)                       |
| `TRUST_PROXY`              | Hayır   | `false`                               | Reverse proxy arkasındaysa `true` yapın (XFF güven)             |
| `LOG_RETENTION_DAYS`       | Hayır   | `30`                                  | İstek loglarının saklanma süresi (gün)                          |
| `MAX_AUTH_FAILURES`        | Hayır   | `5`                                   | Kilitleme öncesi başarısız deneme sınırı                        |
| `LOCKOUT_MINUTES`          | Hayır   | `15`                                  | İlk kilitleme süresi (dakika). Üstel geri çekilme uygulanır    |
| `ADMIN_MAX_BODY_MB`        | Hayır   | `1`                                   | Yönetim paneli istek gövdesi limiti (MB)                        |
| `PROXY_MAX_BODY_MB`        | Hayır   | `10`                                  | Proxy istek gövdesi limiti (MB)                                 |
| `LOCKOUT_CLEANUP_MINUTES`  | Hayır   | `5`                                   | Brute-force kayıtları temizleme aralığı (dakika)               |
| `LOG_CLEANUP_HOURS`        | Hayır   | `6`                                   | Log temizleme aralığı (saat)                                    |

## Uç Noktalar

| Yöntem  | Yol                     | Davranış                                                                    |
|---------|-------------------------|-----------------------------------------------------------------------------|
| GET     | `/`                     | Public landing sayfası (model listesi, yapılandırma bilgisi)                |
| GET     | `/health`               | Canlılık kontrolü, `{ "status": "ok" }` döner                              |
| GET     | `/v1/models`            | NVIDIA model kataloğu, Anthropic formatında (1 saat önbellekli)             |
| GET     | `/v1/models/:id`        | Tek model detayı                                                            |
| POST    | `/v1/messages`          | Anthropic Messages API. `stream: true` geldiğinde SSE ile akıtılır          |
| OPTIONS | `*`                     | CORS ön kontrolü                                                            |
| GET     | `/admin`                | Yönetim paneli arayüzü (Basic Auth)                                         |
| GET     | `/admin/logs`           | Upstream hata log görüntüleyici (Basic Auth)                                |
| GET     | `/admin/api/stats`      | Toplam istatistikler JSON                                                   |
| GET     | `/admin/api/logs`       | Filtrelenebilir istek logları JSON                                          |
| GET     | `/admin/api/keys`       | API anahtarı listesi (maskelenmiş)                                          |
| POST    | `/admin/api/keys`       | Yeni API anahtarı ekle `{ "key": "...", "label": "..." }`                   |
| PATCH   | `/admin/api/keys/:id`   | Anahtarı etkinleştir/devre dışı bırak `{ "isActive": true/false }`          |
| DELETE  | `/admin/api/keys/:id`   | Anahtarı sil                                                                |
| GET     | `/admin/api/tokens`     | Erişim anahtarı listesi (maskelenmiş)                                       |
| POST    | `/admin/api/tokens`     | Yeni erişim anahtarı ekle `{ "token": "...", "label": "..." }`              |
| PATCH   | `/admin/api/tokens/:id` | Erişim anahtarını etkinleştir/devre dışı bırak `{ "isActive": true/false }` |
| DELETE  | `/admin/api/tokens/:id` | Erişim anahtarını sil                                                       |
| GET     | `/admin/api/models`     | NVIDIA model kataloğu (admin cache)                                         |

## API Anahtarı Havuzu

Proxy birden fazla NVIDIA API anahtarını destekler. Anahtarlar SQLite veritabanında (`anthronim.db`) saklanır ve istekler arasında round-robin ile dağıtılır.

- Veritabanında anahtar varsa `NVIDIA_API_KEY` ortam değişkeni opsiyoneldir.
- Hem ortam değişkeni hem veritabanı boşsa sunucu başlangıçta hata verir.
- Ortam değişkeninden gelen anahtar, veritabanında anahtar yoksa yedek olarak kullanılır.
- Devre dışı bırakılan anahtarlar dağıtıma dahil edilmez.
- NVIDIA 403 "Authorization failed" döndüğünde ilgili anahtar otomatik olarak devre dışı bırakılır.

## Güvenlik

- Erişim anahtarları veritabanında SHA-256 hash olarak saklanır.
- Yönetim paneli ve proxy erişim noktası brute-force korumalıdır (IP bazlı kilitleme, üstel geri çekilme).
- `TRUST_PROXY=true` ayarlanmadıkça `X-Forwarded-For` başlığı yok sayılır.
- Upstream NVIDIA hata yanıtları filtrelenir; ham içerik istemciye veya loglara yansıtılmaz.
- İstek logları otomatik temizlenir (`LOG_RETENTION_DAYS` gün sonra silinir).
- Docker konteyneri salt okunur dosya sistemi, düşürülmüş yetenekler ve root olmayan kullanıcıyla çalışır.

## Yönetim Paneli

`ADMIN_USER` ve `ADMIN_PASS` ortam değişkenleri ayarlandığında `/admin` yolu aktif olur. Tarayıcı HTTP Basic Auth penceresi gösterir.

Panel sunar:
- İstek istatistikleri (toplam, son 24 saat, aktif anahtar/token, hata oranı)
- API anahtarı yönetimi (ekleme, silme, etkinleştirme/devre dışı bırakma)
- Erişim anahtarı (token) yönetimi (ekleme, silme, etkinleştirme/devre dışı bırakma, otomatik üretim)
- Upstream hata log görüntüleyici (`/admin/logs`)
- Saatlik istek grafiği (son 24 saat)
- Model bazlı kullanım dağılımı
- NVIDIA model kataloğu

Admin kimlik doğrulaması (Basic Auth), proxy erişim anahtarından bağımsızdır. HTTP Basic Auth base64 kodlaması kullanır; üretim ortamında TLS (reverse proxy) ardında çalıştırılması önerilir.

## Lisans

MIT. Tam metin için `LICENSE` dosyasına bakın.
