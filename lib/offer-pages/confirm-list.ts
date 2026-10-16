/**
 * lib/offer-pages/confirm-list.ts - what Confirm & publish (/forms/publish)
 * shows for every offer page in the session's workspace, read on the server.
 *
 * CC 2026-10-16: one screen, no manual video uploads. Per page: its name, its
 * public link, its form On/Off, Draft/Live, what publishGate says still blocks
 * it, and everything that needs the owner (each flagged sentence, each price,
 * the guarantee, the proposed top video) in one place.
 *
 * Every answer comes from the builder's own reads and rules: readOfferRow and
 * editableForm (the workspace is the caller's session, so another workspace's
 * page matches nothing), publishGate and lintDoc (claims.ts), statusOf
 * (store.ts). "unfixable" is publishGate run on the draft with every tick this
 * screen offers ticked and the form on: whatever is left there only the
 * builder can fix (a missing headline, a result without evidence), and the
 * screen says so instead of offering a Publish that would be refused.
 *
 * WHICH VIDEO IS PROPOSED. First the cut tagged for this page in the Library
 * (taggedHeroVideo: meta.offer_slug = the form's slug, written by Maven's
 * publish_to_library.py --offer-slug), so a new offer's video is proposed with
 * no code change; else the hand map (suggested-videos.ts).
 *
 * THE PROPOSED VIDEO is resolved from its Library asset
 * the way the builder's "Choose from Library" resolves one
 * (app/api/forms/[id]/offer/library-videos): this workspace's own asset, OASIS's
 * own brand, a video, with its video file; the poster and captions when it has
 * them. Approved or published, it can be attached as it is. In review, the
 * owner's tick approves it first through the Library's own route
 * (confirm-publish.ts). Any other status is shown and not offered. The video
 * and poster are signed for the owner's own view, briefly, as the builder's
 * preview signs a draft video (preview-video PREVIEW_TTL_SEC).
 *
 * Callers have passed the builder's edit gate (requireOsRoute("/forms") and
 * formsEditRefusal, app/forms/publish/page.tsx).
 */
import "server-only";
import type { Client } from "@libsql/client";
import type { Aspect, HeroLayout, OfferPageDoc, PricingTier } from "./types";
import { lintDoc, publishGate, type ClaimTick } from "./claims";
import { formatMoney, isConfirmed } from "./visibility";
import { listOfferStatuses, readOfferRow, statusOf } from "./store";
import { editableForm, fallbackHeadline } from "./operator";
import { POSTER_TTL_SEC, mediaKey, type Signer } from "./video";
import { SUGGESTED_HERO_VIDEOS, suggestedHeroVideo, type SuggestedVideo } from "./suggested-videos";
import type { BonusValueItem, ConfirmOffer, GuaranteeItem, PriceItem, ProposalRef, ProposalView } from "./confirm-publish";
import { offerShareablePath } from "@/lib/offers/short-links";
import { FOUNDERS_OWN_BRAND } from "@/lib/founders-marketing-core";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";

/** The proposed video is watched now, on this screen: half an hour, as the builder's preview signs one. */
export const PROPOSAL_PLAY_TTL_SEC = 30 * 60;

/** "From $497 a month, or CA$690": a tier's price as its card reads it (SectionEditors priceAsShown). */
export function priceAsShown(t: PricingTier): string {
  const price = t.price.trim();
  const cadence = (t.cadence ?? "").trim();
  const cad = (t.price_cad ?? "").trim();
  return price ? `${price}${cadence ? ` ${cadence}` : ""}${cad ? `, or ${cad}` : ""}` : "";
}

/**
 * The blockers left once every tick this screen offers is ticked and the form
 * is on: what only the builder can fix. Run on a copy; the stamp is a stand-in
 * that never leaves this function.
 */
