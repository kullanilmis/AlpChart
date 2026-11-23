# TradingView Lightweight Charts Özellikleri ve Eklenebilecek Yapılar

TradingView'in **Lightweight Charts** kütüphanesi, son derece hafif ve yüksek performanslı olacak şekilde tasarlanmıştır. Ağır grafik kütüphanelerinin (Chart.js vb.) aksine, finansal verileri gerçek zamanlı ve pürüzsüz çizmek için optimize edilmiştir. 

Aşağıda, projemizdeki grafik terminaline entegre edebileceğimiz tüm temel özellikleri, teknik indikatörleri ve görsel araçları bulabilirsiniz:

---

## 1. Grafik Türleri (Series Types)
Grafik üzerinde aynı anda veya geçişli olarak farklı veri görselleştirme türleri kullanabiliriz:
*   **Candlestick (Mum Grafiği):** Şu an kullandığımız, açılış-yüksek-düşük-kapanış (OHLC) değerlerini gösteren klasik finansal grafik.
*   **Bar (OHLC Çubuk Grafiği):** Batı tarzı, mum gövdesi olmayan sadece çizgilerden oluşan finansal grafik.
*   **Line (Çizgi Grafiği):** Sadece kapanış fiyatlarını birleştiren sade çizgi.
*   **Area (Alan Grafiği):** Çizginin altını renkli/gradyan dolgu ile dolduran şık grafik.
*   **Baseline (Referans Çizgili Grafik):** Belirli bir fiyat seviyesinin (örneğin dünün kapanışı veya pivot seviyesi) üstünü yeşil, altını kırmızı gösteren dolgulu alan grafiği.
*   **Histogram:** Hacim veya MACD barları gibi dikey sütun grafikleri.

---

## 2. Teknik İndikatörler (Technical Indicators)
Lightweight Charts içinde hazır indikatör kodları bulunmaz, ancak kütüphanenin sunduğu çizgi ve alan özelliklerini matematiksel verilerle besleyerek her türlü indikatörü oluşturabiliriz:

### A. Ana Grafik Üzerine Eklenebilecekler (Overlay Indicators)
*   **Hareketli Ortalamalar (SMA / EMA / WMA):** Grafik üzerine farklı renklerde ince çizgiler ekleyerek trend takibi sağlayabiliriz (Örn: EMA 20, EMA 50, SMA 200).
*   **Bollinger Bantları (Bollinger Bands):** Fiyatın etrafına 3 çizgi (Üst Bant, Orta Bant, Alt Bant) çizeriz ve aralarındaki alanı yarı şeffaf bir renkle doldurabiliriz.
*   **Keltner Kanalları / ATR Kanalları:** Bollinger bantlarına benzer şekilde volatilite kanalları çizilebilir.
*   **SuperTrend:** Fiyatın altında (yeşil) veya üstünde (kırmızı) trend yönüne göre konumlanan kırılım çizgileri.
*   **Destek ve Direnç Bölgeleri:** Belirli fiyat aralıklarını şeffaf dikdörtgen kutular (`box`) veya yatay bantlar olarak çizebiliriz.

### B. Grafik Altına Eklenebilecek Bağımsız Göstergeler (Sub-Charts / Panes)
Grafiğin altına yeni bir panel açarak (hacim paneli gibi) şu göstergeleri ekleyebiliriz:
*   **Hacim (Volume):** Ana grafiğin en altına gömülü veya altında ayrı bir panel olarak yeşil/kırmızı histogram barları.
*   **RSI (Göreceli Güç Endeksi):** Alt panelde 0-100 arası salınan bir çizgi. 30 (aşırı satım) ve 70 (aşırı alım) seviyelerine yatay kesikli referans çizgileri eklenebilir.
*   **MACD (Hareketli Ortalama Yakınsama Iraksama):** İki çizgi (MACD ve Sinyal) ve aralarındaki farkı gösteren sıfır merkezli histogram barları.
*   **Stochastic Osilatör:** RSI'a benzer şekilde çalışan hızlı ve yavaş %K ve %D çizgileri.

