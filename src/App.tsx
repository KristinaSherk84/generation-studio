import { useState, type CSSProperties, type ReactNode } from "react";
import { Upload, Check, X, ArrowLeft, Mail } from "lucide-react";
import { upload } from "@vercel/blob/client";

// A photo the user has picked on the Upload screen. Lives in App-level state
// so the Blob URLs survive navigating forward into Style / Grid / etc.
export type UploadedPhoto = {
  id: string;                        // local unique id, stable across rerenders
  localPreview: string;              // object URL for instant thumbnail
  blobUrl: string | null;            // populated when upload to Blob completes
  status: "uploading" | "done" | "error";
  errorMessage: string | null;
};

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
      Cart ({cartCount})
    </div>
  </div>
);

type PhotogTipProps = {
  children: ReactNode;
  style?: CSSProperties;
};

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

type LandingProps = { onStart: () => void };

const Landing = ({ onStart }: LandingProps) => (
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
    <h1
      style={{
        fontSize: 52,
        fontWeight: 500,
        color: C.dark,
        lineHeight: 1.1,
        margin: 0,
        letterSpacing: -1,
      }}
    >
      Instant Professional Headshots.
      <br />
      Only pay for headshots you like.
    </h1>
    <p
      style={{
        fontSize: 17,
        color: C.mediumGrey,
        lineHeight: 1.6,
        marginTop: 24,
        maxWidth: 560,
      }}
    >
      Upload a few photos, pick a style, and in about 2 minutes you'll have six professional-grade
      headshots at 2K resolution. No 30-minute waits, no model training — just instant results. You
      only pay for the ones you actually want — no subscriptions, no surprises.
    </p>

    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 16,
        margin: "48px 0",
      }}
    >
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            aspectRatio: "4/5",
            background: C.lightGrey,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: C.mediumGrey,
            fontSize: 12,
          }}
        >
          Sample headshot {i}
        </div>
      ))}
    </div>

    <div
      style={{
        background: C.white,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: 32,
        marginBottom: 24,
      }}
    >
      <div style={{ fontSize: 13, color: C.mediumGrey, marginBottom: 12, fontWeight: 500 }}>
        Simple pricing
      </div>
      <div style={{ display: "flex", gap: 48, flexWrap: "wrap", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 500, color: C.dark }}>$4.99</div>
          <div style={{ fontSize: 12, color: C.mediumGrey, marginTop: 4 }}>
            Session fee · generates 6 headshots
          </div>
        </div>
        <div>
          <div style={{ fontSize: 28, fontWeight: 500, color: C.dark }}>$9.99</div>
          <div style={{ fontSize: 12, color: C.mediumGrey, marginTop: 4 }}>
            Per headshot you keep · 2K resolution
          </div>
        </div>
      </div>
      <Button onClick={onStart}>Start session — $4.99</Button>
    </div>

    <PhotogTip style={{ marginTop: 16 }}>
      Twenty years behind the lens photographing headshots in DC. Every style preset, every lighting
      choice, every subtle expression cue was tuned by a working portrait photographer — not a
      generic AI template.
    </PhotogTip>
  </div>
);

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
    }));
    setPhotos((prev) => [...prev, ...placeholders]);

    // Kick off each upload in parallel and update the matching placeholder.
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
          accept="image/jpeg,image/png,image/webp"
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
  { id: "corporate", name: "Corporate", desc: "Clean neutral bg", swatch: "#D3D1C7" },
  { id: "creative", name: "Creative", desc: "Soft creamy bokeh", swatch: "#9C9A91", bokeh: true },
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
  background?: "white" | "lightgrey" | "midgrey" | "dark" | "blue" | "green";
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
  onCheckout: (count: number) => void;
  onBack: () => void;
  onRegenerate: () => void;
  regenCount: number;
  maxRegens: number;
};

