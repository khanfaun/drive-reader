import { useEffect, useState } from "react";

const API_KEY_KEY = "drive-reader:api-key";
const SESSION_KEY = "drive-reader:reader-state";
const RECENT_FILE_KEY = "drive-reader:recent-file";
const RECENT_FOLDERS_KEY = "drive-reader:recent-folders";
const PROJECTS_KEY = "drive-reader:projects";
const REMOVED_FOLDERS_KEY = "drive-reader:removed-folders";
const REMOVED_PROJECTS_KEY = "drive-reader:removed-projects";
const THEME_KEY = "drive-reader:theme";
const FOLDER_MIME = "application/vnd.google-apps.folder";

function readStorage(key, fallback) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); }
  catch { return fallback; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional. */ }
}

function extractId(value = "") {
  const input = value.trim();
  if (/^[\w-]{10,}$/.test(input)) return input;
  const match = input.match(/(?:\/folders\/|\/file\/d\/|\/document\/d\/|\/spreadsheets\/d\/|\/presentation\/d\/|[?&]id=)([\w-]+)/i);
  if (match) return match[1];
  try {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => ["folders", "d"].includes(part));
    return (index >= 0 && parts[index + 1]) || url.searchParams.get("id") || "";
  } catch { return ""; }
}

function folderLink(value) {
  const input = typeof value === "string" ? value.trim() : "";
  const id = extractId(input);
  if (!id) return "";
  return /^https?:\/\//i.test(input) ? input : `https://drive.google.com/drive/folders/${id}?usp=sharing`;
}

function readablePdf(item) {
  return item.mimeType === "application/pdf" || item.name?.toLowerCase().endsWith(".pdf");
}

function apiError(data) {
  const reason = data?.error?.errors?.[0]?.reason;
  if (reason === "keyInvalid") return "API key không hợp lệ. Kiểm tra lại trong cài đặt.";
  if (reason === "accessNotConfigured") return "Project chưa bật Google Drive API.";
  if (data?.error?.code === 403) return "Key bị giới hạn sai hoặc thư mục chưa được chia sẻ công khai.";
  if (data?.error?.code === 404) return "Không tìm thấy thư mục hoặc thư mục không công khai.";
  return data?.error?.message || "Không tải được thư mục. Kiểm tra API key và quyền chia sẻ.";
}