export function blockersAfterEveryTick(doc: OfferPageDoc, headline: string): string[] {
  const all = JSON.parse(JSON.stringify(doc)) as OfferPageDoc;
  const stamp = { by: "every-tick", at: "2000-01-01T00:00:00.000Z" };
  for (const s of all.sections) {
    if (s.key === "pricing" && !s.hidden) {
      for (const t of s.tiers) if (t.price.trim() && !isConfirmed(t.confirmed)) t.confirmed = { ...stamp };
    }
    if (s.key === "guarantee" && (s.body || "").trim() && !isConfirmed(s.confirmed)) s.confirmed = { ...stamp };
  }
  const ticks: ClaimTick[] = lintDoc(all, { fallbackHeadline: headline }).map((h) => ({ hash: h.hash, excerpt: "", ...stamp }));
  return publishGate(all, ticks, { formEnabled: true, fallbackHeadline: headline }).blockers;
}

/** Each priced tier the gate asks about: a price, in a pricing section the page draws. */
function pricesOf(doc: OfferPageDoc): PriceItem[] {
  const s = doc.sections.find((x) => x.key === "pricing");
  if (!s || s.key !== "pricing" || s.hidden) return [];
  return s.tiers
    .map((t, index) => ({ t, index }))
    .filter(({ t }) => t.price.trim())
    .map(({ t, index }) => ({ index, name: t.name.trim() || `Plan ${index + 1}`, shown: priceAsShown(t), confirmed: isConfirmed(t.confirmed) }));
}

function bonusValuesOf(doc: OfferPageDoc): BonusValueItem[] {
  const s = doc.sections.find((x) => x.key === "bonuses");
  if (!s || s.key !== "bonuses") return [];
  const out: BonusValueItem[] = [];
  s.items.forEach((it, index) => {
    if (!it.value || !isConfirmed(it.value.confirmed)) return;
    out.push({ index, title: it.title.trim() || `Bonus ${index + 1}`, value: formatMoney(it.value), confirmedOn: it.value.confirmed.at.slice(0, 10) });
  });
  return out;
}

/** The guarantee the gate asks about: one with words (publishGate reads it hidden or not). */
function guaranteeOf(doc: OfferPageDoc): GuaranteeItem | null {
  const s = doc.sections.find((x) => x.key === "guarantee");
  if (!s || s.key !== "guarantee" || !(s.body || "").trim()) return null;
  return { body: s.body!.trim(), confirmed: isConfirmed(s.confirmed) };
}

type Row = Record<string, unknown>;
const rowsOf = (rs: { columns: string[]; rows: unknown[] }): Row[] =>
  rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, (r as unknown as unknown[])[i]])));

/**
 * The shape a hero layout draws best: beside the words (split) is tall, under
 * them (stacked) is wide; centered takes any. No layout at all draws as split
 * (OfferPage, and the builder's layout picker), so it prefers tall too.
 */
export function aspectForLayout(layout: HeroLayout | undefined): Aspect | null {
  return layout === "stacked" ? "16:9" : layout === "centered" ? null : "9:16";
}

/**
 * The Library cut tagged for this page (meta.offer_slug = the form's slug):
 * this workspace's own video of OASIS's own brand, in review, approved or
 * published, with a video file, in a shape a page can draw. The newest by
 * created_at (a tag write or a byte swap moves updated_at, so updated_at would
 * let an old cut jump ahead), preferring the shape the page's hero layout
 * draws; the newest of any shape otherwise. The choice is the query's own
 * ORDER BY, so no number of newer cuts in another shape can push the matching
 * one out. null when no cut is tagged for it, and always null outside OASIS's
 * own workspaces: the Library is OASIS's only (the builder's picker answers
 * available: false there, and approving an asset is founders-only).
 */
