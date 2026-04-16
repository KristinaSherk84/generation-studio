import { useState, type CSSProperties, type ReactNode } from "react";
import { Upload, Check, X, ArrowLeft, Mail } from "lucide-react";

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
        marginBottom: 24,
        fontWeight: 500,
      }}
    >
      Made by an actual headshot photographer
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
      Your professional headshot.
      <br />
      Only pay for what looks like you.
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
      Upload a few photos, pick a style, and get six professional-grade headshots at 2K resolution.
      You only pay for the ones you actually want — no subscriptions, no surprises.
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
};

const UploadScreen = ({ onNext, onBack }: UploadScreenProps) => {
  const [files, setFiles] = useState<File[]>([]);

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files).slice(0, 8 - files.length);
    setFiles([...files, ...dropped]);
  };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).slice(0, 8 - files.length);
    setFiles([...files, ...picked]);
  };

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
      <p style={{ fontSize: 15, color: C.mediumGrey, marginTop: 12, lineHeight: 1.6 }}>
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
          JPG or PNG · {files.length}/8 uploaded
        </div>
        <input
          id="file-input"
          type="file"
          multiple
          accept="image/*"
          onChange={onPick}
          style={{ display: "none" }}
        />
      </div>

      {files.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
            marginTop: 24,
          }}
        >
          {files.map((f, i) => (
            <div
              key={i}
              style={{
                position: "relative",
                aspectRatio: "1",
                borderRadius: 8,
                overflow: "hidden",
                background: C.lightGrey,
              }}
            >
              <img
                src={URL.createObjectURL(f)}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
              <button
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
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

      <PhotogTip style={{ marginTop: 24 }}>
        Good light beats everything. Face a window, keep shadows off the face, and skip heavy
        filters — the AI reads what's actually there. Varied expressions give the generator room to
        work.
      </PhotogTip>

      <div style={{ marginTop: 32 }}>
        <Button onClick={onNext} disabled={files.length < 3} full>
          {files.length < 3
            ? `Upload ${3 - files.length} more to continue`
            : "Continue to style selection"}
        </Button>
      </div>
    </div>
  );
};

// -------------------- Screen 3: Style Selection --------------------

const STYLES = [
  { id: "corporate", name: "Corporate", desc: "Clean neutral bg", swatch: "#D3D1C7" },
  { id: "creative", name: "Creative", desc: "Soft creamy bokeh", swatch: "#B4B2A9", bokeh: true },
  { id: "executive", name: "Executive", desc: "Bold, authoritative", swatch: "#444441" },
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

type StyleScreenProps = {
  onGenerate: (style: string | null) => void;
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
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                    }}
                  >
                    {[18, 12, 22].map((size, i) => (
                      <div
                        key={i}
                        style={{
                          width: size,
                          height: size,
                          borderRadius: "50%",
                          background: "rgba(255,255,255,0.25)",
                          filter: "blur(4px)",
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
        <Button onClick={() => onGenerate(style)} disabled={!canGenerate} full>
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

// -------------------- Screen 4: Pick & Cart --------------------

type GridScreenProps = {
  onCheckout: (count: number) => void;
  onBack: () => void;
  onRegenerate: () => void;
  regenCount: number;
  maxRegens: number;
};

const GridScreen = ({
  onCheckout,
  onBack,
  onRegenerate,
  regenCount,
  maxRegens,
}: GridScreenProps) => {
  const [cart, setCart] = useState<Set<number>>(new Set());
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
          return (
            <div
              key={i}
              onClick={() => toggle(i)}
              style={{
                position: "relative",
                aspectRatio: "4/5",
                background: C.lightGrey,
                borderRadius: 8,
                cursor: "pointer",
                overflow: "hidden",
                border: `2px solid ${picked ? C.dark : "transparent"}`,
                transition: "border-color 0.15s",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: C.mediumGrey,
                  fontSize: 13,
                  background: `repeating-linear-gradient(45deg, ${C.lightGrey}, ${C.lightGrey} 20px, ${C.border} 20px, ${C.border} 40px)`,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    fontSize: 11,
                    color: C.mediumGrey,
                    opacity: 0.6,
                    transform: "rotate(-30deg)",
                    letterSpacing: 2,
                  }}
                >
                  WATERMARK · WATERMARK
                </div>
                <div style={{ zIndex: 1, fontSize: 12 }}>Headshot {i + 1} (full photo, 2K)</div>
              </div>
              {picked && (
                <div
                  style={{
                    position: "absolute",
                    top: 10,
                    right: 10,
                    background: C.dark,
                    color: C.white,
                    borderRadius: "50%",
                    width: 28,
                    height: 28,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Check size={16} />
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

type Screen = "landing" | "upload" | "style" | "grid" | "checkout" | "success";

export default function App() {
  const [screen, setScreen] = useState<Screen>("landing");
  const [cartCount, setCartCount] = useState(0);
  const [email, setEmail] = useState("");
  const [regenCount, setRegenCount] = useState(0);
  const [showPaywall, setShowPaywall] = useState(false);
  const MAX_REGENS = 2;

  const reset = () => {
    setScreen("landing");
    setCartCount(0);
    setRegenCount(0);
  };

  const handleRegenerate = () => {
    if (regenCount >= MAX_REGENS) {
      setShowPaywall(true);
      return;
    }
    setRegenCount(regenCount + 1);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.pageBg, ...font }}>
      <Navbar cartCount={cartCount} onLogoClick={reset} />

      {screen === "landing" && <Landing onStart={() => setScreen("upload")} />}
      {screen === "upload" && (
        <UploadScreen onNext={() => setScreen("style")} onBack={() => setScreen("landing")} />
      )}
      {screen === "style" && (
        <StyleScreen
          onGenerate={() => {
            setRegenCount(0);
            setScreen("grid");
          }}
          onBack={() => setScreen("upload")}
        />
      )}
      {screen === "grid" && (
        <GridScreen
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
