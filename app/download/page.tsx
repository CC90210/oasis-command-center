import Link from "next/link";
import { Apple, Download, MonitorDown } from "lucide-react";
import { OasisLogo } from "@/components/brand/OasisLogo";

export const dynamic = "force-dynamic";

/**
 * /download — cinematic single-purpose download surface.
 *
 * Rebuilt 2026-05-22 (CC: "radically simplify — overwhelmingly
 * cluttered with multi-colored prerequisite text boxes — center
 * attention on one massive download CTA").
 *
 * Design contract:
 *   - One hero with a single primary CTA. No competing buttons
 *     above the fold.
 *   - Mac (universal) + Windows + Linux as a clean trio of equal-
 *     weight secondary cards. No subtype clutter ("Mac dmg only"
 *     was confusing — now "Mac · Apple Silicon + Intel").
 *   - All technical warnings (SmartScreen, Gatekeeper, Python,
 *     checksums) collapsed into a single "Installation help"
 *     `<details>` at the bottom. Operators who don't need them
 *     never see them.
 *   - Removed the Desktop Product Model sidebar — operators just
 *     want to download the app, not read product copy.
 *
 * alpha.5 (2026-05-23): mac + linux bumped to the turnkey deep-link
 * sign-in build. Windows kept on alpha.4 until a Windows CI runner
 * lands — the auto-detect proxy routes to the right tag per platform.
 */

const VERSION = "0.1.0-alpha.6";
const RELEASE_TAG = "oasis-desktop-v0.1.0-alpha.6";
const RELEASE_URL = `https://github.com/CC90210/CEO-Agent/releases/tag/${RELEASE_TAG}`;
const AUTO_DOWNLOAD_URL = "/api/download/desktop";
const MAC_DMG_URL = "/api/download/desktop?platform=mac";
const WINDOWS_INSTALLER_URL = "/api/download/desktop?platform=windows-installer";
const WINDOWS_PORTABLE_URL = "/api/download/desktop?platform=windows";
const LINUX_APPIMAGE_URL = "/api/download/desktop?platform=linux";
const LINUX_DEB_URL = "/api/download/desktop?platform=linux-deb";
const CHECKSUM_URL = "/api/download/desktop?platform=checksums";

const CHECKSUMS = [
  ["macOS (universal · alpha.6)", "eecde66712654f5cdd4447b33986a1afb2853c0659de56cacd7b59d3cf965139"],
  ["Linux x86_64 AppImage (alpha.6)", "2125e7fa16cdefba02474d11b3d6bc62a5bbba15e61beb962864393b4cfe6b1d"],
  ["Linux amd64 deb (alpha.6)", "41103e2112f7816af4603c29eaf41ea3645a71ccf1b847b4e99692d33f6fe9c9"],
  ["Windows portable zip (alpha.4)", "07dea7cf78ce4ae36321dbdebb0e0c246dbf0c173699c2bd31e3fa9fa88e9c76"],
  ["Windows installer (alpha.4)", "18e09eb6efd275d06c6b2f8f1e116f3edfe9635e888b0d6fb04cf069f3db23cd"],
] as const;

