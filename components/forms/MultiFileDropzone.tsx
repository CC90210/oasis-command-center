"use client";

/**
 * MultiFileDropzone — drag-and-drop multi-file uploader for the public form
 * `file_upload_multi` field (bank statements: a merchant with two accounts needs
 * ~6 statements; the old fixed 3-slot uploader hard-blocked them).
 *
 * Direct-to-Storage: each file is uploaded straight to Supabase Storage via a
 * server-minted signed upload URL (/api/forms/upload-url), so the bytes never
 * pass base64-inlined through /api/forms/submit (which is capped by the Vercel
 * request-body limit and could never carry 12 × 25 MB). The field's value is the
 * array of completed { storage_path, filename, mime_type, size_bytes }
 * descriptors; /api/forms/submit re-validates each path is inside the lead's
 * prefix and that the object exists before registering it on the lead.
 *
 * Self-contained stateful component (same pattern as SignatureField /
 * AddressAutocompleteField) — the renderer is otherwise stateless.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { UploadCloud, FileText, X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

export type UploadedDescriptor = {
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
};

type Row = {
  id: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  status: "uploading" | "done" | "error";
  progress: number; // 0..1
  storage_path?: string;
  error?: string;
};

const DEFAULT_ACCEPT = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
];

function mimeAllowed(mime: string, accept: string[]): boolean {
  return accept.some((rule) =>
    rule.endsWith("/*") ? mime.startsWith(rule.slice(0, -1)) : mime === rule,
  );
}

function localId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `f_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  }
}

/** PUT the file to the signed URL with byte-level progress (fetch has no upload
 *  progress, so use XHR). Resolves true on a 2xx. */
function putWithProgress(
  url: string,
  file: File,
  onProgress: (p: number) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.ontimeout = () => resolve(false);
    xhr.send(file);
  });
}

