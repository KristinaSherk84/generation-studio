import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Upload, Check, X, ArrowLeft, RefreshCw, Loader2, Download } from "lucide-react";
import { upload } from "@vercel/blob/client";
import exifr from "exifr";

// A photo the user has picked on the Upload screen. Lives in App-level state
// so the Blob URLs survive navigating forward into Style / Grid / etc.
export type UploadedPhoto = {
  id: string;                        // local unique id, stable across rerenders
  localPreview: string;              // object URL for instant thumbnail
  blobUrl: string | null;            // populated when upload to Blob completes
  status: "uploading" | "done" | "error";
  errorMessage: string | null;
  // EXIF-derived wide-angle flag, read in the browser via `exifr` as soon as
  // the file is picked. True = focal length < 40mm (35mm-equivalent), so the
  // generate-time prompt should include the stronger lens-correction block.
  // Null = EXIF couldn't be read or didn't contain focal length data; we fall
  // back to Block 1's generic "if it appears wide-angle..." language.
  isWideAngle: boolean | null;
  // True when the user uploads a HEIC/HEIF file (iPhone default format).
  // Chrome and Firefox can't render HEIC natively, so the <img> tag shows a
  // broken-image icon. We lay a "Upload successful — preview unavailable"
  // banner on top of that icon so it reads as "worked fine" rather than
  // "broken app." The upload itself + the Gemini generate step both support
  // HEIC — only the client-side preview is blocked.
  isHeic: boolean;
};

// Detects HEIC / HEIF files. Some browsers don't set file.type on HEIC
// (particularly older Safari and some drag-drop paths), so we fall back to
// the filename extension. The returned boolean informs both the preview
// overlay logic and diagnostic messaging.
function detectHeic(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  if (type === "image/heic" || type === "image/heif") return true;
  const name = (file.name || "").toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

// Design tokens — strict grey palette per brief.
// Do not add colors, gradients, or shadows without updating the brief first.
const C = {
  pageBg: "#F5F5F3",
  white: "#FFFFFF",
  dark: "#2C2C2A",
  mediumGrey: "#888780",
  lightGrey: "#D3D1C7",
  border: "#E8E8E6",
  buttonText: "#F1EFE8",
};

const font: CSSProperties = {
  fontFamily: "Inter, system-ui, -apple-system, sans-serif",
};

// -------------------- Shared components --------------------

type NavbarProps = {
  cartCount?: number;
  onLogoClick?: () => void;
};

const Navbar = ({ cartCount = 0, onLogoClick }: NavbarProps) => (
  <div
    style={{
      height: 70,
      background: C.white,
      borderBottom: `1px solid ${C.border}`,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 32px",
      ...font,
    }}
  >
    <div
      onClick={onLogoClick}
      style={{ fontWeight: 500, fontSize: 18, color: C.dark, cursor: "pointer" }}
    >
      Generation Studio
    </div>
    <div style={{ fontSize: 14, color: C.dark, fontWeight: 400 }}>
      Selected ({cartCount})
    </div>
  </div>
);

type PhotogTipProps = {
  children: ReactNode;
  style?: CSSProperties;
};

// Full-screen modal shown the first time the user lands on the Upload screen
// in a session. Shows photographer's fundamentals before they start uploading
// so their source photos lead to better generations. Dismiss closes the modal;
// we track "seen" at the App level so navigating back to Landing and starting
// over will show it again (fresh session mental model).
type PhotographerTipsModalProps = {
  onDismiss: () => void;
};

const PHOTOG_TIPS = [
  {
    title: "Upload your favorite shot first.",
    body: "The AI weights the first photo heaviest when learning your face — lead with your best one.",
  },
  {
    title: "Face a window, not a ceiling.",
    body: "Natural daylight beats overhead lights, which cast shadows under the eyes.",
  },
  {
    title: "No low-res photos.",
    body: "Blurry inputs produce blurry results. Garbage in, garbage out.",
  },
  {
    title: "4–8 varied photos.",
    body: "Different expressions, angles, outfits. Include one close-crop — the AI mirrors your framing.",
  },
  {
    title: "Use the rear camera, not selfie.",
    body: "Selfie cameras are wide-angle and stretch your nose and face. Have a friend take it.",
  },
];

// Tips that cycle on the LoadingScreen while the 6 headshots are generating.
// Pulled from PHOTOG_TIPS so they stay in sync with the pre-upload modal,
// plus two loading-specific tips: the regenerate icon hint (was the only
// thing shown before) and Kristi's "crap in = crap out" reminder. The user
// sees one tip for a few seconds, then it rotates to the next — turns the
// wait from "staring at a spinner" into "learning how to get a better result."
const LOADING_TIPS: { title: string; body: string }[] = [
  {
    title: "Don't love one? Regenerate just that one.",
    body: "Once your grid is ready, tap the refresh icon on any photo to swap only that headshot — no need to restart the batch.",
  },
  {
    title: "Remember — crap in = crap out.",
    body: "Low-resolution photos of your face don't work for realistic generations. The AI can only mirror what it can clearly see.",
  },
  ...PHOTOG_TIPS,
];

const PhotographerTipsModal = ({ onDismiss }: PhotographerTipsModalProps) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Photographer's tips before upload"
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0, 0, 0, 0.85)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      zIndex: 1000,
      ...font,
    }}
  >
    <div
      style={{
        background: C.white,
        borderRadius: 12,
        padding: "48px 40px",
        maxWidth: 640,
        width: "100%",
        maxHeight: "90vh",
        overflowY: "auto",
        boxShadow: "0 20px 60px rgba(0, 0, 0, 0.4)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: 2,
          color: C.mediumGrey,
          textTransform: "uppercase",
          fontWeight: 500,
          marginBottom: 12,
        }}
      >
        Photographer's tips
      </div>
      <h2
        style={{
          fontSize: 28,
          fontWeight: 500,
          color: C.dark,
          margin: "0 0 8px",
          letterSpacing: -0.5,
        }}
      >
        Before you upload
      </h2>
      <p
        style={{
          fontSize: 15,
          color: C.mediumGrey,
          marginTop: 0,
          marginBottom: 32,
          lineHeight: 1.6,
        }}
      >
        A few fundamentals from Kristi — twenty years behind the lens — that'll meaningfully
        improve the photos the AI gives you back.
      </p>

      <ol style={{ paddingLeft: 0, listStyle: "none", margin: 0 }}>
        {PHOTOG_TIPS.map((tip, idx) => (
          <li
            key={idx}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 16,
              marginBottom: 20,
              paddingBottom: 20,
              borderBottom: idx < PHOTOG_TIPS.length - 1 ? `1px solid ${C.border}` : "none",
            }}
          >
            <div
              style={{
                flexShrink: 0,
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: C.dark,
                color: C.white,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              {idx + 1}
            </div>
            <div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 500,
                  color: C.dark,
                  marginBottom: 4,
                }}
              >
                {tip.title}
              </div>
              <div style={{ fontSize: 14, color: C.mediumGrey, lineHeight: 1.6 }}>{tip.body}</div>
            </div>
          </li>
        ))}
      </ol>

      <div style={{ marginTop: 32 }}>
        <Button onClick={onDismiss} full>
          Got it — let's upload
        </Button>
      </div>
    </div>
  </div>
);

const PhotogTip = ({ children, style = {} }: PhotogTipProps) => (
  <div
    style={{
      borderLeft: `3px solid ${C.mediumGrey}`,
      padding: "12px 16px",
      background: C.white,
      color: C.dark,
      fontSize: 13,
      lineHeight: 1.5,
      ...font,
      ...style,
    }}
  >
    <div
      style={{
        fontSize: 11,
        color: C.mediumGrey,
        textTransform: "uppercase",
        letterSpacing: 1,
        marginBottom: 4,
        fontWeight: 500,
      }}
    >
      Photographer's tip
    </div>
    {children}
  </div>
);

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "secondary";
  full?: boolean;
  style?: CSSProperties;
};

const Button = ({
  children,
  onClick,
  disabled,
  variant = "primary",
  full,
  style = {},
}: ButtonProps) => {
  const base: CSSProperties = {
    padding: "14px 28px",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
    border: "none",
    transition: "opacity 0.15s",
    opacity: disabled ? 0.4 : 1,
    width: full ? "100%" : "auto",
    ...font,
    ...style,
  };
  const styles: CSSProperties =
    variant === "primary"
      ? { ...base, background: C.dark, color: C.buttonText }
      : variant === "ghost"
      ? { ...base, background: "transparent", color: C.dark, border: `1px solid ${C.border}` }
      : { ...base, background: C.white, color: C.dark, border: `1px solid ${C.border}` };
  return (
    <button onClick={onClick} disabled={disabled} style={styles}>
      {children}
    </button>
  );
};

// -------------------- Screen 1: Landing --------------------

type LandingProps = {
  onStart: () => void;
  // Fires after the user successfully validates a promo code. Parent marks
  // the paywall as unlocked in sessionStorage and advances to Upload.
  onPromoUnlock: () => void;
};


// -------------------- Screen 1: LandingV2 (Direction 3) --------------------
//
// New landing page (May 2026 redesign) matching the kristinasherk.com brand
// language. Editorial masthead with gold eyebrow, big serif headline, hero
// photo of Kristi with a CYCLING before/after carousel inside the screen
// frame. Forest green is reserved for the primary CTA only. Charcoal trust
// strip below. Replaces the original `Landing` component for routing while
// `Landing` is preserved above as a fallback.

// Brand tokens specific to LandingV2 (do not pollute the C palette which the
// rest of the app uses for the in-product greys).
const BRAND = {
  forestGreen: "#1B4332",
  forestGreenHover: "#143025",
  gold: "#C9A961",
  charcoal: "#2A2A2A",
  white: "#FFFFFF",
  cream: "#FAF8F4",
  bodyText: "#2A2A2A",
  subText: "#6E6E6A",
};

// Serif stack for headlines. Tiempos / Cormorant / Didot are the design
// targets; Georgia is the universally available fallback shipped with V1.
const SERIF_STACK =
  "'Tiempos Headline','Cormorant Garamond','Didot',Georgia,'Times New Roman',serif";

// Sans stack for body + UI.
const SANS_STACK =
  "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif";

// Pre-composited before/after posters (1200x1600 portrait, after as full
// headshot + before as a circular inset in the lower-left labeled "BEFORE").
// All 32 pairs from /Before-After Graphics/ live under public/marketing/gallery/.
// Used by both the hero film strip and the full gallery screen.
const GALLERY_PAIRS: string[] = Array.from({ length: 32 }, (_, i) => {
  const n = String(i + 7).padStart(2, "0"); // pair-07 through pair-38
  return `/marketing/gallery/pair-${n}.jpg`;
});

const STRIP_DURATION_S = 90; // full-loop duration; matches "slow film-reel" pace

// Wordmark: "GenerAItion" with AI emphasized via italic + gold so it survives
// at logo size (per brand notes — hyphenated "Gener-AI-tion" disappears).
const Wordmark = ({ size = 18 }: { size?: number }) => (
  <span
    style={{
      fontFamily: SERIF_STACK,
      fontSize: size,
      letterSpacing: 0.2,
      color: BRAND.charcoal,
      whiteSpace: "nowrap",
    }}
  >
    Gener
    <span style={{ fontStyle: "italic", color: BRAND.gold, fontWeight: 600 }}>
      AI
    </span>
    tion <span style={{ fontWeight: 500 }}>Headshots</span>
  </span>
);

// Pill button. Two variants: "primary" = forest green (CTA), "secondary"
// = transparent w/ gold underline (used for nav links acting as buttons).
type PillProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary";
  size?: "sm" | "md" | "lg" | "xl";
  fullWidth?: boolean;
  disabled?: boolean;
};
const Pill = ({
  children,
  onClick,
  variant = "primary",
  size = "md",
  fullWidth = false,
  disabled = false,
}: PillProps) => {
  const [hover, setHover] = useState(false);
  // 'xl' is 1.6× 'lg' for hero CTAs that need to dominate (per Kristi
  // 2026-05-04 — the standard 'lg' looked underweight under the hero
  // photo). Padding + font-size scaled together so the pill stays
  // proportional, not squished.
  const sz = {
    sm: { px: 16, py: 8, fs: 13 },
    md: { px: 24, py: 12, fs: 14 },
    lg: { px: 32, py: 16, fs: 16 },
    xl: { px: 52, py: 26, fs: 26 },
  }[size];
  const bg =
    variant === "primary"
      ? hover
        ? BRAND.forestGreenHover
        : BRAND.forestGreen
      : "transparent";
  const color = variant === "primary" ? BRAND.white : BRAND.charcoal;
  const border =
    variant === "primary" ? "none" : `1px solid ${BRAND.charcoal}`;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={disabled}
      style={{
        background: bg,
        color,
        border,
        borderRadius: 999,
        padding: `${sz.py}px ${sz.px}px`,
        fontSize: sz.fs,
        fontWeight: 500,
        letterSpacing: variant === "primary" ? 0.6 : 0.2,
        textTransform: variant === "primary" ? "uppercase" : "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        width: fullWidth ? "100%" : "auto",
        fontFamily: SANS_STACK,
        transition: "background 160ms ease, transform 80ms ease",
        transform: hover && !disabled ? "translateY(-1px)" : "translateY(0)",
        boxShadow:
          variant === "primary"
            ? "0 1px 2px rgba(0,0,0,0.08)"
            : "none",
      }}
    >
      {children}
    </button>
  );
};


// Continuously-scrolling horizontal "film strip" of before/after posters.
// Pure CSS animation — no JS interval. The track contains TWO copies of
// GALLERY_PAIRS so the loop is seamless: when the first copy scrolls fully
// out of view, the second copy occupies the visible area and the animation
// jumps back to start (invisible because the second copy is identical).
//
// Hover pauses the strip via the .film-strip-track:hover rule injected by
// LandingV2's <style> tag. Clicking a frame routes to the full gallery.
const HeroFilmStrip = ({ onShowGallery }: { onShowGallery: () => void }) => (
  <div
    style={{
      width: "100%",
      overflow: "hidden",
      maskImage:
        "linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent)",
      WebkitMaskImage:
        "linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent)",
    }}
  >
    <div
      className="film-strip-track"
      style={{
        display: "flex",
        gap: 16,
        width: "max-content",
        animation: `film-strip-scroll ${STRIP_DURATION_S}s linear infinite`,
      }}
    >
      {[...GALLERY_PAIRS, ...GALLERY_PAIRS].map((src, i) => (
        <button
          key={i}
          onClick={onShowGallery}
          aria-label="View full before-and-after gallery"
          style={{
            flex: "0 0 auto",
            width: "clamp(160px, 18vw, 260px)",
            aspectRatio: "3 / 4",
            border: "none",
            padding: 0,
            background: "transparent",
            cursor: "pointer",
            borderRadius: 6,
            overflow: "hidden",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
          }}
        >
          <img
            src={src}
            alt="AI-generated headshot transformation"
            loading="lazy"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        </button>
      ))}
    </div>
  </div>
);

// -------------------- Gallery Screen --------------------
//
// Full-screen gallery of all 32 before/after pairs. Accessible from the
// landing nav ("Examples") and from any film-strip card click. Same brand
// language as LandingV2.
type GalleryScreenProps = {
  onBack: () => void;
  onStart: () => void;
};
const GalleryScreen = ({ onBack, onStart }: GalleryScreenProps) => (
  <div
    style={{
      background: BRAND.white,
      color: BRAND.bodyText,
      fontFamily: SANS_STACK,
      minHeight: "100vh",
    }}
  >
    <nav
      style={{
        height: 76,
        padding: "0 clamp(16px, 4vw, 56px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottom: `1px solid #EFEAE0`,
        background: BRAND.white,
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      <button
        onClick={onBack}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 0,
          fontFamily: SERIF_STACK,
          fontSize: 20,
          color: BRAND.charcoal,
        }}
      >
        Gener
        <span style={{ fontStyle: "italic", color: BRAND.gold, fontWeight: 600 }}>
          AI
        </span>
        tion <span style={{ fontWeight: 500 }}>Headshots</span>
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 14,
            color: BRAND.charcoal,
            borderBottom: `1px solid ${BRAND.gold}`,
            paddingBottom: 2,
            fontFamily: SANS_STACK,
          }}
        >
          ← Back
        </button>
        <Pill onClick={onStart} size="sm">
          Start now
        </Pill>
      </div>
    </nav>

    <section
      style={{
        textAlign: "center",
        padding: "clamp(40px, 6vw, 72px) 24px 32px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 2.4,
          textTransform: "uppercase",
          color: BRAND.gold,
          marginBottom: 20,
        }}
      >
        Real Customer Transformations
      </div>
      <h1
        style={{
          fontFamily: SERIF_STACK,
          fontSize: "clamp(32px, 5vw, 56px)",
          fontWeight: 400,
          lineHeight: 1.1,
          letterSpacing: -0.4,
          color: BRAND.charcoal,
          margin: "0 0 18px",
        }}
      >
        Before & after gallery
      </h1>
      <p
        style={{
          fontSize: "clamp(14px, 1.3vw, 17px)",
          color: BRAND.subText,
          maxWidth: 640,
          margin: "0 auto",
          lineHeight: 1.55,
        }}
      >
        32 transformations from selfie to professional headshot. Each one
        generated by Kristi's photographer-prompted AI. Click any image to
        view full size.
      </p>
    </section>

    <section
      style={{
        padding: "16px clamp(16px, 4vw, 48px) 64px",
        maxWidth: 1400,
        margin: "0 auto",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        {GALLERY_PAIRS.map((src, i) => (
          <a
            key={src}
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "block",
              aspectRatio: "3 / 4",
              borderRadius: 8,
              overflow: "hidden",
              boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
              transition: "transform 200ms ease, box-shadow 200ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-3px)";
              e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,0.18)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.10)";
            }}
          >
            <img
              src={src}
              alt={`Customer transformation ${i + 7}`}
              loading="lazy"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          </a>
        ))}
      </div>
    </section>

    <section
      style={{
        background: BRAND.cream,
        textAlign: "center",
        padding: "clamp(48px, 7vw, 80px) 24px",
      }}
    >
      <h2
        style={{
          fontFamily: SERIF_STACK,
          fontSize: "clamp(26px, 3.6vw, 42px)",
          fontWeight: 400,
          lineHeight: 1.18,
          color: BRAND.charcoal,
          maxWidth: 720,
          margin: "0 auto 28px",
        }}
      >
        Yours could be next.
      </h2>
      <Pill onClick={onStart} size="lg">
        Create my headshots
      </Pill>
      <div
        style={{
          marginTop: 14,
          fontSize: 13,
          color: BRAND.subText,
        }}
      >
        Starts at <strong style={{ color: BRAND.charcoal }}>$2.99</strong> ·
        Money-back guarantee · 5 minutes
      </div>
    </section>
  </div>
);