export default function DownloadPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-bg-deep text-fg">
      {/* Aurora backdrop — single conic + radial layer, no grid clutter */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-30">
        <div
          className="absolute left-1/2 top-1/2 h-[120vmax] w-[120vmax] -translate-x-1/2 -translate-y-1/2 opacity-45 blur-3xl animate-[orbit-soft_42s_linear_infinite]"
          style={{
            background:
              "conic-gradient(from 0deg at 50% 50%, rgba(0,212,255,0.32), rgba(59,130,246,0.18), transparent 45%, rgba(34,211,238,0.22) 75%, rgba(0,212,255,0.32))",
          }}
        />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-20"
        style={{
          background:
            "radial-gradient(ellipse 60% 60% at 50% 50%, transparent 0%, rgba(8,11,16,0.7) 100%)",
        }}
      />

      {/* === Top brand strip ============================================ */}
      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-6 sm:px-10">
        <Link href="/welcome" className="group flex items-center gap-2.5">
          <OasisLogo
            size={32}
            priority
            className="transition-shadow group-hover:shadow-[0_0_28px_-2px_rgba(0,212,255,0.7)]"
          />
          <div className="leading-none">
            <div className="text-sm font-black tracking-tight text-fg">OASIS AI</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-fg-dim">
              Desktop · v{VERSION}
            </div>
          </div>
        </Link>
        <a
          href={RELEASE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-fg-dim transition-colors hover:text-fg"
        >
          Release notes →
        </a>
      </header>

      {/* === Hero ===================================================== */}
      <section className="relative z-10 mx-auto flex max-w-3xl flex-col items-center px-6 pt-10 text-center sm:pt-16">
        <h1 className="text-5xl font-black leading-[1.02] tracking-tight text-fg sm:text-7xl">
          <span className="block">OASIS Desktop.</span>
          <span className="block bg-gradient-to-r from-accent via-cyan-300 to-accent bg-clip-text text-transparent">
            One click to install.
          </span>
        </h1>
        <p className="mt-5 max-w-md text-sm leading-relaxed text-fg-muted sm:text-base">
          The native shell for the Agent Command Center. Picks your OS
          automatically.
        </p>

        {/* === MASSIVE primary CTA ==================================== */}
        <a
          href={AUTO_DOWNLOAD_URL}
          className="group/cta relative mt-10 inline-flex w-full max-w-xl items-center justify-center gap-3 overflow-hidden rounded-2xl border border-accent/40 bg-gradient-to-br from-accent/30 via-cyan-500/20 to-accent/30 px-8 py-6 text-base font-bold text-fg shadow-[0_0_60px_-12px_rgba(0,212,255,0.7)] transition-all hover:scale-[1.02] hover:shadow-[0_0_90px_-8px_rgba(0,212,255,0.9)] sm:text-lg"
        >
          <span
            aria-hidden
            className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/15 to-transparent transition-transform duration-1000 group-hover/cta:translate-x-full"
          />
          <Download className="relative h-6 w-6" />
          <span className="relative">Download for this computer</span>
        </a>

        {/* === Per-OS triplet (clean, equal-weight, no clutter) ======= */}
        <div className="mt-6 grid w-full max-w-xl grid-cols-3 gap-3">
          <DownloadCard
            href={MAC_DMG_URL}
            icon={<Apple className="h-5 w-5" />}
            label="Mac"
            sub="Apple Silicon + Intel"
          />
          <DownloadCard
            href={WINDOWS_INSTALLER_URL}
            icon={<MonitorDown className="h-5 w-5" />}
            label="Windows"
            sub="Installer (.exe)"
          />
          <DownloadCard
            href={LINUX_APPIMAGE_URL}
            icon={<Download className="h-5 w-5" />}
            label="Linux"
            sub="AppImage / deb"
          />
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-dim">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1 w-1 rounded-full bg-accent" /> Universal binary
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1 w-1 rounded-full bg-accent" /> Bundled runtime
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1 w-1 rounded-full bg-accent" /> Local-first
          </span>
        </div>
      </section>

      {/* === Installation help — ALL warnings hidden by default ====== */}
      <section className="relative z-10 mx-auto mt-20 max-w-3xl px-6 pb-24 sm:px-10">
        <details className="group rounded-2xl border border-bg-border bg-bg-elev/30 backdrop-blur-xl transition-all open:bg-bg-elev/50">
          <summary className="flex cursor-pointer select-none items-center justify-between gap-3 rounded-2xl px-6 py-4 text-sm font-bold text-fg hover:bg-bg-elev/50">
            <span className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="inline-flex h-1.5 w-1.5 rounded-full bg-fg-dim group-open:bg-accent"
              />
              Installation help
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim transition-transform group-open:rotate-180">
              ▾
            </span>
          </summary>

          <div className="space-y-6 border-t border-bg-border/60 px-6 py-6 text-sm leading-relaxed text-fg-muted">
            <HelpRow title="Windows · SmartScreen warning">
              The first time you run the unsigned alpha, Windows will show
              &ldquo;Windows protected your PC.&rdquo; Click <span className="font-mono text-fg">More info</span>{" "}
              → <span className="font-mono text-fg">Run anyway</span>. If
              corporate security blocks the installer entirely, use the{" "}
              <a href={WINDOWS_PORTABLE_URL} className="text-accent hover:underline">
                portable zip
              </a>{" "}
              instead — extract to Downloads, run <span className="font-mono">OASIS AI.exe</span> from the folder.
            </HelpRow>

            <HelpRow title="macOS · Gatekeeper warning">
              Gatekeeper will say &ldquo;Apple cannot verify that OASIS AI is
              free of malware.&rdquo; Right-click the app in Applications,
              choose <span className="font-mono text-fg">Open</span>, then
              click <span className="font-mono text-fg">Open</span> again in
              the dialog. macOS trusts it from then on. Or clear the quarantine
              flag from Terminal:
              <pre className="mt-2 overflow-x-auto rounded-lg border border-bg-border bg-bg-deep/80 px-3 py-2 font-mono text-xs text-accent">
                xattr -d com.apple.quarantine &quot;/Applications/OASIS AI.app&quot;
              </pre>
            </HelpRow>

            <HelpRow title="First launch · runtime bootstrap">
              On first launch the app provisions its own Python runtime in the
              user-data folder. No global install required, no PATH changes.
              If the bootstrap fails (offline / locked-down corporate machine),
              the app surfaces a one-click &ldquo;Install runtime&rdquo; prompt
              that opens the python.org installer for the operator. Either
              path takes &lt;2 minutes.
            </HelpRow>

            <HelpRow title="Verifying the download · SHA-256 checksums">
              <ul className="mt-1.5 space-y-1.5 font-mono text-[11px]">
                {CHECKSUMS.map(([label, hash]) => (
                  <li key={label} className="flex flex-col">
                    <span className="text-fg-dim normal-case">{label}</span>
                    <span className="break-all text-accent">{hash}</span>
                  </li>
                ))}
              </ul>
              <a
                href={CHECKSUM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block text-xs text-accent hover:underline"
              >
                Download SHA256SUMS.txt →
              </a>
            </HelpRow>

            <HelpRow title="Linux · which package">
              <a href={LINUX_APPIMAGE_URL} className="text-accent hover:underline">
                AppImage
              </a>{" "}
              for any distro (chmod +x and run). <a href={LINUX_DEB_URL} className="text-accent hover:underline">
                .deb
              </a>{" "}
              for Debian/Ubuntu. No RPM build yet.
            </HelpRow>
          </div>
        </details>
      </section>

      {/* === Keyframes ============================================ */}
      <style>{`
        @keyframes orbit-soft {
          from { transform: translate(-50%, -50%) rotate(0deg); }
          to { transform: translate(-50%, -50%) rotate(360deg); }
        }
      `}</style>
    </main>
  );
}

function DownloadCard({
  href,
  icon,
  label,
  sub,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  sub: string;
}) {
  return (
    <a
      href={href}
      className="group/card flex flex-col items-center gap-2 rounded-xl border border-bg-border bg-bg-elev/40 px-3 py-4 text-center transition-all hover:border-accent/40 hover:bg-bg-elev/70 hover:shadow-[0_0_28px_-12px_rgba(0,212,255,0.6)]"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent/25 bg-accent/10 text-accent transition-colors group-hover/card:bg-accent/20">
        {icon}
      </div>
      <div className="text-sm font-bold text-fg">{label}</div>
      <div className="text-[10px] uppercase tracking-wider text-fg-dim">{sub}</div>
    </a>
  );
}

function HelpRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-fg">
        {title}
      </div>
      <div className="text-sm text-fg-muted">{children}</div>
    </div>
  );
}
