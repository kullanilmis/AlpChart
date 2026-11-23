# Alp-g // Multi-Chart Terminal

Bu proje, Hyperliquid (Kripto Swap ve Spot) ve Yahoo Finance (BIST hisse senetleri vb.) verilerini tek bir ekranda çoklu grafik (Multi-Chart) arayüzü ile takip etmenizi sağlayan modern ve dinamik bir borsa terminalidir.

Yerleşik **Flow V2.5** (ZigZag, Yapısal Kırılımlar ve Fibonacci Seviyeleri) indikatörü, gelişmiş çizim motoru, paneller arası senkronizasyon, sağ Watchlist ve sesli fiyat alarmları ile masaüstü sınıfı bir analiz deneyimi sunar.

---

## Özellikler

- **Çoklu Grafik Paneli (1, 2, 4, 6, 8 Grafik) & Tam Ekran:** Farklı sembol ve zaman dilimlerini yan yana izleyin veya `Alt+Enter` ile aktif paneli tek tıkla büyütün.
- **İki Farklı Canlı Veri Kaynağı:**
  - **Hyperliquid API / WebSocket:** Kripto Perp & Spot varlıklar için anlık mum akışı (`45m` canlı 15m birleştirme destekli) ve `allMids` canlı izleme listesi fiyatları.
  - **Yahoo Finance API / SSE:** BIST ve küresel hisse senetleri için paralel sorgulama (`ThreadPoolExecutor`) ve canlı akış.
- **Trader Grafik UX:**
  - Sol üst **OHLCV + `%` değişim + aktif indikatör değerleri (Legend)** göstergesi.
  - `Log`, `%` ve `Auto` ölçek modları, canlı **mum kapanış geri sayım sayacı**, `UTC+3 / UTC` saat dilimi seçici ve dinamik fiyat hassasiyeti.
  - Grafiği sola kaydırdıkça geçmiş mumları otomatik yükleme (**Lazy-Load Pagination**).
  - **Monokrom** ve **Klasik TV** (Yeşil/Kırmızı) tema desteği.
- **Çoklu Grafik Senkronizasyonu:** Üst bardan bağımsız açılıp kapatılabilen **Crosshair**, **Zaman/Zoom** ve **Sembol** senkronizasyonu.
- **Gelişmiş Çizim Motoru (`DrawingEngine`):**
  - Zaman tabanlı (`{ time, price }`) kaymayan çizim kaydı.
  - Araçlar: Trend çizgisi, Yatay çizgi, Yatay ışın, Paralel kanal, Dikdörtgen kutu, **Fibonacci Düzeltmesi**, **Long / Short R:R Pozisyon** ve **Ölçüm Cetveli (`Shift+Tık`)**.
  - **Mıknatıs Modu (`M` veya `Ctrl` basılı tutma):** Mum OHLC noktalarına otomatik yapışma.
  - **Floating Stil Çubuğu & Undo/Redo:** Renk, kalınlık, çizgi stili, kilitleme ve `Ctrl+Z` / `Ctrl+Y` ile 50 adımlık geri/ileri alma.
- **İzleme Listesi (Watchlist) & Sesli Fiyat Alarmları:**
  - Sağ açılır/kapanır panelde canlı fiyat ve günlük `%` değişim takibi.
  - `Üstüne Çıkınca` / `Altına İnince` fiyat alarmları (grafik üzerinde kesikli alarm çizgisi, sesli uyarı, tarayıcı bildirimi ve toast).
- **İndikatörler & İstemci Tarafı Flow V2.5:**
  - **EMA 9**, **EMA 21**, bağımsız alt panelli **RSI 14** ve gecikmesiz tarayıcı içi hesaplanan **Flow V2.5** (ZigZag, Kapanış/Sweep çizgileri, yapısal kutular ve 0.25/0.50/0.75 Fibonacci seviyeleri).
- **Kalıcı Yerel SQLite & Yedekleme:** Ayarlar, çizimler, izleme listesi ve alarmlar `backend/data.db` içinde saklanır; tek tıkla JSON **Dışa Aktar / İçe Aktar** yapılabilir.

---

## Kurulum ve Çalıştırma

Python 3.10 veya üzeri gereklidir.

1. **Bağımlılıkları Yükleyin:**
   ```bash
   pip install -r requirements.txt
   ```

2. **Sunucuyu Başlatın:**
   ```bash
   python backend/app.py
   ```

3. **Uygulamaya Erişin:**
   Tarayıcınızdan [http://127.0.0.1:5000](http://127.0.0.1:5000) adresini açın.

---

## Klavye Kısayolları

| Kısayol | İşlev |
| :--- | :--- |
| `Alt + H` | Yatay Çizgi |
| `Alt + T` | Trend Çizgisi |
| `Alt + F` | Fibonacci Düzeltmesi |
| `M` / `Ctrl` | Mıknatıs (OHLC yakalama) aç/kapat / geçici tut |
| `Shift + Tık` | Geçici ölçüm cetveli (`%`, fiyat farkı, bar, süre) |
| `Alt + Enter` | Aktif grafiği büyüt / küçült |
| `Ctrl + Z` / `Ctrl + Y` | Çizimi geri al / yinele |
| `Delete` | Seçili çizimi sil |
| `Esc` | Aracı iptal et / Tam ekrandan çık / Pencereyi kapat |
| `?` | Kısayollar yardım penceresi |

---

## Proje Dosya Yapısı

```text
├── backend/
│   ├── app.py             # Flask sunucusu, SSE yayını ve REST API
│   ├── data_source.py     # Hyperliquid & yfinance veri katmanı, lazy-load ve quotes
│   ├── flow_indicator.py  # Flow V2.5 Python referans hesaplama motoru
│   └── storage.py         # Yerel SQLite kalıcılık ve JSON yedekleme katmanı
├── static/
│   ├── css/
│   │   └── terminal.css   # Monokrom & Klasik TV temaları ve terminal stilleri
│   └── js/
│       ├── main.js        # Uygulama başlatıcı, kısayollar, migrasyon ve yerleşim
│       └── modules/
│           ├── alertManager.js    # Fiyat kesişim motoru ve sesli/tarayıcı bildirimleri
│           ├── api.js             # Backend REST istemcisi
│           ├── chartPane.js       # Grafik paneli, Legend, ölçek/geri sayım, lazy-load
│           ├── drawingEngine.js   # Canvas çizim motoru, Magnet, R:R, Fib, stil ve Undo/Redo
│           ├── indicators.js      # EMA 9/21, RSI 14 ve Flow V2.5 JS motoru
│           ├── syncManager.js     # Crosshair, zaman ve sembol senkronizasyonu
│           ├── themes.js          # Monokrom ve Klasik TV tema tanımları
│           ├── watchlistPanel.js  # Sağ Watchlist & Alarmlar yan paneli
│           └── wsManager.js       # Hyperliquid WebSocket yöneticisi (candle + allMids)
├── templates/
│   └── index.html         # Terminal arayüz iskeleti ve modallar
├── requirements.txt       # Gerekli Python kütüphaneleri
└── README.md              # Proje tanıtım ve kullanım kılavuzu
```
