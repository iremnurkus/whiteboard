# Whiteboard

Tauri + React masaüstü whiteboard uygulaması.

## Geliştirme

Önce Rust toolchain kurulu olmalıdır:

```powershell
npm install
npm run tauri dev
```

## Kullanım

- Görsel eklemek için panodan kopyaladığınız görseli `Ctrl+V` ile yapıştırın veya Dosya Gezgini'nden tuvale sürükleyin. Araç çubuğundaki **Görsel/PDF** düğmesiyle de dosya seçebilirsiniz.
- PDF seçildiğinde her sayfa ayrı görsel olarak oluşturulur ve tuvale yukarıdan aşağıya sıralanır.
- Görseli taşımak için **Seç** aracını kullanıp görseli sürükleyin. Seçiliyken `Delete` ile kaldırabilirsiniz.
- Görseller tahtayla birlikte otomatik kaydedilir ve JSON olarak dışa aktarılabilir.
