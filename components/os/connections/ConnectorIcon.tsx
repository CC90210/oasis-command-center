/**
 * ConnectorIcon — an app's real logo on a neutral tile, or a monogram.
 *
 * The Simple Icons SVGs are single-colour glyphs with no fill of their own, so
 * the file is used as a CSS MASK and the colour comes from here: the brand's own
 * hex, or the foreground colour when that hex would vanish on the dark tile
 * (glyphColor in lib/os/connectors.ts). That keeps the files byte-for-byte as
 * published and lets one asset work on any surface.
 *
 * A monogram is plain letters on the same tile, deliberately unbranded: a brand
 * with no published mark gets its name, never an invented logo.
 *
 * No hooks, so it renders in server and client components alike.
 */

import type { CSSProperties } from "react";
import { connectorIconSrc, glyphColor, type ConnectorDef } from "@/lib/os/connectors";

const SIZES = {
  sm: { tile: "h-7 w-7 rounded-md", glyph: "h-4 w-4", text: "text-[10px]" },
  md: { tile: "h-9 w-9 rounded-lg", glyph: "h-5 w-5", text: "text-[11px]" },
  lg: { tile: "h-11 w-11 rounded-xl", glyph: "h-6 w-6", text: "text-[13px]" },
} as const;

function maskStyle(src: string, color: string): CSSProperties {
  const url = `url("${src}")`;
  return {
    backgroundColor: color,
    WebkitMaskImage: url,
    maskImage: url,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskSize: "contain",
    maskSize: "contain",
  };
}

export function ConnectorIcon({
  def,
  size = "md",
}: {
  def: Pick<ConnectorDef, "icon" | "brandColor">;
  size?: keyof typeof SIZES;
}) {
  const s = SIZES[size];
  const src = connectorIconSrc(def.icon);
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center border border-hairline bg-bg-raised ${s.tile}`}
    >
      {src ? (
        <span className={`block ${s.glyph}`} style={maskStyle(src, glyphColor(def))} />
      ) : (
        <span className={`font-semibold tracking-tight text-fg-muted ${s.text}`}>
          {def.icon.kind === "monogram" ? def.icon.letters : ""}
        </span>
      )}
    </span>
  );
}

/** A small sub-product mark (Gmail, Calendar…) in the drawer's "Includes" row. */
export function SubProductIcon({ file, color }: { file: string; color: string }) {
  return (
    <span
      aria-hidden
      className="block h-3.5 w-3.5 shrink-0"
      style={maskStyle(`/connectors/${file}`, color)}
    />
  );
}