export function MultiFileDropzone({
  inputId,
  accept,
  maxFiles = 50,
  maxFileMb = 25,
  value,
  onChange,
  uploadToken,
}: {
  inputId: string;
  accept?: string[];
  maxFiles?: number;
  maxFileMb?: number;
  value: unknown;
  onChange: (v: UploadedDescriptor[]) => void;
  uploadToken: string | null;
}) {
  const acceptList = accept && accept.length > 0 ? accept : DEFAULT_ACCEPT;
  const maxBytes = maxFileMb * 1024 * 1024;

  // Seed from any descriptors the parent already holds (returning to the step).
  const [rows, setRows] = useState<Row[]>(() => {
    const seed = Array.isArray(value) ? (value as UploadedDescriptor[]) : [];
    return seed
      .filter((d) => d && typeof d.storage_path === "string")
      .map((d) => ({
        id: localId(),
        filename: d.filename,
        size_bytes: d.size_bytes,
        mime_type: d.mime_type,
        status: "done" as const,
        progress: 1,
        storage_path: d.storage_path,
      }));
  });
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Keep onChange in a ref so the emit effect doesn't re-run on its identity.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Emit the completed descriptors whenever the row set changes.
  useEffect(() => {
    const done = rows
      .filter((r) => r.status === "done" && r.storage_path)
      .map((r) => ({
        storage_path: r.storage_path as string,
        filename: r.filename,
        mime_type: r.mime_type,
        size_bytes: r.size_bytes,
      }));
    onChangeRef.current(done);
  }, [rows]);

  const patchRow = useCallback((id: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const uploadOne = useCallback(
    async (file: File, id: string) => {
      try {
        const signRes = await fetch("/api/forms/upload-url", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: uploadToken,
            filename: file.name,
            mime_type: file.type || "application/octet-stream",
            size_bytes: file.size,
          }),
        });
        const signJson = await signRes.json().catch(() => ({}));
        if (!signRes.ok || !signJson.ok) {
          patchRow(id, {
            status: "error",
            error:
              signJson.error === "file_too_large"
                ? `Too large (max ${maxFileMb} MB).`
                : "Couldn't start upload. Try again.",
          });
          return;
        }
        const ok = await putWithProgress(signJson.signed_url, file, (p) =>
          patchRow(id, { progress: p }),
        );
        if (!ok) {
          patchRow(id, { status: "error", error: "Upload failed. Try again." });
          return;
        }
        patchRow(id, { status: "done", progress: 1, storage_path: signJson.storage_path });
      } catch {
        patchRow(id, { status: "error", error: "Network error. Try again." });
      }
    },
    [uploadToken, maxFileMb, patchRow],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      setNotice(null);
      if (!uploadToken) {
        // No HMAC token yet. The real flow (a personalized link we send the
        // merchant) always carries one; this only fires on the anonymous/preview
        // route, or a multi-step form before its first step is submitted.
        setNotice(
          "Open this form from the personalized link we sent you to upload — or complete the earlier steps first.",
        );
        return;
      }
      const incoming = Array.from(files);
      setRows((prev) => {
        const slotsLeft = Math.max(0, maxFiles - prev.length);
        if (incoming.length > slotsLeft) {
          setNotice(`Up to ${maxFiles} files. Extra files were skipped.`);
        }
        const accepted = incoming.slice(0, slotsLeft);
        const newRows: Row[] = [];
        for (const file of accepted) {
          const mime = file.type || "application/octet-stream";
          if (!mimeAllowed(mime, acceptList)) {
            newRows.push({
              id: localId(),
              filename: file.name,
              size_bytes: file.size,
              mime_type: mime,
              status: "error",
              progress: 0,
              error: "Unsupported file type (PDF or image only).",
            });
            continue;
          }
          if (file.size > maxBytes) {
            newRows.push({
              id: localId(),
              filename: file.name,
              size_bytes: file.size,
              mime_type: mime,
              status: "error",
              progress: 0,
              error: `Too large (max ${maxFileMb} MB).`,
            });
            continue;
          }
          const id = localId();
          newRows.push({
            id,
            filename: file.name,
            size_bytes: file.size,
            mime_type: mime,
            status: "uploading",
            progress: 0,
          });
          // Kick off the upload outside the state updater.
          queueMicrotask(() => void uploadOne(file, id));
        }
        return [...prev, ...newRows];
      });
    },
    [uploadToken, maxFiles, maxBytes, maxFileMb, acceptList, uploadOne],
  );

  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const doneCount = rows.filter((r) => r.status === "done").length;

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
        }}
        className={`rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
          dragging ? "border-accent bg-accent/10" : "border-bg-border bg-bg-elev/40"
        }`}
      >
        <UploadCloud className="mx-auto mb-2 h-7 w-7 text-fg-muted" />
        <label htmlFor={inputId} className="cursor-pointer">
          <span className="text-sm font-semibold text-accent underline-offset-2 hover:underline">
            Choose files
          </span>{" "}
          <span className="text-sm text-fg-muted">or drag &amp; drop here</span>
          <input
            id={inputId}
            type="file"
            multiple
            accept={acceptList.join(",")}
            className="sr-only"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />
        </label>
        <p className="mt-1 text-[11px] text-fg-dim">
          PDF or photo · up to {maxFiles} files · {maxFileMb} MB each
        </p>
      </div>

      {notice && (
        <p className="text-[11px] text-amber-400 flex items-center gap-1">
          <AlertCircle className="h-3 w-3" /> {notice}
        </p>
      )}

      {rows.length > 0 && (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-elev/40 px-2.5 py-1.5"
            >
              {r.status === "done" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              ) : r.status === "error" ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              ) : (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-fg-muted" />
              )}
              <FileText className="h-4 w-4 shrink-0 text-fg-dim" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] text-fg">{r.filename}</div>
                {r.status === "uploading" ? (
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-bg-border">
                    <div
                      className="h-full rounded-full bg-accent transition-all"
                      style={{ width: `${Math.round(r.progress * 100)}%` }}
                    />
                  </div>
                ) : (
                  <div className={`text-[10.5px] ${r.status === "error" ? "text-rose-400" : "text-fg-dim"}`}>
                    {r.status === "error"
                      ? r.error
                      : `${Math.max(1, Math.round(r.size_bytes / 1024))} KB · uploaded`}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeRow(r.id)}
                className="shrink-0 rounded p-1 text-fg-dim hover:bg-bg-border hover:text-fg"
                aria-label={`Remove ${r.filename}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {doneCount > 0 && (
        <p className="text-[11px] text-fg-dim">
          {doneCount} file{doneCount === 1 ? "" : "s"} ready.
        </p>
      )}
    </div>
  );
}