export async function taggedHeroVideo(
  db: Client,
  input: { tenantId: string; formSlug: string; layout: HeroLayout | undefined },
): Promise<SuggestedVideo | null> {
  if (!isOasisInternalTenant(input.tenantId)) return null;
  let rows: Row[];
  try {
    rows = rowsOf(
      await db.execute({
        // CASE first: json_extract on a meta that is not JSON would fail the whole read.
        sql: `SELECT a.id, a.aspect FROM marketing_asset a
              WHERE a.tenant_id = ? AND a.brand_slug = ? AND a.format = 'video'
                AND a.status IN ('in_review', 'approved', 'published')
                AND a.aspect IN ('9:16', '16:9', '1:1', '4:5')
                AND (CASE WHEN json_valid(a.meta) THEN json_extract(a.meta, '$.offer_slug') END) = ?
                AND EXISTS (SELECT 1 FROM marketing_asset_media m
                            WHERE m.tenant_id = a.tenant_id AND m.asset_id = a.id AND m.kind = 'video' AND m.storage_path <> '')
              ORDER BY CASE WHEN a.aspect = ? THEN 0 ELSE 1 END, a.created_at DESC, a.id DESC
              LIMIT 1`,
        args: [input.tenantId, FOUNDERS_OWN_BRAND, input.formSlug, aspectForLayout(input.layout) ?? ""],
      }),
    );
  } catch (err) {
    if (/no such table:\s*"?marketing_asset/i.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }
  const hit = rows[0];
  return hit ? { assetId: String(hit.id), aspect: String(hit.aspect) as Aspect } : null;
}

/** The proposal for one page, resolved from its Library asset in this workspace. */
export async function resolveProposal(
  db: Client,
  input: { tenantId: string; suggestion: SuggestedVideo | null; doc: OfferPageDoc; sign: Signer },
): Promise<ProposalView> {
  const s = input.suggestion;
  if (!s) return { state: "none" };
  let asset: Row | undefined;
  let media: Row[];
  try {
    asset = rowsOf(
      await db.execute({
        sql: "SELECT id, title, status, format, brand_slug, duration_s FROM marketing_asset WHERE tenant_id = ? AND id = ? LIMIT 1",
        args: [input.tenantId, s.assetId],
      }),
    )[0];
    media = asset
      ? rowsOf(
          await db.execute({
            sql: "SELECT id, kind, storage_bucket, storage_path FROM marketing_asset_media WHERE tenant_id = ? AND asset_id = ?",
            args: [input.tenantId, s.assetId],
          }),
        )
      : [];
  } catch (err) {
    if (/no such table:\s*"?marketing_asset/i.test(err instanceof Error ? err.message : String(err))) return { state: "missing", assetId: s.assetId };
    throw err;
  }
  if (!asset || asset.brand_slug !== FOUNDERS_OWN_BRAND || asset.format !== "video") return { state: "missing", assetId: s.assetId };
  // The picker's choice of file per kind (library-videos route `pick`).
  const pick = (kinds: string[]) => kinds.map((k) => media.find((r) => r.kind === k && String(r.storage_path ?? ""))).find(Boolean) ?? null;
  const video = pick(["video"]);
  if (!video) return { state: "missing", assetId: s.assetId };
  const poster = pick(["poster", "thumb", "preview", "image"]);
  const caption = pick(["caption"]);
  const title = String(asset.title ?? "");
  const status = String(asset.status ?? "");
  // The builder's draft save takes a NEW Library video only when it is
  // approved or published (app/api/forms/[id]/offer PUT); in review, the
  // owner approves it here first. Nothing else is offered.
  if (status !== "approved" && status !== "published" && status !== "in_review") {
    return { state: "unavailable", assetId: s.assetId, title, status };
  }
  const duration = asset.duration_s == null || asset.duration_s === "" ? NaN : Number(asset.duration_s);
  const ref: ProposalRef = {
    source: "library",
    asset_id: String(asset.id),
    video_media_id: String(video.id),
    ...(poster ? { poster_media_id: String(poster.id) } : {}),
    ...(caption ? { caption_media_id: String(caption.id) } : {}),
    aspect: s.aspect,
    ...(Number.isFinite(duration) && duration > 0 ? { duration_s: Math.round(duration) } : {}),
  };
  const current = input.doc.hero.video;
  const onPage = !!current && current.source === "library" && current.asset_id === ref.asset_id && current.video_media_id === ref.video_media_id;
  let videoUrl: string | null = null;
  let posterUrl: string | null = null;
  try {
    const v = { bucket: String(video.storage_bucket ?? "marketing-media"), path: String(video.storage_path) };
    videoUrl = (await input.sign([v], PROPOSAL_PLAY_TTL_SEC)).get(mediaKey(v.bucket, v.path)) ?? null;
    if (poster) {
      const p = { bucket: String(poster.storage_bucket ?? "marketing-media"), path: String(poster.storage_path) };
      posterUrl = (await input.sign([p], POSTER_TTL_SEC)).get(mediaKey(p.bucket, p.path)) ?? null;
    }
  } catch (err) {
    // A video the owner cannot watch here can still be attached; say so, never hide the row.
    console.error("[offer-pages.confirm] proposal signing failed", { asset_id: s.assetId, error: err instanceof Error ? err.message : String(err) });
  }
  return {
    state: "ready",
    assetId: s.assetId,
    title,
    status: status as "in_review" | "approved" | "published",
    needsApproval: status === "in_review",
    ref,
    videoUrl,
    posterUrl,
    onPage,
    replaces: !!current && !onPage,
  };
}

export type ConfirmList = { state: "unavailable" } | { state: "ok"; offers: ConfirmOffer[] };

/**
 * Every offer page of this workspace, in name order, each with what it still
 * needs. "unavailable" when the offer pages table is not there yet
 * (bravo__203 not applied), as the Offers list reads it.
 */
export async function loadConfirmList(
  db: Client,
  input: { tenantId: string; tenantSlug: string | null; sign: Signer; suggestions?: Readonly<Record<string, SuggestedVideo>> },
): Promise<ConfirmList> {
  const statuses = await listOfferStatuses(db, input.tenantId);
  if (!statuses) return { state: "unavailable" };
  const suggestions = input.suggestions ?? SUGGESTED_HERO_VIDEOS;
  const offers = await Promise.all(
    [...statuses.keys()].map(async (formId): Promise<ConfirmOffer | null> => {
      const [form, read] = await Promise.all([editableForm(db, input.tenantId, formId), readOfferRow(db, input.tenantId, formId)]);
      if (!form || read.state !== "row") return null;
      const row = read.row;
      const base = {
        formId: form.id,
        name: form.name || form.slug,
        slug: form.slug,
        link: offerShareablePath(input.tenantSlug, form.slug),
        formEnabled: form.enabled,
        status: statusOf(row),
        version: row.draftVersion,
      };
      if (!row.draft) {
        return {
          ...base,
          draft: null,
          draftError: row.draftError,
          blockers: ["The saved draft can't be read. Make a change in the builder and save it again."],
          warnings: [],
          unfixable: ["The saved draft can't be read. Make a change in the builder and save it again."],
          claims: [],
          prices: [],
          bonusValues: [],
          guarantee: null,
          proposal: { state: "none" },
        };
      }
      const headline = fallbackHeadline(form);
      const gate = publishGate(row.draft, row.claims, { formEnabled: form.enabled, fallbackHeadline: headline });
      return {
        ...base,
        draft: row.draft,
        draftError: null,
        blockers: gate.blockers,
        warnings: gate.warnings,
        unfixable: blockersAfterEveryTick(row.draft, headline),
        claims: gate.claims.map((c) => ({ hash: c.hash, sentence: c.sentence, why: c.why, section: c.section, confirmed: c.confirmed })),
        prices: pricesOf(row.draft),
        bonusValues: bonusValuesOf(row.draft),
        guarantee: guaranteeOf(row.draft),
        proposal: await resolveProposal(db, {
          tenantId: input.tenantId,
          suggestion:
            (await taggedHeroVideo(db, { tenantId: input.tenantId, formSlug: form.slug, layout: row.draft.theme.layout })) ??
            suggestedHeroVideo(input.tenantSlug, form.slug, suggestions),
          doc: row.draft,
          sign: input.sign,
        }),
      };
    }),
  );
  return {
    state: "ok",
    offers: offers.filter((o): o is ConfirmOffer => o !== null).sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug)),
  };
}