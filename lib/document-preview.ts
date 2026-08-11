export type DocumentPreviewKind = "pdf" | "image" | "text" | "download";

const EXTENSION_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  csv: "text/csv",
};

export function normalizedDocumentMime(
  filename: string | null | undefined,
  declaredMime: string | null | undefined,
): string {
  const declared = (declaredMime || "").toLowerCase().split(";", 1)[0].trim();
  if (declared && declared !== "application/octet-stream") return declared;
  const extension = (filename || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] || "";
  return EXTENSION_MIME[extension] || "application/octet-stream";
}

export function documentPreviewKind(
  filename: string | null | undefined,
  declaredMime: string | null | undefined,
): DocumentPreviewKind {
  const mime = normalizedDocumentMime(filename, declaredMime);
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/plain" || mime === "text/csv") return "text";
  return "download";
}

export function imageNeedsBrowserSafeConversion(mime: string): boolean {
  return !new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]).has(
    mime.toLowerCase().split(";", 1)[0].trim(),
  );
}
