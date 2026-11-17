import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

const STORAGE_KEY = "whiteboard-document-v1";
const PDF_PAGE_WIDTH = 700;
const PDF_PAGE_GAP = 24;

const loadPdfJs = async () => {
  const [pdfjsLib, pdfWorker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker.default;
  return pdfjsLib;
};

function cloneStrokes(strokes) {
  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ ...point })),
  }));
}

function cloneImages(images) {
  return images.map((image) => ({ ...image }));
}

export default function App() {
  const canvasRef = useRef(null);
  const strokesRef = useRef([]);
  const imagesRef = useRef([]);
  const imageCacheRef = useRef(new Map());
  const activeStrokeRef = useRef(null);
  const renderFrameRef = useRef(0);
  const historyRef = useRef([]);
  const futureRef = useRef([]);
  const viewRef = useRef({ x: 0, y: 0, zoom: 1 });
  const panRef = useRef(null);
  const imageDragRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);

  const [color, setColor] = useState("#2563eb");
  const [width, setWidth] = useState(5);
  const [tool, setTool] = useState("pen");
  const [zoomLabel, setZoomLabel] = useState(100);
  const [selectedImageId, setSelectedImageId] = useState(null);
  const [notice, setNotice] = useState("");

  const snapshot = () => ({
    strokes: cloneStrokes(strokesRef.current),
    images: cloneImages(imagesRef.current),
  });

  useEffect(() => {
    if (!isTauri()) return undefined;
    let disposed = false;
    let unlisten;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const dpr = window.devicePixelRatio || 1;
        const point = screenToWorld(event.payload.position.x / dpr, event.payload.position.y / dpr);
        const importablePaths = event.payload.paths.filter((path) => /\.(png|jpe?g|gif|webp|bmp|pdf)$/i.test(path));
        for (const [index, path] of importablePaths.entries()) {
          try {
            const src = await invoke("read_dropped_file", { path });
            const origin = { x: point.x + index * 24, y: point.y + index * 24 };
            if (/\.pdf$/i.test(path)) {
              await importPdfData(decodeDataUrl(src), origin);
            } else {
              addImageSource(src, origin);
            }
          } catch (error) {
            console.error("Could not import dropped file", error);
            setNotice(error instanceof Error ? error.message : "Dosya içe aktarılamadı.");
          }
        }
      })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((error) => {
        console.error("Could not register the native file-drop listener", error);
        setNotice("Dosya sürükle bırak desteği başlatılamadı.");
      });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  const persistDocument = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
      setNotice("");
      return true;
    } catch (error) {
      console.error("Whiteboard autosave failed", error);
      setNotice("Otomatik kayıt alanı doldu. Tahtayı JSON olarak kaydedin.");
      return false;
    }
  };

  const scheduleRender = () => {
    if (renderFrameRef.current) return;
    renderFrameRef.current = requestAnimationFrame(() => {
      renderFrameRef.current = 0;
      render();
    });
  };

  const getCanvas = () => canvasRef.current;

  const getCanvasRect = () => getCanvas().getBoundingClientRect();

  const screenToWorld = (clientX, clientY) => {
    const rect = getCanvasRect();
    const view = viewRef.current;
    return {
      x: (clientX - rect.left - view.x) / view.zoom,
      y: (clientY - rect.top - view.y) / view.zoom,
    };
  };

  const pushHistory = () => {
    historyRef.current.push(snapshot());
    if (historyRef.current.length > 100) historyRef.current.shift();
    futureRef.current = [];
  };

  const restoreDocument = (document) => {
    strokesRef.current = cloneStrokes(document.strokes);
    imagesRef.current = cloneImages(document.images);
    persistDocument();
    scheduleRender();
  };

  const undo = () => {
    if (!historyRef.current.length) return;
    futureRef.current.push(snapshot());
    restoreDocument(historyRef.current.pop());
  };

  const redo = () => {
    if (!futureRef.current.length) return;
    historyRef.current.push(snapshot());
    restoreDocument(futureRef.current.pop());
  };

  const render = () => {
    const canvas = getCanvas();
    if (!canvas) return;

    const context = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const view = viewRef.current;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);

    const spacing = view.zoom < 0.55 ? 100 : view.zoom < 0.9 ? 50 : 25;
    const left = -view.x / view.zoom;
    const top = -view.y / view.zoom;
    const right = left + rect.width / view.zoom;
    const bottom = top + rect.height / view.zoom;
    context.beginPath();
    context.strokeStyle = "#edf0f5";
    context.lineWidth = 1 / view.zoom;

    for (let x = Math.floor(left / spacing) * spacing; x <= right; x += spacing) {
      context.moveTo(x, top);
      context.lineTo(x, bottom);
    }
    for (let y = Math.floor(top / spacing) * spacing; y <= bottom; y += spacing) {
      context.moveTo(left, y);
      context.lineTo(right, y);
    }
    context.stroke();

    for (const image of imagesRef.current) {
      let bitmap = imageCacheRef.current.get(image.id);
      if (!bitmap) {
        bitmap = new Image();
        imageCacheRef.current.set(image.id, bitmap);
        bitmap.onload = scheduleRender;
        bitmap.src = image.src;
      }
      if (!bitmap.complete || !bitmap.naturalWidth) continue;

      context.drawImage(bitmap, image.x, image.y, image.width, image.height);
      if (image.id === selectedImageId) {
        context.save();
        context.strokeStyle = "#2563eb";
        context.lineWidth = 2 / view.zoom;
        context.setLineDash([6 / view.zoom, 4 / view.zoom]);
        context.strokeRect(image.x, image.y, image.width, image.height);
        context.restore();
      }
    }

    for (const stroke of strokesRef.current) {
      if (!stroke.points.length) continue;
      context.beginPath();
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = stroke.width;
      context.lineCap = "round";
      context.lineJoin = "round";

      if (stroke.points.length === 1) {
        context.arc(
          stroke.points[0].x,
          stroke.points[0].y,
          stroke.width / 2,
          0,
          Math.PI * 2,
        );
        context.fill();
        continue;
      }

      context.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let index = 1; index < stroke.points.length - 1; index += 1) {
        const current = stroke.points[index];
        const next = stroke.points[index + 1];
        const midpointX = (current.x + next.x) / 2;
        const midpointY = (current.y + next.y) / 2;
        context.quadraticCurveTo(current.x, current.y, midpointX, midpointY);
      }
      const last = stroke.points[stroke.points.length - 1];
      context.lineTo(last.x, last.y);
      context.stroke();
    }
  };

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const document = JSON.parse(saved);
        if (Array.isArray(document)) {
          strokesRef.current = document;
        } else {
          strokesRef.current = document.strokes || [];
          imagesRef.current = document.images || [];
        }
      } catch {
        strokesRef.current = [];
        imagesRef.current = [];
      }
    }

    const canvas = canvasRef.current;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      scheduleRender();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    scheduleRender();
  }, [selectedImageId]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (event.key === " " && !event.repeat) {
        setTool("pan");
      } else if (event.key === "Escape") {
        setTool("pen");
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedImageId) {
        pushHistory();
        imagesRef.current = imagesRef.current.filter((image) => image.id !== selectedImageId);
        imageCacheRef.current.delete(selectedImageId);
        setSelectedImageId(null);
        persistDocument();
        scheduleRender();
      }
    };
    const onKeyUp = (event) => {
      if (event.key === " ") setTool("pen");
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", addClipboardImage);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", addClipboardImage);
    };
  });

  const pointToSegmentDistance = (point, start, end) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (!dx && !dy) return Math.hypot(point.x - start.x, point.y - start.y);
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
  };

  const eraseAt = (point) => {
    const radius = Math.max(10, width * 2.5) / viewRef.current.zoom;
    let changed = false;
    strokesRef.current = strokesRef.current.filter((stroke) => {
      for (let index = 0; index < stroke.points.length; index += 1) {
        const current = stroke.points[index];
        if (Math.hypot(point.x - current.x, point.y - current.y) <= radius) {
          changed = true;
          return false;
        }
        if (index > 0) {
          if (pointToSegmentDistance(point, stroke.points[index - 1], current) <= radius) {
            changed = true;
            return false;
          }
        }
      }
      return true;
    });
    if (changed) scheduleRender();
  };

  const handlePointerDown = (event) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = screenToWorld(event.clientX, event.clientY);

    if (tool === "select") {
      const hit = [...imagesRef.current].reverse().find((image) =>
        point.x >= image.x &&
        point.x <= image.x + image.width &&
        point.y >= image.y &&
        point.y <= image.y + image.height
      );
      setSelectedImageId(hit?.id || null);
      if (hit) {
        pushHistory();
        imageDragRef.current = { id: hit.id, pointer: point, x: hit.x, y: hit.y };
      }
      return;
    }

    if (tool === "pan" || event.button === 1) {
      panRef.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        viewX: viewRef.current.x,
        viewY: viewRef.current.y,
      };
      return;
    }

    if (tool === "eraser") {
      pushHistory();
      eraseAt(point);
      return;
    }

    pushHistory();
    activeStrokeRef.current = {
      color,
      width: width / viewRef.current.zoom,
      points: [{ ...point, pressure: event.pressure || 0.5 }],
    };
  };

  const handlePointerMove = (event) => {
    if (imageDragRef.current) {
      const point = screenToWorld(event.clientX, event.clientY);
      const drag = imageDragRef.current;
      const image = imagesRef.current.find((item) => item.id === drag.id);
      if (image) {
        image.x = drag.x + point.x - drag.pointer.x;
        image.y = drag.y + point.y - drag.pointer.y;
        scheduleRender();
      }
      return;
    }

    if (panRef.current) {
      viewRef.current.x = panRef.current.viewX + event.clientX - panRef.current.pointerX;
      viewRef.current.y = panRef.current.viewY + event.clientY - panRef.current.pointerY;
      setZoomLabel(Math.round(viewRef.current.zoom * 100));
      scheduleRender();
      return;
    }

    const point = screenToWorld(event.clientX, event.clientY);
    if (tool === "eraser" && event.buttons) {
      eraseAt(point);
      return;
    }
    if (!activeStrokeRef.current) return;

    const points = activeStrokeRef.current.points;
    const previous = points[points.length - 1];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.75 / viewRef.current.zoom) {
      points.push({ ...point, pressure: event.pressure || 0.5 });
      if (points.length === 1) {
        strokesRef.current.push(activeStrokeRef.current);
      } else if (!strokesRef.current.includes(activeStrokeRef.current)) {
        strokesRef.current.push(activeStrokeRef.current);
      }
      scheduleRender();
    }
  };

  const handlePointerUp = (event) => {
    if (panRef.current) panRef.current = null;
    if (imageDragRef.current) {
      imageDragRef.current = null;
      persistDocument();
    }
    if (activeStrokeRef.current) {
      const stroke = activeStrokeRef.current;
      if (!stroke.points.length) return;
      if (!strokesRef.current.includes(stroke)) strokesRef.current.push(stroke);
      activeStrokeRef.current = null;
      persistDocument();
      scheduleRender();
    } else if (tool === "eraser") {
      persistDocument();
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleWheel = (event) => {
    event.preventDefault();
    const rect = getCanvasRect();
    const oldZoom = viewRef.current.zoom;
    const nextZoom = Math.max(0.25, Math.min(4, oldZoom * Math.exp(-event.deltaY * 0.0015)));
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const worldX = (pointerX - viewRef.current.x) / oldZoom;
    const worldY = (pointerY - viewRef.current.y) / oldZoom;

    viewRef.current.zoom = nextZoom;
    viewRef.current.x = pointerX - worldX * nextZoom;
    viewRef.current.y = pointerY - worldY * nextZoom;
    setZoomLabel(Math.round(nextZoom * 100));
    scheduleRender();
  };

  const clearBoard = () => {
    if (!strokesRef.current.length && !imagesRef.current.length) return;
    pushHistory();
    strokesRef.current = [];
    imagesRef.current = [];
    imageCacheRef.current.clear();
    setSelectedImageId(null);
    persistDocument();
    scheduleRender();
  };

  const resetView = () => {
    viewRef.current = { x: 0, y: 0, zoom: 1 };
    setZoomLabel(100);
    scheduleRender();
  };

  const downloadPng = () => {
    const link = document.createElement("a");
    link.download = "whiteboard.png";
    link.href = getCanvas().toDataURL("image/png");
    link.click();
  };

  const saveDocument = () => {
    const blob = new Blob([JSON.stringify(snapshot())], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = "whiteboard.json";
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  };

  const storeImageElement = (source, point, options = {}) => {
    const sourceWidth = source.naturalWidth || source.width;
    const sourceHeight = source.naturalHeight || source.height;
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const bitmapCanvas = document.createElement("canvas");
    bitmapCanvas.width = Math.max(1, Math.round(sourceWidth * scale));
    bitmapCanvas.height = Math.max(1, Math.round(sourceHeight * scale));
    bitmapCanvas.getContext("2d").drawImage(source, 0, 0, bitmapCanvas.width, bitmapCanvas.height);

    const fit = options.displayWidth
      ? options.displayWidth / bitmapCanvas.width
      : Math.min(1, 420 / bitmapCanvas.width, 320 / bitmapCanvas.height);
    const image = {
      id: crypto.randomUUID(),
      src: bitmapCanvas.toDataURL("image/webp", 0.92),
      x: point.x,
      y: point.y,
      width: bitmapCanvas.width * fit,
      height: bitmapCanvas.height * fit,
    };

    if (options.recordHistory !== false) pushHistory();
    imagesRef.current.push(image);
    if (options.select !== false) {
      setSelectedImageId(image.id);
      setTool("select");
    }
    if (options.persist !== false) persistDocument();
    scheduleRender();
    return image;
  };

  const addImageSource = (src, point, options) => new Promise((resolve, reject) => {
    const source = new Image();
    source.onerror = () => {
      const error = new Error("Bu görsel biçimi açılamadı.");
      setNotice(error.message);
      reject(error);
    };
    source.onload = () => resolve(storeImageElement(source, point, options));
    source.src = src;
  });

  const decodeDataUrl = (dataUrl) => {
    const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const binary = atob(encoded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  };

  const importPdfData = async (data, origin) => {
    setNotice("PDF açılıyor...");
    const pdfjsLib = await loadPdfJs();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    pushHistory();
    let y = origin.y;
    let persisted = false;

    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        setNotice(`PDF sayfaları ekleniyor (${pageNumber}/${pdf.numPages})...`);
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.5 });
        const pageCanvas = document.createElement("canvas");
        pageCanvas.width = Math.ceil(viewport.width);
        pageCanvas.height = Math.ceil(viewport.height);
        await page.render({ canvas: pageCanvas, viewport }).promise;

        const image = storeImageElement(pageCanvas, { x: origin.x, y }, {
          displayWidth: PDF_PAGE_WIDTH,
          recordHistory: false,
          persist: false,
          select: pageNumber === 1,
        });
        y += image.height + PDF_PAGE_GAP;
        pageCanvas.width = 0;
        pageCanvas.height = 0;
      }
    } finally {
      persisted = persistDocument();
    }

    if (persisted) {
      setNotice(`${pdf.numPages} PDF sayfası tuvale eklendi.`);
    }
  };

  const importPdfFile = async (file, point) => {
    try {
      await importPdfData(new Uint8Array(await file.arrayBuffer()), point);
    } catch (error) {
      console.error("Could not import PDF", error);
      setNotice(error instanceof Error ? `PDF açılamadı: ${error.message}` : "PDF açılamadı.");
    }
  };

  const addImageFile = (file, point) => {
    if (!file?.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onerror = () => setNotice("Görsel okunamadı.");
    reader.onload = () => {
      addImageSource(String(reader.result), point).catch((error) => {
        console.error("Could not import image", error);
      });
    };
    reader.readAsDataURL(file);
  };

  const addClipboardImage = (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const item = items.find((entry) => entry.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return false;
    event.preventDefault();
    const rect = getCanvasRect();
    addImageFile(file, screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2));
    return true;
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []).filter((file) =>
      file.type.startsWith("image/") || file.type === "application/pdf" || /\.pdf$/i.test(file.name)
    );
    if (!files.length) return;
    const point = screenToWorld(event.clientX, event.clientY);
    for (const [index, file] of files.entries()) {
      const position = { x: point.x + index * 24, y: point.y + index * 24 };
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) await importPdfFile(file, position);
      else addImageFile(file, position);
    }
  };

  const openImageFiles = async (event) => {
    const files = Array.from(event.target.files || []).filter((file) =>
      file.type.startsWith("image/") || file.type === "application/pdf" || /\.pdf$/i.test(file.name)
    );
    const rect = getCanvasRect();
    const center = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    for (const [index, file] of files.entries()) {
      const position = { x: center.x + index * 24, y: center.y + index * 24 };
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) await importPdfFile(file, position);
      else addImageFile(file, position);
    }
    event.target.value = "";
  };

  const openDocument = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const document = Array.isArray(data) ? { strokes: data, images: [] } : data;
        if (!Array.isArray(document.strokes) || !Array.isArray(document.images || [])) {
          throw new Error("Invalid whiteboard document");
        }
        pushHistory();
        imageCacheRef.current.clear();
        restoreDocument({ strokes: document.strokes, images: document.images || [] });
      } catch {
        window.alert("Geçersiz beyaz tahta dosyası.");
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  return (
    <main className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="brand-mark" />
          <strong>Whiteboard</strong>
        </div>

        <div className="tools">
          <button className={tool === "pen" ? "tool active" : "tool"} type="button" onClick={() => setTool("pen")} title="Kalem">
            Kalem
          </button>
          <button className={tool === "eraser" ? "tool active" : "tool"} type="button" onClick={() => setTool("eraser")} title="Silgi">
            Silgi
          </button>
          <button className={tool === "pan" ? "tool active" : "tool"} type="button" onClick={() => setTool("pan")} title="Tahta sürükleme">
            Taşı
          </button>
          <button className={tool === "select" ? "tool active" : "tool"} type="button" onClick={() => setTool("select")} title="Görsel seç ve taşı">
            Seç
          </button>

          <label className="control" title="Kalem rengi">
            <span>Renk</span>
            <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
          </label>

          <label className="control width-control" title="Kalem kalınlığı">
            <span>Kalınlık</span>
            <input type="range" min="2" max="30" value={width} onChange={(event) => setWidth(Number(event.target.value))} />
          </label>

          <button className="tool icon-tool" type="button" onClick={undo} title="Geri al (Ctrl+Z)">↶</button>
          <button className="tool icon-tool" type="button" onClick={redo} title="İleri al (Ctrl+Y)">↷</button>
          <button className="tool" type="button" onClick={resetView}>100%</button>
          <button className="tool" type="button" onClick={clearBoard}>Temizle</button>
          <button className="tool" type="button" onClick={saveDocument}>Kaydet</button>
          <button className="tool" type="button" onClick={() => fileInputRef.current.click()}>Aç</button>
          <button className="tool" type="button" onClick={() => imageInputRef.current.click()}>Görsel/PDF</button>
          <button className="tool primary" type="button" onClick={downloadPng}>PNG</button>
          <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={openDocument} hidden />
          <input ref={imageInputRef} type="file" accept="image/*,.pdf,application/pdf" multiple onChange={openImageFiles} hidden />
        </div>
      </header>

      <section className="canvas-wrap">
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
          onContextMenu={(event) => event.preventDefault()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          className={`canvas-${tool}`}
        />
        <div className="zoom-chip">{zoomLabel}%</div>
        {notice && <div className="notice">{notice}</div>}
      </section>
    </main>
  );
}
