"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PdfDocument = {
  id: string; title: string; current_page?: number | string; total_pages?: number | string;
};
type PdfProxy = {
  numPages: number;
  getPage: (page: number) => Promise<any>;
  getOutline: () => Promise<any[] | null>;
  getDestination: (destination: string) => Promise<any[] | null>;
  getPageIndex: (reference: any) => Promise<number>;
  destroy: () => Promise<void>;
};

export default function PdfReader({ document: material, onClose, onProgress }: { document: PdfDocument; onClose: () => void; onProgress: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PdfProxy | null>(null);
  const renderTaskRef = useRef<any>(null);
  const lastSavedRef = useRef(Date.now());
  const [page, setPage] = useState(Math.max(1, Number(material.current_page) || 1));
  const [pages, setPages] = useState(Math.max(1, Number(material.total_pages) || 1));
  const [scale, setScale] = useState(1.2);
  const [fit, setFit] = useState<"width" | "page" | "custom">("width");
  const [sidebar, setSidebar] = useState<"thumbnails" | "outline" | null>("thumbnails");
  const [outline, setOutline] = useState<any[]>([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<number[]>([]);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const saveProgress = useCallback(async (extraSeconds = 0, currentPage = page, totalPages = pages) => {
    if (!material.id || !totalPages) return;
    try {
      await fetch("/api/reader", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ documentId: material.id, currentPage, totalPages, readingSeconds: extraSeconds }) });
    } finally { if (extraSeconds || currentPage !== Number(material.current_page)) onProgress(); }
  }, [material.id, material.current_page, page, pages, onProgress]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({ url: `/api/reader?documentId=${encodeURIComponent(material.id)}`, withCredentials: true }).promise as unknown as PdfProxy;
        if (cancelled) { await pdf.destroy(); return; }
        pdfRef.current = pdf;
        setPages(pdf.numPages);
        setPage(value => Math.min(Math.max(1, value), pdf.numPages));
        setOutline((await pdf.getOutline()) || []);
        await saveProgress(0, Math.min(Math.max(1, Number(material.current_page) || 1), pdf.numPages), pdf.numPages);
      } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open this PDF"); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; renderTaskRef.current?.cancel(); void pdfRef.current?.destroy(); pdfRef.current = null; };
  }, [material.id]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const seconds = Math.min(60, Math.max(0, Math.round((now - lastSavedRef.current) / 1000)));
      lastSavedRef.current = now;
      if (seconds) void saveProgress(seconds);
    }, 30000);
    const onVisibility = () => { lastSavedRef.current = Date.now(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); const seconds = Math.min(60, Math.max(0, Math.round((Date.now() - lastSavedRef.current) / 1000))); void saveProgress(seconds); };
  }, [saveProgress]);

  useEffect(() => { const timer = window.setTimeout(() => void saveProgress(), 700); return () => window.clearTimeout(timer); }, [page, pages, saveProgress]);

  useEffect(() => {
    const pdf = pdfRef.current, canvas = canvasRef.current, container = viewRef.current;
    if (!pdf || !canvas || !container) return;
    let cancelled = false;
    (async () => {
      const pdfPage = await pdf.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const availableWidth = Math.max(280, container.clientWidth - 36);
      const availableHeight = Math.max(360, container.clientHeight - 36);
      const renderScale = fit === "width" ? availableWidth / base.width : fit === "page" ? Math.min(availableWidth / base.width, availableHeight / base.height) : scale;
      const viewport = pdfPage.getViewport({ scale: Math.max(.25, Math.min(3, renderScale)) });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      renderTaskRef.current?.cancel();
      const task = pdfPage.render({ canvasContext: canvas.getContext("2d")!, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      renderTaskRef.current = task;
      try { await task.promise; } catch (reason: any) { if (reason?.name !== "RenderingCancelledException" && !cancelled) setError("This page could not be rendered"); }
      pdfPage.cleanup();
    })();
    return () => { cancelled = true; renderTaskRef.current?.cancel(); };
  }, [page, scale, fit, pages, loading]);

  async function search() {
    const pdf = pdfRef.current; if (!pdf || !query.trim()) { setMatches([]); return; }
    setSearching(true); const found: number[] = []; const needle = query.trim().toLocaleLowerCase();
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const pdfPage = await pdf.getPage(index); const content = await pdfPage.getTextContent();
      if (content.items.map((item: any) => item.str || "").join(" ").toLocaleLowerCase().includes(needle)) found.push(index);
      pdfPage.cleanup();
    }
    setMatches(found); if (found[0]) setPage(found[0]); setSearching(false);
  }

  async function openOutline(item: any) {
    const pdf = pdfRef.current; if (!pdf || !item.dest) return;
    const destination = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
    if (!destination?.[0]) return;
    setPage((await pdf.getPageIndex(destination[0])) + 1);
  }

  function zoom(delta: number) { setFit("custom"); setScale(value => Math.max(.4, Math.min(3, value + delta))); }
  const percent = Math.round((page / pages) * 100);
  return <div className="reader-overlay" ref={shellRef}>
    <div className="reader-toolbar">
      <button onClick={onClose} aria-label="Close reader">←</button><b title={material.title}>{material.title}</b>
      <button className={sidebar ? "active" : ""} onClick={() => setSidebar(sidebar ? null : "thumbnails")}>☷</button>
      <div className="reader-pages"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button><input aria-label="Current page" value={page} onChange={event => setPage(Math.min(pages, Math.max(1, Number(event.target.value) || 1)))}/><span>/ {pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>›</button></div>
      <button onClick={() => zoom(-.15)}>−</button><span>{Math.round(scale * 100)}%</span><button onClick={() => zoom(.15)}>＋</button>
      <button className={fit === "width" ? "active" : ""} onClick={() => setFit("width")}>Fit width</button><button className={fit === "page" ? "active" : ""} onClick={() => setFit("page")}>Fit page</button>
      <div className="reader-search"><input placeholder="Search text" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => event.key === "Enter" && void search()}/><button onClick={() => void search()}>{searching ? "…" : "⌕"}</button></div>
      <button onClick={() => shellRef.current?.requestFullscreen()}>⛶</button>
    </div>
    <div className="reader-progress"><span style={{ width: `${percent}%` }}/></div>
    <div className="reader-body">
      {sidebar && <aside className="reader-sidebar"><div><button className={sidebar === "thumbnails" ? "active" : ""} onClick={() => setSidebar("thumbnails")}>Pages</button><button className={sidebar === "outline" ? "active" : ""} onClick={() => setSidebar("outline")}>Outline</button></div>
        {sidebar === "thumbnails" && <div className="thumbnail-list">{Array.from({ length: pages }, (_, index) => <button className={page === index + 1 ? "active" : ""} key={index} onClick={() => setPage(index + 1)}><span>{index + 1}</span><i>PDF</i></button>)}</div>}
        {sidebar === "outline" && <div className="outline-list">{outline.length ? outline.map((item, index) => <button key={index} onClick={() => void openOutline(item)}>{item.title || `Section ${index + 1}`}</button>) : <p>No outline in this PDF.</p>}</div>}
      </aside>}
      <div className="reader-stage" ref={viewRef}>{loading && <div className="reader-message">Opening PDF…</div>}{error && <div className="reader-message error">{error}</div>}{!loading && !error && <canvas ref={canvasRef}/>}</div>
      {matches.length > 0 && <div className="search-results"><b>{matches.length} page{matches.length === 1 ? "" : "s"} found</b>{matches.map(match => <button key={match} onClick={() => setPage(match)}>Page {match}</button>)}</div>}
    </div>
  </div>;
}