type LandingV2Props = LandingProps & {
  onShowGallery: () => void;
};

const LandingV2 = ({ onStart, onPromoUnlock, onShowGallery }: LandingV2Props) => {
  // Mobile detection drives the hero photo's aspect-ratio crop. On phones
  // (<= 640px) we use a tighter aspect (1.2 vs desktop's 1.86) so the dark
  // empty space on either side of Kristi gets cropped off and the LinkedIn
  // frames + carousel circles fill the screen instead of being squished
  // into a thin band. The breakpoint matches what other parts of the app
  // already use for the mobile/desktop split.
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 640px)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Keep promo code functionality alive — discreet "have a code?" link at
  // the bottom of the page rather than a prominent input. We don't want to
  // distract from the primary CTA on the new editorial layout.
  const [showPromoInput, setShowPromoInput] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [promoStatus, setPromoStatus] =
    useState<"idle" | "submitting" | "success" | "error">("idle");
  const [promoErrMsg, setPromoErrMsg] = useState("");

  const submitPromo = async () => {
    const trimmed = promoCode.trim();
    if (!trimmed) return;
    setPromoStatus("submitting");
    setPromoErrMsg("");
    try {
      const resp = await fetch("/api/verify-promo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as { valid?: boolean };
      if (data.valid) {
        setPromoStatus("success");
        setTimeout(() => onPromoUnlock(), 700);
      } else {
        setPromoStatus("error");
        setPromoErrMsg("That code isn't recognized.");
      }
    } catch {
      setPromoStatus("error");
      setPromoErrMsg("Something went wrong. Try again in a moment.");
    }
  };

  return (
    <div
      style={{
        background: BRAND.white,
        color: BRAND.bodyText,
        fontFamily: SANS_STACK,
        minHeight: "100vh",
      }}
    >
      {/* Inline keyframes for the film-strip auto-scroll. Two copies of the
          GALLERY_PAIRS array are rendered side-by-side; we translate the
          track left by exactly half its width over STRIP_DURATION_S seconds,
          then the animation restarts from 0 — visually seamless because the
          second copy is byte-identical to the first. */}
      <style>{`
        @keyframes film-strip-scroll {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        .film-strip-track:hover {
          animation-play-state: paused;
        }
        @media (prefers-reduced-motion: reduce) {
          .film-strip-track { animation: none !important; }
        }
      `}</style>
      {/* ========== TOP NAV ========== */}
      <nav
        style={{
          height: 76,
          padding: "0 clamp(16px, 4vw, 56px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid #EFEAE0`,
          background: BRAND.white,
        }}
      >
        <Wordmark size={20} />
        {/* Nav links — kept on desktop for orientation, hidden on mobile
            because they were pushing the wordmark off the screen edge.
            The "Start now" pill that used to live here was removed
            entirely 2026-05-04 — the big "CREATE MY HEADSHOTS" CTA below
            the hero is the primary conversion surface, and a duplicate
            in the nav added clutter without adding value. */}
        {!isMobile && (
          <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
            <a
              href="#how"
              style={{
                fontSize: 14,
                color: BRAND.charcoal,
                textDecoration: "none",
                borderBottom: `1px solid ${BRAND.gold}`,
                paddingBottom: 2,
              }}
            >
              How it works
            </a>
            <button
              onClick={onShowGallery}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: 14,
                color: BRAND.charcoal,
                borderBottom: `1px solid ${BRAND.gold}`,
                paddingBottom: 2,
                fontFamily: SANS_STACK,
                padding: 0,
              }}
            >
              Examples
            </button>
          </div>
        )}
      </nav>

      {/* ========== HERO ========== */}
      <section
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          // Top padding tightened 2026-05-11 to reduce "dead space" between
          // the nav and headline on mobile (Kristi marked this on a phone
          // mockup). Desktop unchanged via the clamp's max.
          padding: isMobile
            ? "12px 20px 16px"
            : "clamp(40px, 7vw, 80px) clamp(20px, 4vw, 56px) 32px",
          textAlign: "center",
        }}
      >
        {/* Big serif headline — font sized down on mobile (was 34px min,
            now 26px min) per Kristi 2026-05-11. Tighter line-height too. */}
        <h1
          style={{
            fontFamily: SERIF_STACK,
            fontSize: isMobile
              ? "clamp(24px, 6.5vw, 32px)"
              : "clamp(34px, 5.5vw, 68px)",
            fontWeight: 400,
            lineHeight: isMobile ? 1.12 : 1.08,
            letterSpacing: -0.4,
            color: BRAND.charcoal,
            margin: isMobile ? "0 auto 14px" : "0 auto 24px",
            maxWidth: 980,
          }}
        >
          A professional headshot generator,{" "}
          <em
            style={{
              fontStyle: "italic",
              fontWeight: 400,
              color: BRAND.charcoal,
            }}
          >
            finally made by a real photographer.
          </em>
        </h1>

        {/* Muted subheadline */}
        <p
          style={{
            fontSize: "clamp(15px, 1.4vw, 18px)",
            lineHeight: 1.55,
            color: BRAND.subText,
            maxWidth: 640,
            margin: isMobile ? "0 auto 24px" : "0 auto 40px",
          }}
        >
          Most AI headshot tools are built by coders. This one is built by an
          actual headshot photographer, so they actually look like you.
        </p>

        {/* Hero photo of Kristi leaning over her camera, transparent
            background (PNG). Swapped in 2026-05-11 — clean cutout, no
            cropping needed. On mobile the max-width is tightened (260px
            vs 640px desktop) so the photo doesn't dominate vertical space
            and leaves room for the filmstrip + CTA above the fold. */}
        <div
          style={{
            position: "relative",
            width: "100%",
            maxWidth: isMobile ? 260 : 640,
            margin: "0 auto",
          }}
        >
          <img
            src="/marketing/hero-kristi-lean.png"
            alt="Kristi Sherk leaning over her camera"
            style={{
              width: "100%",
              height: "auto",
              display: "block",
            }}
          />
        </div>
      </section>

      {/* ========== FILM STRIP (auto-scrolling before/after gallery preview) ========== */}
      {/* Replaces the previous 3-image hardcoded strip (2026-05-11). Pulls
          from the same 32 composited posters used by the /gallery screen.
          Continuously scrolls left-to-right; clicking any frame routes to
          the full gallery. Hover pauses the strip. */}
      <section
        id="examples"
        style={{
          background: BRAND.white,
          padding: isMobile ? "16px 0 8px" : "clamp(48px, 6vw, 80px) 0 16px",
        }}
      >
        <div
          style={{
            maxWidth: 1280,
            margin: "0 auto",
            padding: isMobile
              ? "0 16px 12px"
              : "0 clamp(16px, 4vw, 56px) 24px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: isMobile ? 10 : 12,
              fontWeight: 600,
              letterSpacing: 2.4,
              textTransform: "uppercase",
              color: BRAND.gold,
              marginBottom: isMobile ? 8 : 16,
            }}
          >
            Real Transformations
          </div>
          <h2
            style={{
              fontFamily: SERIF_STACK,
              fontSize: isMobile ? 20 : "clamp(26px, 3.4vw, 40px)",
              fontWeight: 400,
              lineHeight: 1.15,
              color: BRAND.charcoal,
              margin: 0,
            }}
          >
            32 selfies, transformed.
          </h2>
          {!isMobile && (
            <p
              style={{
                fontSize: 14,
                color: BRAND.subText,
                margin: "10px 0 0",
              }}
            >
              Hover to pause · click any image to see the full gallery
            </p>
          )}
        </div>
        <HeroFilmStrip onShowGallery={onShowGallery} />
        <div style={{ textAlign: "center", marginTop: 24 }}>
          <button
            onClick={onShowGallery}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 14,
              fontFamily: SANS_STACK,
              color: BRAND.charcoal,
              borderBottom: `1px solid ${BRAND.gold}`,
              paddingBottom: 2,
            }}
          >
            View all 32 transformations →
          </button>
        </div>
      </section>

      {/* ========== PRIMARY CTA ========== */}
      {/* Moved here 2026-05-11 — was above the filmstrip, now sits below
          it. New flow: see the work first, then the ask. On mobile this
          plus the tightened hero brings the CTA closer to above-the-fold
          territory. On desktop the visual progression (hero → proof → ask)
          is cleaner than the prior hero → ask → proof order. */}
      <section
        style={{
          textAlign: "center",
          padding: isMobile ? "20px 20px 40px" : "32px 20px 64px",
        }}
      >
        <Pill onClick={onStart} size={isMobile ? "lg" : "xl"}>
          Create my headshots
        </Pill>
        <div
          style={{
            marginTop: isMobile ? 12 : 18,
            fontSize: isMobile ? 12 : 13,
            color: BRAND.subText,
            letterSpacing: 0.3,
          }}
        >
          Starts at <strong style={{ color: BRAND.charcoal }}>$2.99</strong> ·
          {isMobile ? " 5 min · Money-back" : " Money-back guarantee · 5 minutes"}
        </div>
      </section>

      {/* ========== TRUST STRIP (charcoal full-bleed) ========== */}
      <section
        style={{
          background: BRAND.charcoal,
          color: BRAND.white,
          padding: "56px clamp(20px, 4vw, 56px)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontFamily: SANS_STACK,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 2.6,
            textTransform: "uppercase",
            color: BRAND.gold,
            marginBottom: 32,
          }}
        >
          Kristina Is Trusted By · Taught 1M+ to Retouch · Featured On
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            alignItems: "center",
            gap: "clamp(20px, 4vw, 56px)",
            opacity: 0.85,
          }}
        >
          {[
            "Microsoft",
            "Marriott",
            "Adobe",
            "Canon",
            "CNET",
            "LinkedIn Learning",
          ].map((brand) => (
            <div
              key={brand}
              style={{
                fontFamily: SERIF_STACK,
                fontSize: "clamp(16px, 1.6vw, 22px)",
                fontWeight: 400,
                letterSpacing: 0.5,
                color: BRAND.white,
              }}
            >
              {brand}
            </div>
          ))}
        </div>
      </section>

      {/* ========== EDITORIAL TAGLINE BAND ========== */}
      <section
        style={{
          textAlign: "center",
          padding: "clamp(56px, 8vw, 100px) 24px",
          background: BRAND.cream,
        }}
      >
        <div
          style={{
            fontFamily: SANS_STACK,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 2.4,
            textTransform: "uppercase",
            color: BRAND.gold,
            marginBottom: 20,
          }}
        >
          The Promise
        </div>
        <h2
          style={{
            fontFamily: SERIF_STACK,
            fontSize: "clamp(28px, 4vw, 48px)",
            fontWeight: 400,
            lineHeight: 1.18,
            letterSpacing: -0.3,
            color: BRAND.charcoal,
            maxWidth: 820,
            margin: "0 auto",
          }}
        >
          Only pay for the headshots that{" "}
          <em style={{ fontStyle: "italic" }}>look like you.</em>
        </h2>
        <p
          style={{
            fontSize: "clamp(15px, 1.3vw, 17px)",
            lineHeight: 1.6,
            color: BRAND.subText,
            maxWidth: 600,
            margin: "28px auto 0",
          }}
        >
          $2.99 to start your session. $9.99 per keeper. No bundles, no surprise
          fees, no charges for headshots that don't look like you.
        </p>
        <div style={{ marginTop: 36 }}>
          <Pill onClick={onStart} size="lg">
            Create my headshots
          </Pill>
        </div>
      </section>

      {/* ========== FOOTER ========== */}
      <footer
        style={{
          padding: "40px 24px 56px",
          textAlign: "center",
          background: BRAND.white,
          borderTop: `1px solid #EFEAE0`,
        }}
      >
        <Wordmark size={16} />
        <div
          style={{
            marginTop: 18,
            fontSize: 12,
            color: BRAND.subText,
            letterSpacing: 0.3,
          }}
        >
          © 2026 GenerAItion Headshots · A Kristina Sherk project
        </div>
        <div
          style={{
            marginTop: 12,
            display: "flex",
            justifyContent: "center",
            gap: 24,
            fontSize: 12,
            color: BRAND.subText,
          }}
        >
          <a href="/privacy" style={{ color: BRAND.subText, textDecoration: "none" }}>
            Privacy
          </a>
          <a href="/terms" style={{ color: BRAND.subText, textDecoration: "none" }}>
            Terms
          </a>
          {!showPromoInput ? (
            <button
              onClick={() => setShowPromoInput(true)}
              style={{
                background: "none",
                border: "none",
                color: BRAND.subText,
                fontSize: 12,
                cursor: "pointer",
                textDecoration: "underline",
                fontFamily: SANS_STACK,
                padding: 0,
              }}
            >
              Have a promo code?
            </button>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                placeholder="Enter code"
                style={{
                  fontSize: 12,
                  padding: "4px 8px",
                  border: `1px solid ${BRAND.subText}`,
                  borderRadius: 4,
                  fontFamily: SANS_STACK,
                  width: 120,
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitPromo();
                }}
              />
              <button
                onClick={submitPromo}
                disabled={promoStatus === "submitting" || !promoCode.trim()}
                style={{
                  fontSize: 12,
                  padding: "4px 10px",
                  background: BRAND.charcoal,
                  color: BRAND.white,
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontFamily: SANS_STACK,
                }}
              >
                {promoStatus === "submitting"
                  ? "..."
                  : promoStatus === "success"
                    ? "✓"
                    : "Apply"}
              </button>
            </div>
          )}
        </div>
        {promoStatus === "error" && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              color: "#B00020",
              fontFamily: SANS_STACK,
            }}
          >
            {promoErrMsg}
          </div>
        )}
      </footer>
    </div>
  );
};

// -------------------- Screen 2: Upload --------------------

type UploadScreenProps = {
  onNext: () => void;
  onBack: () => void;
  photos: UploadedPhoto[];
  setPhotos: React.Dispatch<React.SetStateAction<UploadedPhoto[]>>;
};

