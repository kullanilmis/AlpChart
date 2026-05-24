# Alp-g // Multi-Chart Terminal

Bu proje, Hyperliquid (Kripto Swap ve Spot) ve Yahoo Finance (BIST hisse senetleri vb.) verilerini tek bir ekranda çoklu grafik (Multi-Chart) arayüzü ile takip etmenizi sağlayan modern ve dinamik bir borsa terminalidir. 

Ayrıca yerleşik **Flow V2.5** (ZigZag, Yapısal Kırılımlar ve Fibonacci Seviyeleri) indikatörü ve interaktif çizim araçları (Trend Çizgisi, Yatay Işın, Paralel Kanal vb.) barındırır.

---

## 🚀 Özellikler

- **Çoklu Grafik Paneli (1, 2, 4, 6, 8 Grafik)**: Aynı anda farklı zaman dilimi veya borsalardaki grafikleri yan yana izleyin.
- **İki Farklı Veri Kaynağı**:
  - **Hyperliquid API / WebSockets**: Kripto varlıklar için milisaniyelik canlı mum güncellemeleri.
  - **Yahoo Finance API / SSE**: BIST ve küresel hisse senetleri için otomatik sorgulama ve veri akışı.
- **Pine Script Entegrasyonu (Flow V2.5)**:
  - Canlı güncellenen ZigZag yapısı.
  - Mum kapanış onaylı Yapısal Kırılımlar (Break of Structure - BoS).
  - İhlal edilen seviyeler için Sweep (Likidite alımı) tespiti.
  - Yapısal kutular ve kutu içi otomatik 0.25, 0.50, 0.75 Fibonacci seviyeleri.
- **Gelişmiş Çizim Araçları**: Trend çizgisi, yatay çizgi, yatay ışın, paralel kanal, dikdörtgen kutu çizimleri (TradingView tarzı sürükle-bırak ve düzenleme destekli).
- **Diğer İndikatörler**: EMA 9, EMA 21 ve bağımsız alt panele sahip RSI 14.

---

## 🛠️ Kurulum ve Çalıştırma

Projenin bilgisayarınızda çalışması için Python 3.8 veya üzeri bir sürümün yüklü olması gerekmektedir.

1. **Bağımlılıkları Yükleyin**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Sunucuyu Başlatın**:
   ```bash
   python backend/app.py
   ```

3. **Uygulamaya Erişin**:
   Tarayıcınızdan aşağıdaki adresi açın:
   [http://127.0.0.1:5000](http://127.0.0.1:5000)

---

## 📁 Proje Dosya Yapısı

```text
├── backend/
│   ├── app.py             # Flask Web Sunucusu ve SSE Yayını
│   ├── data_source.py     # Hyperliquid & yfinance Veri Katmanları
│   └── flow_indicator.py  # Flow V2.5 Matematiksel Hesaplama Motoru
├── static/
│   └── js/
│       └── chart.js       # Lightweight Charts Yönetimi, Çizim Araçları ve Render Motoru
├── templates/
│   └── index.html         # Arayüz ve Stil Katmanı
├── requirements.txt       # Gerekli Python Kütüphaneleri
└── README.md              # Proje Tanıtım ve Kurulum Kılavuzu
```
