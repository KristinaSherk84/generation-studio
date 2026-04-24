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
    title: "Turn off overhead lights.",
    body: "Face a window. Natural daylight is best — overhead lights cast unflattering shadows under the eyes.",
  },
  {
    title: "No low-res photos.",
    body: "The AI can only work with what it can see. Blurry, pixelated, or heavily compressed inputs produce blurry, distorted results.",
  },
  {
    title: "Variety matters.",
    body: "Different expressions, angles, and outfits. Four to eight photos is the sweet spot — more isn't always better. Include at least one close-cropped shot where your head nearly fills the frame — the AI mirrors your framing.",
  },
  {
    title: "The wider the lens, the more distorted your face.",
    body: "Have a friend take the photo using the regular (rear) camera on the phone — NOT the selfie camera. Selfie cameras use wide lenses that stretch your nose and face.",
  },
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

const Landing = ({ onStart, onPromoUnlock }: LandingProps) => {
  // Promo code state — scoped to Landing so it resets if the user navigates
  // away and comes back. The unlock flag itself lives in App/sessionStorage.
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
        // Brief pause so the "Unlocked" flash is visible before navigation.
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
  <div style={{ maxWidth: 960, margin: "0 auto", padding: "80px 32px", ...font }}>
    <div
      style={{
        fontSize: 11,
        letterSpacing: 2,
        color: C.mediumGrey,
        textTransform: "uppercase",
        marginBottom: 16,
        fontWeight: 500,
      }}
    >
      Made by an actual headshot photographer
    </div>
    {/* Speed-focused marketing badge. Generation Studio generates images in
        ~2 minutes vs. the 30–60 minute training step other AI headshot apps
        require — this callout leans into that differentiation. */}
    <div
      style={{
        display: "inline-block",
        background: C.dark,
        color: C.white,
        fontSize: 11,
        letterSpacing: 2,
        textTransform: "uppercase",
        padding: "8px 16px",
        borderRadius: 999,
        fontWeight: 600,
        marginBottom: 24,
      }}
    >
      Instant · No wait · Ready in 2 minutes
    </div>
    {/* H1 fontSize uses clamp() so the title scales with viewport width.
        On narrow mobile (~390px) it resolves to ~22px — roughly 1/3 of its
        desktop size — which keeps the title from dominating the first screen.
        On desktop (≥1040px wide) it hits the 52px ceiling and looks as before. */}
    <h1
      style={{
        fontSize: "clamp(22px, 5vw, 52px)",
        fontWeight: 500,
        color: C.dark,
        lineHeight: 1.15,
        margin: 0,
        letterSpacing: -0.5,
      }}
    >
      Instant Professional Headshots.
      <br />
      Only pay for headshots you like.
    </h1>

    {/* Landing hero before/after gallery — three real headshot transformations.
        Filenames and alt text front-load Kristi's highest-volume target
        keywords ("AI headshot generator", "AI headshots") for image-search
        discoverability. Files live in /public/ so Vite serves them at the
        site root. aspectRatio 3/4 matches the 1200x1600 composite dimensions. */}
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 12,
        // Vertical margin scales down on mobile so the title→gallery→copy
        // stack stays tight on a phone and breathes on desktop.
        margin: "clamp(20px, 4vw, 48px) 0",
      }}
    >
      {[
        {
          src: "/ai-headshot-generator-man-suit-tie.jpg",
          alt: "AI headshot generator result — casual outdoor photo transformed into professional headshot in navy suit and tie",
        },
        {
          src: "/ai-headshot-generator-woman-blue-blazer.jpg",
          alt: "AI headshot generator result — phone selfie transformed into professional headshot of woman in blue blazer",
        },
        {
          src: "/ai-headshot-generator-man-glasses.jpg",
          alt: "AI headshot generator result — casual photo transformed into professional headshot of man with glasses and long hair",
        },
      ].map((img) => (
        <div
          key={img.src}
          style={{
            aspectRatio: "3/4",
            background: C.lightGrey,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <img
            src={img.src}
            alt={img.alt}
            loading="lazy"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        </div>
      ))}
    </div>

    {/* Description copy — moved below the gallery on 2026-04-22 so the
        first-screen stack on mobile is: title → real results → explainer.
        Showing the proof images above the copy makes the value legible in
        the first glance instead of forcing users to scroll past a paragraph. */}
    <p
      style={{
        fontSize: 16,
        color: C.mediumGrey,
        lineHeight: 1.6,
        marginTop: 0,
        marginBottom: 24,
        maxWidth: 560,
      }}
    >
      Upload a few photos, pick a style, and in about 2 minutes you'll have six professional-grade
      headshots in high-rez. No 30-minute waits, no model training — just instant results. You
      only pay for the ones you actually want — no subscriptions, no surprises.
    </p>

    {/* Pet callout — surfaces the "also works for pets" angle early so
        users know from the landing page they can use their animals. Kept
        as a soft centered line so it doesn't fight the before/after gallery
        above or the pricing card below for attention. */}
    <div
      style={{
        textAlign: "center",
        fontSize: 14,
        color: C.mediumGrey,
        marginTop: 0,
        marginBottom: 32,
        lineHeight: 1.6,
      }}
    >
      <span style={{ color: C.dark, fontWeight: 500 }}>It even works for pets.</span>{" "}
      Upload a few photos of your dog, cat, or horse — same flow, same price.
    </div>

    {/* Pricing box padding, internal gap, and vertical spacing all use
        clamp() so the card compresses on mobile (less negative space,
        prices sit closer together) while keeping desktop unchanged. */}
    <div
      style={{
        background: C.white,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: "clamp(18px, 4vw, 32px)",
        marginBottom: 24,
      }}
    >
      <div style={{ fontSize: 13, color: C.mediumGrey, marginBottom: 10, fontWeight: 500 }}>
        Simple pricing
      </div>
      <div
        style={{
          display: "flex",
          gap: "clamp(20px, 5vw, 48px)",
          flexWrap: "wrap",
          marginBottom: "clamp(14px, 3vw, 24px)",
        }}
      >
        <div>
          <div style={{ fontSize: 26, fontWeight: 500, color: C.dark }}>$4.99</div>
          <div style={{ fontSize: 12, color: C.mediumGrey, marginTop: 4 }}>
            Try it · credited toward your first high-rez download
          </div>
        </div>
        <div>
          <div style={{ fontSize: 26, fontWeight: 500, color: C.dark }}>$9.99</div>
          <div style={{ fontSize: 12, color: C.mediumGrey, marginTop: 4 }}>
            Per high-rez headshot you keep · minus your $4.99 credit
          </div>
        </div>
      </div>
      <Button onClick={onStart}>Start — $4.99</Button>
    </div>

    <PhotogTip style={{ marginTop: 16 }}>
      Twenty years behind the lens photographing headshots in DC. Every style preset, every lighting
      choice, every subtle expression cue was tuned by a working portrait photographer — not a
      generic AI template.
    </PhotogTip>

    {/* Promo code — tucked at the very bottom so normal users never notice it.
        Click the link to reveal the input; successful code flips the paywall
        unlock flag in sessionStorage and auto-advances to Upload. The code
        itself lives as an env var in Vercel (PROMO_CODE) and is validated
        server-side via /api/verify-promo, so it never ships in the JS bundle. */}
    <div style={{ marginTop: 64, textAlign: "center", opacity: 0.75 }}>
      {!showPromoInput ? (
        <button
          type="button"
          onClick={() => setShowPromoInput(true)}
          style={{
            background: "transparent",
            border: "none",
            color: C.mediumGrey,
            fontSize: 11,
            letterSpacing: 1,
            textTransform: "uppercase",
            cursor: "pointer",
            textDecoration: "underline",
            padding: 4,
          }}
        >
          Got a promo code?
        </button>
      ) : (
        <div
          style={{
            display: "inline-flex",
            flexDirection: "column",
            gap: 8,
            alignItems: "center",
          }}
        >
          {promoStatus === "success" ? (
            <span style={{ fontSize: 13, color: C.dark, fontWeight: 500 }}>
              Unlocked — continuing…
            </span>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value)}
                placeholder="Enter code"
                disabled={promoStatus === "submitting"}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitPromo();
                }}
                style={{
                  padding: "8px 12px",
                  fontSize: 13,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  fontFamily: "inherit",
                  background: C.white,
                  color: C.dark,
                  outline: "none",
                }}
              />
              <button
                type="button"
                onClick={submitPromo}
                disabled={promoStatus === "submitting" || !promoCode.trim()}
                style={{
                  padding: "8px 14px",
                  fontSize: 12,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  border: `1px solid ${C.dark}`,
                  background: C.dark,
                  color: C.buttonText,
                  borderRadius: 6,
                  cursor:
                    promoStatus === "submitting" || !promoCode.trim()
                      ? "not-allowed"
                      : "pointer",
                  fontFamily: "inherit",
                  opacity:
                    promoStatus === "submitting" || !promoCode.trim() ? 0.5 : 1,
                }}
              >
                {promoStatus === "submitting" ? "…" : "Unlock"}
              </button>
            </div>
          )}
          {promoStatus === "error" && (
            <span style={{ fontSize: 11, color: "#c0392b" }}>{promoErrMsg}</span>
          )}
        </div>
      )}
    </div>
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
          JPG or PNG · {photos.length}/8 added
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