const GridScreen = ({
  images,
  onCheckout,
  onBack,
  onRegenerate,
  regenCount,
  maxRegens,
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

  const total = cart.size * 9.99;
  const canRegen = regenCount < maxRegens;

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
            $9.99 each. Watermark removed after checkout. Full 2K files delivered to your email.
          </p>
        </div>
        <div style={{ fontSize: 12, color: C.mediumGrey }}>
          Regenerations used: {regenCount} / {maxRegens}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 16,
          marginTop: 32,
        }}
      >
        {photos.map((i) => {
          const picked = cart.has(i);
          const src = images[i]; // may be undefined if this slot failed to generate
          return (
            <div
              key={i}
              onClick={() => src && toggle(i)}
              style={{
                position: "relative",
                aspectRatio: "4/5",
                background: C.lightGrey,
                borderRadius: 8,
                cursor: src ? "pointer" : "default",
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
                  {/* Watermark overlay — a tiled, diagonal grid of repeating
                      "WATERMARK" text that fully blankets the thumbnail so it's
                      physically impossible to crop out without obscuring the
                      face. Removed after checkout when Step 6 regenerates the
                      unwatermarked 2K files server-side. Future: swap the text
                      for Kristina Sherk's logo mark once one exists. */}
                  <div
                    style={{
                      position: "absolute",
                      inset: "-25%",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      alignItems: "center",
                      pointerEvents: "none",
                      transform: "rotate(-30deg)",
                      transformOrigin: "center",
                      overflow: "hidden",
                    }}
                  >
                    {Array.from({ length: 10 }).map((_, row) => (
                      <div
                        key={row}
                        style={{
                          fontSize: 10,
                          color: "rgba(255,255,255,0.55)",
                          textShadow: "0 1px 1px rgba(0,0,0,0.35)",
                          letterSpacing: 1.5,
                          whiteSpace: "nowrap",
                          fontWeight: 600,
                        }}
                      >
                        WATERMARK · WATERMARK · WATERMARK · WATERMARK · WATERMARK · WATERMARK
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
          <div style={{ fontSize: 13, color: C.mediumGrey }}>
            {cart.size} selected · ${total.toFixed(2)}
          </div>
          <div style={{ fontSize: 11, color: C.mediumGrey, marginTop: 4 }}>
            Session fee already paid · No bundles, flat $9.99 each
          </div>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Button variant="ghost" onClick={onRegenerate} disabled={!canRegen}>
            {canRegen ? `Regenerate (${maxRegens - regenCount} left)` : "No regenerations left"}
          </Button>
          <Button onClick={() => onCheckout(cart.size)} disabled={cart.size === 0}>
            Checkout · ${total.toFixed(2)}
          </Button>
        </div>
      </div>
    </div>
  );
};

// -------------------- Screen 5: Pay & Deliver --------------------

type CheckoutScreenProps = {
  count: number;
  onComplete: (email: string) => void;
  onBack: () => void;
};

const CheckoutScreen = ({ count, onComplete, onBack }: CheckoutScreenProps) => {
  const [email, setEmail] = useState("");
  const [processing, setProcessing] = useState(false);
  const total = count * 9.99;

  const submit = () => {
    if (!email.includes("@")) return;
    setProcessing(true);
    setTimeout(() => onComplete(email), 1400);
  };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "64px 32px", ...font }}>
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
        Checkout
      </h2>
      <p style={{ fontSize: 15, color: C.mediumGrey, marginTop: 12, lineHeight: 1.6 }}>
        {count} headshot{count !== 1 ? "s" : ""} at $9.99 each
      </p>

      <div
        style={{
          background: C.white,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          padding: 24,
          marginTop: 32,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 14,
            color: C.dark,
            marginBottom: 12,
          }}
        >
          <div>{count} × $9.99</div>
          <div>${total.toFixed(2)}</div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 14,
            color: C.mediumGrey,
            marginBottom: 16,
          }}
        >
          <div>Session fee (already paid)</div>
          <div>$0.00</div>
        </div>
        <div
          style={{
            borderTop: `1px solid ${C.border}`,
            paddingTop: 16,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 16,
            fontWeight: 500,
            color: C.dark,
          }}
        >
          <div>Total</div>
          <div>${total.toFixed(2)}</div>
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <label style={{ fontSize: 13, color: C.mediumGrey, fontWeight: 500 }}>
          Email for delivery
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@email.com"
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
        <div style={{ fontSize: 12, color: C.mediumGrey, marginTop: 8 }}>
          High-res 2K files will be sent here.
        </div>
      </div>

      <div
        style={{
          marginTop: 24,
          padding: 16,
          background: C.white,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          fontSize: 12,
          color: C.mediumGrey,
          lineHeight: 1.6,
        }}
      >
        Stripe payment form appears here in production build.
      </div>

      <div style={{ marginTop: 24 }}>
        <Button onClick={submit} disabled={!email.includes("@") || processing} full>
          {processing ? "Processing..." : `Pay $${total.toFixed(2)} & deliver to email`}
        </Button>
      </div>
    </div>
  );
};

// -------------------- Success screen --------------------

type SuccessProps = {
  email: string;
  onNewStyle: () => void;
  onHome: () => void;
};

const Success = ({ email, onNewStyle, onHome }: SuccessProps) => (
  <div style={{ maxWidth: 560, margin: "0 auto", padding: "96px 32px", textAlign: "center", ...font }}>
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
      <Mail size={24} color={C.white} />
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
      On the way to your inbox
    </h2>
    <p style={{ fontSize: 15, color: C.mediumGrey, marginTop: 16, lineHeight: 1.6 }}>
      Your 2K headshots are being delivered to <span style={{ color: C.dark }}>{email}</span>. Check
      your inbox in a few minutes.
    </p>

    <div
      style={{
        background: C.white,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: 24,
        marginTop: 32,
        textAlign: "left",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 500, color: C.dark, marginBottom: 8 }}>
        Want to try a different style?
      </div>
      <div style={{ fontSize: 13, color: C.mediumGrey, lineHeight: 1.6, marginBottom: 16 }}>
        A new style set is a new session ($4.99). Keeps things clean — your previous purchases stay
        yours.
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Button onClick={onNewStyle}>Start new session — $4.99</Button>
        <Button variant="ghost" onClick={onHome}>
          Back to home
        </Button>
      </div>
    </div>
  </div>
);

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
  const [cartCount, setCartCount] = useState(0);
  const [email, setEmail] = useState("");
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
  const MAX_REGENS = 2;

  const reset = () => {
    setScreen("landing");
    setCartCount(0);
    setRegenCount(0);
    setPhotos([]);
    setGeneratedImages([]);
    setReadyCount(0);
    setGenerationError(null);
  };

  const handleRegenerate = () => {
    if (regenCount >= MAX_REGENS) {
      setShowPaywall(true);
      return;
    }
    setRegenCount(regenCount + 1);
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
    const photoUrls = photos
      .filter((p) => p.status === "done" && p.blobUrl)
      .map((p) => p.blobUrl as string);

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
      } catch (err) {
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
      <Navbar cartCount={cartCount} onLogoClick={reset} />

      {screen === "landing" && <Landing onStart={() => setScreen("upload")} />}
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
          onCheckout={(n) => {
            setCartCount(n);
            setScreen("checkout");
          }}
          onBack={() => setScreen("style")}
          onRegenerate={handleRegenerate}
          regenCount={regenCount}
          maxRegens={MAX_REGENS}
        />
      )}
      {screen === "checkout" && (
        <CheckoutScreen
          count={cartCount}
          onComplete={(e) => {
            setEmail(e);
            setCartCount(0);
            setScreen("success");
          }}
          onBack={() => setScreen("grid")}
        />
      )}
      {screen === "success" && (
        <Success
          email={email}
          onNewStyle={() => {
            reset();
            setScreen("upload");
          }}
          onHome={reset}
        />
      )}

      {showPaywall && <PaywallModal onClose={() => setShowPaywall(false)} />}
    </div>
  );
}