---

## 3. İşaretçiler ve Etiketler (Markers & Annotations)
Grafik üzerinde belirli noktalara dinamik görsel işaretler koyabiliriz. Özellikle **Trading Bot** veya **Al-Sat Sinyalleri** için mükemmeldir:
*   **Alış / Satış Okları (Trade Markers):** Mumların hemen altına yeşil yukarı oku ("BUY") veya üstüne kırmızı aşağı oku ("SELL") koyabiliriz.
*   **Bilgi Balonları (Text Callouts):** Mumların üzerine fiyat, tarih veya formasyon ismi (örneğin "Yutan Boğa", "Çekiç") yazan küçük etiketler yerleştirebiliriz.
*   **Özel Şekiller:** Mumların üzerine/altına daire, kare veya yıldız gibi işaretçiler yerleştirebiliriz.

---

## 4. Çizgiler ve Fiyat Seviyeleri (Price Lines & Axis)
*   **Yatay Destek/Direnç Çizgileri:** Grafik üzerine elinizle veya otomatik olarak yatay çizgiler çekip sağdaki fiyat eksenine özel etiketler koyabiliriz.
*   **Tetikleyici Fiyat Çizgisi (Alert Lines):** Fiyat alarmı kurulan seviyeleri kesikli ve renkli çizgilerle gösterebiliriz.
*   **Maksimum / Minimum Fiyat Etiketleri:** Görünür alandaki en yüksek ve en düşük fiyatı otomatik tespit edip ok işaretiyle gösterebiliriz.

---

## 5. Grafik Senkronizasyonu (Chart Synchronization)
Split-screen (bölünmüş ekran) terminalimiz için en kullanışlı özelliklerden biridir:
*   **Zaman Senkronizasyonu:** Bir grafiği fareyle sağa/sola kaydırdığınızda veya yakınlaştırdığınızda (zoom), diğer tüm grafiklerin de otomatik olarak aynı zaman dilimine kaymasını sağlayabiliriz.
*   **İmleç Senkronizasyonu (Crosshair Sync):** İmlecinizi (çapraz çizgiyi) 1. grafiğe götürdüğünüzde, diğer grafiklerde de aynı tarih ve saate denk gelen yerde hayalet bir imlecin hareket etmesini sağlayabiliriz.

---

## 6. Gelişmiş Arayüz (UI) Özellikleri
*   **Özel İpucu Kutusu (Custom Tooltip):** Fareyi grafik üzerinde gezdirdiğinizde mum bilgilerini (Açılış, Kapanış, Hacim, indikatör değerleri) grafik alanının sol üst köşesinde şık, siyah-beyaz e-ink stiline uygun bir kutuda gösterebiliriz.
*   **Arka Plan Filigranı (Watermark):** Grafiğin tam arkasına büyük ve yarı şeffaf gri tonlarda sembol adını (örneğin "BTC", "THYAO") yazdırabiliriz.
*   **Fiyat Eksen Formatlama:** Kripto paralarda küsuratlı fiyatları (0.000123), hisselerde normal fiyatları (288.00) eksende otomatik ve düzgün biçimlendirme.

---

### Nasıl İlerleyelim?
Bu özelliklerden hangilerini grafiğinize eklemek istersiniz? Örneğin:
1.  Grafiklerin altına **Hacim (Volume)** barları ekleyelim mi?
2.  Mumların üzerine Hareketli Ortalama çizgileri (**EMA 20 / EMA 50**) ekleyelim mi?
3.  Fareyle gezinirken detayları görmek için şık bir **Tooltip (Veri Kutusu)** yapalım mı?
4.  Bölünmüş ekranlardaki grafiklerin kaydırma ve imleç hareketlerini **birbirine senkronize** edelim mi?

İstediğiniz özellikleri seçip bana bildirdiğinizde, kodları doğrudan güncelleyebilirim.