// Small helper to generate a stable-ish per-file id without pulling in uuid.
const makePhotoId = () =>
  `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// Wide-angle lens detection threshold, in 35mm-equivalent millimeters.
// Anything shorter than this is "wide" enough to produce visible selfie-style
// distortion at portrait distances. Typical phone selfie cameras report
// 24–28mm in FocalLengthIn35mmFormat, so they all get flagged.
const WIDE_ANGLE_THRESHOLD_MM = 40;

// Best-effort browser EXIF read. Returns:
//   true  — EXIF present AND shows focal length < WIDE_ANGLE_THRESHOLD_MM
//   false — EXIF present AND shows focal length ≥ WIDE_ANGLE_THRESHOLD_MM
//   null  — no EXIF, unreadable EXIF, no focal length field, or a read error.
// The null case lets /api/generate fall back to Block 1's generic wording.
const readWideAngleFromFile = async (file: File): Promise<boolean | null> => {
  try {
    const exif = (await exifr.parse(file, {
      pick: ["FocalLengthIn35mmFormat", "FocalLength"],
    })) as { FocalLengthIn35mmFormat?: number; FocalLength?: number } | undefined;
    if (!exif) return null;
    // Prefer the 35mm-equivalent field — phone cameras report both and the
    // 35mm figure is what "40mm" means in photographic terms.
    if (typeof exif.FocalLengthIn35mmFormat === "number") {
      return exif.FocalLengthIn35mmFormat < WIDE_ANGLE_THRESHOLD_MM;
    }
    // Fallback: raw focal length in mm (actual lens spec, not 35mm-equiv).
    // Phone lenses are physically short — 6–8mm actual — so anything under
    // 20mm actual is almost certainly wide at portrait distances. This is a
    // conservative heuristic; it'll miss some crop-sensor cameras but won't
    // false-positive on true 85mm portrait lenses.
    if (typeof exif.FocalLength === "number") {
      return exif.FocalLength < 20;
    }
    return null;
  } catch {
    // Any parse failure (corrupt EXIF, stripped metadata, unsupported format)
    // → silently null so the generic Block 1 wording handles it.
    return null;
  }
};

const UploadScreen = ({ onNext, onBack, photos, setPhotos }: UploadScreenProps) => {
  // Upload files one at a time to Vercel Blob via our /api/upload endpoint.
  // Each photo flows through three states: uploading → done (with blobUrl) or error.
  const handleNewFiles = (incoming: File[]) => {
    const remainingSlots = 8 - photos.length;
    if (remainingSlots <= 0) return;
    const batch = incoming.slice(0, remainingSlots);

    // Optimistically add placeholders so the thumbnails appear instantly.
    const placeholders: UploadedPhoto[] = batch.map((file) => ({
      id: makePhotoId(),
      localPreview: URL.createObjectURL(file),
      blobUrl: null,
      status: "uploading",
      errorMessage: null,
      isWideAngle: null, // filled in by the EXIF read below once it resolves
      isHeic: detectHeic(file),
    }));
    setPhotos((prev) => [...prev, ...placeholders]);

    // Kick off each upload in parallel and update the matching placeholder.
    // We also fire an EXIF read in parallel so the wide-angle flag is ready
    // by the time the user clicks "Generate 6 headshots" on the Style screen.
    // EXIF reads are local and near-instant; upload is the long pole.
    placeholders.forEach((placeholder, idx) => {
      const file = batch[idx];
      upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/upload",
      })
        .then((result) => {
          setPhotos((prev) =>
            prev.map((p) =>
              p.id === placeholder.id
                ? { ...p, status: "done", blobUrl: result.url }
                : p,
            ),
          );
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : "Upload failed. Try again.";
          setPhotos((prev) =>
            prev.map((p) =>
              p.id === placeholder.id
                ? { ...p, status: "error", errorMessage: message }
                : p,
            ),
          );
        });

      // EXIF read — independent of upload result. Even if the upload fails,
      // the flag isn't load-bearing; the UI doesn't surface it to the user.
      readWideAngleFromFile(file).then((isWideAngle) => {
        setPhotos((prev) =>
          prev.map((p) =>
            p.id === placeholder.id ? { ...p, isWideAngle } : p,
          ),
        );
      });
    });
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    handleNewFiles(Array.from(e.dataTransfer.files));
  };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleNewFiles(Array.from(e.target.files ?? []));
    // Reset the input so picking the same file again still triggers onChange.
    e.target.value = "";
  };
  const removePhoto = (id: string) => {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
  };

  const uploadingCount = photos.filter((p) => p.status === "uploading").length;
  const doneCount = photos.filter((p) => p.status === "done").length;
  const hasError = photos.some((p) => p.status === "error");
  const enoughPhotos = doneCount >= 3;
  const canContinue = enoughPhotos && uploadingCount === 0;

  let ctaLabel: string;
  if (uploadingCount > 0) {
    ctaLabel = `Uploading ${uploadingCount}…`;
  } else if (!enoughPhotos) {
    ctaLabel = `Upload ${3 - doneCount} more to continue`;
  } else {
    ctaLabel = "Continue to style selection";
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "64px 32px", ...font }}>
      <button
        onClick={onBack}
        style={{
          background: "none",
          border: "none",
          color: C.mediumGrey,
          cursor: "pointer",
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 32,
          padding: 0,
          ...font,
        }}
      >
        <ArrowLeft size={14} /> Back
      </button>
      <h2
        style={{
          fontSize: 32,
          fontWeight: 500,
          color: C.dark,
          margin: 0,
          letterSpacing: -0.5,
        }}
      >
        Upload your photos
      </h2>

      <div
        style={{
          marginTop: 20,
          padding: "20px 24px",
          background: C.white,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
        }}
      >
        <div
          style={{
            fontSize: 22,
            fontWeight: 500,
            color: C.dark,
            lineHeight: 1.3,
            letterSpacing: -0.3,
          }}
        >
          Upload a minimum of 3 photos.
        </div>
        <div
          style={{
            fontSize: 22,
            fontWeight: 500,
            color: C.dark,
            lineHeight: 1.3,
            letterSpacing: -0.3,
            marginTop: 8,
          }}
        >
          Crop tightly to your face, head, and torso for best results.
        </div>
      </div>

      <p style={{ fontSize: 15, color: C.mediumGrey, marginTop: 16, lineHeight: 1.6 }}>
        3 to 8 photos works best. Faces clearly visible, varied angles and expressions.
      </p>

      <div
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        style={{
          border: `1.5px dashed ${C.lightGrey}`,
          borderRadius: 8,
          padding: 48,
          textAlign: "center",
          background: C.white,
          marginTop: 32,
          cursor: "pointer",
        }}
        onClick={() => document.getElementById("file-input")?.click()}
      >
        <Upload size={28} color={C.mediumGrey} style={{ marginBottom: 12 }} />
        <div style={{ fontSize: 15, color: C.dark, fontWeight: 500 }}>
          Drop photos here, or click to browse
        </div>
        <div style={{ fontSize: 13, color: C.mediumGrey, marginTop: 6 }}>
          JPG, PNG, or HEIC · {photos.length}/8 added
          {uploadingCount > 0 && ` · ${uploadingCount} uploading`}
        </div>
        <input
          id="file-input"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
          onChange={onPick}
          style={{ display: "none" }}
        />
      </div>

      {photos.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
            marginTop: 24,
          }}
        >
          {photos.map((p) => (
            <div
              key={p.id}
              style={{
                position: "relative",
                aspectRatio: "1",
                borderRadius: 8,
                overflow: "hidden",
                background: C.lightGrey,
              }}
            >
              <img
                src={p.localPreview}
                alt=""
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  opacity: p.status === "done" ? 1 : 0.55,
                }}
              />

              {p.status === "uploading" && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: C.white,
                    fontSize: 12,
                    fontWeight: 500,
                    background: "rgba(44, 44, 42, 0.35)",
                  }}
                >
                  Uploading…
                </div>
              )}

              {p.status === "error" && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    color: C.white,
                    fontSize: 11,
                    fontWeight: 500,
                    textAlign: "center",
                    padding: 8,
                    background: "rgba(44, 44, 42, 0.65)",
                  }}
                  title={p.errorMessage ?? "Upload failed"}
                >
                  Upload failed
                  <div style={{ fontSize: 10, marginTop: 4, opacity: 0.8 }}>
                    Remove & try again
                  </div>
                </div>
              )}

              {/* HEIC overlay — Chrome/Firefox can't render HEIC, so the <img>
                  above shows a broken-image icon. Instead of letting that
                  confuse the user ("is my upload broken?"), we lay a clear
                  "Upload successful — preview unavailable" banner over the top
                  once the blob upload finishes. Only shown on "done" state;
                  while uploading, the generic "Uploading…" overlay already
                  covers it. Bypassed on error state by that overlay's stacking.
                  */}
              {p.isHeic && p.status === "done" && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    color: C.white,
                    fontSize: 11,
                    fontWeight: 500,
                    textAlign: "center",
                    padding: 8,
                    background: "rgba(44, 44, 42, 0.78)",
                    lineHeight: 1.35,
                  }}
                  title="HEIC format previews don't render in this browser, but the upload worked and your headshots will generate correctly."
                >
                  <Check size={18} style={{ marginBottom: 4 }} />
                  Upload successful
                  <div
                    style={{
                      fontSize: 10,
                      marginTop: 2,
                      opacity: 0.85,
                      fontWeight: 400,
                    }}
                  >
                    Preview unavailable (HEIC)
                  </div>
                </div>
              )}

              <button
                onClick={() => removePhoto(p.id)}
                style={{
                  position: "absolute",
                  top: 6,
                  right: 6,
                  background: C.dark,
                  color: C.white,
                  border: "none",
                  borderRadius: "50%",
                  width: 22,
                  height: 22,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {hasError && (
        <div
          style={{
            marginTop: 16,
            fontSize: 13,
            color: C.dark,
            background: C.white,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "10px 14px",
          }}
        >
          One or more photos didn't upload. Remove them with the × and try again.
        </div>
      )}

      <PhotogTip style={{ marginTop: 24 }}>
        Good light beats everything. Face a window, keep shadows off the face, and skip heavy
        filters — the AI reads what's actually there. Varied expressions give the generator room to
        work.
      </PhotogTip>

      <div style={{ marginTop: 32 }}>
        <Button onClick={onNext} disabled={!canContinue} full>
          {ctaLabel}
        </Button>
      </div>
    </div>
  );
};

// -------------------- Screen 3: Style Selection --------------------

// Style chips on the Style screen. 2026-05-01: revamped to 4 styles —
// "creative" renamed to "Creative Natural" (now nature-only backgrounds —
// trees, spring garden, fall colored), and a new "urban" style absorbs
// the old industrial-office background plus a new urban-street option.
// IDs stay short for code (creative/urban); display names are the longer
// "Creative Natural" / "Urban Industrial" form Kristi requested.
// Style chips on the Style screen. 2026-05-01: revamped to 4 styles + new
// per-style swatch visuals (was: solid color squares, now: gradient/vignette
// treatments that evoke the actual look of the generated headshots).
//
// `swatch` is the base color the inline visual layers on top of.
// `visual` keys to a render branch in the StyleScreen — see the JSX below.
const STYLES = [
  { id: "creative", name: "Creative Natural", desc: "Outdoor bokeh", swatch: "#7A8A5C", visual: "creative" as const },
  { id: "corporate", name: "Corporate", desc: "Clean studio", swatch: "#D3D1C7", visual: "corporate" as const },
  { id: "executive", name: "Executive", desc: "Bold, moody", swatch: "#2A2A28", visual: "executive" as const },
  { id: "urban", name: "Urban Industrial", desc: "Modern street", swatch: "#6F614F", visual: "urban" as const },
] as const;

// Colored bokeh orbs for the Creative Natural swatch — designed to evoke the
// 3 nature backgrounds (green trees, pink/cream spring blossoms, gold/orange
// fall foliage) at a glance. Updated 2026-05-01 from white-on-grey to
// nature-color palette so the swatch reads less "abstract dots" and more
// "outdoor garden bokeh."
const CREATIVE_BOKEH = [
  { top: "8%",  left: "12%", size: 36, color: "rgba(180, 200, 130, 0.85)" }, // green
  { top: "18%", left: "62%", size: 48, color: "rgba(245, 210, 220, 0.82)" }, // soft pink (spring)
  { top: "48%", left: "8%",  size: 32, color: "rgba(150, 180, 110, 0.80)" }, // green
  { top: "42%", left: "48%", size: 52, color: "rgba(230, 165, 95, 0.78)" },  // amber/fall
  { top: "68%", left: "72%", size: 40, color: "rgba(200, 220, 150, 0.85)" }, // pale green
  { top: "72%", left: "28%", size: 34, color: "rgba(220, 140, 100, 0.75)" }, // rust/fall
] as const;

const STUDIO_BGS = [
  { id: "white", color: "#FFFFFF", label: "White" },
  { id: "lightgrey", color: "#D3D1C7", label: "Light grey" },
  { id: "midgrey", color: "#888780", label: "Mid grey" },
  { id: "dark", color: "#444441", label: "Dark" },
  { id: "blue", color: "#B5D4F4", label: "Soft blue" },
  { id: "green", color: "#C0DD97", label: "Soft green" },
  // Rainbow generates 6 different backgrounds instead of the same color six
  // times — 3 from the above swatches (light grey, dark, blue) plus 3 new
  // accent colors (warm beige, burgundy, deep teal). Shown as a conic
  // gradient swatch in the UI so it reads as "all of them" at a glance.
  {
    id: "rainbow",
    color:
      "conic-gradient(from 0deg, #D3D1C7, #444441, #B5D4F4, #E8D8C0, #8B4049, #2F5C60, #D3D1C7)",
    label: "Rainbow (all 6 colors)",
  },
] as const;

const ATTIRE = [
  { id: "formal", label: "Business formal" },
  { id: "casual", label: "Business casual" },
  { id: "medical", label: "Healthcare" },
  { id: "keep", label: "Keep my outfit" },
] as const;

const LIGHTING = [
  { id: "studio", label: "Studio clean" },
  { id: "natural", label: "Natural / warm" },
  { id: "dramatic", label: "Dramatic" },
  { id: "golden", label: "Golden hour" },
] as const;

type ChipProps = {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
};

const Chip = ({ selected, onClick, children }: ChipProps) => (
  <div
    onClick={onClick}
    style={{
      padding: "8px 14px",
      borderRadius: 999,
      fontSize: 13,
      border: `1px solid ${selected ? C.dark : C.border}`,
      background: selected ? C.dark : C.white,
      color: selected ? C.buttonText : C.dark,
      cursor: "pointer",
      userSelect: "none",
      transition: "all 0.15s",
      ...font,
    }}
  >
    {children}
  </div>
);

type SectionLabelProps = {
  children: ReactNode;
  style?: CSSProperties;
};

const SectionLabel = ({ children, style = {} }: SectionLabelProps) => (
  <p
    style={{
      fontSize: 11,
      letterSpacing: 1.5,
      color: C.mediumGrey,
      textTransform: "uppercase",
      fontWeight: 500,
      margin: "24px 0 12px",
      ...font,
      ...style,
    }}
  >
    {children}
  </p>
);

// Selections captured on the Style screen. All four are required to generate,
// except `background` — which is only meaningful for Corporate style. Creative
// and Executive get their background direction from the style prompt itself.
export type StyleSelections = {
  style: "corporate" | "creative" | "executive" | "urban";
  attire: "formal" | "casual" | "keep" | "medical";
  lighting: "studio" | "natural" | "dramatic" | "golden";
  background?: "white" | "lightgrey" | "midgrey" | "dark" | "blue" | "green" | "rainbow";
  // Skin treatment toggle (added 2026-04-26, expanded 2026-05-01 to add glam).
  // - "realistic" (default) — current behavior, no extra block.
  // - "polished" — BLOCK_SKIN_POLISHED smooths color inconsistencies while
  //   preserving / re-adding pore texture. Still age-aware on under-eye via
  //   BLOCK_UNDER_EYE.
  // - "glam" — heavy magazine-cover retouching for women who want
  //   minimal-wrinkles editorial finish. Overrides BLOCK_UNDER_EYE entirely
  //   (no age-tiered preservation; smooth full face including under-eye).
  // All three only affect WOMEN; men's skin treatment is unchanged
  // regardless of this setting (each backend block is gender-gated).
  skin?: "realistic" | "polished" | "glam";
};

type StyleScreenProps = {
  onGenerate: (selections: StyleSelections) => void;
  onBack: () => void;
};

const StyleScreen = ({ onGenerate, onBack }: StyleScreenProps) => {
  const [style, setStyle] = useState<string | null>(null);
  const [background, setBackground] = useState<string>("lightgrey");
  const [attire, setAttire] = useState<string | null>(null);
  const [lighting, setLighting] = useState<string | null>(null);
  // Skin treatment defaults to "realistic" (current behavior). "polished"
  // and "glam" apply backend overrides that only fire for women —
  // men's skin treatment is unchanged regardless of this toggle.
  const [skin, setSkin] = useState<"realistic" | "polished" | "glam">(
    "realistic",
  );

  const canGenerate = Boolean(style && attire && lighting);

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 32px", ...font }}>
      <button
        onClick={onBack}
        style={{
          background: "none",
          border: "none",
          color: C.mediumGrey,
          cursor: "pointer",
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 24,
          padding: 0,
          ...font,
        }}
      >
        <ArrowLeft size={14} /> Back
      </button>

      {/* Session banner */}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px",
          background: C.white,
          border: `1px solid ${C.border}`,
          borderRadius: 999,
          fontSize: 12,
          color: C.mediumGrey,
          marginBottom: 24,
        }}
      >
        <Check size={13} color={C.mediumGrey} />
        Session active — 6 headshots at 2K included
      </div>

      <h1
        style={{
          fontSize: 32,
          fontWeight: 500,
          color: C.dark,
          margin: 0,
          letterSpacing: -0.5,
        }}
      >
        What style fits your world?
      </h1>
      <p style={{ fontSize: 15, color: C.mediumGrey, marginTop: 12, lineHeight: 1.6 }}>
        Pick a style, set the scene, and we'll generate 6 varied headshots to choose from.
      </p>

      {/* Style cards — 4-column responsive grid (auto-collapses to 2 cols
          on narrow phones via minmax). Smaller padding/typography than the
          earlier 3-col layout so all 4 fit on one row at desktop widths.
          Each style gets a distinct visual treatment instead of a flat
          color swatch — per-style rendering branches below evoke the actual
          generated-headshot aesthetic at a glance. */}
      <SectionLabel>Style</SectionLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: 10,
        }}
      >
        {STYLES.map((s) => {
          const selected = style === s.id;
          return (
            <div
              key={s.id}
              onClick={() => setStyle(s.id)}
              style={{
                background: C.white,
                borderRadius: 8,
                padding: 8,
                border: `1.5px solid ${selected ? C.dark : C.border}`,
                cursor: "pointer",
                transition: "border-color 0.15s",
              }}
            >
              <div
                style={{
                  aspectRatio: "1",
                  background: s.swatch,
                  borderRadius: 5,
                  position: "relative",
                  overflow: "hidden",
                  marginBottom: 8,
                }}
              >
                {/* Creative Natural — colored bokeh orbs over green base.
                    Greens for trees, pink for spring blossoms, amber/rust
                    for fall foliage. A gradient vignette behind softens
                    the orbs so they read as out-of-focus highlights, not
                    polka dots. */}
                {s.visual === "creative" && (
                  <>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background:
                          "radial-gradient(circle at 50% 45%, rgba(160,180,110,0.35) 0%, rgba(80,100,60,0.55) 100%)",
                      }}
                    />
                    {CREATIVE_BOKEH.map((orb, i) => (
                      <div
                        key={i}
                        style={{
                          position: "absolute",
                          top: orb.top,
                          left: orb.left,
                          width: orb.size,
                          height: orb.size,
                          borderRadius: "50%",
                          background: orb.color,
                          filter: "blur(5px)",
                        }}
                      />
                    ))}
                  </>
                )}

                {/* Corporate — clean studio backdrop. Subtle radial
                    brightening at center + faint vignette at edges, like
                    a real seamless paper photographed with a soft key. */}
                {s.visual === "corporate" && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background:
                        "radial-gradient(circle at 50% 40%, rgba(255,255,255,0.5) 0%, transparent 50%), radial-gradient(circle at 50% 50%, transparent 60%, rgba(0,0,0,0.18) 100%)",
                    }}
                  />
                )}

                {/* Executive — bold dark backdrop with strong vignette and
                    a subtle warm hair-rim-light hint from one side, evoking
                    the moody C-suite aesthetic. */}
                {s.visual === "executive" && (
                  <>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background:
                          "radial-gradient(circle at 50% 45%, rgba(80,80,75,0.4) 0%, rgba(0,0,0,0.6) 80%)",
                      }}
                    />
                    {/* Warm rim suggestion from upper-right */}
                    <div
                      style={{
                        position: "absolute",
                        top: "10%",
                        right: "5%",
                        width: "40%",
                        height: "40%",
                        background:
                          "radial-gradient(circle, rgba(200,160,110,0.18) 0%, transparent 70%)",
                        filter: "blur(6px)",
                      }}
                    />
                  </>
                )}

                {/* Urban Industrial — warm brown base with a vertical
                    gradient suggesting industrial-window light, plus a
                    soft golden-hour wash on one side evoking the street
                    background option. */}
                {s.visual === "urban" && (
                  <>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background:
                          "linear-gradient(180deg, rgba(200,170,130,0.35) 0%, rgba(60,50,40,0.55) 100%)",
                      }}
                    />
                    {/* Warm golden-hour wash from upper left */}
                    <div
                      style={{
                        position: "absolute",
                        top: "8%",
                        left: "8%",
                        width: "55%",
                        height: "55%",
                        background:
                          "radial-gradient(circle, rgba(245,200,140,0.30) 0%, transparent 70%)",
                        filter: "blur(8px)",
                      }}
                    />
                  </>
                )}
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, color: C.dark, lineHeight: 1.25 }}>
                {s.name}
              </div>
              <div style={{ fontSize: 11, color: C.mediumGrey, marginTop: 2 }}>{s.desc}</div>
            </div>
          );
        })}
      </div>

      {/* Creative style info banner */}
      {style === "creative" && (
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            padding: "12px 14px",
            background: C.white,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            marginTop: 16,
          }}
        >
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              border: `1.5px solid ${C.mediumGrey}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              color: C.mediumGrey,
              fontWeight: 500,
              flexShrink: 0,
              marginTop: 2,
            }}
          >
            i
          </div>
          <p style={{ fontSize: 12, color: C.mediumGrey, margin: 0, lineHeight: 1.5 }}>
            Renders with an extremely shallow depth of field — the kind of silky, creamy bokeh you
            get shooting at f/1.4 with a prime lens. Each of your 6 results will have a different
            background.
          </p>
        </div>
      )}

      {/* Corporate style background picker */}
      {style === "corporate" && (
        <>
          <SectionLabel>Background color</SectionLabel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {STUDIO_BGS.map((bg) => (
              <div
                key={bg.id}
                onClick={() => setBackground(bg.id)}
                title={bg.label}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: bg.color,
                  border:
                    background === bg.id
                      ? `2px solid ${C.dark}`
                      : `1px solid ${C.border}`,
                  cursor: "pointer",
                  transition: "border 0.15s",
                }}
              />
            ))}
          </div>
        </>
      )}

      {/* Attire */}
      <SectionLabel>Attire</SectionLabel>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {ATTIRE.map((a) => (
          <Chip key={a.id} selected={attire === a.id} onClick={() => setAttire(a.id)}>
            {a.label}
          </Chip>
        ))}
      </div>

      {/* Lighting */}
      <SectionLabel>Lighting</SectionLabel>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {LIGHTING.map((l) => (
          <Chip key={l.id} selected={lighting === l.id} onClick={() => setLighting(l.id)}>
            {l.label}
          </Chip>
        ))}
      </div>

      {/* Skin (women only — men's treatment unchanged regardless of this
          toggle, but the toggle is shown to everyone since we don't ask for
          gender). Defaults to Realistic = current behavior. Polished applies
          a tone-evening + pore-preserving treatment for women. */}
      <SectionLabel>Skin</SectionLabel>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Chip selected={skin === "realistic"} onClick={() => setSkin("realistic")}>
          Realistic
        </Chip>
        <Chip selected={skin === "polished"} onClick={() => setSkin("polished")}>
          Polished
        </Chip>
        <Chip selected={skin === "glam"} onClick={() => setSkin("glam")}>
          Glam
        </Chip>
      </div>

      {/* Photographer's tip */}
      <PhotogTip style={{ marginTop: 24 }}>
        For the most natural results, choose Creative style with natural lighting. The AI will
        generate 6 varied headshots each with a different organic background. Studio backgrounds
        work best for corporate or executive looks.
      </PhotogTip>

      {/* CTA */}
      <div style={{ marginTop: 24 }}>
        <Button
          onClick={() => {
            if (!canGenerate || !style || !attire || !lighting) return;
            onGenerate({
              style: style as StyleSelections["style"],
              attire: attire as StyleSelections["attire"],
              lighting: lighting as StyleSelections["lighting"],
              // Only pass background for Corporate — for Creative / Executive
              // the style block handles background direction on its own.
              background:
                style === "corporate"
                  ? (background as StyleSelections["background"])
                  : undefined,
              skin,
            });
          }}
          disabled={!canGenerate}
          full
        >
          {!style
            ? "Select a style"
            : !attire
            ? "Choose your attire"
            : !lighting
            ? "Choose your lighting"
            : "Generate 6 headshots"}
        </Button>
      </div>
    </div>
  );
};

