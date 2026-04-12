# Anthronim

NVIDIA NIM'in OpenAI uyumlu uç noktasını Anthropic Messages API olarak sunan bir Node.js proxy'sidir. Claude Code ve Anthropic formatını konuşan diğer istemciler, herhangi bir kod değişikliği olmadan NVIDIA tarafında barındırılan açık kaynak modelleri (Minimax, GLM, Llama, DeepSeek, Qwen vb.) bu sunucu üzerinden çağırabilir.

## Özellikler

- Node.js 20+, tek dış bağımlılık (`better-sqlite3`), framework yok.
- Çift kanallı akıl yürütme desteği: hem yerel `reasoning_content` delta'ları hem de satır içi `<think>...</think>` etiketleri Anthropic `thinking` bloklarına çevrilir.
- Araç kullanım döngüsü uçtan uca. `tool_use` ↔ `tool_calls` dönüşümü, akışta aşamalı `input_json_delta` olayları dahil tam olarak desteklenir.
- Anthropic `image` blokları OpenAI `image_url` data URL biçimine çevrilir.
- API anahtarı havuzu: birden fazla NVIDIA anahtarını yönetim panelinden ekleyin, round-robin ile dağıtın.
- Erişim anahtarı (token) yönetimi: DB'den veya ortam değişkeninden. Birden fazla istemci farklı tokenlarla erişebilir.
- Yönetim paneli: anahtar/token CRUD, istek istatistikleri, saatlik grafik, model listesi (`/admin`).
- NVIDIA model kataloğu otomatik çekilir ve Anthropic formatında sunulur (`/v1/models`).
- Docker desteği: multi-stage build, dev/prod profilleri.

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

Oturum içinde model geçişi `/model opus`, `/model sonnet` veya `/model haiku` komutlarıyla yapılır. Sunucu `body.model` değerini aynen geçirir; `build.nvidia.com/models` üzerindeki herhangi bir kimlik kod değişikliği gerektirmeden çalışır.

## Yapılandırma Referansı

| Ortam değişkeni   | Zorunlu | Varsayılan       | Amaç                                                           |
|--------------------|---------|------------------|----------------------------------------------------------------|
| `NVIDIA_API_KEY`   | Koşullu | —                | NVIDIA NIM uç noktasına iletilir. DB'de anahtar varsa opsiyonel |
| `AUTH_TOKEN`       | Hayır   | —                | Erişim anahtarı (yedek). DB'de token varsa opsiyonel            |
| `PORT`             | Hayır   | `8787`           | HTTP sunucusunun dinleyeceği port                               |
| `HOST`             | Hayır   | `0.0.0.0`        | HTTP sunucusunun bağlanacağı arayüz                             |
| `ADMIN_USER`       | Hayır   | —                | Yönetim paneli kullanıcı adı (`ADMIN_PASS` ile birlikte)        |
| `ADMIN_PASS`       | Hayır   | —                | Yönetim paneli şifresi (`ADMIN_USER` ile birlikte)              |
| `MODEL_CACHE_TTL`  | Hayır   | `3600000` (1 sa) | NVIDIA model listesi önbellek süresi (ms)                       |
| `DB_PATH`          | Hayır   | `./anthronim.db` | SQLite dosya yolu (Docker'da `/app/data/anthronim.db`)          |

Shell ortamında tanımlı bir değişken, aynı adı taşıyan `.env` girdisinin önüne geçer.

## Uç Noktalar

| Yöntem | Yol                     | Davranış                                                                   |
|--------|-------------------------|----------------------------------------------------------------------------|
| GET    | `/`                     | Public landing sayfası (model listesi, yapılandırma bilgisi)               |
| GET    | `/health`               | Canlılık kontrolü, `{ "status": "ok" }` döner                             |
| GET    | `/v1/models`            | NVIDIA model kataloğu, Anthropic formatında (1 saat önbellekli)            |
| GET    | `/v1/models/:id`        | Tek model detayı                                                           |
| POST   | `/v1/messages`          | Anthropic Messages API. `stream: true` geldiğinde SSE ile akıtılır         |
| OPTIONS| `*`                     | CORS ön kontrolü                                                           |
| GET    | `/admin`                | Yönetim paneli arayüzü (Basic Auth)                                        |
| GET    | `/admin/api/stats`      | Toplam istatistikler JSON                                                  |
| GET    | `/admin/api/keys`       | API anahtarı listesi (maskelenmiş)                                         |
| POST   | `/admin/api/keys`       | Yeni API anahtarı ekle `{ "key": "...", "label": "..." }`                  |
| PATCH  | `/admin/api/keys/:id`   | Anahtarı etkinleştir/devre dışı bırak `{ "isActive": true/false }`         |
| DELETE | `/admin/api/keys/:id`   | Anahtarı sil                                                               |
| GET    | `/admin/api/tokens`     | Erişim anahtarı listesi (maskelenmiş)                                      |
| POST   | `/admin/api/tokens`     | Yeni erişim anahtarı ekle `{ "token": "...", "label": "..." }`             |
| PATCH  | `/admin/api/tokens/:id` | Erişim anahtarını etkinleştir/devre dışı bırak `{ "isActive": true/false }`|
| DELETE | `/admin/api/tokens/:id` | Erişim anahtarını sil                                                      |
| GET    | `/admin/api/models`     | NVIDIA model kataloğu (admin cache)                                        |

## API Anahtarı Havuzu

Proxy birden fazla NVIDIA API anahtarını destekler. Anahtarlar SQLite veritabanında (`anthronim.db`) saklanır ve istekler arasında round-robin ile dağıtılır.

- Veritabanında anahtar varsa `NVIDIA_API_KEY` ortam değişkeni opsiyoneldir.
- Hem ortam değişkeni hem veritabanı boşsa sunucu başlangıçta hata verir.
- Ortam değişkeninden gelen anahtar, veritabanında anahtar yoksa yedek olarak kullanılır.
- Devre dışı bırakılan anahtarlar dağıtıma dahil edilmez.

## Yönetim Paneli

`ADMIN_USER` ve `ADMIN_PASS` ortam değişkenleri ayarlandığında `/admin` yolu aktif olur. Tarayıcı HTTP Basic Auth penceresi gösterir.

Panel sunar:
- İstek istatistikleri (toplam, son 24 saat, aktif anahtar/token, hata oranı)
- API anahtarı yönetimi (ekleme, silme, etkinleştirme/devre dışı bırakma)
- Erişim anahtarı (token) yönetimi (ekleme, silme, etkinleştirme/devre dışı bırakma, otomatik üretim)
- Saatlik istek grafiği (son 24 saat)
- Model bazlı kullanım dağılımı
- NVIDIA model kataloğu (istek sayılarıyla birlikte)

Erişim anahtarları DB'den yönetildiğinde `AUTH_TOKEN` ortam değişkeni yedek olarak kalır. DB'de aktif token varsa, istemciler `x-api-key` veya `Authorization: Bearer` başlığıyla eşleşen bir token göndermelidir.

Admin kimlik doğrulaması (Basic Auth), proxy erişim anahtarından bağımsızdır.

HTTP Basic Auth base64 kodlaması kullanır; üretim ortamında TLS (reverse proxy) ardında çalıştırılması önerilir.

## Lisans

MIT. Tam metin için `LICENSE` dosyasına bakın.