export default function DriveReader() {
  const saved = readStorage(SESSION_KEY, {});
  const recentSaved = readStorage(RECENT_FILE_KEY, null);
  const foldersSaved = readStorage(RECENT_FOLDERS_KEY, []);
  const projectsSaved = readStorage(PROJECTS_KEY, []);
  const removedFoldersSaved = readStorage(REMOVED_FOLDERS_KEY, []);
  const removedProjectsSaved = readStorage(REMOVED_PROJECTS_KEY, []);
  const savedReads = Array.isArray(recentSaved) ? recentSaved : recentSaved ? [recentSaved] : [];
  const legacyRootFolderId = saved.folderStack?.[0]?.id || saved.folderId || "";
  const initialFolderLink = saved.rootFolderLink || (saved.folderStack?.length ? folderLink(legacyRootFolderId) : saved.folderInput || folderLink(legacyRootFolderId));
  const [apiKey, setApiKey] = useState(() => readStorage(API_KEY_KEY, ""));
  const [keyDraft, setKeyDraft] = useState(() => readStorage(API_KEY_KEY, ""));
  const [keyOpen, setKeyOpen] = useState(false);
  const [theme, setTheme] = useState(() => readStorage(THEME_KEY, "light"));
  const [folderInput, setFolderInput] = useState(initialFolderLink);
  const [folderId, setFolderId] = useState(saved.folderId || "");
  const [folderReload, setFolderReload] = useState(0);
  const [folderName, setFolderName] = useState(saved.folderName || "");
  const [parentFolder, setParentFolder] = useState(null);
  const [folderStack, setFolderStack] = useState(Array.isArray(saved.folderStack) ? saved.folderStack : []);
  const [items, setItems] = useState([]);
  const [fileId, setFileId] = useState(saved.fileId || "");
  const [fileName, setFileName] = useState(saved.fileName || savedReads[0]?.name || "");
  const [recentReads, setRecentReads] = useState(() => savedReads.slice(0, 3));
  const [recentFolders, setRecentFolders] = useState(() => Array.isArray(foldersSaved) ? foldersSaved : []);
  const [projects, setProjects] = useState(() => Array.isArray(projectsSaved) ? projectsSaved.slice(0, 3) : []);
  const [removedFolderIds, setRemovedFolderIds] = useState(() => Array.isArray(removedFoldersSaved) ? removedFoldersSaved : []);
  const [removedProjectIds, setRemovedProjectIds] = useState(() => Array.isArray(removedProjectsSaved) ? removedProjectsSaved : []);
  const [readerMode, setReaderMode] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const projectRootId = folderStack[0]?.id || folderId;

  useEffect(() => { writeStorage(THEME_KEY, theme); }, [theme]);
  useEffect(() => { writeStorage(SESSION_KEY, { folderId, folderInput, rootFolderLink: folderInput, folderName, folderStack, fileId, fileName }); }, [folderId, folderInput, folderName, folderStack, fileId, fileName]);

  useEffect(() => {
    if (!folderId || !apiKey) { setItems([]); setLoading(false); return; }
    let cancelled = false;
    async function loadFolder() {
      setLoading(true); setErrorMessage("");
      const query = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`, pageSize: "1000", orderBy: "folder,name",
        fields: "files(id,name,mimeType,webViewLink,resourceKey,size)", key: apiKey,
        supportsAllDrives: "true", includeItemsFromAllDrives: "true",
      });
      const metaQuery = new URLSearchParams({ fields: "id,name,mimeType,parents,resourceKey", key: apiKey, supportsAllDrives: "true" });
      try {
        const [listRes, metaRes] = await Promise.all([
          fetch(`https://www.googleapis.com/drive/v3/files?${query}`),
          fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?${metaQuery}`),
        ]);
        const listData = await listRes.json();
        if (!listRes.ok) throw listData;
        const metadata = metaRes.ok ? await metaRes.json() : null;
        if (cancelled) return;
        const sorted = (listData.files || []).sort((a, b) => Number(a.mimeType !== FOLDER_MIME) - Number(b.mimeType !== FOLDER_MIME) || a.name.localeCompare(b.name, "vi", { numeric: true, sensitivity: "base" }));
        setItems(sorted);
        if (metadata?.name) {
          setFolderName(metadata.name);
          if (folderId === projectRootId && !removedProjectIds.includes(folderId)) {
            setProjects((current) => {
              const existing = current.find((entry) => entry.id === folderId);
              const next = [{ id: folderId, name: metadata.name, link: existing?.link || folderLink(folderId) }, ...current.filter((entry) => entry.id !== folderId)].slice(0, 3);
              writeStorage(PROJECTS_KEY, next);
              return next;
            });
            const childFolders = sorted.filter((entry) => entry.mimeType === FOLDER_MIME).slice(0, 3);
            setRecentFolders((current) => {
              const removedForProject = removedFolderIds.filter((entry) => entry.projectId === folderId).map((entry) => entry.id);
              const nextForProject = childFolders.filter((entry) => !removedForProject.includes(entry.id)).map((entry) => ({
                id: entry.id, name: entry.name, link: folderLink(entry.id), projectId: folderId,
              }));
              const next = [...nextForProject, ...current.filter((entry) => entry.projectId !== folderId)].slice(0, 30);
              writeStorage(RECENT_FOLDERS_KEY, next);
              return next;
            });
          }
        } else {
          setFolderName("Không lấy được tên thư mục");
        }
        const parentId = metadata?.parents?.[0];
        if (parentId) {
          const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(parentId)}?${new URLSearchParams({ fields: "id,name,parents", key: apiKey, supportsAllDrives: "true" })}`);
          if (response.ok) { const parent = await response.json(); if (!cancelled) setParentFolder(parent); }
        } else if (!cancelled) setParentFolder(null);
      } catch (error) {
        if (!cancelled) { setItems([]); setErrorMessage(apiError(error)); }
      } finally { if (!cancelled) setLoading(false); }
    }
    loadFolder();
    return () => { cancelled = true; };
  }, [folderId, apiKey, folderReload, projectRootId, removedFolderIds, removedProjectIds]);

  useEffect(() => {
    if (!fileId || !apiKey || fileName) return;
    let cancelled = false;
    fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${new URLSearchParams({ fields: "id,name,mimeType", key: apiKey, supportsAllDrives: "true" })}`)
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (cancelled || !data?.name) return;
        setFileName(data.name);
        const recent = { fileId, folderId, folderLink: folderLink(folderInput), folderName, folderStack, name: data.name };
        setRecentReads((current) => {
          const next = [recent, ...current.filter((entry) => entry.fileId !== fileId)].slice(0, 3);
          writeStorage(RECENT_FILE_KEY, next);
          return next;
        });
      }).catch(() => {});
    return () => { cancelled = true; };
  }, [fileId, apiKey, fileName, folderId, folderInput, folderName, folderStack]);

  function openFolder(value, stack = [], updateRootLink = true) {
    const id = extractId(value);
    if (!id) { setErrorMessage("Link hoặc ID thư mục không hợp lệ."); return; }
    setErrorMessage("");
    if (updateRootLink) {
      const link = folderLink(value);
      setFolderInput(link);
      setRemovedProjectIds((current) => {
        const next = current.filter((removedId) => removedId !== id);
        writeStorage(REMOVED_PROJECTS_KEY, next);
        return next;
      });
      setProjects((current) => {
        const existing = current.find((entry) => entry.id === id);
        const next = [{ id, name: existing?.name || (id === folderId ? folderName : ""), link }, ...current.filter((entry) => entry.id !== id)].slice(0, 3);
        writeStorage(PROJECTS_KEY, next);
        return next;
      });
    }
    setFolderStack(stack);
    if (id === folderId) {
      setFolderReload((count) => count + 1);
      return;
    }
    setFolderId(id);
    setFolderName("");
  }

  function openFile(item) {
    const id = typeof item === "string" ? extractId(item) : item.id;
    if (!id) return;
    const name = typeof item === "string" ? (items.find((entry) => entry.id === id)?.name || "") : item.name;
    setFileId(id); setFileName(name); setReaderMode(true); setListOpen(false);
    const recent = { fileId: id, folderId, folderLink: folderInput, folderName, folderStack, name };
    setRecentReads((current) => {
      const next = [recent, ...current.filter((entry) => entry.fileId !== id)].slice(0, 3);
      writeStorage(RECENT_FILE_KEY, next);
      return next;
    });
  }

  function stepFile(direction) {
    const pdfs = items.filter(readablePdf);
    const target = pdfs[pdfs.findIndex((item) => item.id === fileId) + direction];
    if (target) openFile(target);
  }

  function selectRecent(read) {
    if (!read) return;
    if (read.folderId) {
      setFolderId(read.folderId);
      setFolderInput(folderLink(read.folderLink || folderInput));
      setFolderName(read.folderName || "");
      setFolderStack(Array.isArray(read.folderStack) ? read.folderStack : []);
    }
    setFileId(read.fileId); setFileName(read.name || ""); setReaderMode(true);
  }

  function selectProject(project) {
    if (project) openFolder(project.link || project.id, [], true);
  }

  function openRecentFolder(folder) {
    const project = projects.find((entry) => entry.id === folder.projectId);
    const stack = project ? [{ id: project.id, name: project.name || "" }] : [];
    openFolder(folder.link || folder.id, stack, false);
  }

  function removeProject(id) {
    setRemovedProjectIds((current) => {
      const next = [...new Set([...current, id])];
      writeStorage(REMOVED_PROJECTS_KEY, next);
      return next;
    });
    setProjects((current) => {
      const next = current.filter((entry) => entry.id !== id);
      writeStorage(PROJECTS_KEY, next);
      return next;
    });
  }

  function removeRecentFolder(folder) {
    const removal = { projectId: folder.projectId, id: folder.id };
    setRemovedFolderIds((current) => {
      const next = [...current.filter((entry) => !(entry.projectId === removal.projectId && entry.id === removal.id)), removal];
      writeStorage(REMOVED_FOLDERS_KEY, next);
      return next;
    });
    setRecentFolders((current) => {
      const next = current.filter((entry) => !(entry.projectId === folder.projectId && entry.id === folder.id));
      writeStorage(RECENT_FOLDERS_KEY, next);
      return next;
    });
  }

  function removeRecentRead(fileIdToRemove) {
    setRecentReads((current) => {
      const next = current.filter((entry) => entry.fileId !== fileIdToRemove);
      writeStorage(RECENT_FILE_KEY, next);
      return next;
    });
  }

  function goToParentFolder() {
    const stackParent = folderStack[folderStack.length - 1];
    if (stackParent?.id) {
      openFolder(stackParent.id, folderStack.slice(0, -1), false);
      return;
    }
    if (parentFolder?.id) openFolder(parentFolder.id, [], false);
  }

  function saveKey(event) {
    event.preventDefault();
    const value = keyDraft.trim();
    if (!value) return;
    writeStorage(API_KEY_KEY, value); setApiKey(value); setKeyOpen(false);
  }

  function deleteKey() {
    writeStorage(API_KEY_KEY, ""); setApiKey(""); setKeyDraft(""); setKeyOpen(true);
  }

  function renderItems() {
    if (loading) return <div className="drive-empty">Đang tải thư mục…</div>;
    if (errorMessage) return <div className="drive-error">{errorMessage}</div>;
    if (folderId && !apiKey) return <div className="drive-empty">Thêm Google Drive API key để tải danh mục.</div>;
    if (!items.length) return <div className="drive-empty">{folderId ? "Thư mục trống" : "Dán link thư mục để bắt đầu"}</div>;
    return <ul className="drive-items">{items.map((item) => {
      const folder = item.mimeType === FOLDER_MIME;
      const pdf = readablePdf(item);
      return <li key={item.id}><button type="button" disabled={!folder && !pdf} className={`drive-item ${pdf && item.id === fileId ? "selected" : ""}`} onClick={() => {
        if (folder) openFolder(item.id, [...folderStack, { id: folderId, name: folderName }], false);
        else if (pdf) openFile(item);
      }}><span className="item-icon">{folder ? "▰" : pdf ? "▤" : "·"}</span><span className="item-name">{item.name}</span><span className="item-action">{folder ? "Mở" : pdf ? "Đọc" : "—"}</span></button></li>;
    })}</ul>;
  }

  return <main className={`reader-app ${theme} ${readerMode ? "reading" : "home-view"}`}>
    {!readerMode ? <section className="home-screen">
      <header className="home-header"><button type="button" className="brand home-brand"><span className="brand-mark">D</span><span>Drive Reader</span></button><div className="home-actions"><button type="button" className="icon-button" onClick={() => setTheme((value) => value === "light" ? "dark" : "light")} aria-label="Đổi giao diện">{theme === "light" ? "☾" : "☼"}</button><button type="button" className="text-button" onClick={() => setKeyOpen((value) => !value)}>{apiKey ? "API key" : "Thêm API key"}</button></div></header>
      {keyOpen && <form className="home-key-form" onSubmit={saveKey}><input type="password" autoComplete="off" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} placeholder="Google Drive API key"/><button type="submit">Lưu key</button>{apiKey && <button type="button" className="danger-text" onClick={deleteKey}>Xóa key</button>}</form>}
      <div className="home-content"><div className="home-intro"><span className="section-label">THƯ VIỆN CÁ NHÂN</span><h1>Tiếp tục hành trình đọc</h1><p>Nhập link Drive để duyệt danh mục ngay tại đây.</p></div>
        <form className="home-open-form" onSubmit={(event) => { event.preventDefault(); openFolder(folderInput); }}><span>↗</span><input value={folderInput} onChange={(event) => setFolderInput(event.target.value)} placeholder="Dán link hoặc ID thư mục Drive" aria-label="Link thư mục Drive"/><button type="submit">Mở thư mục</button></form>
        <div className="home-grid">
          <section className="home-card">
            <div className="card-topline"><span className="section-label">Dự án</span><span className="count-pill">{Math.min(projects.length, 3)}</span></div>
            {projects.length ? <ul className="home-folder-list">{projects.slice(0, 3).map((project) => <li key={project.id} className="home-list-row"><button type="button" className="home-row-open" onClick={() => selectProject(project)}><span className="folder-card-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M2.5 5.5h6l1.7 2h7.3v7a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 2.5 14.5z"/></svg></span><span className="home-row-copy"><span className="item-name">{project.name || "Đang lấy tên thư mục…"}</span><small>{project.link || project.id}</small></span></button><button type="button" className="home-row-remove" onClick={() => removeProject(project.id)} aria-label={`Xóa dự án ${project.name || project.id}`} title="Xóa"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg></button></li>)}</ul> : <div className="home-empty">Nhập link thư mục gốc để tạo dự án.</div>}
          </section>
          <section className="home-card">
            <div className="card-topline"><span className="section-label">Thư mục gần đây</span><span className="count-pill">{Math.min(recentFolders.filter((entry) => entry.projectId === projectRootId).length, 3)}</span></div>
            {recentFolders.filter((entry) => entry.projectId === projectRootId).slice(0, 3).length ? <ul className="home-folder-list">{recentFolders.filter((entry) => entry.projectId === projectRootId).slice(0, 3).map((folder) => <li key={folder.id} className="home-list-row"><button type="button" className="home-row-open" onClick={() => openRecentFolder(folder)}><span className="folder-card-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M2.5 5.5h6l1.7 2h7.3v7a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 2.5 14.5z"/></svg></span><span className="home-row-copy"><span className="item-name">{folder.name || "Thư mục Drive"}</span><small>{projects.find((entry) => entry.id === folder.projectId)?.name || "Dự án"}</small></span></button><button type="button" className="home-row-remove" onClick={() => removeRecentFolder(folder)} aria-label={`Xóa thư mục ${folder.name || folder.id}`} title="Xóa"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg></button></li>)}</ul> : <div className="home-empty">Thư mục con của dự án đang mở sẽ xuất hiện ở đây.</div>}
          </section>
          <section className="home-card continue-card">
            <div className="card-topline"><span className="section-label">Tiếp tục đọc</span><span className="count-pill">{Math.min(recentReads.length, 3)}</span></div>
            {recentReads.length ? <ul className="home-folder-list">{recentReads.slice(0, 3).map((read) => <li key={read.fileId} className="home-list-row"><button type="button" className="home-row-open" onClick={() => selectRecent(read)}><span className="pdf-badge">PDF</span><span className="home-row-copy"><span className="item-name">{read.name || "PDF Drive"}</span><small>{read.folderName || "File đã mở gần đây"}</small></span></button><button type="button" className="home-row-remove" onClick={() => removeRecentRead(read.fileId)} aria-label={`Xóa ${read.name || "file"} khỏi danh sách gần đây`} title="Xóa"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg></button></li>)}</ul> : <div className="home-empty">File đã đọc sẽ xuất hiện ở đây.</div>}
          </section>
        </div>
        {folderId && <section className="home-folder-section"><div className="home-folder-titlebar">{(folderStack.length > 0 || parentFolder) && <button type="button" className="back-button" onClick={goToParentFolder} aria-label="Quay lại thư mục cha">←</button>}<div><span className="section-label">DANH MỤC ĐANG MỞ</span><h2>{folderName || "Đang lấy tên thư mục…"}</h2></div></div>{renderItems()}</section>}
      </div>
    </section> : <>
      <header className="reader-toolbar">
        <button type="button" className="reader-home-button" onClick={() => setReaderMode(false)} aria-label="Trang chủ" title="Trang chủ">⌂</button>
        <div className="reader-center-controls">
          <button type="button" className="toolbar-button previous" onClick={() => stepFile(-1)} disabled={!items.some((item) => item.id === fileId)} aria-label="File trước">‹</button>
          <div className="reader-title" title={fileName}>{fileName || "Đang lấy tên file…"}</div>
          <button type="button" className="toolbar-button next" onClick={() => stepFile(1)} disabled={!items.some((item) => item.id === fileId)} aria-label="File tiếp theo">›</button>
        </div>
        <div className="reader-tools"><button type="button" className={`file-list-button ${listOpen ? "active" : ""}`} onClick={() => setListOpen((value) => !value)} aria-label="Danh sách file trong thư mục" title="Danh sách file trong thư mục"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5h9M7.5 10h9M7.5 15h9"/><path d="M3.5 5h.01M3.5 10h.01M3.5 15h.01"/></svg></button><button type="button" className="theme-button" onClick={() => setTheme((value) => value === "light" ? "dark" : "light")} aria-label="Đổi theme">{theme === "light" ? "☾" : "☼"}</button></div>
      </header>
      <div className="pdf-stage">{fileId ? <iframe key={fileId} className="pdf-frame" title={fileName || "PDF Drive"} src={`https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`} allow="autoplay"/> : <div className="drive-empty">Chọn file PDF trong danh sách</div>}</div>
      {listOpen && <aside className="reader-file-drawer"><div className="drawer-heading">{(folderStack.length > 0 || parentFolder) && <button type="button" className="back-button" onClick={goToParentFolder} aria-label="Quay lại thư mục cha">←</button>}<div className="drawer-title"><span className="section-label">FILE TRONG THƯ MỤC</span><h2>{folderName || "Drive"}</h2></div><button type="button" className="drawer-close" onClick={() => setListOpen(false)} aria-label="Đóng danh sách">×</button></div><div className="drawer-content">{renderItems()}</div></aside>}
    </>}
  </main>;
}