// -------------------- Loading screen (while 6 headshots generate) --------------------
//
// Shown after the user clicks "Generate 6 headshots" on the Style screen.
// The parent App fires six parallel POSTs to /api/generate and updates
// `readyCount` + `readyImages` as each one returns. When readyCount === 6
// (or the last pending call resolves even as a failure), the parent
// transitions to the Grid screen.

type LoadingScreenProps = {
  readyCount: number;            // 0–6, increments as each image returns
  readyImages: string[];         // images collected so far, rendered as thumbnails
  totalCount: number;            // always 6 for V1 — passed explicitly so it can change later
  errorMessage: string | null;   // shown if all 6 failed
  onBack: () => void;            // cancel / go back to the style screen
  // Called when the user clicks "Continue with what's ready" — fires only
  // when readyCount >= 5 < totalCount, so the user can advance to the grid
  // while the last call is still in flight. Slot 6 frequently gets queue-
  // placed last by Gemini's Tier 1 burst limiter and adds 60–120s of wait
  // for nothing. The 6th call keeps firing in the background and populates
  // its slot when it returns.
  onContinueWithReady: () => void;
};

const LoadingScreen = ({
  readyCount,
  readyImages,
  totalCount,
  errorMessage,
  onBack,
  onContinueWithReady,
}: LoadingScreenProps) => {
  // The counter message says "Generating headshot N of 6" where N = the
  // image currently being worked on. With parallel requests all 6 are
  // technically in flight at once, but showing (readyCount + 1) mirrors
  // the user's mental model: "how far along am I?"
  const currentlyGenerating = Math.min(readyCount + 1, totalCount);
  const allDone = readyCount >= totalCount;

  // Rotate through LOADING_TIPS while the user waits. ~7 seconds per tip is
  // long enough to read + absorb but short enough that waiting users cycle
  // through 3–5 tips over a typical 2–3 minute generation. Pauses on error
  // and when all 6 are done — at those points the tip is irrelevant.
  const [tipIndex, setTipIndex] = useState(0);
  useEffect(() => {
    if (errorMessage || allDone) return;
    const id = setInterval(() => {
      setTipIndex((i) => (i + 1) % LOADING_TIPS.length);
    }, 7000);
    return () => clearInterval(id);
  }, [errorMessage, allDone]);
  const activeTip = LOADING_TIPS[tipIndex];

  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "80px 32px",
        textAlign: "center",
        ...font,
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px",
          background: C.white,
          border: `1px solid ${C.border}`,
          borderRadius: 999,
          fontSize: 12,
          color: C.mediumGrey,
          marginBottom: 24,
        }}
      >
        {allDone ? (
          <>
            <Check size={13} color={C.mediumGrey} />
            All 6 ready
          </>
        ) : (
          <>
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: "50%",
                border: `2px solid ${C.mediumGrey}`,
                borderTopColor: "transparent",
                animation: "spin 0.8s linear infinite",
              }}
            />
            Working
          </>
        )}
      </div>

      <h1
        style={{
          fontSize: 32,
          fontWeight: 500,
          color: C.dark,
          margin: 0,
          letterSpacing: -0.5,
        }}
      >
        {errorMessage
          ? "Something went wrong"
          : allDone
          ? "All 6 headshots are ready"
          : `Generating headshot ${currentlyGenerating} of ${totalCount}…`}
      </h1>

      <p style={{ fontSize: 15, color: C.mediumGrey, marginTop: 12, lineHeight: 1.6 }}>
        {errorMessage
          ? errorMessage
          : "This will take 2 to 3 minutes. Please don't close this tab — your headshots appear below as they finish."}
      </p>

      {/* Progress count */}
      {!errorMessage && (
        <div
          style={{
            marginTop: 24,
            fontSize: 14,
            color: C.mediumGrey,
          }}
        >
          {readyCount} of {totalCount} ready
        </div>
      )}

      {/* Early-advance button — fires when at least 5 of 6 are ready but the
          last one is still in flight. Slot 6 frequently gets queue-placed
          last by Gemini's Tier 1 burst limiter and can take 60–120s longer
          than the rest, so this lets users move on rather than stare at a
          spinner. The remaining call keeps running in the background and
          populates its slot in the grid when it returns; until then the
          grid renders a spinner on that slot (not the "failed" placeholder). */}
      {!errorMessage && !allDone && readyCount >= totalCount - 1 && (
        <div style={{ marginTop: 24 }}>
          <Button onClick={onContinueWithReady} full>
            Continue with {readyCount} ready →
          </Button>
          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              color: C.mediumGrey,
            }}
          >
            The last one will appear on the next screen as soon as it's done.
          </div>
        </div>
      )}

      {/* Cycling tip carousel — rotates through LOADING_TIPS every ~7s while
          generation is in-flight. Gives the user something useful to read
          during the 2–3 minute wait instead of a static message. Fades on
          error state and after all 6 finish (tips become irrelevant). */}
      {!errorMessage && !allDone && activeTip && (
        <div
          style={{
            marginTop: 24,
            marginLeft: "auto",
            marginRight: "auto",
            maxWidth: 520,
            padding: "16px 20px",
            borderRadius: 8,
            background: C.lightGrey,
            color: C.dark,
            fontSize: 14,
            lineHeight: 1.6,
            textAlign: "center",
            minHeight: 72,
            transition: "opacity 0.3s",
          }}
          key={tipIndex} // forces re-mount on tip change so transition plays
        >
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            {activeTip.title}
          </div>
          <div style={{ color: C.mediumGrey, fontSize: 13 }}>
            {activeTip.body}
          </div>
        </div>
      )}

      {/* Thumbnails appear here as each one finishes */}
      {readyImages.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12,
            marginTop: 32,
          }}
        >
          {Array.from({ length: totalCount }, (_, i) => {
            const src = readyImages[i];
            return (
              <div
                key={i}
                style={{
                  aspectRatio: "4/5",
                  background: C.lightGrey,
                  borderRadius: 8,
                  overflow: "hidden",
                  border: `1px solid ${C.border}`,
                }}
              >
                {src ? (
                  <img
                    src={src}
                    alt={`Headshot ${i + 1}`}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: C.mediumGrey,
                      fontSize: 11,
                    }}
                  >
                    {i + 1}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Back / cancel — only shown after an error so the user isn't stuck */}
      {errorMessage && (
        <div style={{ marginTop: 32 }}>
          <Button onClick={onBack} full>
            Back to style selection
          </Button>
        </div>
      )}

      {/* Spinner keyframes — scoped here so the component is self-contained */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

// -------------------- Screen 4: Pick & Cart --------------------

type GridScreenProps = {
  images: string[]; // base64 data URIs returned from /api/generate, one per card
  // Called when the user clicks "Get my photos" — passes the INDICES of the
  // selected thumbnails so the App can pull the matching base64 images out of
  // the generated-images array and forward them to /api/deliver.
  onDeliver: (selectedIndices: number[]) => void;
  onBack: () => void;
  onRegenerateSlot: (index: number) => void;
  regenCount: number;
  maxRegens: number;
  regeneratingSlots: Set<number>;
  // One-line error banner shown above the grid when a per-slot regen
  // call fails on the server. App owns the state; GridScreen just renders.
  regenError: string | null;
  // Slots from the INITIAL 6-image batch that are still in flight. Set when
  // the user advanced to the grid early via "Continue with what's ready" on
  // the loading screen. Drives a spinner on those slots instead of the
  // "Generation failed" placeholder, and hides the regen button until the
  // call resolves (so users don't burn a regen on a slot that's about to
  // populate naturally).
  initialBatchInFlight: Set<number>;
};

const GridScreen = ({
  images,
  onDeliver,
  onBack,
  onRegenerateSlot,
  regenCount,
  maxRegens,
  regeneratingSlots,
  regenError,
  initialBatchInFlight,
}: GridScreenProps) => {
  const [cart, setCart] = useState<Set<number>>(new Set());
  // Always render 6 slots. If generation returned fewer than 6 (some failed),
  // the missing slots render as empty placeholders — better than blanking the
  // whole grid, and it's clear to the user how many images actually arrived.
  const photos = Array.from({ length: 6 }, (_, i) => i);

  const toggle = (i: number) => {
    const next = new Set(cart);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setCart(next);
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "64px 32px", ...font }}>
      <button
        onClick={onBack}
        style={{
          background: "none",
          border: "none",
          color: C.mediumGrey,
          cursor: "pointer",
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 32,
          padding: 0,
          ...font,
        }}
      >
        <ArrowLeft size={14} /> Back
      </button>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        <div>
          <h2
            style={{
              fontSize: 32,
              fontWeight: 500,
              color: C.dark,
              margin: 0,
              letterSpacing: -0.5,
            }}
          >
            Pick the ones you want
          </h2>
          <p style={{ fontSize: 15, color: C.mediumGrey, marginTop: 12, lineHeight: 1.6 }}>
            Tap your favorites. You'll get the clean, unwatermarked 2K files to download on the next screen.
          </p>
        </div>
        <div style={{ fontSize: 12, color: C.mediumGrey, textAlign: "right" }}>
          Regenerations used: {regenCount} / {maxRegens}
          <div style={{ fontSize: 11, marginTop: 4, color: C.mediumGrey }}>
            Don't love one? Click the refresh icon on any photo.
          </div>
        </div>
      </div>

      {/* Inline error banner — appears when a per-slot regenerate API call
          fails. Budget is automatically refunded by the App handler before
          this renders, so the user can try again immediately. */}
      {regenError && (
        <div
          style={{
            margin: "12px 0",
            padding: "10px 14px",
            background: "#FDECEC",
            border: "1px solid #F5C7C5",
            borderRadius: 8,
            fontSize: 13,
            color: "#7A1F1B",
            lineHeight: 1.5,
          }}
        >
          {regenError}
        </div>
      )}

      {/* Hint above the grid so users discover per-photo regeneration.
          It's a soft one-liner, not a button — the actual affordance lives
          on each tile as the refresh icon. */}
      <div
        style={{
          marginTop: 24,
          padding: "12px 16px",
          borderRadius: 8,
          background: C.lightGrey,
          color: C.dark,
          fontSize: 13,
          lineHeight: 1.6,
          textAlign: "center",
        }}
      >
        <span style={{ fontWeight: 500 }}>Don't love one?</span>{" "}
        Tap the <RefreshCw size={12} style={{ display: "inline", verticalAlign: "middle", marginBottom: 2 }} />{" "}
        icon on any photo to regenerate just that one.
      </div>

      {/* Responsive 3x2 on desktop, 2x3 on mobile. Inline style sets the
          desktop default; the <style> block below overrides to 2 columns
          when the viewport is narrow so each watermarked thumbnail stays
          large enough to see on a phone. The !important is required
          because inline gridTemplateColumns would otherwise win. */}
      <style>{`
        @media (max-width: 600px) {
          .gen-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
      <div
        className="gen-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 16,
          marginTop: 16,
        }}
      >
        {photos.map((i) => {
          const picked = cart.has(i);
          const src = images[i]; // may be undefined if this slot failed to generate
          const regenerating = regeneratingSlots.has(i);
          // True only for slots whose ORIGINAL /api/generate call hasn't come
          // back yet — i.e., the user advanced via "Continue with what's ready"
          // on the loading screen and one (or more) calls are still in flight.
          // We render a spinner on these (not the failed-placeholder) and
          // hide the regen button so the user doesn't burn a regen on a slot
          // that's about to populate naturally.
          const stillLoadingFromInitial = !src && initialBatchInFlight.has(i);
          // Note: deliberately NOT requiring `!!src`. An errored slot (src
          // undefined and NOT in initialBatchInFlight) is exactly the case
          // where the user MOST needs the regen button — that's the slot
          // the initial batch failed on. 2026-05-01 fix. We do still hide
          // the button for slots stillLoadingFromInitial.
          const canRegenThisSlot =
            !regenerating && !stillLoadingFromInitial && regenCount < maxRegens;
          const handleRegenClick = (e: MouseEvent) => {
            e.stopPropagation(); // don't also toggle selection
            if (!canRegenThisSlot) return;
            // If the user had this slot selected, unselect it — the image is
            // about to change so the old pick no longer applies.
            if (picked) {
              const next = new Set(cart);
              next.delete(i);
              setCart(next);
            }
            onRegenerateSlot(i);
          };
          return (
            <div
              key={i}
              onClick={() => src && !regenerating && toggle(i)}
              style={{
                position: "relative",
                aspectRatio: "4/5",
                background: C.lightGrey,
                borderRadius: 8,
                cursor: src && !regenerating ? "pointer" : "default",
                overflow: "hidden",
                border: `2px solid ${picked ? C.dark : "transparent"}`,
                transition: "border-color 0.15s",
              }}
            >
              {src ? (
                <>
                  <img
                    src={src}
                    alt={`Headshot variation ${i + 1}`}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                  {/* Watermark overlay — two diagonal lines of thin text,
                      one at upper-third height and one at lower-third height.
                      Light enough not to drown the image, but placed across
                      the two main focal bands so cropping can't cleanly remove
                      both. Removed after checkout when Step 6 regenerates the
                      unwatermarked 2K files server-side. Future: swap the text
                      for Kristina Sherk's logo mark once one exists. */}
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      pointerEvents: "none",
                      overflow: "hidden",
                    }}
                  >
                    {[33, 67].map((topPercent, row) => (
                      <div
                        key={row}
                        style={{
                          position: "absolute",
                          top: `${topPercent}%`,
                          left: "50%",
                          transform: "translate(-50%, -50%) rotate(-30deg)",
                          fontSize: 11,
                          color: "rgba(255,255,255,0.55)",
                          textShadow: "0 1px 2px rgba(0,0,0,0.4)",
                          letterSpacing: 2,
                          whiteSpace: "nowrap",
                          fontWeight: 400,
                        }}
                      >
                        WATERMARK · WATERMARK · WATERMARK
                      </div>
                    ))}
                  </div>
                </>
              ) : stillLoadingFromInitial ? (
                // The user advanced from the loading screen at 5/6 ready, and
                // this slot's original generate call hasn't returned yet.
                // Show a spinner + "Still generating…" instead of the failed
                // placeholder. When the call resolves, App writes the image
                // into images[i] and removes i from initialBatchInFlight, at
                // which point this branch falls through to the image render.
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    color: C.mediumGrey,
                    fontSize: 12,
                    gap: 10,
                    padding: 16,
                    textAlign: "center",
                    background: C.lightGrey,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 24,
                      height: 24,
                      borderRadius: "50%",
                      border: `2.5px solid ${C.mediumGrey}`,
                      borderTopColor: "transparent",
                      animation: "spin 0.8s linear infinite",
                    }}
                  />
                  Still generating…
                </div>
              ) : (
                // Generation failed for this slot — show a clear, non-clickable
                // placeholder so the user knows which card didn't come back.
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: C.mediumGrey,
                    fontSize: 12,
                    padding: 16,
                    textAlign: "center",
                    background: `repeating-linear-gradient(45deg, ${C.lightGrey}, ${C.lightGrey} 20px, ${C.border} 20px, ${C.border} 40px)`,
                  }}
                >
                  Generation failed. Try regenerating.
                </div>
              )}
              {/* Selection indicator — always shown when there's a photo.
                  Unselected = translucent empty circle (affordance that it CAN
                  be selected). Selected = filled dark circle with checkmark. */}
              {src && (
                <div
                  style={{
                    position: "absolute",
                    top: 10,
                    right: 10,
                    background: picked ? C.dark : "rgba(255, 255, 255, 0.35)",
                    color: C.white,
                    border: picked ? "none" : "1.5px solid rgba(255, 255, 255, 0.9)",
                    boxShadow: picked ? "none" : "0 1px 3px rgba(0,0,0,0.25)",
                    borderRadius: "50%",
                    width: 28,
                    height: 28,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "background 0.15s",
                  }}
                >
                  {picked && <Check size={16} />}
                </div>
              )}
              {/* Per-slot regenerate button — bottom-right corner. Lets users
                  swap just this one photo instead of burning a bulk regeneration
                  on all 6. Hidden when budget is exhausted so there's no
                  confusing disabled state. Also rendered on FAILED slots so
                  users can retry slots that didn't come back on the first
                  pass — previously those slots only showed "Generation
                  failed" with no action affordance. Hidden on slots still
                  in flight from the initial batch so the user doesn't burn
                  a regen on a slot that's about to populate naturally. */}
              {regenCount < maxRegens && !regenerating && !stillLoadingFromInitial && (
                <button
                  onClick={handleRegenClick}
                  title="Regenerate this photo"
                  aria-label="Regenerate this photo"
                  style={{
                    position: "absolute",
                    bottom: 10,
                    right: 10,
                    background: "rgba(255, 255, 255, 0.85)",
                    color: C.dark,
                    border: "none",
                    borderRadius: "50%",
                    width: 32,
                    height: 32,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                    padding: 0,
                    transition: "background 0.15s, transform 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = C.white;
                    e.currentTarget.style.transform = "scale(1.08)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(255, 255, 255, 0.85)";
                    e.currentTarget.style.transform = "scale(1)";
                  }}
                >
                  <RefreshCw size={16} />
                </button>
              )}
              {/* Loading overlay while this specific slot is regenerating.
                  Dims the old image and shows a spinner so the user knows
                  their click was received and this one card is working. */}
              {regenerating && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: "rgba(0, 0, 0, 0.55)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    color: C.white,
                    pointerEvents: "none",
                    zIndex: 5,
                  }}
                >
                  <Loader2
                    size={32}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                  <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>
                    Regenerating…
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <PhotogTip style={{ marginTop: 24 }}>
        Look for the eyes first. If the eyes feel like you, the rest of the frame will usually
        follow.
      </PhotogTip>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 40,
          padding: 24,
          background: C.white,
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 13, color: C.dark, fontWeight: 500 }}>
            {cart.size} selected
          </div>
          <div style={{ fontSize: 11, color: C.mediumGrey, marginTop: 4 }}>
            Enter your email on the next screen, then download your clean 2K files.
          </div>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Button
            onClick={() => onDeliver(Array.from(cart))}
            disabled={cart.size === 0}
          >
            Get my photos
          </Button>
        </div>
      </div>

      {/* Spinner keyframes for the per-slot regeneration loader.
          Scoped here so the grid is self-contained. */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

// -------------------- Screen 5: Deliver --------------------
//
// Beta delivery screen. No Stripe, no email sending. Asks for the user's
// email (for our marketing archive — we'll send a before/after graphic later)
// and posts the selected clean 2K images + the reference photo URLs + their
// style selections to /api/deliver, which:
//   1. Stores the images in Vercel Blob under deliveries/<id>/photo-N.jpg
//   2. Stores a manifest.json next to them recording email, selections, and
//      reference photo URLs
//   3. Returns public Blob URLs we hand to the next screen as download links.
//
// When Stripe gets added post-beta this screen is where that work lands.

type CheckoutScreenProps = {
  // Base64 data URLs of the clean (unwatermarked) 2K images the user picked on
  // the Grid screen. We forward these to /api/deliver verbatim.
  selectedImages: string[];
  // Blob URLs of the reference photos the user uploaded in Step 3. Stored in
  // the delivery manifest so Kristi can build a "before vs. after" graphic
  // from the manifest later.
  referencePhotoUrls: string[];
  // Style selections that produced these images; recorded in the manifest for
  // posterity (and to help diagnose if someone reports bad output).
  selections: StyleSelections;
  // On success: parent navigates to the download screen with the email the
  // user typed + the public Blob URLs for the delivered photos.
  onComplete: (args: {
    email: string;
    photoUrls: string[];
    shareGraphicUrls?: string[];
  }) => void;
  onBack: () => void;
};

// Turn a "data:image/jpeg;base64,AAAA" URL into a real File the browser can
// stream directly to Vercel Blob. Returns null if the data URL is malformed
// — shouldn't happen with our own /api/generate output, but we guard anyway
// so a single bad slot can't silently break the whole delivery.
const dataUrlToFile = (dataUrl: string, filename: string): File | null => {
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!match) return null;
  const [, mime, base64] = match;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], filename, { type: mime });
};

const CheckoutScreen = ({
  selectedImages,
  referencePhotoUrls,
  selections,
  onComplete,
  onBack,
}: CheckoutScreenProps) => {
  // Pre-fill email from Phase 1 Stripe if available. Stripe captured it
  // during the $4.99 entry checkout; the App's verify useEffect stashed it
  // in sessionStorage. Saves the user from re-typing the same address, and
  // the same email gets forwarded into the Phase 2 Stripe Checkout session
  // so Stripe Link auto-recognizes them and one-taps the card.
  const [email, setEmail] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.sessionStorage.getItem("stripe_customer_email") ?? "";
  });
  const [processing, setProcessing] = useState(false);
  // Human-readable progress line shown on the button while we're uploading
  // each image to Blob. Cleared when not in-flight.
  const [progressLabel, setProgressLabel] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const count = selectedImages.length;

  // Same regex as api/deliver.ts. Kept in sync deliberately — client-side
  // check catches typos before we burn a round-trip; server-side check is
  // the real gate.
  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  // --- Phase 2 pricing math, mirrored from /api/create-photo-checkout-session ---
  // Read unlock state from sessionStorage to decide whether this user skips
  // Stripe (promo) or pays (stripe, with $4.99 credit on first checkout).
  // Reading at render time (not state) keeps the UI responsive to changes
  // made in the same tab without extra state plumbing.
  // unlock_source moved from sessionStorage → localStorage 2026-05-04
  // (paired with paywall_unlocked) so a paid customer who lost their tab
  // session can still re-enter the funnel without paying again.
  const unlockSource =
    typeof window !== "undefined"
      ? (() => {
          try {
            return window.localStorage.getItem("unlock_source");
          } catch {
            return null;
          }
        })()
      : null;
  const creditUsed =
    typeof window !== "undefined"
      ? window.sessionStorage.getItem("credit_used") === "true"
      : false;
  const isPromoUnlock = unlockSource === "promo";
  const creditEligible = !isPromoUnlock && !creditUsed;

  const PRICE_PER_PHOTO = 9.99;
  const CREDIT_AMOUNT = 2.99;
  const subtotal = PRICE_PER_PHOTO * count;
  const creditApplied = creditEligible ? CREDIT_AMOUNT : 0;
  const totalOwed = Math.max(0, subtotal - creditApplied);
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  const submit = async () => {
    if (!emailLooksValid || processing) return;
    setProcessing(true);
    setErrorMessage(null);
    try {
      // -----------------------------------------------------------------
      // STEP 1 — Upload each selected base64 image directly to Vercel Blob.
      //
      // We MUST do this client-side, not through /api/deliver. Vercel caps
      // serverless function request payloads at 4.5 MB; two 2K JPEGs encoded
      // as base64 exceed that and the edge returns 413 FUNCTION_PAYLOAD_TOO_
      // LARGE before our function even runs. Uploading directly via the
      // client SDK bypasses the function entirely and goes straight to Blob.
      //
      // Same upload token endpoint (/api/upload) we use for reference
      // photos on the Upload screen.
      //
      // We upload BEFORE the Stripe redirect so the Blob URLs are ready to
      // hand to /api/deliver when the user returns from Stripe. The Stripe
      // redirect navigates the page away, which would clear the base64
      // `selectedImages` prop from React state. Stashing the already-uploaded
      // URLs in sessionStorage lets the return-handler pick up where we
      // left off.
      // -----------------------------------------------------------------
      const uploadedUrls: string[] = [];
      for (let i = 0; i < selectedImages.length; i++) {
        setProgressLabel(`Uploading photo ${i + 1} of ${selectedImages.length}…`);
        const file = dataUrlToFile(selectedImages[i], `headshot-${i + 1}.jpg`);
        if (!file) {
          throw new Error(`Photo ${i + 1} was in an unrecognized format.`);
        }
        const result = await upload(`delivered/${file.name}`, file, {
          access: "public",
          handleUploadUrl: "/api/upload",
        });
        uploadedUrls.push(result.url);
      }

      // -----------------------------------------------------------------
      // STEP 2 — Branch on unlock source.
      //   - Promo user: skip Stripe, call /api/deliver directly (as V1).
      //   - Paid user: stash the delivery payload in sessionStorage and
      //     redirect to Stripe for the per-photo charge. App-level return
      //     handler picks up after Stripe redirects back and calls
      //     /api/deliver from there.
      // -----------------------------------------------------------------
      if (isPromoUnlock) {
        setProgressLabel("Finalizing delivery…");
        const response = await fetch("/api/deliver", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            photoUrls: uploadedUrls,
            referencePhotoUrls,
            style: selections.style,
            attire: selections.attire,
            lighting: selections.lighting,
            background: selections.background,
            skin: selections.skin,
          }),
        });
        if (!response.ok) {
          const err = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(
            err.error || `Delivery failed (HTTP ${response.status})`,
          );
        }
        const data = (await response.json()) as {
          photoUrls: string[];
          shareGraphicUrls?: string[];
        };
        onComplete({
          email,
          photoUrls: data.photoUrls,
          shareGraphicUrls: data.shareGraphicUrls,
        });
        return;
      }

      // Paid path — stash the pending delivery and redirect to Stripe.
      setProgressLabel("Redirecting to secure checkout…");
      const stash = {
        email,
        uploadedUrls,
        referencePhotoUrls,
        selections,
      };
      window.sessionStorage.setItem(
        "pending_delivery",
        JSON.stringify(stash),
      );

      const checkoutResp = await fetch(
        "/api/create-photo-checkout-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            count,
            creditApplied: creditEligible,
            // Forward the email so Stripe pre-fills it on the Checkout page.
            // If Stripe Link has a saved card for this email, Link auto-fills
            // the payment method with one tap — effectively turning the
            // second payment into "click Pay."
            customerEmail: email,
          }),
        },
      );
      if (!checkoutResp.ok) {
        const err = (await checkoutResp.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          err.error || `Checkout setup failed (HTTP ${checkoutResp.status})`,
        );
      }
      const checkoutData = (await checkoutResp.json()) as { url?: string };
      if (!checkoutData.url) {
        throw new Error("Stripe returned no checkout URL");
      }
      // Full-page redirect to Stripe. Don't reset processing state — we're
      // navigating away. On return, App's photo_paid useEffect finishes
      // the delivery and routes to the Success screen.
      window.location.href = checkoutData.url;
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Delivery failed");
      setProcessing(false);
      setProgressLabel("");
    }
  };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "64px 32px", ...font }}>
      <button
        onClick={onBack}
        disabled={processing}
        style={{
          background: "none",
          border: "none",
          color: C.mediumGrey,
          cursor: processing ? "default" : "pointer",
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 32,
          padding: 0,
          opacity: processing ? 0.5 : 1,
          ...font,
        }}
      >
        <ArrowLeft size={14} /> Back
      </button>
      <h2
        style={{
          fontSize: 32,
          fontWeight: 500,
          color: C.dark,
          margin: 0,
          letterSpacing: -0.5,
        }}
      >
        Almost there
      </h2>
      <p style={{ fontSize: 15, color: C.mediumGrey, marginTop: 12, lineHeight: 1.6 }}>
        {count} headshot{count !== 1 ? "s" : ""} ready. Drop your email below and
        we'll take you straight to the download page.
      </p>

      {/* Pricing breakdown — skipped entirely for promo-unlocked users, who
          pay nothing. Paid users see subtotal + optional credit + total owed
          so there's zero surprise when Stripe loads. */}
      {!isPromoUnlock && (
        <div
          style={{
            marginTop: 24,
            background: C.white,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            padding: "14px 16px",
            fontSize: 14,
            color: C.dark,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              color: C.mediumGrey,
              fontSize: 13,
            }}
          >
            <span>
              {count} high-rez headshot{count !== 1 ? "s" : ""} × $9.99
            </span>
            <span>{fmt(subtotal)}</span>
          </div>
          {creditEligible && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                color: C.mediumGrey,
                fontSize: 13,
                marginTop: 6,
              }}
            >
              <span>$2.99 entry credit applied</span>
              <span>−{fmt(creditApplied)}</span>
            </div>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontWeight: 500,
              fontSize: 16,
              marginTop: 10,
              paddingTop: 10,
              borderTop: `1px solid ${C.border}`,
            }}
          >
            <span>Total due</span>
            <span>{fmt(totalOwed)}</span>
          </div>
        </div>
      )}

      <div style={{ marginTop: 32 }}>
        <label style={{ fontSize: 13, color: C.mediumGrey, fontWeight: 500 }}>
          Email
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@email.com"
          disabled={processing}
          style={{
            width: "100%",
            padding: "12px 14px",
            marginTop: 8,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            fontSize: 14,
            background: C.white,
            color: C.dark,
            outline: "none",
            boxSizing: "border-box",
            ...font,
          }}
        />
        <div style={{ fontSize: 12, color: C.mediumGrey, marginTop: 8, lineHeight: 1.5 }}>
          We'll never spam you. Kristi will use this to send you a before/after
          graphic you can share.
        </div>
      </div>

      {errorMessage && (
        <div
          style={{
            marginTop: 20,
            padding: 12,
            background: "#FDECEC",
            border: "1px solid #F5C7C5",
            borderRadius: 8,
            fontSize: 13,
            color: "#7A1F1B",
            lineHeight: 1.5,
          }}
        >
          {errorMessage}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <Button onClick={submit} disabled={!emailLooksValid || processing} full>
          {processing
            ? progressLabel || "Preparing your download…"
            : isPromoUnlock
              ? "Take me to my photos"
              : `Pay ${fmt(totalOwed)} → unlock downloads`}
        </Button>
      </div>
    </div>
  );
};

// -------------------- Download screen --------------------
//
// Final screen of the beta flow. Renders one download button per delivered
// photo URL. Buttons visually track "already downloaded" state via a Set of
// indices — when a user clicks a download button, its index is added to the
// set and the button transitions to a muted background + green checkmark +
// "Downloaded" label. The button stays clickable so the user can re-download
// if they need to.
//
// State is session-only (no persistence). A page reload loses it, which is
// fine — if the user comes back, the email they got has the links anyway
// (once we turn on email delivery post-beta). During beta we tell them
// clearly that these links are their delivery; save the files locally.

type DownloadScreenProps = {
  email: string;
  photoUrls: string[];
  // "Generate a different Style" — takes the user back to the Style screen
  // with their reference photos preserved (no re-upload required).
  onNewStyle: () => void;
  onHome: () => void;
  // Inputs for the post-purchase cross-style bonus block. When all present,
  // DownloadScreen fires 2 extra /api/generate calls on mount (one per style
  // the user did NOT pick) and renders them as 2 additional download cards.
  // Optional so the component still renders if called from a code path that
  // doesn't have these (e.g. a future preview screen).
  chosenStyle?: StyleSelections["style"];
  referencePhotoUrls?: string[];
  hasWideAngle?: boolean;
  attire?: StyleSelections["attire"];
  lighting?: StyleSelections["lighting"];
};

// localStorage key for the "Don't show again" preference on the download
// instructions modal. Kept here (not inlined) so search can find it if we
// ever need to reset the preference.
const DOWNLOAD_INSTRUCTIONS_SUPPRESS_KEY = "gs_download_instructions_suppressed";

// Detect mobile (iOS + Android) via user-agent. Not perfect, but good enough:
// desktop browsers never advertise iPhone/iPad/iPod/Android strings, so any
// false positive lands on the mobile path which opens the image in a new tab
// — a path that works fine on desktop too, it just loses the auto-download
// nicety. False negatives would send a touch device down the desktop path;
// right-click-save fallback still works with long-press there.
const isMobileDevice = (): boolean => {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
};

// Safely read the "suppress instructions" preference. Wrapped because
// localStorage can throw in private browsing / strict environments.
const readSuppressed = (): boolean => {
  try {
    return localStorage.getItem(DOWNLOAD_INSTRUCTIONS_SUPPRESS_KEY) === "1";
  } catch {
    return false;
  }
};

const DownloadScreen = ({
  email,
  photoUrls,
  onNewStyle,
  onHome,
  chosenStyle,
  referencePhotoUrls,
  hasWideAngle,
  attire,
  lighting,
}: DownloadScreenProps) => {
  const [downloaded, setDownloaded] = useState<Set<number>>(new Set());
  // In-app full-screen photo viewer — shown on MOBILE when the customer
  // taps Download. Replaces the prior "open the raw blob URL in a new
  // tab" behavior, which left the customer stranded on a bare image with
  // no obvious way back to download the rest. The overlay shows the
  // photo (long-pressable for "Add to Photos") and a prominent "Back"
  // button right beneath it. Desktop is unchanged — keeps the auto-
  // download fetch+blob flow because that's friction-free on a real
  // file system.
  const [viewingPhoto, setViewingPhoto] = useState<{
    url: string;
    indexLabel: string; // e.g. "1 of 4" — shown in the back button
  } | null>(null);
  // Track which tile currently has a download in-flight so we can show a
  // tiny "Preparing…" state on its button. Separate from `downloaded` so a
  // user re-downloading doesn't lose their completed ✓ state.
  const [inFlight, setInFlight] = useState<Set<number>>(new Set());
  // Show the instructions modal automatically on every mount — UNLESS the
  // user has previously ticked "Don't show again" (persisted in localStorage
  // so it survives page reloads and future sessions).
  const [showInstructions, setShowInstructions] = useState(() => !readSuppressed());
  // Local "Don't show again" checkbox state. Written to localStorage only
  // when the user dismisses with it ticked — so they can uncheck before
  // closing if they change their mind.
  const [suppressNext, setSuppressNext] = useState(false);

  // Dismiss the modal and, if the user ticked the checkbox, persist their
  // preference so future visits skip the modal.
  const dismissInstructions = () => {
    if (suppressNext) {
      try {
        localStorage.setItem(DOWNLOAD_INSTRUCTIONS_SUPPRESS_KEY, "1");
      } catch {
        // Private browsing or storage blocked — silently ignore; the modal
        // just won't be suppressed next time, which is acceptable.
      }
    }
    setShowInstructions(false);
  };

  // Kill body scroll while the instructions modal is up so the background
  // doesn't fight the overlay on mobile.
  useEffect(() => {
    if (showInstructions) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [showInstructions]);

  // Two totally different download strategies depending on device:
  //
  // MOBILE (iPhone / iPad / Android)
  //   Just open the image URL in a new tab. Safari/Chrome render the JPEG
  //   inline, and the user long-presses → "Save to Photos" (iOS) or "Save
  //   image" (Android) which drops the file STRAIGHT into the camera roll /
  //   gallery. This is the flow real users expect.
  //
  //   What we do NOT do on mobile: fetch-and-blob with the download attribute.
  //   Why: iOS Safari honors the download attribute too aggressively and
  //   triggers its native "Download headshot-1.jpg" file-save prompt, which
  //   drops the file into iCloud Drive's Files → Downloads folder. Users
  //   have no idea how to move it from Files into Photos. We got a real
  //   report of this from a beta user on 2026-04-20.
  //
  // DESKTOP (everything else)
  //   Vercel Blob is cross-origin from our app domain, so a bare
  //   <a href={url} download> is ignored — desktop browsers just preview the
  //   image inline and the user has to right-click-save. Fix: fetch the
  //   bytes into JS, wrap them in a same-origin Object URL, and trigger the
  //   download from THAT. Same-origin means the download attribute is honored,
  //   so the file actually saves to the Downloads folder in one click.
  const handleDownload = async (url: string, index: number) => {
    if (inFlight.has(index)) return;

    // --- Mobile path: open the IN-APP photo viewer, not a new tab ---
    //
    // Previously this opened the raw blob URL in a new tab, which left
    // the customer stranded on a bare image with no obvious way back to
    // the rest of their photos. Now we render the photo in an in-app
    // fullscreen overlay with a prominent "Back" button beneath it
    // (per Kristi's review, 2026-05-04). Long-press save-to-Photos
    // still works because the overlay renders the image as a normal
    // <img> tag — Safari's long-press menu is content-source agnostic.
    if (isMobileDevice()) {
      // Indices for SHARE images are stored at +1000 — strip that for a
      // user-facing label. Photo indices are 0-based; show 1-based.
      const isShareImage = index >= 1000;
      const realIndex = isShareImage ? index - 1000 : index;
      const total = photoUrls.length;
      const indexLabel = isShareImage
        ? `Share image ${realIndex + 1}`
        : `Photo ${realIndex + 1} of ${total}`;
      setViewingPhoto({ url, indexLabel });
      // Mark as "handled" so the button flips to the Downloaded ✓ state.
      // This reflects "you've tapped this one" rather than "the file is
      // definitively on your device" — we can't know the latter on mobile.
      setDownloaded((prev) => {
        const next = new Set(prev);
        next.add(index);
        return next;
      });
      return;
    }

    // --- Desktop path: fetch-and-blob to force the save ---
    setInFlight((prev) => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const extMatch = url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `headshot-${index + 1}.${ext}`;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      // Give the browser a beat to kick off the save before we reclaim
      // the memory. 1s is plenty for even large JPEGs.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setDownloaded((prev) => {
        const next = new Set(prev);
        next.add(index);
        return next;
      });
    } catch {
      // Last-ditch fallback: open the raw URL in a new tab so the user can
      // right-click-save. Not pretty, but beats a silent failure.
      window.open(url, "_blank", "noopener");
    } finally {
      setInFlight((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };

  // ------------------------------------------------------------------
  // CROSS-STYLE BONUS GENERATIONS
  //
  // After a purchase, we give the user 2 free single headshots rendered
  // in the two styles they DIDN'T pick. So if they bought Executive, we
  // generate 1 Corporate + 1 Creative preview. Fires on DownloadScreen
  // mount using the same reference photos + attire/lighting they chose,
  // and renders as 2 additional download cards below the main grid.
  //
  // Cost: 2 extra Gemini calls per successful purchase. Ok during the
  // last 24h of free beta; once Stripe is in we'll want to confirm these
  // only fire post-payment (they already do, since DownloadScreen only
  // renders from the "success" screen state after CheckoutScreen
  // completes).
  // ------------------------------------------------------------------

  // Which two styles are "other" relative to the one the user chose. We
  // randomly pick ONE of them to preview below (alternates per page load)
  // so the bonus row is a single human teaser + a pet example card.
  const OTHER_STYLES: StyleSelections["style"][] = chosenStyle
    ? (["corporate", "creative", "executive", "urban"] as const).filter(
        (s): s is StyleSelections["style"] => s !== chosenStyle,
      )
    : [];

  type BonusSlot = {
    style: StyleSelections["style"];
    image: string | null; // data URL from /api/generate, or null while pending/errored
    loading: boolean;
    error: string | null;
  };
  const [bonus, setBonus] = useState<BonusSlot[]>(() => {
    if (OTHER_STYLES.length === 0) return [];
    const pick = OTHER_STYLES[Math.floor(Math.random() * OTHER_STYLES.length)];
    return [{ style: pick, image: null, loading: false, error: null }];
  });
  // Guard against React 19 StrictMode double-invocation firing the bonus API
  // call twice in development. Survives strict-mode's simulated remount because
  // useRef state persists across effect re-runs of the same instance.
  const bonusFired = useRef(false);

  useEffect(() => {
    if (bonusFired.current) return;
    // Need enough inputs to actually generate. If any are missing (e.g. a
    // direct navigation to /success that skipped checkout), just silently
    // omit the bonus section.
    if (
      !chosenStyle ||
      !referencePhotoUrls ||
      referencePhotoUrls.length === 0 ||
      !attire ||
      !lighting ||
      bonus.length === 0
    ) {
      return;
    }
    bonusFired.current = true;

    const idx = 0;
    const bonusStyle = bonus[idx].style;
    // Mark the slot as loading up front so the UI shows a spinner while the
    // request is in flight.
    setBonus((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], loading: true, error: null };
      return next;
    });

    fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        photoUrls: referencePhotoUrls,
        style: bonusStyle,
        attire,
        lighting,
        // Corporate needs a background; Creative/Executive pull their
        // background direction from the style prompt itself. Default to
        // lightgrey for a safe, clean look that flatters any skin tone.
        background: bonusStyle === "corporate" ? "lightgrey" : undefined,
        // variationIndex 0 = Duchenne-eye-smile, slight left lean. Best
        // single-frame flavor to show off the bonus style.
        variationIndex: 0,
        hasWideAngle: hasWideAngle ?? false,
      }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const err = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error || `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ image: string }>;
      })
      .then((data) => {
        setBonus((prev) => {
          const next = [...prev];
          next[idx] = { ...next[idx], loading: false, image: data.image, error: null };
          return next;
        });
      })
      .catch((e: unknown) => {
        setBonus((prev) => {
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            loading: false,
            error: e instanceof Error ? e.message : "Generation failed",
          };
          return next;
        });
      });
    // Mount-only: DownloadScreen is rendered once per delivery and unmounted
    // when the user navigates away, so a deps array here would add noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pretty label for each style used in the bonus section headings.
  const STYLE_LABEL: Record<StyleSelections["style"], string> = {
    corporate: "Corporate",
    creative: "Creative Natural",
    urban: "Urban Industrial",
    executive: "Executive",
  };

  return (
    <>
    {/* In-app fullscreen photo viewer for the mobile download flow. Replaces
        the previous "open the blob URL in a new tab" path so the customer
        always has a clear way back to the rest of their downloads. The
        photo is a regular <img> so iOS Safari's long-press → "Add to
        Photos" still works. The big forest-green back button below the
        photo is the user's escape hatch — placed directly under the photo
        per Kristi's spec. */}
    {viewingPhoto && (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#FFFFFF",
          zIndex: 9999,
          overflow: "auto",
          padding: "24px 16px 48px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          ...font,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "#666",
            letterSpacing: 1,
            textTransform: "uppercase",
            marginBottom: 12,
          }}
        >
          {viewingPhoto.indexLabel}
        </div>
        <img
          src={viewingPhoto.url}
          alt={viewingPhoto.indexLabel}
          style={{
            maxWidth: "100%",
            maxHeight: "70vh",
            height: "auto",
            display: "block",
            borderRadius: 6,
            boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
          }}
        />
        <div
          style={{
            fontSize: 13,
            color: "#666",
            marginTop: 14,
            textAlign: "center",
            lineHeight: 1.5,
            maxWidth: 360,
          }}
        >
          Long-press the photo above and tap <strong>Add to Photos</strong> to
          save it to your camera roll.
        </div>
        <button
          onClick={() => setViewingPhoto(null)}
          style={{
            marginTop: 28,
            background: "#1B4332",
            color: "#FFFFFF",
            border: "none",
            borderRadius: 999,
            padding: "16px 28px",
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: 0.4,
            cursor: "pointer",
            maxWidth: 480,
            width: "100%",
            ...font,
          }}
        >
          ← Back to download my other photos
        </button>
      </div>
    )}
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "24px 32px 48px",
        ...font,
      }}
    >
      {/* Inline header — download icon on either side of the title. Replaces
          the earlier stacked "big circle icon above heading" layout which
          pushed the download thumbnails below the fold on most mobile
          screens. Icons are decorative here; the real download buttons live
          per-tile in the grid below. */}
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
          }}
        >
          <Download size={22} color={C.dark} strokeWidth={1.6} />
          <h2
            style={{
              fontSize: 26,
              fontWeight: 500,
              color: C.dark,
              margin: 0,
              letterSpacing: -0.5,
              lineHeight: 1.2,
            }}
          >
            Your headshots are ready
          </h2>
          <Download size={22} color={C.dark} strokeWidth={1.6} />
        </div>
        <p
          style={{
            fontSize: 14,
            color: C.mediumGrey,
            marginTop: 10,
            lineHeight: 1.55,
            maxWidth: 520,
            marginLeft: "auto",
            marginRight: "auto",
          }}
        >
          We've saved a copy tied to <span style={{ color: C.dark }}>{email}</span>.
          Download each file to your device now — this page is the delivery,
          so don't close it until you have them all saved.
        </p>
      </div>

      {/* Download list — horizontal "mini rows," one row per delivered photo.
          Each row: small thumbnail on the LEFT (visual confirmation that the
          customer is downloading the right file) + wide download button on
          the RIGHT (color-shifts green-tinted when downloaded).
          Replaced 2026-05-04 from a 2-col tile grid that was much taller —
          on mobile, the old grid pushed the cross-style "See what else you
          can do" bonus block well below the fold, hurting discoverability.
          Mini rows save ~140px of vertical real estate on mobile so the
          bonus block now lands above the fold. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginTop: 24,
          maxWidth: 480,
          marginLeft: "auto",
          marginRight: "auto",
        }}
      >
        {photoUrls.map((url, i) => {
          const isDownloaded = downloaded.has(i);
          const isLoading = inFlight.has(i);
          return (
            <div
              key={i}
              style={{
                background: C.white,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                overflow: "hidden",
                display: "flex",
                flexDirection: "row",
                alignItems: "stretch",
                minHeight: 90,
              }}
            >
              {/* Thumbnail — fixed 72px width, full row height. Tapping it
                  triggers download (same as the button), which on mobile
                  opens the image in a new tab so native long-press save-to-
                  Photos works. Role=button + keyboard handlers keep it
                  accessible. */}
              <div
                role="button"
                tabIndex={isLoading ? -1 : 0}
                onClick={() => {
                  if (!isLoading) handleDownload(url, i);
                }}
                onKeyDown={(e) => {
                  if (isLoading) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleDownload(url, i);
                  }
                }}
                aria-label={`Download headshot ${i + 1}`}
                style={{
                  flex: "0 0 72px",
                  background: C.lightGrey,
                  overflow: "hidden",
                  cursor: isLoading ? "default" : "pointer",
                  position: "relative",
                }}
              >
                <img
                  src={url}
                  alt={`Headshot ${i + 1}`}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              </div>
              {/* Download button — fills the rest of the row. Color shift is
                  the primary "you got this one" signal: dark slab → soft
                  green-tinted slab with green check + "Downloaded." */}
              <button
                onClick={() => handleDownload(url, i)}
                disabled={isLoading}
                style={{
                  flex: "1 1 auto",
                  border: "none",
                  padding: "12px 16px",
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: isLoading ? "default" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  background: isDownloaded ? "#dde7d8" : C.dark,
                  color: isDownloaded ? "#2F7A3E" : C.buttonText,
                  transition: "background 0.2s, color 0.2s",
                  ...font,
                }}
              >
                {isLoading ? (
                  <>
                    <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
                    <span>Preparing…</span>
                  </>
                ) : isDownloaded ? (
                  <>
                    <Check size={16} color="#2F7A3E" />
                    <span>Downloaded</span>
                  </>
                ) : (
                  <>
                    <Download size={16} />
                    <span>Download photo {i + 1}</span>
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Spinner keyframes so the in-flight button can use the same rotation
          animation as other loaders across the app. */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* Heartstrings note + share-graphic downloads were here previously.
          Both moved to an automated customer email at /api/deliver on
          2026-05-04 (sendCustomerDeliveryEmail). Reasons:
            1. Download screen was getting visually crowded; the
               'Regenerate a different style' CTA below was getting lost.
            2. Email is the natural channel for the relationship-building
               'please share' ask — customers can return to those graphics
               later from their inbox without re-flowing the whole funnel.
          The share-graphic generation pipeline still runs server-side,
          so every customer's email contains those URLs. */}

      {/* Cross-style bonus: two single headshots rendered in the styles the
          user didn't pick. Each has its own loading / ready / error state and
          its own download button with Downloaded ✓ confirmation. Only shown
          if we actually have the inputs needed to fire the requests. */}
      {bonus.length > 0 && chosenStyle && (
        <div style={{ marginTop: 48 }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div
              style={{
                fontSize: 11,
                letterSpacing: 2,
                color: C.mediumGrey,
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Bonus
            </div>
            <h3
              style={{
                fontSize: 20,
                fontWeight: 500,
                color: C.dark,
                margin: 0,
                letterSpacing: -0.2,
              }}
            >
              See what else you can do
            </h3>
            <p
              style={{
                fontSize: 13,
                color: C.mediumGrey,
                marginTop: 8,
                lineHeight: 1.6,
                maxWidth: 480,
                marginLeft: "auto",
                marginRight: "auto",
              }}
            >
              You picked{" "}
              <span style={{ color: C.dark, fontWeight: 500 }}>
                {STYLE_LABEL[chosenStyle]}
              </span>
              . Here's a watermarked preview of your photos in another style —
              and a reminder that this works for pets too.
            </p>
          </div>

          {/* Two equal-weight CTAs side-by-side: bonus preview (click =
              regenerate in a different style) and pet card (click = restart
              with pet photos). Grid keeps them paired on every viewport —
              cards shrink together on mobile instead of stacking. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 16,
              maxWidth: 520,
              margin: "0 auto",
            }}
          >
            {bonus.map((slot) => {
              return (
                <button
                  type="button"
                  key={slot.style}
                  onClick={onNewStyle}
                  style={{
                    background: C.white,
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                    padding: 0,
                    cursor: "pointer",
                    textAlign: "left",
                    ...font,
                  }}
                >
                  <div
                    style={{
                      aspectRatio: "4/5",
                      background: C.dark,
                      overflow: "hidden",
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {slot.image ? (
                      <>
                        <img
                          src={slot.image}
                          alt={`${STYLE_LABEL[slot.style]} bonus headshot — watermarked preview`}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                            display: "block",
                            userSelect: "none",
                            pointerEvents: "none",
                          }}
                          draggable={false}
                          onContextMenu={(e) => e.preventDefault()}
                        />
                        {/* Diagonal repeating "PREVIEW" watermark. Rendered as
                            an SVG background-image pattern so the watermark
                            appears even on any screenshot the user takes. */}
                        <div
                          aria-hidden
                          style={{
                            position: "absolute",
                            inset: 0,
                            pointerEvents: "none",
                            backgroundImage:
                              "url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='110'%3E%3Ctext x='90' y='65' font-family='Arial, sans-serif' font-size='18' font-weight='700' fill='rgba(255,255,255,0.55)' stroke='rgba(0,0,0,0.25)' stroke-width='0.6' text-anchor='middle' letter-spacing='3' transform='rotate(-28 90 65)'%3EPREVIEW%3C/text%3E%3C/svg%3E\")",
                            backgroundRepeat: "repeat",
                          }}
                        />
                      </>
                    ) : slot.loading ? (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 10,
                          color: C.buttonText,
                          fontSize: 12,
                        }}
                      >
                        <Loader2 size={22} style={{ animation: "spin 1s linear infinite" }} />
                        <span>Generating {STYLE_LABEL[slot.style]}…</span>
                      </div>
                    ) : slot.error ? (
                      <div
                        style={{
                          padding: 16,
                          textAlign: "center",
                          color: C.buttonText,
                          fontSize: 12,
                          lineHeight: 1.5,
                        }}
                      >
                        Couldn't generate the {STYLE_LABEL[slot.style]} version. Your paid
                        headshots above are unaffected.
                      </div>
                    ) : null}
                    {/* Style badge in the top-left corner so users can tell at a
                        glance which style this card represents. */}
                    <div
                      style={{
                        position: "absolute",
                        top: 10,
                        left: 10,
                        background: "rgba(44, 44, 42, 0.82)",
                        color: C.white,
                        fontSize: 11,
                        fontWeight: 500,
                        letterSpacing: 0.5,
                        padding: "4px 10px",
                        borderRadius: 999,
                        textTransform: "uppercase",
                      }}
                    >
                      {STYLE_LABEL[slot.style]}
                    </div>
                  </div>
                  {/* Dark footer mirrors the pet card's footer so the two
                      cards read as equal-weight CTAs. Clicking anywhere on
                      the card fires onNewStyle (back to the Style screen
                      with reference photos preserved). */}
                  <div
                    style={{
                      padding: "12px 14px",
                      background: C.dark,
                      color: C.buttonText,
                      fontSize: 13,
                      fontWeight: 500,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                    }}
                  >
                    <RefreshCw size={16} />
                    <span>Regenerate in a different style</span>
                  </div>
                </button>
              );
            })}

            {/* Pet card — static example + CTA. Clicking anywhere on the card
                resets the flow back to Landing so the user can upload their
                pet and run a fresh set. */}
            <button
              type="button"
              onClick={onHome}
              style={{
                background: C.white,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                padding: 0,
                cursor: "pointer",
                textAlign: "left",
                ...font,
              }}
            >
              <div
                style={{
                  aspectRatio: "4/5",
                  background: C.lightGrey,
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <img
                  src="/ai-headshot-generator-pet-example.jpg"
                  alt="AI headshot generator example — dog in a suit and tie"
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    display: "block",
                  }}
                  draggable={false}
                />
                {/* PETS badge top-left to match the style badge on the sibling
                    human-preview card. */}
                <div
                  style={{
                    position: "absolute",
                    top: 10,
                    left: 10,
                    background: "rgba(44, 44, 42, 0.82)",
                    color: C.white,
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: 0.5,
                    padding: "4px 10px",
                    borderRadius: 999,
                    textTransform: "uppercase",
                  }}
                >
                  Pets
                </div>
              </div>
              <div
                style={{
                  padding: "12px 14px",
                  background: C.dark,
                  color: C.buttonText,
                  fontSize: 13,
                  fontWeight: 500,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <Upload size={16} />
                <span>Upload your pet</span>
              </div>
            </button>
          </div>

          {/* No tagline or standalone button here anymore — both cards are
              self-explanatory via their own footer CTAs ("Regenerate in a
              different style" / "Upload your pet"). */}
        </div>
      )}

      <div
        style={{
          background: C.white,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          padding: 24,
          marginTop: 32,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 500, color: C.dark, marginBottom: 8 }}>
          Want a full new set in a different style?
        </div>
        <div style={{ fontSize: 13, color: C.mediumGrey, lineHeight: 1.6, marginBottom: 16 }}>
          Generate 6 fresh headshots in another style. Your uploaded reference photos
          are still saved, so you'll go straight to the style picker — no re-uploading.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button onClick={onNewStyle}>Generate a different Style</Button>
          <Button variant="ghost" onClick={onHome}>
            Back to home
          </Button>
        </div>
      </div>

      {/* Auto-show instructions the first time DownloadScreen renders.
          Covers both desktop and mobile behavior in plain, non-technical
          language — Kristi's audience is photography clients, not devs. */}
      {showInstructions && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="How to save your headshots"
          onClick={dismissInstructions}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(44, 44, 42, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 200,
            padding: 24,
            ...font,
          }}
        >
          {/* Compact modal — tuned so the "Got it" button lands above the
              fold on an iPhone viewport (~670px usable after Safari chrome).
              Intro paragraph removed (heading + cards carry the message),
              icon shrunk, padding + margins + font sizes tightened. */}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: C.white,
              borderRadius: 12,
              padding: 22,
              maxWidth: 480,
              width: "100%",
              maxHeight: "90vh",
              overflowY: "auto",
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                background: C.dark,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 12,
              }}
            >
              <Download size={18} color={C.white} />
            </div>
            <h3
              style={{
                fontSize: 18,
                fontWeight: 500,
                color: C.dark,
                margin: 0,
                letterSpacing: -0.3,
              }}
            >
              How to save your headshots
            </h3>

            <div
              style={{
                marginTop: 14,
                padding: 12,
                background: C.pageBg,
                borderRadius: 8,
                border: `1px solid ${C.border}`,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: C.dark,
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                On your phone
              </div>
              <div style={{ fontSize: 13, color: C.dark, lineHeight: 1.5 }}>
                Tapping{" "}
                <span style={{ fontWeight: 500 }}>
                  Download beneath each photo
                </span>{" "}
                opens it in a new tab. Press and hold the photo, then tap{" "}
                <em>Save to Photos</em> (iPhone) or <em>Download image</em>{" "}
                (Android) — this drops it straight into your camera roll.
                Close the tab to return and save the next one.
              </div>
            </div>

            <div
              style={{
                marginTop: 8,
                padding: 12,
                background: C.pageBg,
                borderRadius: 8,
                border: `1px solid ${C.border}`,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: C.dark,
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                On your computer
              </div>
              <div style={{ fontSize: 13, color: C.dark, lineHeight: 1.5 }}>
                Tapping{" "}
                <span style={{ fontWeight: 500 }}>
                  Download beneath each photo
                </span>{" "}
                opens it in a new tab. Right-click the photo and choose{" "}
                <em>Save Image As…</em> to save it to your device.
              </div>
            </div>

            <p
              style={{
                fontSize: 11,
                color: C.mediumGrey,
                marginTop: 10,
                marginBottom: 0,
                lineHeight: 1.4,
              }}
            >
              Don't close this page until you've saved every photo you want —
              this download page is the delivery.
            </p>

            {/* "Don't show again" checkbox — persists to localStorage when
                the user dismisses with it ticked. Unticked by default so
                first-time visitors always see the explanation. */}
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 12,
                cursor: "pointer",
                fontSize: 12,
                color: C.mediumGrey,
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={suppressNext}
                onChange={(e) => setSuppressNext(e.target.checked)}
                style={{
                  width: 16,
                  height: 16,
                  accentColor: C.dark,
                  cursor: "pointer",
                }}
              />
              Don't show this again
            </label>

            <div style={{ marginTop: 12 }}>
              <Button onClick={dismissInstructions} full>
                Got it, let's go
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
};

// -------------------- Regeneration paywall --------------------

type PaywallModalProps = {
  onClose: () => void;
};

const PaywallModal = ({ onClose }: PaywallModalProps) => (
  <div
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(44, 44, 42, 0.4)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 100,
      padding: 24,
      ...font,
    }}
  >
    <div style={{ background: C.white, borderRadius: 8, padding: 32, maxWidth: 440 }}>
      <div style={{ fontSize: 18, fontWeight: 500, color: C.dark }}>
        You've used all 3 regenerations
      </div>
      <div style={{ fontSize: 14, color: C.mediumGrey, marginTop: 12, lineHeight: 1.6 }}>
        Pick your favorites from the current set, or start a new session to try a different style.
      </div>
      <div style={{ marginTop: 24 }}>
        <Button onClick={onClose} full>
          Got it
        </Button>
      </div>
    </div>
  </div>
);

// -------------------- Root app --------------------

type Screen =
  | "landing"
  | "gallery" // before/after gallery — accessible from landing nav
  | "upload"
  | "style"
  | "loading" // shown while /api/generate runs 6 times in parallel
  | "grid"
  | "checkout"
  | "success";

const TOTAL_HEADSHOTS = 6;

export default function App() {
  const [screen, setScreen] = useState<Screen>("landing");
  // Indices of the thumbnails the user selected on the Grid screen. Passed to
  // CheckoutScreen so we can forward the matching clean base64 images to
  // /api/deliver. Navbar "Selected (N)" reads this set's size.
  const [selectedImageIndices, setSelectedImageIndices] = useState<number[]>([]);
  const [email, setEmail] = useState("");
  // Public Blob URLs returned by /api/deliver — handed to DownloadScreen so
  // each photo gets its own Download button.
  const [deliveredPhotoUrls, setDeliveredPhotoUrls] = useState<string[]>([]);
  // Auto-generated share graphics, same array order as deliveredPhotoUrls.
  // Currently UNUSED on the client — moved to email delivery on
  // 2026-05-04 (sendCustomerDeliveryEmail in /api/deliver). State kept
  // for reset-flow consistency; the underscore-prefix on the read side
  // tells TypeScript we know it's unused. Setters are still called so
  // the response shape stays parsed and we can re-introduce client-side
  // rendering later without re-plumbing.
  const [_deliveredShareGraphicUrls, setDeliveredShareGraphicUrls] = useState<
    string[]
  >([]);
  const [regenCount, setRegenCount] = useState(0);
  // Surfaces a one-line error to the user when a per-slot regenerate call
  // fails on the backend (Gemini timeout / 500 / safety filter / etc).
  // Without this, the failure was silent — user clicked Refresh, nothing
  // visible changed, and the regen budget ticked down with no result.
  // Now: refund the budget, show this banner. Cleared when user starts
  // another regen or navigates away. Added 2026-05-01.
  const [regenError, setRegenError] = useState<string | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  // Stripe Checkout return state. After Stripe redirects back with
  // ?paid=1&session_id=cs_..., we POST to /api/verify-checkout. For card
  // payments verification is instant and this flips through "verifying" →
  // "idle" almost immediately. For async payment methods (Cash App Pay,
  // Klarna, ACH), settlement takes a few seconds to a few minutes — we
  // poll the verify endpoint and keep the user on a "Verifying your
  // payment…" overlay until it resolves. If polling times out the state
  // flips to "error" and we surface the session ID so the user can email
  // support — much better than the silent failure that bit one customer
  // on 2026-05-04.
  const [stripeVerifyState, setStripeVerifyState] = useState<
    "idle" | "verifying" | "error"
  >("idle");
  const [stripeVerifyErrorSessionId, setStripeVerifyErrorSessionId] = useState<
    string | null
  >(null);
  // Photos are lifted to App scope so the Blob URLs survive navigating forward
  // into Style / Grid / Checkout. /api/generate reads their blobUrl values.
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  // Generated headshots. Indexed 0..5. A given slot may be undefined if that
  // particular API call failed — GridScreen renders missing slots as
  // "generation failed" placeholders rather than hiding them.
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  // How many of the 6 parallel requests have returned successfully so far.
  // Drives the "Generating headshot N of 6" copy on the loading screen.
  const [readyCount, setReadyCount] = useState(0);
  // Set only if ALL 6 calls fail, so LoadingScreen can offer a way back.
  const [generationError, setGenerationError] = useState<string | null>(null);
  // Remember the last-used Style/Attire/Lighting/Background selections + the
  // photo URLs that were sent, so per-slot "Regenerate this one" can reuse them
  // without forcing the user to restart the flow.
  const [lastSelections, setLastSelections] = useState<StyleSelections | null>(null);
  const [lastPhotoUrls, setLastPhotoUrls] = useState<string[]>([]);
  // Whether the client EXIF read found a wide-angle lens on any reference
  // photo. Cached at generate time so per-slot regenerations use the same
  // prompt-correction flag. See /api/generate BLOCK_LENS_CORRECTION.
  const [lastHasWideAngle, setLastHasWideAngle] = useState(false);
  // Which thumbnail slots currently have an in-flight single-slot regeneration.
  // The GridScreen overlays a loading spinner on these so the rest of the grid
  // stays interactive.
  const [regeneratingSlots, setRegeneratingSlots] = useState<Set<number>>(new Set());
  // Which slots from the INITIAL 6-image batch are still in flight. Distinct
  // from regeneratingSlots (which tracks per-slot regen clicks from the grid).
  // Used so the user can advance to the grid early — once 5 of 6 are ready,
  // a "Continue with what's ready" button appears on the loading screen.
  // The 6th call keeps firing in the background; the grid renders a spinner
  // (not a "Generation failed" placeholder) on slots in this set, then swaps
  // in the image when it returns. Added 2026-05-01 because slot 6 frequently
  // gets queue-placed last by Gemini's Tier 1 burst limiter and takes 60–120s
  // longer than slots 1–5.
  const [initialBatchInFlight, setInitialBatchInFlight] = useState<Set<number>>(new Set());
  // Budget of individual-photo regenerations per session. Previously this was
  // 2 bulk-regens (~12 API calls worth); individual regens are cheaper so we
  // give users 6 single swaps, which is the same total cost ceiling at most.
  const MAX_SINGLE_REGENS = 6;
  // Photographer's tips modal: shown the first time the user arrives at the
  // Upload screen in a given session. Resets when reset() fires so starting
  // over from Landing shows it again.
  const [hasSeenTips, setHasSeenTips] = useState(false);
  const [showTipsModal, setShowTipsModal] = useState(false);

  // --------- Paywall unlock state ---------
  //
  // The entry paywall is considered "unlocked" for this session once EITHER:
  //   (a) the user completed Stripe Checkout for the $4.99 entry fee, or
  //   (b) the user entered a valid promo code on the landing page.
  //
  // Persisted via LOCALSTORAGE (changed from sessionStorage on 2026-05-04).
  // History: original V1 used sessionStorage so the unlock would only survive
  // the current browser tab/session and "couldn't" leak across visits. That
  // backfired hard on the customer who hit browser-back after paying — the
  // back navigation pulled her browser context to the now-completed Stripe
  // URL, leaving her stranded on Stripe's "You're all done here" dead-end.
  // sessionStorage being aggressive about session boundaries meant her paid
  // unlock was already gone by the time she navigated to the app URL fresh.
  // With localStorage, the unlock survives tab close + browser-back + brief
  // navigation away, which is exactly what we want for a paid customer.
  // Risk: shared device → next user inherits the unlock. Acceptable at the
  // $2.99 price point; roadmap item #19 plans an email-match server-side
  // recovery as the cleaner long-term fix.
  //
  // unlock_source distinguishes the two paths so Phase 2 (the per-photo
  // checkout at CheckoutScreen) knows whether to skip Stripe entirely
  // (promo = free everything) or charge minus a $2.99 credit (stripe = paid
  // entry, credit eligible on first photo purchase).
  const [isUnlocked, setIsUnlocked] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("paywall_unlocked") === "true";
    } catch {
      // localStorage can throw in private browsing or strict-mode envs.
      return false;
    }
  });
  const markUnlocked = (source: "stripe" | "promo") => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("paywall_unlocked", "true");
        window.localStorage.setItem("unlock_source", source);
      } catch {
        // localStorage can throw in private browsing — fall back to in-memory
        // state only. The user keeps unlock for THIS tab but not after refresh.
      }
    }
    setIsUnlocked(true);
  };

  // On mount, check whether we're returning from Stripe Checkout. Stripe
  // redirects back to `${origin}/?paid=1&session_id=<cs_xxx>` — we verify
  // server-side before trusting the query param (users can forge ?paid=1
  // by hand, but they can't forge a paid session ID against our secret key).
  //
  // Polling: verify-checkout can return paid:true (unlock now), pending:true
  // (async settlement in progress — Cash App Pay / Klarna / ACH; keep
  // polling), or paid:false with no pending flag (truly didn't pay — stay
  // on landing silently). For pending we poll up to ~30s before falling
  // through to a visible error UI with the session ID, so a customer in
  // limbo always knows what to do next.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const paidParam = url.searchParams.get("paid");
    const sessionId = url.searchParams.get("session_id");
    if (paidParam !== "1" || !sessionId) return;

    // Strip the params immediately so refresh doesn't re-run verify or leave
    // ?paid=1 in the URL bar if verification fails.
    const cleanUrl = `${url.origin}${url.pathname}`;
    window.history.replaceState({}, "", cleanUrl);

    setStripeVerifyState("verifying");

    (async () => {
      // Cash App Pay typically settles in 2–8s, Klarna similar. ACH can
      // take days — but for ACH we'd just want the user to see a clear
      // "we'll email you when it clears" state, which the post-timeout
      // error UI delivers. ~30s polling catches Cash App / Klarna races
      // without making the user stare too long.
      const MAX_ATTEMPTS = 16;
      const POLL_INTERVAL_MS = 2000;

      let lastEmail: string | undefined;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const resp = await fetch("/api/verify-checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionId }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = (await resp.json()) as {
            paid?: boolean;
            pending?: boolean;
            customerEmail?: string;
          };

          if (data.customerEmail) lastEmail = data.customerEmail;

          if (data.paid) {
            markUnlocked("stripe");
            // Stash the email Stripe captured during Phase 1 checkout so the
            // CheckoutScreen can pre-fill it later (saves re-typing) and so
            // Phase 2 Stripe Checkout gets passed the same customer_email
            // (which lets Stripe Link auto-recognize them and fill their
            // saved card).
            if (data.customerEmail) {
              window.sessionStorage.setItem(
                "stripe_customer_email",
                data.customerEmail,
              );
              setEmail(data.customerEmail);
            }
            setStripeVerifyState("idle");
            setScreen("upload");
            setShowTipsModal(true);
            return;
          }

          if (!data.pending) {
            // Definitive "not paid" — abandoned, expired, or payment failed
            // outright. Silent return to landing is correct here; Stripe
            // would have surfaced any error on its own page.
            setStripeVerifyState("idle");
            return;
          }

          // pending: Stripe says session is complete but settlement is still
          // in progress. Wait and re-poll.
        } catch (err) {
          console.error(
            `verify-checkout attempt ${attempt + 1}/${MAX_ATTEMPTS} failed:`,
            err,
          );
          // Network/server hiccup → retry on the next loop iteration.
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      // All attempts exhausted while still pending. Surface an error UI
      // with the session ID so the customer can email support — much
      // better than silently dumping them on the landing page.
      if (lastEmail) {
        window.sessionStorage.setItem("stripe_customer_email", lastEmail);
      }
      setStripeVerifyErrorSessionId(sessionId);
      setStripeVerifyState("error");
    })();
    // Run exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------- Phase 2 return handler ---------
  //
  // After the CheckoutScreen redirects the user to Stripe for the per-photo
  // purchase, Stripe redirects back with `?photo_paid=1&session_id=...`. The
  // CheckoutScreen stashed the pending delivery payload in sessionStorage
  // under "pending_delivery" before redirecting — we pick it up here,
  // verify payment server-side, call /api/deliver, then advance to success.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const photoPaid = url.searchParams.get("photo_paid");
    const sessionId = url.searchParams.get("session_id");
    const photoCancel = url.searchParams.get("photo_cancel");

    // Cancel path: Stripe back-button returns with ?photo_cancel=1. Just
    // strip the param and leave the user on Landing — they can re-navigate.
    // (Their selections are gone with the redirect; that's acceptable MVP UX.)
    if (photoCancel === "1") {
      const cleanUrl = `${url.origin}${url.pathname}`;
      window.history.replaceState({}, "", cleanUrl);
      return;
    }

    if (photoPaid !== "1" || !sessionId) return;

    const cleanUrl = `${url.origin}${url.pathname}`;
    window.history.replaceState({}, "", cleanUrl);

    (async () => {
      // Verify the Stripe session was actually paid.
      try {
        const verifyResp = await fetch("/api/verify-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        });
        if (!verifyResp.ok) throw new Error(`HTTP ${verifyResp.status}`);
        const verifyData = (await verifyResp.json()) as { paid?: boolean };
        if (!verifyData.paid) {
          console.warn("Photo Stripe session not marked as paid");
          return;
        }
      } catch (err) {
        console.error("verify-checkout (photo) failed:", err);
        return;
      }

      // Payment confirmed — mark the entry credit as consumed so a future
      // grid checkout in this same session gets charged full price.
      window.sessionStorage.setItem("credit_used", "true");

      // Read the pending delivery payload stashed by CheckoutScreen.
      const stashRaw = window.sessionStorage.getItem("pending_delivery");
      if (!stashRaw) {
        console.error(
          "photo_paid return without pending_delivery in sessionStorage",
        );
        return;
      }
      window.sessionStorage.removeItem("pending_delivery");
      let stash: {
        email: string;
        uploadedUrls: string[];
        referencePhotoUrls: string[];
        selections: StyleSelections;
      };
      try {
        stash = JSON.parse(stashRaw);
      } catch {
        console.error("pending_delivery JSON parse failed");
        return;
      }

      // Call /api/deliver with the stashed data — same shape the CheckoutScreen
      // would have sent directly in the promo/unpaid path.
      try {
        const deliverResp = await fetch("/api/deliver", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: stash.email,
            photoUrls: stash.uploadedUrls,
            referencePhotoUrls: stash.referencePhotoUrls,
            style: stash.selections.style,
            attire: stash.selections.attire,
            lighting: stash.selections.lighting,
            background: stash.selections.background,
            skin: stash.selections.skin,
          }),
        });
        if (!deliverResp.ok) throw new Error(`HTTP ${deliverResp.status}`);
        const deliverData = (await deliverResp.json()) as {
          photoUrls: string[];
          shareGraphicUrls?: string[];
        };
        // Restore ALL state DownloadScreen needs. The Stripe redirect is a
        // full page navigation, which wipes React in-memory state — so
        // lastSelections/lastPhotoUrls come back null on return and the
        // `screen === "success" && lastSelections` render gate fails (blank
        // page). We restore them from the stash so the guard passes.
        //
        // hasWideAngle isn't in the stash currently — defaulting to false
        // is safe; it only affects bonus cross-style previews' lens
        // correction language (soft downgrade, not broken).
        setEmail(stash.email);
        setDeliveredPhotoUrls(deliverData.photoUrls);
        setDeliveredShareGraphicUrls(deliverData.shareGraphicUrls ?? []);
        setLastSelections(stash.selections);
        setLastPhotoUrls(stash.referencePhotoUrls);
        setLastHasWideAngle(false);
        setScreen("success");
      } catch (err) {
        console.error("deliver after Stripe payment failed:", err);
        alert(
          "Your payment went through but the delivery step hit a snag. Contact kristi@kristinasherk.com with your email and we'll send your files directly.",
        );
      }
    })();
    // Run exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    setScreen("landing");
    setSelectedImageIndices([]);
    setDeliveredPhotoUrls([]);
    setDeliveredShareGraphicUrls([]);
    setEmail("");
    setRegenCount(0);
    setPhotos([]);
    setGeneratedImages([]);
    setReadyCount(0);
    setGenerationError(null);
    setLastSelections(null);
    setLastPhotoUrls([]);
    setLastHasWideAngle(false);
    setRegeneratingSlots(new Set());
    setHasSeenTips(false);
    setShowTipsModal(false);
  };

  // Landing → Upload. If the user has already unlocked (via Stripe or promo
  // code earlier in this session), go straight to Upload. Otherwise redirect
  // to Stripe Checkout for the $4.99 entry fee — on return, the mount-time
  // useEffect above catches ?paid=1&session_id=... and advances them here.
  const handleStart = async () => {
    if (isUnlocked) {
      setScreen("upload");
      if (!hasSeenTips) setShowTipsModal(true);
      return;
    }
    // Kick off Stripe Checkout.
    try {
      const resp = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as { url?: string; error?: string };
      if (data.url) {
        // Full-page redirect to Stripe's hosted Checkout. Stripe handles the
        // payment flow and redirects back to success_url when complete.
        window.location.href = data.url;
        return;
      }
      throw new Error(data.error || "Stripe returned no URL");
    } catch (err) {
      console.error("create-checkout-session failed:", err);
      alert(
        "Couldn't start checkout — please refresh and try again. If the problem continues, contact kristi@kristinasherk.com.",
      );
    }
  };

  // Promo code success path. Marks the paywall unlocked with source="promo"
  // so the Phase 2 per-photo checkout can skip Stripe entirely (promo users
  // get free everything). Friends skip both fees.
  const handlePromoUnlock = () => {
    markUnlocked("promo");
    setScreen("upload");
    if (!hasSeenTips) setShowTipsModal(true);
  };

  const handleDismissTips = () => {
    setShowTipsModal(false);
    setHasSeenTips(true);
  };

  // Regenerate a SINGLE thumbnail slot, reusing the most recently-submitted
  // Style/Attire/Lighting/Background + photo URLs. Fires one /api/generate call
  // with the slot's variationIndex, and on success overwrites that slot only —
  // the other 5 thumbnails are untouched.
  const handleRegenerateSlot = async (index: number) => {
    if (regenCount >= MAX_SINGLE_REGENS) {
      setShowPaywall(true);
      return;
    }
    if (!lastSelections || lastPhotoUrls.length < 3) {
      // Shouldn't happen — we only show the Grid after a successful generate,
      // which always sets these. Silent no-op safety net.
      return;
    }
    if (regeneratingSlots.has(index)) {
      return; // already in flight for this slot
    }

    // Clear any prior error and burn one regen — we'll refund this if the
    // call fails so the user doesn't lose budget on a server-side problem.
    setRegenError(null);
    setRegenCount((n) => n + 1);
    setRegeneratingSlots((prev) => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photoUrls: lastPhotoUrls,
          style: lastSelections.style,
          attire: lastSelections.attire,
          lighting: lastSelections.lighting,
          background: lastSelections.background,
          variationIndex: index,
          hasWideAngle: lastHasWideAngle,
          skin: lastSelections.skin,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as { image: string };
      setGeneratedImages((prev) => {
        const next = [...prev];
        next[index] = data.image;
        return next;
      });
    } catch (err) {
      // Surface a visible error AND refund the regen budget — Gemini charged
      // us regardless, but charging the user a regen budget for a failure
      // they had no control over is the wrong UX.
      setRegenCount((n) => Math.max(0, n - 1));
      const msg =
        err instanceof Error && err.message.includes("HTTP")
          ? `Regeneration failed (server returned ${err.message.replace("HTTP ", "")}). Try again in a few seconds — if it keeps failing, refresh the page.`
          : `Regeneration failed for slot ${index + 1}. Try again in a few seconds — if it keeps failing, refresh the page.`;
      setRegenError(msg);
    } finally {
      setRegeneratingSlots((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };

  // Kicks off the 6 parallel /api/generate calls. Runs after the user picks
  // Style + Attire + Lighting + Background and clicks "Generate 6 headshots".
  //
  // Architecture note: we fire 6 separate requests (not one request that loops
  // inside the server) for two reasons —
  //   1. Real per-image progress: each returning request increments the
  //      counter so the user sees "Generating headshot 3 of 6" honestly.
  //   2. Timeout safety on Vercel Hobby: each call only needs to fit inside
  //      its own 60s ceiling, rather than all 6 squeezing into one window.
  const handleGenerate = async (selections: StyleSelections) => {
    // Only send the photos that successfully uploaded to Blob. Silently drop
    // any that are still pending or errored — the user shouldn't be blocked
    // on a stray failed upload if they have 3+ good ones.
    const usablePhotos = photos.filter((p) => p.status === "done" && p.blobUrl);
    const photoUrls = usablePhotos.map((p) => p.blobUrl as string);
    // Wide-angle flag: true if ANY usable reference photo was detected as
    // wide via EXIF. `null` (EXIF unreadable) and `false` (confirmed ≥40mm)
    // both count as "not wide" — the server will fall back to Block 1's
    // generic "if it appears wide-angle..." wording in those cases.
    const hasWideAngle = usablePhotos.some((p) => p.isWideAngle === true);

    if (photoUrls.length < 3) {
      setGenerationError(
        "We need at least 3 uploaded photos to generate. Go back and add more.",
      );
      setScreen("loading");
      return;
    }

    // Reset prior generation state in case the user regenerated.
    setGeneratedImages([]);
    setReadyCount(0);
    setGenerationError(null);
    setRegenCount(0);
    setRegeneratingSlots(new Set());
    // All 6 slots are about to start firing — record them as in-flight.
    // Each call removes its own index in its `finally` block so the grid
    // can swap a spinner for the failed-placeholder at the right moment.
    setInitialBatchInFlight(new Set([0, 1, 2, 3, 4, 5]));
    // Persist selections + URLs so per-slot regeneration can reuse them
    // without asking the user to reselect anything.
    setLastSelections(selections);
    setLastPhotoUrls(photoUrls);
    setLastHasWideAngle(hasWideAngle);
    setScreen("loading");

    // Fire 6 staggered calls (2s apart). Each gets a unique variationIndex
    // (0-5) so the backend picks a different "flavor" per photo. Staggering
    // matters: firing all 6 at the same instant overwhelms Gemini's Tier 1
    // concurrent-request quota and consistently 429s the last one — even
    // with the per-call retry wrapper, multiple parallel retries collide.
    //
    // Tightened 3s → 2s on 2026-05-04 to shave 5s off slot 6's start time
    // (start times: 0, 2, 4, 6, 8, 10s instead of 0, 3, 6, 9, 12, 15s).
    // The retry wrapper in /api/generate absorbs any extra 429s from the
    // tighter concurrency. If we start seeing systematic 429s on slot 5
    // or 6 we can dial back to 2.5s.
    const STAGGER_MS = 2000;
    const calls = Array.from({ length: TOTAL_HEADSHOTS }, async (_, index) => {
      // Each call waits its turn before firing. Promise.all below still
      // collects them in parallel — we're just delaying the START of the
      // network request, not blocking the array map.
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, index * STAGGER_MS));
      }
      try {
        const response = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            photoUrls,
            style: selections.style,
            attire: selections.attire,
            lighting: selections.lighting,
            background: selections.background,
            variationIndex: index,
            hasWideAngle,
            skin: selections.skin,
          }),
        });
        if (!response.ok) {
          const err = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error || `HTTP ${response.status}`);
        }
        const data = (await response.json()) as { image: string };
        // Write this image into its fixed slot AND bump the counter. Using
        // functional setState so the six overlapping callbacks compose cleanly.
        setGeneratedImages((prev) => {
          const next = [...prev];
          next[index] = data.image;
          return next;
        });
        setReadyCount((n) => n + 1);
        return data.image;
      } catch {
        // Swallow per-call errors — we'll surface them only if ALL 6 fail.
        return null;
      } finally {
        // Whether this call succeeded or failed, it's no longer in flight.
        // The GridScreen reads this set to decide whether to show a spinner
        // (still in flight) or "Generation failed" (returned + no image).
        setInitialBatchInFlight((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      }
    });

    const results = await Promise.all(calls);
    const successCount = results.filter((r) => r !== null).length;

    if (successCount === 0) {
      // Edge case: if the user has already advanced to the grid via the
      // "Continue with what's ready" button by the time all calls fail,
      // we still want to surface this — but they're not on the loading
      // screen anymore. setGenerationError() is a no-op for the grid
      // (regenError handles per-slot grid errors instead). We still set
      // it here so a user who's still on /loading sees the message.
      setGenerationError(
        "All 6 generations failed. Please try again — if it keeps happening, check your uploaded photos are clear headshots.",
      );
      return;
    }

    // At least one succeeded → advance to the grid IF the user hasn't
    // already advanced early via the 5-of-6 "Continue" button. Functional
    // setScreen lets us check the latest screen value without a stale
    // closure on the captured `screen` from when handleGenerate fired.
    setScreen((s) => (s === "loading" ? "grid" : s));
  };

  return (
    <div style={{ minHeight: "100vh", background: C.pageBg, ...font }}>
      {/* Old "Generation Studio / Selected (N)" navbar — hidden on the
          landing screen because LandingV2 has its own GenerAItion top nav.
          Showing both at once stacks two header bars and visually clashes. */}
      {screen !== "landing" && (
        <Navbar cartCount={selectedImageIndices.length} onLogoClick={reset} />
      )}

      {/* Stripe verification overlay — shown when the user just returned from
          Stripe Checkout. Card payments resolve instantly so this barely
          flashes; async methods (Cash App Pay / Klarna / ACH) sit here for a
          few seconds while we poll. The error variant surfaces the session
          ID and a mailto: support link so a customer in limbo always knows
          what to do — replacing the silent-failure path that bit one
          customer on 2026-05-04. */}
      {stripeVerifyState !== "idle" && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(247, 245, 240, 0.96)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: 24,
            ...font,
          }}
        >
          <div style={{ maxWidth: 440, textAlign: "center" }}>
            {stripeVerifyState === "verifying" ? (
              <>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
                  <Loader2
                    size={36}
                    color={C.dark}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                </div>
                <h2
                  style={{
                    fontSize: 22,
                    fontWeight: 500,
                    color: C.dark,
                    margin: 0,
                    letterSpacing: -0.3,
                  }}
                >
                  Verifying your payment…
                </h2>
                <p
                  style={{
                    fontSize: 14,
                    color: C.mediumGrey,
                    marginTop: 12,
                    lineHeight: 1.6,
                  }}
                >
                  Cash App, Klarna, and bank transfers can take a few seconds
                  to confirm. Hang tight — don't refresh.
                </p>
              </>
            ) : (
              <>
                <h2
                  style={{
                    fontSize: 22,
                    fontWeight: 500,
                    color: C.dark,
                    margin: 0,
                    letterSpacing: -0.3,
                  }}
                >
                  Your payment is still processing
                </h2>
                <p
                  style={{
                    fontSize: 14,
                    color: C.mediumGrey,
                    marginTop: 12,
                    lineHeight: 1.6,
                  }}
                >
                  Stripe is taking longer than usual to confirm your payment.
                  This can happen with Cash App, Klarna, or bank transfers.
                  Your card has NOT been charged twice — please don't try to
                  pay again.
                </p>
                <p
                  style={{
                    fontSize: 14,
                    color: C.mediumGrey,
                    marginTop: 16,
                    lineHeight: 1.6,
                  }}
                >
                  Email{" "}
                  <a
                    href={`mailto:kristi@kristinasherk.com?subject=AI%20Headshots%20payment%20pending&body=Hi%20Kristi%2C%0A%0AMy%20payment%20is%20stuck%20on%20%22verifying.%22%20Stripe%20session%20ID%3A%20${encodeURIComponent(stripeVerifyErrorSessionId ?? "")}%0A%0AThanks%21`}
                    style={{ color: C.dark, fontWeight: 500 }}
                  >
                    kristi@kristinasherk.com
                  </a>{" "}
                  with your session ID and we'll unlock your account
                  manually.
                </p>
                {stripeVerifyErrorSessionId && (
                  <div
                    style={{
                      marginTop: 16,
                      padding: "10px 14px",
                      background: C.lightGrey,
                      border: `1px solid ${C.border}`,
                      borderRadius: 6,
                      fontSize: 12,
                      color: C.dark,
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                      wordBreak: "break-all",
                    }}
                  >
                    {stripeVerifyErrorSessionId}
                  </div>
                )}
                <button
                  onClick={() => setStripeVerifyState("idle")}
                  style={{
                    marginTop: 20,
                    padding: "10px 18px",
                    background: "transparent",
                    color: C.mediumGrey,
                    border: `1px solid ${C.border}`,
                    borderRadius: 6,
                    fontSize: 13,
                    cursor: "pointer",
                    ...font,
                  }}
                >
                  Close
                </button>
              </>
            )}
          </div>
          <style>{`
            @keyframes spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
          `}</style>
        </div>
      )}

      {screen === "landing" && (
        <LandingV2
          onStart={handleStart}
          onPromoUnlock={handlePromoUnlock}
          onShowGallery={() => setScreen("gallery")}
        />
      )}
      {screen === "gallery" && (
        <GalleryScreen
          onBack={() => setScreen("landing")}
          onStart={handleStart}
        />
      )}
      {screen === "upload" && (
        <UploadScreen
          onNext={() => setScreen("style")}
          onBack={() => setScreen("landing")}
          photos={photos}
          setPhotos={setPhotos}
        />
      )}
      {screen === "style" && (
        <StyleScreen
          onGenerate={handleGenerate}
          onBack={() => setScreen("upload")}
        />
      )}
      {screen === "loading" && (
        <LoadingScreen
          readyCount={readyCount}
          readyImages={generatedImages}
          totalCount={TOTAL_HEADSHOTS}
          errorMessage={generationError}
          onBack={() => {
            setGenerationError(null);
            setScreen("style");
          }}
          onContinueWithReady={() => setScreen("grid")}
        />
      )}
      {screen === "grid" && (
        <GridScreen
          images={generatedImages}
          onDeliver={(indices) => {
            setSelectedImageIndices(indices);
            setScreen("checkout");
          }}
          onBack={() => setScreen("style")}
          onRegenerateSlot={handleRegenerateSlot}
          regenError={regenError}
          regenCount={regenCount}
          maxRegens={MAX_SINGLE_REGENS}
          regeneratingSlots={regeneratingSlots}
          initialBatchInFlight={initialBatchInFlight}
        />
      )}
      {screen === "checkout" && lastSelections && (
        <CheckoutScreen
          selectedImages={selectedImageIndices
            .map((i) => generatedImages[i])
            .filter((img): img is string => !!img)}
          referencePhotoUrls={lastPhotoUrls}
          selections={lastSelections}
          onComplete={({ email: submittedEmail, photoUrls, shareGraphicUrls }) => {
            setEmail(submittedEmail);
            setDeliveredPhotoUrls(photoUrls);
            setDeliveredShareGraphicUrls(shareGraphicUrls ?? []);
            setScreen("success");
          }}
          onBack={() => setScreen("grid")}
        />
      )}
      {screen === "success" && lastSelections && (
        <DownloadScreen
          email={email}
          photoUrls={deliveredPhotoUrls}
          chosenStyle={lastSelections.style}
          referencePhotoUrls={lastPhotoUrls}
          hasWideAngle={lastHasWideAngle}
          attire={lastSelections.attire}
          lighting={lastSelections.lighting}
          onNewStyle={() => {
            // "Generate a different Style": keep reference photos + EXIF flag
            // + email, but wipe generated images / cart / selections so the
            // Style screen is a clean slate. Skips Upload since photos are
            // already in state and cached in Blob.
            setGeneratedImages([]);
            setReadyCount(0);
            setGenerationError(null);
            setSelectedImageIndices([]);
            setDeliveredPhotoUrls([]);
            setDeliveredShareGraphicUrls([]);
            setRegenCount(0);
            setRegeneratingSlots(new Set());
            setLastSelections(null);
            // Keep: photos, lastPhotoUrls, lastHasWideAngle, email, hasSeenTips
            setScreen("style");
          }}
          onHome={reset}
        />
      )}

      {showPaywall && <PaywallModal onClose={() => setShowPaywall(false)} />}

      {/* Photographer's tips modal — shown once per session on Landing→Upload.
          Overlays the Upload screen until the user clicks "Got it." */}
      {showTipsModal && <PhotographerTipsModal onDismiss={handleDismissTips} />}
    </div>
  );
}