const STYLES = [
  { id: "creative", name: "Creative", desc: "Soft creamy bokeh", swatch: "#9C9A91", bokeh: true },
  { id: "corporate", name: "Corporate", desc: "Clean neutral bg", swatch: "#D3D1C7" },
  { id: "executive", name: "Executive", desc: "Bold, authoritative", swatch: "#444441" },
] as const;

// Large bokeh orbs for the Creative swatch. Positions and sizes are hand-placed
// to read as scattered out-of-focus highlights from an f/1.4 lens, not a pattern.
const CREATIVE_BOKEH = [
  { top: "8%",  left: "12%", size: 42, opacity: 0.45 },
  { top: "18%", left: "62%", size: 55, opacity: 0.55 },
  { top: "48%", left: "8%",  size: 36, opacity: 0.35 },
  { top: "42%", left: "48%", size: 60, opacity: 0.60 },
  { top: "68%", left: "72%", size: 46, opacity: 0.50 },
  { top: "72%", left: "28%", size: 38, opacity: 0.40 },
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
  style: "corporate" | "creative" | "executive";
  attire: "formal" | "casual" | "keep";
  lighting: "studio" | "natural" | "dramatic" | "golden";
  background?: "white" | "lightgrey" | "midgrey" | "dark" | "blue" | "green" | "rainbow";
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

      {/* Style cards */}
      <SectionLabel>Style</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {STYLES.map((s) => {
          const selected = style === s.id;
          return (
            <div
              key={s.id}
              onClick={() => setStyle(s.id)}
              style={{
                background: C.white,
                borderRadius: 8,
                padding: 12,
                border: `1.5px solid ${selected ? C.dark : C.border}`,
                cursor: "pointer",
                transition: "border-color 0.15s",
              }}
            >
              <div
                style={{
                  aspectRatio: "1",
                  background: s.swatch,
                  borderRadius: 6,
                  position: "relative",
                  overflow: "hidden",
                  marginBottom: 10,
                }}
              >
                {"bokeh" in s && s.bokeh && (
                  <div style={{ position: "absolute", inset: 0 }}>
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
                          background: `rgba(255, 255, 255, ${orb.opacity})`,
                          filter: "blur(6px)",
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, color: C.dark }}>{s.name}</div>
              <div style={{ fontSize: 12, color: C.mediumGrey, marginTop: 2 }}>{s.desc}</div>
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
};

const LoadingScreen = ({
  readyCount,
  readyImages,
  totalCount,
  errorMessage,
  onBack,
}: LoadingScreenProps) => {
  // The counter message says "Generating headshot N of 6" where N = the
  // image currently being worked on. With parallel requests all 6 are
  // technically in flight at once, but showing (readyCount + 1) mirrors
  // the user's mental model: "how far along am I?"
  const currentlyGenerating = Math.min(readyCount + 1, totalCount);
  const allDone = readyCount >= totalCount;

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

      {/* Pre-announce the per-photo regenerate feature while the user waits.
          Same wording pattern as the Grid screen hint so when they land on
          the Grid they recognize the icon immediately. Only shown while
          generation is in-flight (hidden on error or after all 6 finish). */}
      {!errorMessage && !allDone && (
        <div
          style={{
            marginTop: 24,
            marginLeft: "auto",
            marginRight: "auto",
            maxWidth: 480,
            padding: "14px 18px",
            borderRadius: 8,
            background: C.lightGrey,
            color: C.dark,
            fontSize: 14,
            lineHeight: 1.6,
            textAlign: "center",
          }}
        >
          <span style={{ fontWeight: 500 }}>Not happy with one of your 6?</span>{" "}
          Use the{" "}
          <RefreshCw
            size={14}
            style={{
              display: "inline",
              verticalAlign: "middle",
              marginBottom: 2,
            }}
          />{" "}
          icon on any photo to get a better result.
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
};

const GridScreen = ({
  images,
  onDeliver,
  onBack,
  onRegenerateSlot,
  regenCount,
  maxRegens,
  regeneratingSlots,
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
          const canRegenThisSlot = !!src && !regenerating && regenCount < maxRegens;
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
                  confusing disabled state. */}
              {src && regenCount < maxRegens && !regenerating && (
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
  onComplete: (args: { email: string; photoUrls: string[] }) => void;
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
  const [email, setEmail] = useState("");
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
      // -----------------------------------------------------------------
      const uploadedUrls: string[] = [];
      for (let i = 0; i < selectedImages.length; i++) {
        setProgressLabel(`Uploading photo ${i + 1} of ${selectedImages.length}…`);
        const file = dataUrlToFile(selectedImages[i], `headshot-${i + 1}.jpg`);
        if (!file) {
          throw new Error(`Photo ${i + 1} was in an unrecognized format.`);
        }
        // Pathname prefix keeps delivered images visually grouped in the
        // Blob dashboard; the token endpoint still adds a random suffix,
        // so the full key will look like `delivered/headshot-1-<hash>.jpg`.
        const result = await upload(`delivered/${file.name}`, file, {
          access: "public",
          handleUploadUrl: "/api/upload",
        });
        uploadedUrls.push(result.url);
      }

      // -----------------------------------------------------------------
      // STEP 2 — Tell /api/deliver to record the manifest. Tiny JSON body,
      // no 413 risk; images are already in Blob at this point.
      // -----------------------------------------------------------------
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
        }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Delivery failed (HTTP ${response.status})`);
      }
      const data = (await response.json()) as { photoUrls: string[] };
      onComplete({ email, photoUrls: data.photoUrls });
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
            : "Take me to my photos"}
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

    // --- Mobile path: open in a new tab, let the user long-press ---
    if (isMobileDevice()) {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
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
    ? (["corporate", "creative", "executive"] as const).filter(
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
    creative: "Creative",
    executive: "Executive",
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "64px 32px", ...font }}>
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: C.dark,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 24,
          }}
        >
          <Download size={24} color={C.white} />
        </div>
        <h2
          style={{
            fontSize: 28,
            fontWeight: 500,
            color: C.dark,
            margin: 0,
            letterSpacing: -0.5,
          }}
        >
          Your headshots are ready
        </h2>
        <p
          style={{
            fontSize: 15,
            color: C.mediumGrey,
            marginTop: 16,
            lineHeight: 1.6,
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

      {/* Download grid — one thumbnail + button per delivered photo.
          Button shows "Download" by default, "Downloaded ✓" after click.
          auto-fit + minmax(140, 1fr) so mobile fits 2 cols side-by-side (~155px
          each) and desktop collapses empty tracks so 2 items stretch to fill. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 16,
          marginTop: 40,
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
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  aspectRatio: "4/5",
                  background: C.lightGrey,
                  overflow: "hidden",
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
              <button
                onClick={() => handleDownload(url, i)}
                disabled={isLoading}
                style={{
                  border: "none",
                  padding: "12px 14px",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: isLoading ? "default" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  background: isDownloaded ? C.border : C.dark,
                  color: isDownloaded ? C.dark : C.buttonText,
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
  const [regenCount, setRegenCount] = useState(0);
  const [showPaywall, setShowPaywall] = useState(false);
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
  // Persisted via sessionStorage so a refresh mid-flow doesn't kick them back
  // to Stripe. sessionStorage (not localStorage) intentionally — unlock should
  // only survive the current browser tab/session, not forever.
  //
  // Phase 1 scope: this flag only gates the UI flow. /api/generate is NOT
  // gated on paid state yet — Phase 2 will tighten that alongside the $9.99
  // per-photo checkout at the Grid screen.
  const [isUnlocked, setIsUnlocked] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem("paywall_unlocked") === "true";
  });
  const markUnlocked = () => {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("paywall_unlocked", "true");
    }
    setIsUnlocked(true);
  };

  // On mount, check whether we're returning from Stripe Checkout. Stripe
  // redirects back to `${origin}/?paid=1&session_id=<cs_xxx>` — we verify
  // server-side before trusting the query param (users can forge ?paid=1
  // by hand, but they can't forge a paid session ID against our secret key).
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

    (async () => {
      try {
        const resp = await fetch("/api/verify-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as { paid?: boolean };
        if (data.paid) {
          markUnlocked();
          setScreen("upload");
          setShowTipsModal(true);
        } else {
          // Payment didn't complete — stay on Landing. No error toast; the
          // user either canceled (expected silent return) or payment failed
          // (Stripe would have shown its own error on their side).
          console.warn("Stripe session not marked as paid");
        }
      } catch (err) {
        console.error("verify-checkout failed:", err);
      }
    })();
    // Run exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    setScreen("landing");
    setSelectedImageIndices([]);
    setDeliveredPhotoUrls([]);
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

  // Promo code success path. Marks the paywall unlocked and advances the user
  // to Upload, same as a successful Stripe return. Friends skip the fee.
  const handlePromoUnlock = () => {
    markUnlocked();
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
    } catch {
      // Silent per-slot failure — the old image stays in that slot. The user
      // can hit regenerate again; we've already burned a budget increment,
      // which matches Gemini charging us regardless of whether we liked the
      // result. (Future: surface a small inline error + refund the budget.)
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
    // Persist selections + URLs so per-slot regeneration can reuse them
    // without asking the user to reselect anything.
    setLastSelections(selections);
    setLastPhotoUrls(photoUrls);
    setLastHasWideAngle(hasWideAngle);
    setScreen("loading");

    // Fire 6 parallel calls. Each gets a unique variationIndex (0-5) so the
    // backend can pick a different "flavor" (expression / pose / crop / outfit
    // detail) per photo and we get six distinct single headshots.
    const calls = Array.from({ length: TOTAL_HEADSHOTS }, async (_, index) => {
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
      }
    });

    const results = await Promise.all(calls);
    const successCount = results.filter((r) => r !== null).length;

    if (successCount === 0) {
      setGenerationError(
        "All 6 generations failed. Please try again — if it keeps happening, check your uploaded photos are clear headshots.",
      );
      return;
    }

    // At least one succeeded → move on to the grid even if some failed. The
    // grid renders a "generation failed" placeholder for any missing slots.
    setScreen("grid");
  };

  return (
    <div style={{ minHeight: "100vh", background: C.pageBg, ...font }}>
      <Navbar cartCount={selectedImageIndices.length} onLogoClick={reset} />

      {screen === "landing" && (
        <Landing onStart={handleStart} onPromoUnlock={handlePromoUnlock} />
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
          regenCount={regenCount}
          maxRegens={MAX_SINGLE_REGENS}
          regeneratingSlots={regeneratingSlots}
        />
      )}
      {screen === "checkout" && lastSelections && (
        <CheckoutScreen
          selectedImages={selectedImageIndices
            .map((i) => generatedImages[i])
            .filter((img): img is string => !!img)}
          referencePhotoUrls={lastPhotoUrls}
          selections={lastSelections}
          onComplete={({ email: submittedEmail, photoUrls }) => {
            setEmail(submittedEmail);
            setDeliveredPhotoUrls(photoUrls);
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
