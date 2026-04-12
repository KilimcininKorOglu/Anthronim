# Anthronim

NVIDIA NIM'in OpenAI uyumlu uç noktasını Anthropic Messages API olarak sunan tek dosyalık bir Node.js proxy'sidir. Claude Code ve Anthropic formatını konuşan diğer istemciler, herhangi bir kod değişikliği olmadan NVIDIA tarafında barındırılan açık kaynak modelleri (Minimax, GLM, Llama, DeepSeek, Qwen) bu sunucu üzerinden çağırabilir.

## Özellikler

- Tek dosya, sıfır bağımlılık, framework yok. Yalnızca Node.js 20 veya üzeri gerektirir.
- Çift kanallı akıl yürütme desteği: hem yerel `reasoning_content` delta'ları hem de satır içi `<think>...</think>` etiketleri Anthropic `thinking` bloklarına çevrilir.
- Araç kullanım döngüsü uçtan uca. `tool_use` ↔ `tool_calls` dönüşümü, akışta aşamalı `input_json_delta` olayları dahil tam olarak desteklenir.
- Anthropic `image` blokları OpenAI `image_url` data URL biçimine çevrilir.
- Opsiyonel `AUTH_TOKEN` ile erişim anahtarı kimlik doğrulaması.

## Gereksinimler

- Node.js 20 veya üzeri.
- `build.nvidia.com` üzerinden alınmış bir NVIDIA NIM API anahtarı.

## Kurulum

### 1. Depoyu klonlayın

```bash
git clone https://github.com/kilimcininkoroglu/anthronim.git
cd anthronim
```

### 2. Ortam değişkenlerini hazırlayın

```bash
cp .env.example .env
chmod 600 .env
```

`.env` dosyasını açın ve en az `NVIDIA_API_KEY` değerini doldurun:

```
NVIDIA_API_KEY=nvapi-...
AUTH_TOKEN=erisim-anahtari
PORT=8787
HOST=0.0.0.0
```

`.env` yüklemesi `index.js` içine gömülüdür; harici bir paket gerekmez. Aynı değişkenleri doğrudan shell ortamına `export` ederek de kullanabilirsiniz.

### 3. Sunucuyu başlatın

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

### Kalıcı Kurulum

Üretim ortamında `systemd`, `pm2` veya Docker gibi bir süreç yöneticisi kullanın. `.env` dosyasını çalışma dizinine yerleştirin ya da değişkenleri süreç yöneticisinden geçirin.

## Claude Code Yapılandırması

`~/.claude/settings.json` dosyasına ekleyin:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8787",
    "ANTHROPIC_DEFAULT_OPUS_MODEL":   "minimaxai/minimax-m2.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "minimaxai/minimax-m2.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL":  "z-ai/glm4.7"
  }
}
```

Sunucu tarafında `AUTH_TOKEN` ayarlıysa aynı bloğa `"ANTHROPIC_API_KEY": "<token>"` ekleyin; Claude Code bu değeri `x-api-key` başlığı olarak iletir.

Oturum içinde model geçişi `/model opus`, `/model sonnet` veya `/model haiku` komutlarıyla yapılır. Sunucu `body.model` değerini aynen geçirir; `build.nvidia.com/models` üzerindeki herhangi bir kimlik kod değişikliği gerektirmeden çalışır.

## Yapılandırma Referansı

| Ortam değişkeni  | Zorunlu | Varsayılan | Amaç                                                                          |
|------------------|---------|------------|-------------------------------------------------------------------------------|
| `NVIDIA_API_KEY` | Evet    | —          | NVIDIA NIM uç noktasına `Authorization: Bearer` olarak iletilir.              |
| `AUTH_TOKEN`     | Hayır   | —          | Ayarlandığında istemcilerden `x-api-key` veya `Authorization: Bearer` bekler. |
| `PORT`           | Hayır   | `8787`     | HTTP sunucusunun dinleyeceği port.                                            |
| `HOST`           | Hayır   | `0.0.0.0`  | HTTP sunucusunun bağlanacağı arayüz.                                          |

Shell ortamında tanımlı bir değişken, aynı adı taşıyan `.env` girdisinin önüne geçer.

## Uç Noktalar

| Yöntem  | Yol            | Davranış                                                                                  |
|---------|----------------|-------------------------------------------------------------------------------------------|
| POST    | `/v1/messages` | Anthropic Messages API. `stream: true` geldiğinde SSE ile akıtılır.                       |
| GET     | `/v1/models`   | Boş liste döner. Model seçimi istemci ortam değişkenlerinden yapılır.                     |
| GET     | `/health`, `/` | Canlılık kontrolü, `{ "status": "ok" }` döner.                                            |
| OPTIONS | `*`            | CORS ön kontrolü.                                                                         |

## Desteklenen Modeller

Proxy, model kimliklerini NVIDIA'ya aynen iletir; aşağıdaki tablo bir başlangıç noktasıdır, izin listesi değildir.

| Model kimliği                  | Notlar                                                                   |
|--------------------------------|--------------------------------------------------------------------------|
| `minimaxai/minimax-m2.1`       | Güçlü çok dilli kodlama modeli, satır içi `<think>` yayar.               |
| `z-ai/glm4.7`                  | Zhipu GLM 4, düşük ilk jeton gecikmesi.                                  |
| `deepseek-ai/deepseek-r1`      | Ayrılmış akıl yürütme modeli, yerel `reasoning_content` deltaları yayar. |
| `meta/llama-3.3-70b-instruct`  | Genel amaçlı sohbet.                                                     |
| `qwen/qwen2.5-72b-instruct`    | Alibaba Qwen 2.5 instruct.                                               |

Tam katalog: `build.nvidia.com/models`.

## Lisans

MIT. Tam metin için `LICENSE` dosyasına bakın.
