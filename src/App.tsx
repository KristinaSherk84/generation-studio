import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Upload, Check, X, ArrowLeft, RefreshCw, Loader2, Download, Maximize2, ChevronDown, User, Sparkles, CircleUser, ArrowDown, ArrowRight, Menu, Plus, ShoppingBag } from "lucide-react";
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

// Module-scope helper so all /api/generate callers (DownloadScreen's
// cross-style fetches included) can read the current unlock identifier
// off localStorage at request time. Returns the body fragment to merge
// into the fetch payload. Server is the gate; this is just transport.
function readUnlockRequestFields(): {
  stripeSessionId?: string;
  promoCode?: string;
} {
  if (typeof window === "undefined") return {};
  try {
    const source = window.localStorage.getItem("unlock_source");
    if (source === "promo") {
      const code = window.localStorage.getItem("promo_code");
      return code ? { promoCode: code } : {};
    }
    if (source === "stripe") {
      const sid = window.localStorage.getItem("stripe_session_id");
      return sid ? { stripeSessionId: sid } : {};
    }
    return {};
  } catch {
    return {};
  }
}

// User-facing error message for the 402 Payment Required response from
// /api/generate. Per Kristi 2026-05-15 — this is the exact wording.
const PAYWALL_EXPIRED_MESSAGE =
  "API Error: Your 2 hours to try the app has expired.";
// Note: above message also fires if the unlock was consumed by /api/deliver
// (the burn-on-download path). Same UX outcome — user re-pays $2.99.

// -------------------- Flow-step framework --------------------
// The user-facing journey is communicated as 5 numbered steps. The intro
// modal shows the full list before they begin; the Navbar shows dot
// progress on every screen; the LoadingScreen shows a step checklist
// while photos are generating. Adding the framework here as the single
// source of truth so all three surfaces stay in sync.
//
// Step → Screen mapping (see getStepFromScreen below):
//   1 (Upload)        → "upload"
//   2 (Pick style)    → "style"
//   3 (Pick favorites)→ "loading", "grid", "checkout"
//   4 (Retouch)       → reserved for the Path B Gemini Pro polish pass
//                       — currently transitions to step 5 immediately
//                       until that endpoint ships
//   5 (Download)      → "success"
const FLOW_STEPS: { label: string }[] = [
  { label: "Upload 5-8 cropped shots of your face" },
  { label: "Pick your styles: Backgrounds, Lighting, Outfit" },
  { label: "Pick the realistic headshots that look like you." },
  { label: "Choose your Retouching Level" },
  { label: "Download your New Headshots!" },
];

// Map a Screen value to the current 1-based step number (or null if no
// step is meaningful, e.g. landing/gallery). Centralized so we don't
// scatter step logic across components.
function getStepFromScreen(
  screen:
    | "landing"
    | "healthcare"
    | "how-it-works"
    | "gallery"
    | "upload"
    | "style"
    | "loading"
    | "grid"
    | "retouch"
    | "checkout"
    | "delivering"
    | "success",
): number | null {
  switch (screen) {
    case "upload":
      return 1;
    case "style":
      return 2;
    case "loading":
    case "grid":
      return 3;
    case "retouch":
    case "checkout":
      // Both retouch and checkout map to step 4 "Retouch your headshots"
      // in the 5-step framework. Checkout is the final commit before
      // the retouch pass actually fires server-side (in /api/deliver),
      // so it conceptually belongs in the same step.
      return 4;
    case "delivering":
      // The Stripe-redirect interstitial — payment is done, the delivery
      // pass is running. Step 5 ("Success") shows immediately after, so
      // mapping this to step 5 gives the customer the satisfying "final
      // dot lit up" feel during the 1-2 minute wait. (Added 2026-05-27.)
      return 5;
    case "success":
      return 5;
    default:
      return null;
  }
}

// 5-dot step indicator used in the Navbar. Past steps render filled
// with a checkmark; the current step renders filled with its number;
// future steps render as outlined circles. Compact enough to sit
// alongside the logo without crowding the brand on desktop. On narrow
// viewports (≤480px) the connector lines shrink so 5 dots still fit.
type StepIndicatorDotsProps = {
  currentStep: number; // 1-based
  totalSteps?: number;
};

const StepIndicatorDots = ({
  currentStep,
  totalSteps = FLOW_STEPS.length,
}: StepIndicatorDotsProps) => (
  <div
    aria-label={`Step ${currentStep} of ${totalSteps}: ${FLOW_STEPS[currentStep - 1]?.label ?? ""}`}
    style={{
      display: "flex",
      alignItems: "center",
      gap: 3,
    }}
  >
    {Array.from({ length: totalSteps }, (_, i) => {
      const stepNum = i + 1;
      const isPast = stepNum < currentStep;
      const isCurrent = stepNum === currentStep;
      const isFuture = stepNum > currentStep;
      const stepLabel = FLOW_STEPS[i]?.label ?? "";
      return (
        <div
          key={stepNum}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 3,
          }}
        >
          <div
            title={stepLabel}
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: isPast || isCurrent ? C.dark : "transparent",
              border: isFuture ? `1px solid ${C.lightGrey}` : "none",
              color: isPast || isCurrent ? C.white : C.mediumGrey,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 500,
              flexShrink: 0,
            }}
          >
            {isPast ? <Check size={11} strokeWidth={3} /> : stepNum}
          </div>
          {stepNum < totalSteps && (
            <div
              style={{
                width: 16,
                height: 1,
                background: stepNum < currentStep ? C.dark : C.lightGrey,
                flexShrink: 0,
              }}
            />
          )}
        </div>
      );
    })}
  </div>
);

// Vertical step checklist shown on the LoadingScreen so users can see
// where they are in the 5-step journey while their photos are being
// generated. Past steps render with a checkmark, the current step
// renders with a spinner, future steps render with an outlined circle.
// Compact card layout matches the existing LoadingScreen tip-carousel
// aesthetic (light-grey background, rounded corners, ~520px wide).
type GenerationStepsListProps = {
  currentStep: number; // 1-based; typically 3 while generating
};

const GenerationStepsList = ({ currentStep }: GenerationStepsListProps) => (
  <div
    style={{
      marginTop: 24,
      marginLeft: "auto",
      marginRight: "auto",
      maxWidth: 520,
      padding: "20px 22px",
      borderRadius: 8,
      background: C.white,
      border: `1px solid ${C.border}`,
      textAlign: "left",
    }}
  >
    <div
      style={{
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: 1.5,
        color: C.mediumGrey,
        textTransform: "uppercase",
        marginBottom: 14,
      }}
    >
      Where you are
    </div>
    {FLOW_STEPS.map((step, i) => {
      const stepNum = i + 1;
      const isPast = stepNum < currentStep;
      const isCurrent = stepNum === currentStep;
      return (
        <div
          key={stepNum}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            paddingTop: 8,
            paddingBottom: 8,
            opacity: isPast || isCurrent ? 1 : 0.5,
          }}
        >
          {/* Status icon — checkmark for done, spinner for current,
              empty circle for upcoming. Spinner uses the same keyframes
              already declared at the bottom of LoadingScreen. */}
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: isPast ? C.dark : "transparent",
              border: isPast ? "none" : `1.5px solid ${isCurrent ? C.dark : C.lightGrey}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              ...(isCurrent
                ? {
                    borderTopColor: "transparent",
                    animation: "spin 0.8s linear infinite",
                  }
                : {}),
            }}
          >
            {isPast && <Check size={12} color={C.white} strokeWidth={3} />}
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: isCurrent ? 500 : 400,
              color: C.dark,
            }}
          >
            {step.label}
          </div>
        </div>
      );
    })}
  </div>
);

// -------------------- Welcome popup with 2-hour countdown --------------------
//
// Fires the moment /api/verify-checkout confirms the $2.99 entry payment.
// Tells the customer the rules of the road: they have 2 hours, refund
// available, email Kristi for support. Includes a live ticking countdown
// so they SEE the 2 hours start visibly, not just as words on a screen.
//
// The expiresAt prop is the epoch-ms timestamp the server stamped onto
// the Stripe Checkout session metadata. The popup recomputes "remaining"
// every second from Date.now() so the countdown is always live and
// recovers correctly across tab close + reopen.

type WelcomeUnlockedModalProps = {
  expiresAt: number; // epoch ms; 4h from when the server confirmed payment
  onDismiss: () => void;
};

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0h 0m 0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

const WelcomeUnlockedModal = ({
  expiresAt,
  onDismiss,
}: WelcomeUnlockedModalProps) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remainingMs = expiresAt - now;
  const remainingText = formatRemaining(remainingMs);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Payment confirmed — your 2-hour session has started"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 1100,
        ...font,
      }}
    >
      <div
        style={{
          background: C.white,
          borderRadius: 12,
          padding: "32px 36px",
          maxWidth: 480,
          width: "100%",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: C.dark,
            color: C.white,
            margin: "0 auto 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Check size={26} strokeWidth={3} />
        </div>
        <h2
          style={{
            fontSize: 26,
            fontWeight: 500,
            color: C.dark,
            margin: "0 0 8px",
            lineHeight: 1.2,
          }}
        >
          You have 2 hours to try it out.
        </h2>
        <p
          style={{
            fontSize: 14,
            color: C.mediumGrey,
            margin: "0 0 22px",
            lineHeight: 1.6,
          }}
        >
          For issues, email me for a refund:{" "}
          <a
            href="mailto:kristi@kristinasherk.com"
            style={{ color: C.dark, fontWeight: 500 }}
          >
            kristi@kristinasherk.com
          </a>
        </p>

        {/* Live countdown — updates every second so the 2-hour clock is
            visible and unambiguous. Kept big and centered so it reads as
            the centerpiece of the popup. */}
        <div
          style={{
            background: C.pageBg,
            borderRadius: 10,
            padding: "18px 16px",
            marginBottom: 22,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: 1.5,
              color: C.mediumGrey,
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Time remaining
          </div>
          <div
            style={{
              fontSize: 32,
              fontWeight: 500,
              color: C.dark,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: -0.5,
            }}
          >
            {remainingText}
          </div>
        </div>

        <button
          onClick={onDismiss}
          style={{
            width: "100%",
            padding: "14px 24px",
            background: C.dark,
            color: C.buttonText,
            border: "none",
            borderRadius: 8,
            fontSize: 15,
            fontWeight: 500,
            cursor: "pointer",
            ...font,
          }}
        >
          Let's get started
        </button>
      </div>
    </div>
  );
};

// -------------------- 15-minute "winding down" warning modal --------------
//
// Fires exactly once per session when the 2-hour unlock crosses below
// 15 minutes remaining. Kristi 2026-05-15: chose this over a persistent
// header countdown chip because the chip ate too much screen real estate
// for a value that's irrelevant most of the time. One sharp prompt at
// the 15-minute mark is enough to let the user decide whether to wrap
// up or pay another $2.99 for a fresh try.

type SessionTimeWarningModalProps = {
  // Epoch ms — shown in the body so the user knows their actual deadline.
  expiresAt: number;
  onDismiss: () => void;
};

const SessionTimeWarningModal = ({
  expiresAt,
  onDismiss,
}: SessionTimeWarningModalProps) => {
  // Live-ticking remaining time so the displayed number is accurate the
  // whole time the modal is open (even if the user lingers on it).
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remainingMs = Math.max(0, expiresAt - now);
  const remainingText = formatRemaining(remainingMs);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="15 minutes left in your try-it session"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 1050,
        ...font,
      }}
    >
      <div
        style={{
          background: C.white,
          borderRadius: 12,
          padding: "28px 32px",
          maxWidth: 440,
          width: "100%",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: 1.5,
            color: "#A32D2D",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Heads up
        </div>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 500,
            color: C.dark,
            margin: "0 0 8px",
            lineHeight: 1.3,
          }}
        >
          About 15 minutes left in your session.
        </h2>
        <p
          style={{
            fontSize: 14,
            color: C.mediumGrey,
            margin: "0 0 18px",
            lineHeight: 1.6,
          }}
        >
          Your 2-hour try-it window ends in{" "}
          <span
            style={{
              fontWeight: 500,
              color: C.dark,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {remainingText}
          </span>
          . If you need more time after that, pay $2.99 to start a new session.
        </p>
        <button
          onClick={onDismiss}
          style={{
            width: "100%",
            padding: "12px 24px",
            background: C.dark,
            color: C.buttonText,
            border: "none",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
            ...font,
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
};

// -------------------- Intro-steps modal --------------------
// Full-screen modal shown ONCE per session when the user first arrives
// at the upload screen. Lays out all 5 numbered steps with a one-line
// description for each so customers know what they're signing up for
// before they start uploading. Dismissed by clicking "Let's get started";
// dismissal state is held at the App level so navigating back to landing
// and re-entering shows it again (fresh-session mental model — matches
// how the PhotographerTipsModal already behaves).
type IntroStepsModalProps = {
  onDismiss: () => void;
};

const IntroStepsModal = ({ onDismiss }: IntroStepsModalProps) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-label="How it works — 5 steps"
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
        padding: "32px 36px",
        maxWidth: 540,
        width: "100%",
        maxHeight: "90vh",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: 1.5,
          color: C.mediumGrey,
          textTransform: "uppercase",
          marginBottom: 8,
        }}
      >
        How it works
      </div>
      <h2
        style={{
          fontSize: 26,
          fontWeight: 500,
          color: C.dark,
          margin: "0 0 6px",
          lineHeight: 1.2,
        }}
      >
        5 quick steps to your new headshots
      </h2>
      <p
        style={{
          fontSize: 14,
          color: C.mediumGrey,
          margin: "0 0 22px",
          lineHeight: 1.5,
        }}
      >
        Most people finish in under 10 minutes.
      </p>
      <ol
        style={{
          listStyle: "none",
          padding: 0,
          margin: "0 0 24px",
        }}
      >
        {FLOW_STEPS.map((step, i) => (
          <li
            key={i}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 14,
              marginBottom: 14,
              paddingBottom: 14,
              borderBottom:
                i < FLOW_STEPS.length - 1 ? `1px solid ${C.border}` : "none",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: C.dark,
                color: C.white,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 500,
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              {i + 1}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  color: C.dark,
                  lineHeight: 1.4,
                }}
              >
                {step.label}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <button
        onClick={onDismiss}
        style={{
          width: "100%",
          padding: "14px 24px",
          background: C.dark,
          color: C.buttonText,
          border: "none",
          borderRadius: 8,
          fontSize: 15,
          fontWeight: 500,
          cursor: "pointer",
          ...font,
        }}
      >
        Let's get started
      </button>
    </div>
  </div>
);

// -------------------- Shared components --------------------

type NavbarProps = {
  cartCount?: number;
  onLogoClick?: () => void;
  // If set (1-based), replaces the "Selected (N)" indicator with the
  // 5-dot step progress UI. Null/undefined on screens where steps
  // aren't meaningful (e.g. landing) so we fall back to the cart count.
  currentStep?: number | null;
};

const Navbar = ({
  cartCount = 0,
  onLogoClick,
  currentStep,
}: NavbarProps) => (
  <div
    style={{
      height: 70,
      background: C.white,
      borderBottom: `1px solid ${C.border}`,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 32px",
      gap: 16,
      ...font,
    }}
  >
    <div
      onClick={onLogoClick}
      style={{
        fontWeight: 500,
        fontSize: 18,
        color: C.dark,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      Generation Studio
    </div>
    {/* Step indicator sits in the middle when we're inside the flow;
        the "Selected (N)" counter is preserved on the right so users
        still see their cart state on the grid screen. The 2-hour
        countdown chip used to live here too but was removed 2026-05-15
        — Kristi felt the persistent timer ate too much screen real
        estate. A single one-shot 15-minute warning modal (see
        SessionTimeWarningModal) handles the same notification need. */}
    {currentStep && <StepIndicatorDots currentStep={currentStep} />}
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
    title: "5–8 varied photos.",
    body: "Different expressions, angles, outfits. Include one close-crop — the AI mirrors your framing.",
  },
  {
    title: "Use the rear camera, not selfie.",
    body: "Selfie cameras are wide-angle and stretch your nose and face. Have a friend take it.",
  },
];

// Tips that cycle on the LoadingScreen while the 6 headshots are generating.
// Pulled from PHOTOG_TIPS so they stay in sync with the pre-upload modal,
// plus loading-specific tips. The user sees one tip for a few seconds, then
// it rotates to the next — turns the wait from "staring at a spinner" into
// "learning how to get a better result."
//
// Ordering note (2026-05-27): the first two tips are the only ones that
// are actionable RIGHT NOW (phone-lock + cellular). They're placed at the
// front of the array so they're the first thing a customer sees when the
// loading screen mounts at tipIndex=0. Wake Lock API (in LoadingScreen
// below) actively keeps the screen awake on supported browsers, but the
// tip is the fallback for Safari < 16.4 and older Android Chrome.
const LOADING_TIPS: { title: string; body: string }[] = [
  {
    title: "Don't let your phone go to sleep.",
    body: "If your screen locks during generation, your browser may interrupt the process and you'll have to start over. Keep the screen on for the next 30–60 seconds.",
  },
  {
    title: "Stay on WiFi if you can.",
    body: "Cellular connections can drop mid-generation. WiFi gives the most reliable results for getting all 6 headshots back cleanly.",
  },
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
        padding: "28px 36px",
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
          marginBottom: 8,
        }}
      >
        Photographer's tips
      </div>
      <h2
        style={{
          fontSize: 26,
          fontWeight: 500,
          color: C.dark,
          margin: "0 0 6px",
          letterSpacing: -0.5,
        }}
      >
        Before you upload
      </h2>
      <p
        style={{
          fontSize: 14,
          color: C.mediumGrey,
          marginTop: 0,
          marginBottom: 18,
          lineHeight: 1.5,
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
              gap: 14,
              marginBottom: 12,
              paddingBottom: 12,
              borderBottom: idx < PHOTOG_TIPS.length - 1 ? `1px solid ${C.border}` : "none",
            }}
          >
            <div
              style={{
                flexShrink: 0,
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: C.dark,
                color: C.white,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              {idx + 1}
            </div>
            <div>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  color: C.dark,
                  marginBottom: 2,
                }}
              >
                {tip.title}
              </div>
              <div style={{ fontSize: 13, color: C.mediumGrey, lineHeight: 1.5 }}>{tip.body}</div>
            </div>
          </li>
        ))}
      </ol>

      <div style={{ marginTop: 16 }}>
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
  // Fires after a valid promo code is verified server-side. Receives the
  // validated code so the App can persist it for /api/generate re-verification.
  onPromoUnlock: (code: string) => void;
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
// Filenames cycle through 8 SEO templates × 4 each (renamed 2026-05-11).
// Each template captures a different long-tail search variant. Google reads
// filenames + alt text as content hints — varying gives us coverage across
// the keyword cluster instead of stacking all weight on one term.
const GALLERY_PAIR_TEMPLATES = [
  { slug: "ai-headshot-generator-before-after", alt: "AI headshot generator before and after example" },
  { slug: "realistic-ai-headshot-example",      alt: "Realistic AI headshot example" },
  { slug: "professional-ai-headshot",           alt: "Professional AI headshot" },
  { slug: "ai-headshot-portrait",               alt: "AI headshot portrait" },
  { slug: "ai-headshot-before-and-after",       alt: "AI headshot before and after" },
  { slug: "ai-generated-headshot-example",      alt: "AI generated headshot example" },
  { slug: "ai-portrait-generator-result",       alt: "AI portrait generator result" },
  { slug: "professional-headshot-ai",           alt: "Professional headshot from AI generator" },
];

// Source list keyed by source-pair index 0..31. Each entry references the
// actual file on disk (filename has both template slug + index baked in).
const GALLERY_SOURCE: { src: string; alt: string }[] = Array.from(
  { length: 32 },
  (_, i) => {
    const tpl = GALLERY_PAIR_TEMPLATES[i % GALLERY_PAIR_TEMPLATES.length];
    return {
      src: `/marketing/gallery/${tpl.slug}-${String(i).padStart(2, "0")}.jpg`,
      alt: tpl.alt,
    };
  },
);

// 4-quarter interleave order. Same-person pairs tend to cluster in
// sequential source positions (Kristi often shoots the same model in
// multiple outfits), so pulling consecutive display positions from
// different quarters of the source array guarantees they're at least 8
// source-positions apart in the rendered strip + gallery. Deterministic
// so React keys are stable across renders.
const SHUFFLE_ORDER: number[] = (() => {
  const arr: number[] = [];
  for (let offset = 0; offset < 8; offset++) {
    for (let quarter = 0; quarter < 4; quarter++) {
      arr.push(offset + quarter * 8);
    }
  }
  return arr;
})();

const GALLERY_PAIRS: { src: string; alt: string }[] = SHUFFLE_ORDER.map(
  (sourceIdx) => GALLERY_SOURCE[sourceIdx],
);

// STRIP_DURATION_S constant was here until 2026-06-02. Removed when the
// home-page filmstrip was replaced by the HowItWorks section. The matching
// @keyframes film-strip-scroll CSS in LandingV2 was also removed.

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
// HeroFilmStrip component was here until 2026-06-02. Removed when the
// auto-scrolling filmstrip was replaced by the HowItWorks section on the
// home page (Clarity scroll data showed 30% of desktop visitors bounced
// at the filmstrip's scroll position). GALLERY_PAIRS data is still used
// by GalleryScreen for the full "Examples" gallery view.

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
        {GALLERY_PAIRS.map((pair) => (
          <a
            key={pair.src}
            href={pair.src}
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
              src={pair.src}
              alt={pair.alt}
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
        Generate 6 Headshots $2.99
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

// -------------------- HowItWorks section --------------------
//
// Added 2026-06-02 to replace the auto-scrolling filmstrip per Clarity
// scroll-depth data: 30% of desktop visitors dropped off between 20-25%
// scroll exactly where the filmstrip began. Hypothesis: heavy LCP +
// "this looks like a portfolio, not a tool" confusion. The three-step
// explainer below converts that scroll position from a dead zone into
// an active hand-off ("here's what you do").
//
// Layout: 3 horizontal columns on desktop, vertical stack on mobile.
// Each step has an illustrated icon-card + step-eyebrow + serif title +
// one-line descriptor. Step 2 uses an inverted forest-green card to
// signal "the magic happens here." Step 3 shows 2 of 6 headshot icons
// checked off — implies the customer pays only for what they keep.

type HowItWorksProps = {
  isMobile: boolean;
};

const HowItWorks = ({ isMobile }: HowItWorksProps) => {
  // Reusable inner sub-components keep the JSX below readable. None
  // need to be top-level because they're tied to this section's visual
  // language and never reused elsewhere.
  const stepEyebrow = (text: string) => (
    <div
      style={{
        display: "inline-block",
        fontSize: 10,
        letterSpacing: 1.6,
        textTransform: "uppercase",
        color: BRAND.gold,
        fontWeight: 500,
        marginBottom: 4,
      }}
    >
      {text}
    </div>
  );
  const stepTitle = (text: string) => (
    <div
      style={{
        fontFamily: SERIF_STACK,
        fontSize: isMobile ? 17 : 15,
        color: BRAND.charcoal,
        lineHeight: 1.4,
      }}
    >
      {text}
    </div>
  );
  const stepDescriptor = (text: string) => (
    <div
      style={{
        fontSize: isMobile ? 12 : 11,
        color: BRAND.subText,
        lineHeight: 1.5,
        marginTop: 6,
      }}
    >
      {text}
    </div>
  );

  // STEP 1 — pyramid of 5 selfie icons (2 + 2 + 1).
  const step1Card = (
    <div
      style={{
        width: isMobile ? 120 : 110,
        height: isMobile ? 160 : 150,
        margin: "0 auto",
        background: BRAND.white,
        border: `1.5px solid ${BRAND.charcoal}`,
        borderRadius: 14,
        padding: "10px 6px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
        }}
      >
        <div style={{ display: "flex", gap: 6 }}>
          <CircleUser size={isMobile ? 24 : 22} color={BRAND.gold} strokeWidth={1.5} />
          <CircleUser size={isMobile ? 24 : 22} color={BRAND.gold} strokeWidth={1.5} />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <CircleUser size={isMobile ? 24 : 22} color={BRAND.gold} strokeWidth={1.5} />
          <CircleUser size={isMobile ? 24 : 22} color={BRAND.gold} strokeWidth={1.5} />
        </div>
        <CircleUser size={isMobile ? 24 : 22} color={BRAND.gold} strokeWidth={1.5} />
      </div>
      <div
        style={{
          fontSize: 9,
          letterSpacing: 1,
          color: BRAND.subText,
          textTransform: "uppercase",
          marginTop: 6,
        }}
      >
        selfies
      </div>
    </div>
  );

  // STEP 2 — inverted forest-green processing card.
  const step2Card = (
    <div
      style={{
        width: isMobile ? 120 : 110,
        height: isMobile ? 160 : 150,
        margin: "0 auto",
        background: BRAND.forestGreen,
        borderRadius: 14,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
      }}
    >
      <Sparkles size={isMobile ? 44 : 40} color={BRAND.gold} strokeWidth={1.5} />
      <div
        style={{
          fontSize: 9,
          letterSpacing: 1,
          color: BRAND.gold,
          textTransform: "uppercase",
        }}
      >
        processing
      </div>
      <div style={{ display: "flex", gap: 3 }}>
        <div style={{ width: 4, height: 4, borderRadius: "50%", background: BRAND.gold }} />
        <div style={{ width: 4, height: 4, borderRadius: "50%", background: BRAND.gold, opacity: 0.5 }} />
        <div style={{ width: 4, height: 4, borderRadius: "50%", background: BRAND.gold, opacity: 0.25 }} />
      </div>
    </div>
  );

  // STEP 3 — 3x2 grid of 6 headshot icons; icons 1 and 5 have checkmarks.
  const headshotIcon = (checked: boolean, key: number) => (
    <div
      key={key}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <User size={isMobile ? 24 : 22} color={BRAND.forestGreen} strokeWidth={1.5} />
      {checked && (
        <div
          style={{
            position: "absolute",
            top: -4,
            right: -4,
            width: 13,
            height: 13,
            borderRadius: "50%",
            background: BRAND.forestGreen,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Check size={8} color={BRAND.white} strokeWidth={3} />
        </div>
      )}
    </div>
  );
  const step3Card = (
    <div
      style={{
        width: isMobile ? 120 : 110,
        height: isMobile ? 160 : 150,
        margin: "0 auto",
        background: BRAND.white,
        border: `1.5px solid ${BRAND.charcoal}`,
        borderRadius: 14,
        padding: "10px 6px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, auto)",
          gap: "8px 6px",
        }}
      >
        {headshotIcon(true, 0)}
        {headshotIcon(false, 1)}
        {headshotIcon(false, 2)}
        {headshotIcon(false, 3)}
        {headshotIcon(true, 4)}
        {headshotIcon(false, 5)}
      </div>
      <div
        style={{
          fontSize: 9,
          letterSpacing: 1,
          color: BRAND.forestGreen,
          textTransform: "uppercase",
          fontWeight: 500,
          marginTop: 4,
        }}
      >
        headshots
      </div>
    </div>
  );

  // Per-step column (card + eyebrow + title + descriptor).
  const stepColumn = (
    card: ReactNode,
    eyebrow: string,
    title: string,
    descriptor: string,
  ) => (
    <div style={{ textAlign: "center" }}>
      <div style={{ marginBottom: 14 }}>{card}</div>
      {stepEyebrow(eyebrow)}
      {stepTitle(title)}
      {stepDescriptor(descriptor)}
    </div>
  );

  return (
    <section
      id="how-it-works"
      style={{
        background: BRAND.cream,
        padding: isMobile ? "48px 20px" : "64px clamp(20px, 4vw, 56px)",
      }}
    >
      <div style={{ textAlign: "center", marginBottom: isMobile ? 28 : 36 }}>
        <h2
          style={{
            fontFamily: SANS_STACK,
            fontSize: isMobile ? 22 : "clamp(26px, 3vw, 36px)",
            fontWeight: 600,
            color: BRAND.gold,
            lineHeight: 1.15,
            margin: 0,
            letterSpacing: 2.4,
            textTransform: "uppercase",
          }}
        >
          How it works
        </h2>
        <p
          style={{
            fontSize: isMobile ? 14 : 16,
            color: BRAND.subText,
            margin: "12px 0 0",
            fontStyle: "italic",
            fontFamily: SERIF_STACK,
          }}
        >
          It's simpler than you think.
        </p>
      </div>

      {isMobile ? (
        // ----- Mobile: stacked vertically with down-arrows -----
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            gap: 20,
            maxWidth: 360,
            margin: "0 auto",
          }}
        >
          {stepColumn(step1Card, "Step one", "Upload a few selfies", "More variation = better results")}
          <div style={{ display: "flex", justifyContent: "center" }}>
            <ArrowDown size={20} color={BRAND.gold} strokeWidth={2} />
          </div>
          {stepColumn(step2Card, "Step two", "Choose your styles", "Facial mapping and style integration")}
          <div style={{ display: "flex", justifyContent: "center" }}>
            <ArrowDown size={20} color={BRAND.gold} strokeWidth={2} />
          </div>
          {stepColumn(step3Card, "Step three", "Download your headshots", "Pay only for what looks like you")}
        </div>
      ) : (
        // ----- Desktop: 3 columns with right-arrows between -----
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr auto 1fr",
            gap: 16,
            alignItems: "start",
            maxWidth: 880,
            margin: "0 auto",
          }}
        >
          {stepColumn(step1Card, "Step one", "Upload a few selfies", "More variation = better results")}
          <div style={{ display: "flex", justifyContent: "center", paddingTop: 70 }}>
            <ArrowRight size={22} color={BRAND.gold} strokeWidth={2} />
          </div>
          {stepColumn(step2Card, "Step two", "Choose your styles", "Facial mapping and style integration")}
          <div style={{ display: "flex", justifyContent: "center", paddingTop: 70 }}>
            <ArrowRight size={22} color={BRAND.gold} strokeWidth={2} />
          </div>
          {stepColumn(step3Card, "Step three", "Download your headshots", "Pay only for what looks like you")}
        </div>
      )}
    </section>
  );
};

type LandingV2Props = LandingProps & {
  // Navigate the customer to the /healthcare vertical landing page.
  // Wired into App.tsx, which sets the URL + screen state + clears any
  // stale entry-specialty so the healthcare flow starts clean. Added
  // 2026-05-27 alongside the Specialty nav dropdown.
  onNavigateHealthcare: () => void;
  onShowGallery: () => void;
  // Navigate to the /how-it-works dedicated explainer page. Added
  // 2026-06-02 alongside the home-page filmstrip → HowItWorks swap; the
  // "How it works" nav link now routes here instead of anchor-scrolling.
  onNavigateHowItWorks: () => void;
};

const LandingV2 = ({
  onStart,
  onPromoUnlock,
  onShowGallery,
  onNavigateHealthcare,
  onNavigateHowItWorks,
}: LandingV2Props) => {
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

  // Specialty dropdown nav state (added 2026-05-27). Houses the vertical
  // sub-pages — currently Healthcare (live) and Realtor (greyed out,
  // coming soon). Click trigger to toggle, click outside or hit Escape
  // to close. Visible on both desktop and mobile so vertical visitors
  // can self-route from the home page (the rest of the nav is hidden
  // on mobile but Specialty is the gateway to verticals, so it stays).
  const [specialtyOpen, setSpecialtyOpen] = useState(false);
  const specialtyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!specialtyOpen) return;
    const onDocClick = (e: globalThis.MouseEvent) => {
      const node = specialtyRef.current;
      if (node && !node.contains(e.target as Node)) {
        setSpecialtyOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSpecialtyOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [specialtyOpen]);

  // Mobile hamburger menu (added 2026-06-02). On mobile, the right-side
  // nav collapses into a single hamburger icon that, when tapped, opens
  // a single menu containing Specialty (with its sub-items inline),
  // How it works, and Examples. Replaces the previous mobile nav where
  // only Specialty was visible and How it works + Examples were hidden.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onDocClick = (e: globalThis.MouseEvent) => {
      const node = mobileMenuRef.current;
      if (node && !node.contains(e.target as Node)) {
        setMobileMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [mobileMenuOpen]);

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
        // Pass the validated code up so App stores it for /api/generate
        // to re-verify on every call (server-side check is what actually
        // gates access — localStorage is just for survival across refresh).
        setTimeout(() => onPromoUnlock(trimmed), 700);
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
      {/* Inline keyframes for the film-strip auto-scroll were here until
          2026-06-02. Removed alongside the HeroFilmStrip component when the
          home-page filmstrip was swapped for the static HowItWorks section.
          GalleryScreen has its own scoped keyframes for its own filmstrip. */}
      {/* ========== TOP NAV ========== */}
      <nav
        style={{
          height: 52,
          padding: "0 clamp(16px, 4vw, 56px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid #EFEAE0`,
          background: BRAND.white,
        }}
      >
        <Wordmark size={20} />
        {/* Nav links. Specialty dropdown is always shown (mobile + desktop)
            because it's the gateway to vertical landing pages — leaving
            mobile users with no way to reach /healthcare from the home
            page would defeat the point of the dropdown. "How it works"
            and "Examples" stay desktop-only since they push the wordmark
            off-edge on phones (the dropdown is much narrower).
            The "Start now" pill that used to live here was removed
            entirely 2026-05-04 — the big "CREATE MY HEADSHOTS" CTA below
            the hero is the primary conversion surface. */}
        {isMobile ? (
          // -------- Mobile: hamburger icon that opens a comprehensive menu --------
          <div ref={mobileMenuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={mobileMenuOpen}
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 6,
                display: "inline-flex",
                alignItems: "center",
                color: BRAND.charcoal,
              }}
            >
              {mobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
            </button>
            {mobileMenuOpen && (
              <div
                role="menu"
                aria-label="Site menu"
                style={{
                  position: "absolute",
                  top: "calc(100% + 10px)",
                  right: 0,
                  minWidth: 220,
                  background: BRAND.white,
                  border: `1px solid #EFEAE0`,
                  borderRadius: 8,
                  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.08)",
                  padding: 6,
                  zIndex: 50,
                }}
              >
                {/* SPECIALTY section header */}
                <div
                  style={{
                    fontSize: 10,
                    letterSpacing: 1.6,
                    textTransform: "uppercase",
                    color: BRAND.gold,
                    fontWeight: 600,
                    padding: "8px 12px 4px",
                  }}
                >
                  Specialty
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onNavigateHealthcare();
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "10px 12px",
                    fontSize: 14,
                    color: BRAND.charcoal,
                    fontFamily: SANS_STACK,
                    cursor: "pointer",
                    borderRadius: 4,
                  }}
                >
                  Healthcare
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled
                  aria-disabled="true"
                  style={{
                    display: "flex",
                    width: "100%",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    background: "transparent",
                    border: "none",
                    padding: "10px 12px",
                    fontSize: 14,
                    color: BRAND.charcoal,
                    opacity: 0.45,
                    fontFamily: SANS_STACK,
                    cursor: "not-allowed",
                    textAlign: "left",
                    borderRadius: 4,
                  }}
                >
                  <span>Realtor</span>
                  <span
                    style={{
                      fontSize: 10,
                      letterSpacing: 0.5,
                      textTransform: "uppercase",
                      color: BRAND.gold,
                      opacity: 0.85,
                      fontWeight: 500,
                    }}
                  >
                    Coming soon
                  </span>
                </button>
                {/* Divider */}
                <div
                  style={{
                    height: 1,
                    background: "#EFEAE0",
                    margin: "6px 6px",
                  }}
                />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onNavigateHowItWorks();
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "10px 12px",
                    fontSize: 14,
                    color: BRAND.charcoal,
                    fontFamily: SANS_STACK,
                    cursor: "pointer",
                    borderRadius: 4,
                  }}
                >
                  How it works
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onShowGallery();
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "10px 12px",
                    fontSize: 14,
                    color: BRAND.charcoal,
                    fontFamily: SANS_STACK,
                    cursor: "pointer",
                    borderRadius: 4,
                  }}
                >
                  Examples
                </button>
              </div>
            )}
          </div>
        ) : (
          // -------- Desktop: Specialty dropdown + How it works + Examples --------
          <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
            {/* Specialty dropdown — Healthcare (live) + Realtor (coming soon). */}
            <div ref={specialtyRef} style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => setSpecialtyOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={specialtyOpen}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 14,
                  color: BRAND.charcoal,
                  fontFamily: SANS_STACK,
                  padding: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  borderBottom: `1px solid ${BRAND.gold}`,
                  paddingBottom: 2,
                }}
              >
                Specialty
                <ChevronDown
                  size={14}
                  style={{
                    transform: specialtyOpen ? "rotate(180deg)" : "rotate(0)",
                    transition: "transform 0.15s",
                  }}
                />
              </button>
              {specialtyOpen && (
                <div
                  role="menu"
                  aria-label="Specialty options"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 10px)",
                    right: 0,
                    minWidth: 200,
                    background: BRAND.white,
                    border: `1px solid #EFEAE0`,
                    borderRadius: 8,
                    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.08)",
                    padding: 6,
                    zIndex: 50,
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setSpecialtyOpen(false);
                      onNavigateHealthcare();
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#F6F1E6";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      padding: "10px 12px",
                      fontSize: 14,
                      color: BRAND.charcoal,
                      fontFamily: SANS_STACK,
                      cursor: "pointer",
                      borderRadius: 4,
                      transition: "background 0.12s",
                    }}
                  >
                    Healthcare
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled
                    aria-disabled="true"
                    style={{
                      display: "flex",
                      width: "100%",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      background: "transparent",
                      border: "none",
                      padding: "10px 12px",
                      fontSize: 14,
                      color: BRAND.charcoal,
                      opacity: 0.45,
                      fontFamily: SANS_STACK,
                      cursor: "not-allowed",
                      textAlign: "left",
                      borderRadius: 4,
                    }}
                  >
                    <span>Realtor</span>
                    <span
                      style={{
                        fontSize: 10,
                        letterSpacing: 0.5,
                        textTransform: "uppercase",
                        color: BRAND.gold,
                        opacity: 0.85,
                        fontWeight: 500,
                      }}
                    >
                      Coming soon
                    </span>
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={onNavigateHowItWorks}
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
              How it works
            </button>
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
          // Bottom padding set to 0 so the filmstrip sits flush against
          // the hero photo with no gap (per Kristi 2026-05-11 — "remove
          // all padding between the hand and the film strip").
          padding: isMobile
            ? "12px 20px 0"
            : "16px clamp(20px, 4vw, 56px) 0",
          textAlign: "center",
        }}
      >
        {/* 2026-05-13 — restructured per generationheadshots-build-handoff
            now that Google Ads point directly at generationheadshots.com.
            Page needs to convert cold strangers (paid traffic), not just
            warm referrals from kristinasherk.com:
              - H1 shortened to plain "AI Headshot Generator" so the
                primary keyword leads
              - Italic H2 ("finally made by a real photographer") removed
              - Subhead rewritten as a single value-prop + guarantee
                paragraph that does the work the old H2 + subhead split
                used to do */}
        <h1
          style={{
            fontFamily: SERIF_STACK,
            fontSize: isMobile
              ? "clamp(28px, 7.5vw, 40px)"
              : "clamp(36px, 4.2vw, 56px)",
            fontWeight: 400,
            lineHeight: isMobile ? 1.12 : 1.15,
            letterSpacing: -0.3,
            color: BRAND.charcoal,
            margin: isMobile ? "0 auto 12px" : "0 auto 16px",
            maxWidth: 820,
          }}
        >
          AI Headshot Generator
        </h1>

        {/* Replacement subhead — combines the old italic H2 and old muted
            subhead into a single value-prop + guarantee paragraph. */}
        <p
          style={{
            fontSize: "clamp(15px, 1.4vw, 18px)",
            lineHeight: 1.55,
            color: BRAND.subText,
            maxWidth: 640,
            margin: isMobile ? "0 auto 18px" : "0 auto 24px",
          }}
        >
          Most AI headshot apps aren't made by actual headshot photographers.
          This one is. So your headshots look like you — or your money back.
          No more plastic skin and fake-looking headshots. Only pay for what
          truly looks like you.
        </p>

        {/* Primary CTA sits ABOVE the hero photo on both mobile and desktop
            (2026-05-11 — Kristi flagged that putting it below pushed the
            button under the fold). Smaller "lg" pill (was "xl" on desktop)
            so it doesn't dominate the composition above the photo.
            CTA TEXT: Hero uses the short action-verb variant per Kristi
            2026-06-02 — Clarity showed "Create my headshots" was the
            previously-most-clicked CTA. After-chart CTA keeps the
            price-anchored variant for the decision moment. */}
        <div style={{ marginBottom: isMobile ? 18 : 24 }}>
          <Pill onClick={onStart} size="lg">
            Create my headshots
          </Pill>
          <div
            style={{
              marginTop: 10,
              fontSize: isMobile ? 12 : 13,
              color: BRAND.subText,
              letterSpacing: 0.3,
            }}
          >
            Starts at <strong style={{ color: BRAND.charcoal }}>$2.99</strong> ·
            {isMobile ? " 5 min · Money-back" : " Money-back guarantee · 5 minutes"}
          </div>
        </div>

        {/* Hero photo of Kristi MOVED OUT of the hero section (2026-05-13).
            Per build-handoff: new page order is hero → filmstrip → trust
            strip → founder photo + personal note → promise. Photo +
            personal note now live in their own "Founder" section below
            the trust strip — the page flow goes hook → action → social
            proof → authority → founder face → trust story. */}
      </section>

      {/* ========== HOW IT WORKS (replaces the filmstrip 2026-06-02) ==========
          Replaced the auto-scrolling filmstrip per Clarity scroll-depth data
          showing 30% of desktop visitors bounced exactly at the filmstrip's
          scroll position (20-25% depth). The 3-step explainer converts that
          drop-off zone from passive eye-candy into an active hand-off
          ("here's how this works"). Gallery is still accessible via the
          Examples nav link + the "View all transformations" link below this
          section, so customers who want visual proof can still get it. */}
      <HowItWorks isMobile={isMobile} />

      {/* ========== GALLERY TEASER (added 2026-06-02) ==========
          Variant A from the mockup pass: single composite image
          (public/marketing/gallery-teaser-composite.jpg — 6 representative
          before/after pairs composited into one 1200x267 strip, 51KB) with
          a gradient overlay + serif caption + gold arrow. Whole card is
          clickable, routes to the full GalleryScreen. One image = one HTTP
          request — avoids the LCP problem the old auto-scrolling filmstrip
          had. The composite was built by _scripts via Pillow; to refresh
          the 6 featured photos, re-run that script (or ask Claude). */}
      <div
        id="examples"
        style={{
          padding: isMobile ? "0 16px 32px" : "0 clamp(20px, 4vw, 56px) 40px",
          background: BRAND.cream,
        }}
      >
        <button
          onClick={onShowGallery}
          aria-label="View the transformation gallery"
          style={{
            display: "block",
            width: "100%",
            maxWidth: 720,
            margin: "0 auto",
            border: "none",
            padding: 0,
            background: "transparent",
            cursor: "pointer",
            borderRadius: 12,
            overflow: "hidden",
            boxShadow: "0 6px 20px rgba(0, 0, 0, 0.08)",
            position: "relative",
            // The 1200x267 composite is 4.49:1 aspect, so the container
            // height auto-adapts to the width via the img element below.
          }}
        >
          <img
            src="/marketing/gallery-teaser-composite.jpg"
            alt="Six AI headshot transformations — view the full gallery"
            loading="lazy"
            decoding="async"
            style={{
              display: "block",
              width: "100%",
              height: "auto",
            }}
          />
          {/* Dark overlay — two-stop gradient so the photos stay readable
              at the top but the bottom (where the caption sits) is heavily
              darkened. Strengthened 2026-06-02 after Kristi noted the
              original gradient wasn't strong enough to make the white
              text pop against lighter photos. */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.2) 45%, rgba(0,0,0,0.78) 100%)",
              pointerEvents: "none",
            }}
          />
          {/* Caption — serif headline + gold arrow. Layered text shadow
              (a tight halo + a wider drop) gives a "ringed" black outline
              effect without needing a separate -webkit-text-stroke that
              renders inconsistently across browsers. */}
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              padding: isMobile ? "16px 16px 18px" : "20px 20px 24px",
              textAlign: "center",
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontFamily: SERIF_STACK,
                fontSize: isMobile ? 18 : 22,
                color: BRAND.white,
                textShadow:
                  "0 0 6px rgba(0,0,0,0.9), 0 2px 4px rgba(0,0,0,0.85), 0 4px 16px rgba(0,0,0,0.7)",
                letterSpacing: 0.3,
                lineHeight: 1.2,
                fontWeight: 500,
              }}
            >
              View the transformation gallery
              <span
                style={{
                  color: BRAND.gold,
                  textShadow:
                    "0 0 6px rgba(0,0,0,0.9), 0 2px 4px rgba(0,0,0,0.85)",
                }}
              >
                →
              </span>
            </span>
          </div>
        </button>
      </div>

      {/* ========== POST-HOWITWORKS CTA (added 2026-06-02) ==========
          Per Kristi: put a CTA right before the founder section so visitors
          who liked what they saw in HowItWorks can convert without having
          to scroll all the way through the trust strip + comparison chart.
          Uses the price-anchored variant so this slot reinforces the
          $2.99 entry point while the hero + promise CTAs use the simpler
          action-verb variant. Background stays cream to visually group
          with the HowItWorks section above. */}
      <section
        style={{
          background: BRAND.cream,
          textAlign: "center",
          padding: isMobile ? "8px 16px 56px" : "8px clamp(20px, 4vw, 56px) 72px",
        }}
      >
        <Pill onClick={onStart} size="lg">
          Generate 6 Headshots $2.99
        </Pill>
        <div
          style={{
            marginTop: 10,
            fontSize: 13,
            color: BRAND.subText,
            letterSpacing: 0.3,
          }}
        >
          Money-back guarantee · 5 minutes
        </div>
      </section>

      {/* ========== FOUNDER (photo + personal note) ==========
          Moved ABOVE the trust strip on 2026-06-02 per Kristi: on mobile
          the dark charcoal trust strip read as the page footer and stopped
          scroll. Putting the founder portrait + personal note here gives
          mobile visitors a face right after the action, and the (now
          lighter-treatment) trust strip below reads as a content row
          rather than the end of the page. */}
      <section
        style={{
          background: BRAND.white,
          padding: "clamp(56px, 8vw, 96px) clamp(20px, 4vw, 56px)",
        }}
      >
        <div
          style={{
            maxWidth: 720,
            margin: "0 auto",
            textAlign: "center",
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
            From the photographer
          </div>
          <div
            style={{
              width: "100%",
              maxWidth: isMobile ? 280 : 460,
              margin: "0 auto 28px",
            }}
          >
            <img
              src="/marketing/ai-headshot-photographer-kristi-sherk.png"
              alt="Kristi Sherk — AI headshot photographer with 20 years of experience, holding a professional camera"
              style={{
                width: "100%",
                height: "auto",
                display: "block",
              }}
            />
          </div>
          <p
            style={{
              fontFamily: SERIF_STACK,
              fontSize: "clamp(16px, 1.5vw, 19px)",
              lineHeight: 1.65,
              color: BRAND.charcoal,
              margin: 0,
              textAlign: "left",
            }}
          >
            I've spent two decades shooting professional headshots in DC.
            I've also had a lot of conversations about AI headshot generators
            — and frankly, most of them don't look like real people. So I put
            my 20 years of knowledge about lighting, posing, lens choice, and
            backgrounds into this one. The results are better than I expected.
            Other AI tools don't use actual photographers to build their
            products. This one does.
          </p>
          <div
            style={{
              fontFamily: SANS_STACK,
              fontSize: 13,
              letterSpacing: 0.4,
              color: BRAND.subText,
              marginTop: 16,
              fontStyle: "italic",
            }}
          >
            — Kristina Sherk
          </div>
        </div>
      </section>

      {/* ========== TRUST STRIP (light, restyled 2026-06-02) ==========
          Was a dark charcoal full-bleed band. Restyled to light cream
          with a subtle top + bottom border so it reads as a content row
          rather than the page footer (the dark version was killing
          mobile scroll because it visually closed the page). */}
      <section
        style={{
          background: BRAND.cream,
          color: BRAND.charcoal,
          padding: "48px clamp(20px, 4vw, 56px)",
          textAlign: "center",
          borderTop: `1px solid #EFEAE0`,
          borderBottom: `1px solid #EFEAE0`,
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
            marginBottom: 28,
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
                fontSize: "clamp(15px, 1.5vw, 20px)",
                fontWeight: 400,
                letterSpacing: 0.4,
                color: BRAND.charcoal,
                opacity: 0.78,
              }}
            >
              {brand}
            </div>
          ))}
        </div>
      </section>

      {/* ========== COMPARISON CHART ========== */}
      {/* Side-by-side feature/price comparison against the major AI
          headshot competitors. Added 2026-05-11 per Kristi's request,
          modeled on the InstaHeadshots "10 times better, 1/10th the price"
          chart format but multi-column to show GenerAItion winning across
          the whole field. Numbers verified against competitor audit; safer
          framings used where competitor data has tiers (e.g. "Tiered" for
          resolution rather than claiming "1K" outright — competitors
          have multiple resolution tiers and the precise base-tier number
          isn't always public). Per Kristi's prior decision: competitors
          may be named in factual comparison tables but not in URL slugs.
          Horizontal scroll on narrow viewports preserves the full table
          rather than collapsing to less-readable card stacks. */}
      <section
        style={{
          background: BRAND.white,
          padding: "clamp(56px, 8vw, 96px) clamp(16px, 4vw, 56px)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 2.4,
            textTransform: "uppercase",
            color: BRAND.gold,
            marginBottom: 14,
          }}
        >
          The Verdict
        </div>
        <h2
          style={{
            fontFamily: SERIF_STACK,
            fontSize: isMobile
              ? "clamp(24px, 6vw, 32px)"
              : "clamp(30px, 3.4vw, 46px)",
            fontWeight: 400,
            lineHeight: 1.2,
            letterSpacing: -0.3,
            color: BRAND.charcoal,
            maxWidth: 900,
            margin: "0 auto 14px",
          }}
        >
          Choose Us, the{" "}
          <span style={{ color: BRAND.gold, fontStyle: "italic" }}>
            Fastest, Greenest, Cheapest and Most Realistic
          </span>{" "}
          Headshot Generator.
        </h2>
        <p
          style={{
            fontSize: isMobile ? 14 : 16,
            color: BRAND.subText,
            maxWidth: 560,
            margin: "0 auto 36px",
            lineHeight: 1.55,
          }}
        >
          Compared to the most expensive AI headshot tools on the market today.
          Real numbers, no asterisks.
        </p>

        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            // Horizontal scroll on narrow viewports keeps the table readable
            // instead of stacking into less-scannable cards.
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
            border: `0.5px solid #EFEAE0`,
            borderRadius: 10,
          }}
        >
          <table
            style={{
              width: "100%",
              // Mobile: shrink minWidth so 3 columns (row label + GenerAItion +
              // 1 competitor) fit on a ~375px phone viewport — the 4th column
              // (second competitor) is reached via horizontal scroll. Desktop
              // keeps the original 720 minimum so the whole table reads at
              // once. Updated 2026-05-27 after Kristi noted only her column
              // was visible on phone screens.
              minWidth: isMobile ? 500 : 720,
              borderCollapse: "collapse",
              fontFamily: SANS_STACK,
              textAlign: "left",
              fontSize: isMobile ? 12 : 14,
            }}
          >
            <thead>
              <tr>
                <th style={{
                  padding: isMobile ? "12px 8px" : "16px 14px",
                  fontWeight: 500,
                  fontSize: 12,
                  color: BRAND.subText,
                  background: BRAND.cream,
                  borderBottom: `0.5px solid #EFEAE0`,
                  // Mobile: roughly-half-width row-label column so each cell
                  // wraps to ~2 lines, leaving more room for the 3 visible
                  // value columns. Padding tightened to recover content width.
                  // Desktop: keep the original auto-fit behavior.
                  // (Updated 2026-05-27 per Kristi — was 110px, now ~75px.)
                  width: isMobile ? 75 : "1%",
                  minWidth: isMobile ? 75 : undefined,
                  maxWidth: isMobile ? 75 : undefined,
                  whiteSpace: isMobile ? "normal" : "nowrap",
                  wordBreak: isMobile ? "normal" : undefined,
                  overflowWrap: isMobile ? "break-word" : undefined,
                  // Sticky-left so the row labels stay visible as the user
                  // scrolls horizontally to see the 4th column. Mobile only —
                  // on desktop the whole table fits without scrolling.
                  position: isMobile ? "sticky" : "static",
                  left: 0,
                  zIndex: 2,
                }}></th>
                <th style={{
                  padding: isMobile ? "12px 10px" : "16px 14px",
                  background: "#F4F8F4",
                  borderBottom: `2px solid ${BRAND.forestGreen}`,
                  borderLeft: `2px solid ${BRAND.forestGreen}`,
                  borderRight: `2px solid ${BRAND.forestGreen}`,
                  borderTop: `2px solid ${BRAND.forestGreen}`,
                  textAlign: "left",
                  minWidth: isMobile ? 130 : undefined,
                }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 1.4,
                    textTransform: "uppercase",
                    color: BRAND.forestGreen,
                  }}>
                    Our tool
                  </div>
                  <div style={{
                    fontFamily: SERIF_STACK,
                    fontSize: 17,
                    fontWeight: 500,
                    color: BRAND.forestGreen,
                    marginTop: 4,
                  }}>
                    GenerAItion
                    <span style={{
                      display: "inline-block",
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: 1.2,
                      textTransform: "uppercase",
                      color: BRAND.white,
                      background: BRAND.forestGreen,
                      padding: "2px 6px",
                      borderRadius: 3,
                      marginLeft: 6,
                      verticalAlign: "middle",
                      fontFamily: SANS_STACK,
                    }}>
                      Best
                    </span>
                  </div>
                </th>
                <th style={{
                  padding: isMobile ? "12px 10px" : "16px 14px",
                  background: BRAND.cream,
                  borderBottom: `0.5px solid #EFEAE0`,
                  textAlign: "left",
                  minWidth: isMobile ? 130 : undefined,
                }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 1.4,
                    textTransform: "uppercase",
                    color: BRAND.subText,
                  }}>
                    Competitor
                  </div>
                  <div style={{
                    fontFamily: SERIF_STACK,
                    fontSize: isMobile ? 14 : 17,
                    fontWeight: 500,
                    color: BRAND.charcoal,
                    marginTop: 4,
                  }}>
                    HeadshotPro
                  </div>
                </th>
                <th style={{
                  padding: isMobile ? "12px 10px" : "16px 14px",
                  background: BRAND.cream,
                  borderBottom: `0.5px solid #EFEAE0`,
                  textAlign: "left",
                  minWidth: isMobile ? 130 : undefined,
                }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 1.4,
                    textTransform: "uppercase",
                    color: BRAND.subText,
                  }}>
                    Competitor
                  </div>
                  <div style={{
                    fontFamily: SERIF_STACK,
                    fontSize: isMobile ? 14 : 17,
                    fontWeight: 500,
                    color: BRAND.charcoal,
                    marginTop: 4,
                  }}>
                    InstaHeadshots
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {([
                {
                  label: "Starting price",
                  us: "$12.98",
                  usSub: "Session + 1 keeper. Pay for what you love.",
                  values: ["$29", "$44+"],
                  valuesSub: ["40-pack bundle — keep or not.", "100-pack bundle — keep or not."],
                  usWins: true,
                },
                {
                  label: "Processing time",
                  us: "Under 5 min",
                  usSub: "",
                  values: ["30 min", "15 min"],
                  valuesSub: ["", ""],
                  usWins: true,
                },
                {
                  label: "Environmental impact",
                  us: "6 generations",
                  usSub: "Up to 16× less AI processing.",
                  values: ["40+ generations", "100 generations"],
                  valuesSub: ["~7× more energy per session.", "~16× more energy per session."],
                  usWins: true,
                },
                {
                  label: "2K resolution",
                  us: "Included",
                  usSub: "",
                  values: ["Premium tier", "Premium tier"],
                  valuesSub: ["Paid upgrade.", "Paid upgrade."],
                  usWins: true,
                },
                {
                  label: "Made by a real photographer",
                  us: "Yes — 20 years",
                  usSub: "Lighting + posing baked into the prompts.",
                  values: ["No", "No"],
                  valuesSub: ["Built by coders.", "Built by coders."],
                  usWins: true,
                },
                {
                  label: "Money-back guarantee",
                  us: "Yes",
                  usSub: "",
                  values: ["Yes", "Yes"],
                  valuesSub: ["", ""],
                  usWins: false,
                },
              ] as const).map((row, rowIdx, rows) => {
                const isLast = rowIdx === rows.length - 1;
                const cellBorder = isLast ? "none" : `0.5px solid #EFEAE0`;
                return (
                  <tr key={row.label}>
                    <td style={{
                      padding: isMobile ? "12px 8px" : "14px",
                      color: BRAND.subText,
                      fontWeight: 500,
                      borderBottom: cellBorder,
                      whiteSpace: isMobile ? "normal" : "nowrap",
                      verticalAlign: "top",
                      // Sticky-left so the row label stays visible as the
                      // user scrolls the table horizontally. Background must
                      // be opaque or the scrolling cells would show through.
                      // Mobile-only — desktop fits the whole table at once.
                      position: isMobile ? "sticky" : "static",
                      left: 0,
                      zIndex: 1,
                      background: BRAND.white,
                      // Match the header cell width (~75px on mobile) so
                      // labels wrap to ~2 lines instead of stretching the
                      // column wide. (Updated 2026-05-27 per Kristi.)
                      width: isMobile ? 75 : undefined,
                      minWidth: isMobile ? 75 : undefined,
                      maxWidth: isMobile ? 75 : undefined,
                      overflowWrap: isMobile ? "break-word" : undefined,
                      lineHeight: isMobile ? 1.3 : undefined,
                    }}>
                      {row.label}
                    </td>
                    <td style={{
                      padding: isMobile ? "12px 10px" : "14px",
                      borderBottom: cellBorder,
                      borderLeft: `2px solid ${BRAND.forestGreen}`,
                      borderRight: `2px solid ${BRAND.forestGreen}`,
                      background: "#F4F8F4",
                      verticalAlign: "top",
                      minWidth: isMobile ? 130 : undefined,
                    }}>
                      <span style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        color: BRAND.forestGreen,
                        fontWeight: 600,
                      }}>
                        {row.usWins && (
                          <span
                            aria-hidden="true"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 14,
                              height: 14,
                              borderRadius: "50%",
                              background: BRAND.forestGreen,
                              color: BRAND.white,
                              fontSize: 9,
                              fontWeight: 700,
                              lineHeight: 1,
                            }}
                          >
                            ✓
                          </span>
                        )}
                        {row.us}
                      </span>
                      {row.usSub && (
                        <div style={{
                          fontSize: 11,
                          color: BRAND.forestGreen,
                          opacity: 0.8,
                          marginTop: 4,
                          fontWeight: 500,
                          lineHeight: 1.4,
                        }}>
                          {row.usSub}
                        </div>
                      )}
                    </td>
                    {row.values.map((v, i) => (
                      <td key={i} style={{
                        padding: isMobile ? "12px 10px" : "14px",
                        color: BRAND.charcoal,
                        borderBottom: cellBorder,
                        verticalAlign: "top",
                        minWidth: isMobile ? 130 : undefined,
                      }}>
                        <div>{v}</div>
                        {row.valuesSub[i] && (
                          <div style={{
                            fontSize: 11,
                            color: "#8a8782",
                            marginTop: 4,
                            lineHeight: 1.4,
                          }}>
                            {row.valuesSub[i]}
                          </div>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* After-comparison-chart CTA was removed 2026-06-02 per Kristi.
            The conversion slot moved up the page to right before the
            Founder section. The Promise Band below still has a CTA at
            the end of the page so visitors who scroll all the way still
            have an action surface. */}
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
          $2.99 to start your session. $9.99 per Basic keeper, or $14.99 for the
          Glow Up Deluxe Bundle — smoother skin + magazine-style polish across
          3 retouched versions (just $5 more than Basic). No surprise fees, no
          charges for headshots that don't look like you.
        </p>
        {/* Promise-band CTA uses the short action variant per 2026-06-02
            CTA-variation pass. After-chart CTA above this section is the
            price-anchored one. */}
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

// -------------------- Screen 1b: Healthcare vertical landing --------------------
//
// /healthcare — vertical-specific landing page for medical professionals.
// Same brand language as LandingV2 but tuned for the audience:
//   - Medical-only filmstrip (7 pairs, composited large-AFTER + circular-BEFORE
//     inset matching the home page filmstrip style).
//   - Time-savings copy ("about 1% the cost of an in-person session").
//   - "Recommended settings" block that points visitors to the Healthcare
//     option on Background AND Attire when they land on the style screen.
//   - Click any pair card → full-screen lightbox showing the separate BEFORE
//     and AFTER images side-by-side (stacked on mobile) for a real comparison.
//
// Reachable at the URL path /healthcare (App reads window.location.pathname
// on mount + listens for popstate; vercel.json has a rewrite so direct visits
// serve the SPA). Not currently linked from LandingV2 nav — discoverable via
// search + ads + (future) sitemap.

const HEALTHCARE_PAIRS: { composite: string; before: string; after: string; alt: string }[] = [
  {
    composite: "/marketing/healthcare/web/ai-headshot-for-doctors-1.jpg",
    before: "/marketing/healthcare/web/ai-headshot-for-doctors-1-before.jpg",
    after: "/marketing/healthcare/web/ai-headshot-for-doctors-1-after.jpg",
    alt: "AI headshot for doctors — before and after",
  },
  {
    composite: "/marketing/healthcare/web/ai-physician-headshot-1.jpg",
    before: "/marketing/healthcare/web/ai-physician-headshot-1-before.jpg",
    after: "/marketing/healthcare/web/ai-physician-headshot-1-after.jpg",
    alt: "AI physician headshot — before and after",
  },
  {
    composite: "/marketing/healthcare/web/doctor-headshot-generator-1.jpg",
    before: "/marketing/healthcare/web/doctor-headshot-generator-1-before.jpg",
    after: "/marketing/healthcare/web/doctor-headshot-generator-1-after.jpg",
    alt: "Doctor headshot from AI generator — before and after",
  },
  {
    composite: "/marketing/healthcare/web/ai-medical-headshot-1.jpg",
    before: "/marketing/healthcare/web/ai-medical-headshot-1-before.jpg",
    after: "/marketing/healthcare/web/ai-medical-headshot-1-after.jpg",
    alt: "AI medical headshot — before and after",
  },
  {
    composite: "/marketing/healthcare/web/ai-headshot-for-medical-professionals-1.jpg",
    before: "/marketing/healthcare/web/ai-headshot-for-medical-professionals-1-before.jpg",
    after: "/marketing/healthcare/web/ai-headshot-for-medical-professionals-1-after.jpg",
    alt: "AI headshot for medical professionals — before and after",
  },
  {
    composite: "/marketing/healthcare/web/healthcare-headshot-ai-1.jpg",
    before: "/marketing/healthcare/web/healthcare-headshot-ai-1-before.jpg",
    after: "/marketing/healthcare/web/healthcare-headshot-ai-1-after.jpg",
    alt: "Healthcare headshot from AI — before and after",
  },
  {
    composite: "/marketing/healthcare/web/medical-professional-headshot-ai-1.jpg",
    before: "/marketing/healthcare/web/medical-professional-headshot-ai-1-before.jpg",
    after: "/marketing/healthcare/web/medical-professional-headshot-ai-1-after.jpg",
    alt: "Medical professional headshot — AI generated",
  },
];

// Strip displays 7 pairs × 2 copies for the seamless infinite loop. Slightly
// faster than the home page strip because there are fewer pairs to cycle.
const HEALTHCARE_STRIP_DURATION_S = 35;

// Lightbox overlay shown when a healthcare filmstrip card is clicked. Renders
// the separate BEFORE and AFTER images side-by-side (auto-stacks on narrow
// screens via grid auto-fit) at a much larger size than the strip card. Esc
// key, X button, and clicking the dark backdrop all close it.
type HealthcareLightboxProps = {
  pair: typeof HEALTHCARE_PAIRS[number] | null;
  onClose: () => void;
};
const HealthcareLightbox = ({ pair, onClose }: HealthcareLightboxProps) => {
  useEffect(() => {
    if (!pair) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Lock body scroll while the lightbox is open so the background page
    // doesn't move behind the overlay on mobile.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [pair, onClose]);

  if (!pair) return null;

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={pair.alt}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.92)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "clamp(16px, 4vw, 56px)",
        overflowY: "auto",
      }}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        style={{
          position: "absolute",
          top: 24,
          right: 24,
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.12)",
          border: "1px solid rgba(255,255,255,0.25)",
          color: BRAND.white,
          fontSize: 22,
          lineHeight: 1,
          cursor: "pointer",
          zIndex: 1,
        }}
      >
        ×
      </button>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 1400,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(380px,100%), 1fr))",
          gap: 24,
        }}
      >
        <figure style={{ margin: 0 }}>
          <img
            src={pair.before}
            alt={`Before — ${pair.alt}`}
            style={{
              width: "100%",
              height: "auto",
              maxHeight: "82vh",
              objectFit: "contain",
              borderRadius: 8,
              display: "block",
            }}
          />
          <figcaption
            style={{
              marginTop: 12,
              textAlign: "center",
              color: BRAND.white,
              fontFamily: SANS_STACK,
              fontSize: 13,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              opacity: 0.85,
            }}
          >
            Before — phone selfie
          </figcaption>
        </figure>
        <figure style={{ margin: 0 }}>
          <img
            src={pair.after}
            alt={`After — ${pair.alt}`}
            style={{
              width: "100%",
              height: "auto",
              maxHeight: "82vh",
              objectFit: "contain",
              borderRadius: 8,
              display: "block",
            }}
          />
          <figcaption
            style={{
              marginTop: 12,
              textAlign: "center",
              color: BRAND.white,
              fontFamily: SANS_STACK,
              fontSize: 13,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              opacity: 0.85,
            }}
          >
            After — AI-generated
          </figcaption>
        </figure>
      </div>
    </div>
  );
};

type HealthcareScreenProps = {
  onStart: () => void;
  onBackToHome: () => void;
  // Wired to App.tsx's handlePromoUnlock — same handler LandingV2 uses.
  // Lets a healthcare-vertical visitor enter a promo code without having
  // to detour through the home page. Added 2026-05-27.
  onPromoUnlock: (code: string) => void;
};
const HealthcareScreen = ({
  onStart,
  onBackToHome,
  onPromoUnlock,
}: HealthcareScreenProps) => {
  const [openPair, setOpenPair] = useState<typeof HEALTHCARE_PAIRS[number] | null>(null);

  // Promo code reveal — mirrors the LandingV2 footer pattern so a
  // healthcare visitor can apply a code without leaving /healthcare.
  // Added 2026-05-27.
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
        // Brief checkmark pause before transitioning so the visitor sees
        // the success state, then App routes them straight to Upload.
        setTimeout(() => onPromoUnlock(trimmed), 700);
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
      {/* TOP NAV — Wordmark links back to home, Start CTA on the right */}
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
          onClick={onBackToHome}
          aria-label="Back to home"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <Wordmark size={20} />
        </button>
        <Pill onClick={onStart} variant="primary" size="sm">
          Start now
        </Pill>
      </nav>

      {/* HERO — centered text, no photo (filmstrip is the visual below) */}
      <section
        style={{
          padding: "clamp(48px, 9vw, 112px) clamp(16px, 4vw, 56px) clamp(32px, 6vw, 64px)",
          textAlign: "center",
          maxWidth: 980,
          margin: "0 auto",
        }}
      >
        <h1
          style={{
            fontFamily: SERIF_STACK,
            fontWeight: 400,
            fontSize: "clamp(34px, 5.4vw, 64px)",
            lineHeight: 1.05,
            letterSpacing: -0.5,
            margin: "0 0 16px",
            color: BRAND.charcoal,
          }}
        >
          AI Headshots for Healthcare Professionals
        </h1>
        <p
          style={{
            fontFamily: SERIF_STACK,
            fontStyle: "italic",
            fontSize: "clamp(18px, 2.2vw, 24px)",
            lineHeight: 1.4,
            color: BRAND.subText,
            margin: "0 0 28px",
          }}
        >
          realistic ai headshots, made by an actual photographer.
        </p>
        <p
          style={{
            fontSize: "clamp(15px, 1.6vw, 18px)",
            lineHeight: 1.6,
            color: BRAND.bodyText,
            maxWidth: 720,
            margin: "0 auto 36px",
          }}
        >
          Three lab coats, three colored scrubs, all of you. Ready in under five minutes
          — for about 1% the cost of an in-person session.
        </p>
        <Pill onClick={onStart} variant="primary" size="lg">
          Generate 6 Headshots $2.99
        </Pill>
        {/* Price clarification under the hero CTA. Customers don't "get" the
            6 previews — they pay $2.99 to try, then $9.99 per keeper they
            actually want to download. This line prevents an over-promise
            that would damage trust at the checkout screen. */}
        <p
          style={{
            marginTop: 16,
            fontSize: 14,
            lineHeight: 1.5,
            color: BRAND.subText,
            maxWidth: 480,
            margin: "16px auto 0",
          }}
        >
          Only buy what looks like you. Downloads starting at $9.99.
        </p>
      </section>

      {/* MEDICAL FILMSTRIP — 7 composited pairs, infinite scroll, click to enlarge */}
      <section style={{ padding: "0 0 clamp(32px, 6vw, 64px)" }}>
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
            className="hc-strip-track"
            style={{
              display: "flex",
              gap: 16,
              width: "max-content",
              animation: `hc-strip-scroll ${HEALTHCARE_STRIP_DURATION_S}s linear infinite`,
            }}
          >
            {[...HEALTHCARE_PAIRS, ...HEALTHCARE_PAIRS].map((pair, i) => (
              <button
                key={i}
                onClick={() => setOpenPair(pair)}
                aria-label={`Open ${pair.alt}`}
                style={{
                  flex: "0 0 auto",
                  width: "clamp(220px, 24vw, 360px)",
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
                  src={pair.composite}
                  alt={pair.alt}
                  loading="eager"
                  fetchPriority={i < 5 ? "high" : "auto"}
                  decoding="async"
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
        <p
          style={{
            textAlign: "center",
            marginTop: 20,
            fontSize: 13,
            color: BRAND.subText,
            letterSpacing: 0.3,
          }}
        >
          Real selfies, transformed. Tap any pair to enlarge.
        </p>
      </section>

      {/* WHAT YOU GET — cream section, gold bullet dots, short lines */}
      <section
        style={{
          background: BRAND.cream,
          padding: "clamp(56px, 9vw, 112px) clamp(16px, 4vw, 56px)",
        }}
      >
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <h2
            style={{
              fontFamily: SERIF_STACK,
              fontWeight: 400,
              fontSize: "clamp(28px, 4vw, 44px)",
              lineHeight: 1.15,
              color: BRAND.charcoal,
              margin: "0 0 28px",
              textAlign: "center",
            }}
          >
            What you get
          </h2>
          <div
            style={{
              display: "grid",
              gap: 18,
              fontSize: 17,
              lineHeight: 1.55,
              color: BRAND.bodyText,
            }}
          >
            {[
              "Six previews to choose from — three in lab coats, three in scrubs in different colors.",
              "2K resolution. The same file size I deliver to my in-person clients.",
              "Tailored to your specialty and your look.",
              "Done in under five minutes.",
            ].map((line, i) => (
              <div key={i} style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                <span
                  aria-hidden
                  style={{
                    flex: "0 0 auto",
                    width: 8,
                    height: 8,
                    marginTop: 12,
                    borderRadius: "50%",
                    background: BRAND.gold,
                  }}
                />
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* WHY IT WORKS — centered first-person credibility */}
      <section
        style={{
          padding: "clamp(56px, 9vw, 112px) clamp(16px, 4vw, 56px)",
        }}
      >
        <div style={{ maxWidth: 720, margin: "0 auto", textAlign: "center" }}>
          <p
            style={{
              fontFamily: SANS_STACK,
              fontSize: 12,
              letterSpacing: 2.5,
              textTransform: "uppercase",
              color: BRAND.gold,
              margin: "0 0 14px",
            }}
          >
            Why it works
          </p>
          <h2
            style={{
              fontFamily: SERIF_STACK,
              fontWeight: 400,
              fontSize: "clamp(26px, 3.6vw, 40px)",
              lineHeight: 1.18,
              color: BRAND.charcoal,
              margin: "0 0 28px",
            }}
          >
            Twenty years behind the camera, baked into every generation.
          </h2>
          <p
            style={{
              fontSize: 17,
              lineHeight: 1.65,
              color: BRAND.bodyText,
              margin: 0,
            }}
          >
            I'm Kristina Sherk — a portrait photographer with over 20 years behind the
            camera and 400+ five-star Google reviews on KristinaSherk.com. Across that
            career I've photographed hundreds of physicians and healthcare professionals.
            The lighting, posing, and retouching that make my in-person headshots work
            are baked into every generation this app produces.
          </p>
        </div>
      </section>

      {/* RECOMMENDED SETTINGS — visual guide to picking Healthcare in app */}
      <section
        style={{
          background: BRAND.cream,
          padding: "clamp(56px, 9vw, 112px) clamp(16px, 4vw, 56px)",
        }}
      >
        <div style={{ maxWidth: 780, margin: "0 auto" }}>
          <p
            style={{
              fontFamily: SANS_STACK,
              fontSize: 12,
              letterSpacing: 2.5,
              textTransform: "uppercase",
              color: BRAND.gold,
              textAlign: "center",
              margin: "0 0 14px",
            }}
          >
            Recommended settings
          </p>
          <h2
            style={{
              fontFamily: SERIF_STACK,
              fontWeight: 400,
              fontSize: "clamp(26px, 3.6vw, 40px)",
              lineHeight: 1.18,
              color: BRAND.charcoal,
              textAlign: "center",
              margin: "0 0 36px",
            }}
          >
            When you get to the style screen, pick these.
          </h2>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 24,
              marginBottom: 28,
            }}
          >
            {/* Card 1: Background = Healthcare */}
            <div
              style={{
                background: BRAND.white,
                border: `1px solid #EFEAE0`,
                borderRadius: 10,
                padding: "32px 24px 28px",
                textAlign: "center",
              }}
            >
              <p
                style={{
                  fontSize: 11,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  color: BRAND.subText,
                  margin: "0 0 22px",
                }}
              >
                Background
              </p>
              {/* Mini-mockup of the Healthcare background tile (matches app's
                  actual chip look — light blue/teal swatch with a person icon),
                  ringed in forest green with a green checkmark badge to signal
                  "this is the one to pick" */}
              <div
                style={{
                  width: 96,
                  height: 96,
                  margin: "0 auto 16px",
                  borderRadius: 8,
                  background: "#C8D7DE",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: `2px solid ${BRAND.forestGreen}`,
                  position: "relative",
                  boxShadow: `0 0 0 4px ${BRAND.white}, 0 0 0 6px ${BRAND.forestGreen}33`,
                }}
              >
                <svg width="44" height="44" viewBox="0 0 24 24" fill="#6E7E84" aria-hidden="true">
                  <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                </svg>
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: -8,
                    right: -8,
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    background: BRAND.forestGreen,
                    color: BRAND.white,
                    fontSize: 15,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 600,
                  }}
                >
                  ✓
                </span>
              </div>
              <p
                style={{
                  fontFamily: SERIF_STACK,
                  fontSize: 20,
                  color: BRAND.charcoal,
                  margin: 0,
                }}
              >
                Healthcare
              </p>
            </div>

            {/* Card 2: Attire = Healthcare */}
            <div
              style={{
                background: BRAND.white,
                border: `1px solid #EFEAE0`,
                borderRadius: 10,
                padding: "32px 24px 28px",
                textAlign: "center",
              }}
            >
              <p
                style={{
                  fontSize: 11,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  color: BRAND.subText,
                  margin: "0 0 22px",
                }}
              >
                Attire
              </p>
              {/* Mini-mockup of the Healthcare attire pill (stethoscope icon +
                  "Healthcare" label), ringed in forest green w/ checkmark */}
              <div style={{ position: "relative", display: "inline-block", margin: "0 0 26px" }}>
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "12px 22px",
                    borderRadius: 999,
                    background: BRAND.white,
                    border: `2px solid ${BRAND.forestGreen}`,
                    boxShadow: `0 0 0 4px ${BRAND.forestGreen}22`,
                  }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={BRAND.charcoal}
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M6 3v6a5 5 0 0 0 10 0V3" />
                    <path d="M5 3h2M17 3h2" />
                    <circle cx="20" cy="14" r="2" />
                    <path d="M11 14v3a4 4 0 0 0 8 0v-1" />
                  </svg>
                  <span
                    style={{
                      fontFamily: SANS_STACK,
                      fontSize: 15,
                      color: BRAND.charcoal,
                    }}
                  >
                    Healthcare
                  </span>
                </div>
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: -10,
                    right: -10,
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    background: BRAND.forestGreen,
                    color: BRAND.white,
                    fontSize: 15,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 600,
                  }}
                >
                  ✓
                </span>
              </div>
              <p
                style={{
                  fontFamily: SERIF_STACK,
                  fontSize: 20,
                  color: BRAND.charcoal,
                  margin: 0,
                }}
              >
                Healthcare
              </p>
            </div>
          </div>
          <p
            style={{
              textAlign: "center",
              fontSize: 15,
              lineHeight: 1.6,
              color: BRAND.subText,
              margin: 0,
            }}
          >
            On the style screen, choose Healthcare for both — that's tuned for lab
            coats and scrubs.
          </p>
        </div>
      </section>

      {/* CLOSING CTA */}
      <section
        style={{
          padding: "clamp(72px, 11vw, 144px) clamp(16px, 4vw, 56px)",
          textAlign: "center",
        }}
      >
        <h2
          style={{
            fontFamily: SERIF_STACK,
            fontWeight: 400,
            fontSize: "clamp(32px, 5vw, 56px)",
            lineHeight: 1.1,
            color: BRAND.charcoal,
            margin: "0 0 32px",
          }}
        >
          Ready when you are.
        </h2>
        <Pill onClick={onStart} variant="primary" size="lg">
          Generate 6 Headshots $2.99
        </Pill>
      </section>

      {/* FOOTER — charcoal block matching home page */}
      <footer
        style={{
          background: BRAND.charcoal,
          color: "rgba(255,255,255,0.7)",
          padding: "clamp(32px, 5vw, 56px) clamp(16px, 4vw, 56px)",
          textAlign: "center",
          fontSize: 13,
        }}
      >
        <div style={{ marginBottom: 12 }}>
          <span style={{ color: BRAND.white, fontFamily: SERIF_STACK, fontSize: 18 }}>
            Gener
            <span style={{ fontStyle: "italic", color: BRAND.gold, fontWeight: 600 }}>
              AI
            </span>
            tion <span style={{ fontWeight: 500 }}>Headshots</span>
          </span>
        </div>
        <p style={{ margin: 0, opacity: 0.6 }}>
          Made by Kristina Sherk · KristinaSherk.com
        </p>

        {/* Promo code affordance — mirrors the LandingV2 footer pattern.
            Dark-mode styling (white text, translucent border, white Apply
            button on charcoal background) since this footer sits on a
            charcoal block. Added 2026-05-27. */}
        <div
          style={{
            marginTop: 18,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          {!showPromoInput ? (
            <button
              onClick={() => setShowPromoInput(true)}
              style={{
                background: "none",
                border: "none",
                color: "rgba(255,255,255,0.7)",
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
                  border: `1px solid rgba(255,255,255,0.35)`,
                  background: "rgba(255,255,255,0.06)",
                  color: BRAND.white,
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
                  background: BRAND.white,
                  color: BRAND.charcoal,
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
              color: "#FF8A8A",
              fontFamily: SANS_STACK,
            }}
          >
            {promoErrMsg}
          </div>
        )}
      </footer>

      {/* Lightbox overlay — null pair means hidden */}
      <HealthcareLightbox pair={openPair} onClose={() => setOpenPair(null)} />

      {/* Keyframes + hover pause for the strip. Scoped via the .hc-strip-track
          class so it doesn't collide with the home page's film-strip-track. */}
      <style>{`
        @keyframes hc-strip-scroll {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        .hc-strip-track:hover {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  );
};

// -------------------- Screen 1c: How It Works dedicated page --------------------
//
// /how-it-works — full-page explainer reached from the "How it works"
// nav link on the home page (or by direct URL). Shows the same 3-step
// HowItWorks section that lives on the home page, plus a FAQ block with
// generic Q&As Kristi will rewrite over time. Has its own top nav with
// a back-to-home link and matches the home page's footer treatment.
//
// Added 2026-06-02 as part of the home-page filmstrip → HowItWorks swap.
// The shared HowItWorks component (defined just before LandingV2) makes
// the section consistent between home and this page.

type HowItWorksScreenProps = {
  onStart: () => void;
  onBackToHome: () => void;
};

// FAQ content — generic placeholders Kristi will edit. Kept in a const
// array so adding/removing items is a one-line change. Each item renders
// as a serif question + sans-serif answer.
const HOW_IT_WORKS_FAQ: { q: string; a: string }[] = [
  {
    q: "How does the AI actually generate my headshots?",
    a: "You upload 5–8 selfies. Our AI studies your facial features — your face shape, eye color, hairline, distinguishing marks — and then renders six professional headshots in the style you chose. Each one is a unique pose, expression, and composition generated specifically for you.",
  },
  {
    q: "What kind of photos work best?",
    a: "Clear, well-lit photos of your face. Phone selfies with natural daylight are great. Avoid heavy filters, sunglasses, group shots, or photos where your face takes up less than half the frame. The more variation across your uploads (different angles, expressions, outfits), the better the AI captures what you actually look like.",
  },
  {
    q: "How long does the whole process take?",
    a: "About five minutes from upload to download. The AI generation itself takes 30–60 seconds. The rest is choosing your style and looking through the six headshots to pick the ones you love.",
  },
  {
    q: "What if I don't like any of my headshots?",
    a: "You only pay for the ones that look like you. Preview all six before you decide. If none of them feel right, you don't pay for any — and we have a money-back guarantee on the $2.99 session fee too. We'd rather you walk away happy than hand you headshots you can't use.",
  },
  {
    q: "Can I use these for LinkedIn, my company website, real estate listings, anywhere professional?",
    a: "Yes. Every delivered headshot is full 2K resolution, ready for LinkedIn, professional bios, press, real estate signage, email signatures, agency websites, and anywhere else you need a polished photo. They're yours to use.",
  },
  {
    q: "What styles can I choose from?",
    a: "Corporate, Creative, Executive, Urban Industrial, and Healthcare. More verticals (real estate, construction, and more) are on the way. Each style has tailored attire, lighting, and background options — picked to match what actually works in that profession's headshots.",
  },
  {
    q: "What's the difference between Basic and Glow Up Deluxe?",
    a: "Basic ($9.99 per headshot) gives you one realistic version of each chosen headshot — natural skin, professional finish. Glow Up Deluxe ($14.99 per headshot, just $5 more than Basic) gives you three versions of each chosen headshot — realistic, polished (smoother skin), and glam (magazine-style retouching). Most customers who pick Deluxe say the glam version is the one they end up using.",
  },
  {
    q: "Are my photos kept private?",
    a: "Your uploaded selfies are used only to generate your headshots. They're not shared, sold, or used to train our AI. The headshots themselves are delivered to your email and stored only as long as we need to deliver them. If you'd like your data deleted, just email us.",
  },
];

const HowItWorksScreen = ({
  onStart,
  onBackToHome,
}: HowItWorksScreenProps) => {
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

  return (
    <div
      style={{
        background: BRAND.white,
        color: BRAND.bodyText,
        fontFamily: SANS_STACK,
        minHeight: "100vh",
      }}
    >
      {/* ========== TOP NAV ========== */}
      <nav
        style={{
          height: 52,
          padding: "0 clamp(16px, 4vw, 56px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid #EFEAE0`,
          background: BRAND.white,
        }}
      >
        <button
          onClick={onBackToHome}
          aria-label="Back to home"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
            display: "flex",
            alignItems: "center",
          }}
        >
          <Wordmark size={20} />
        </button>
        <button
          onClick={onBackToHome}
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
          ← Back to home
        </button>
      </nav>

      {/* ========== HOW IT WORKS 3-STEP SECTION ========== */}
      <HowItWorks isMobile={isMobile} />

      {/* ========== FAQ ========== */}
      <section
        style={{
          background: BRAND.white,
          padding: isMobile
            ? "48px 20px"
            : "72px clamp(20px, 4vw, 56px)",
          maxWidth: 880,
          margin: "0 auto",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: isMobile ? 32 : 48 }}>
          <h2
            style={{
              fontFamily: SERIF_STACK,
              fontSize: isMobile ? 32 : "clamp(36px, 4vw, 48px)",
              fontWeight: 400,
              color: BRAND.charcoal,
              lineHeight: 1.15,
              margin: 0,
              letterSpacing: -0.5,
            }}
          >
            Frequently asked questions
          </h2>
          <p
            style={{
              fontSize: isMobile ? 14 : 16,
              color: BRAND.subText,
              margin: "12px 0 0",
              fontStyle: "italic",
              fontFamily: SERIF_STACK,
            }}
          >
            The questions we get most.
          </p>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: isMobile ? 28 : 36,
          }}
        >
          {HOW_IT_WORKS_FAQ.map((item, i) => (
            <div key={i}>
              <h3
                style={{
                  fontFamily: SERIF_STACK,
                  fontSize: isMobile ? 18 : 22,
                  fontWeight: 500,
                  color: BRAND.charcoal,
                  lineHeight: 1.3,
                  margin: "0 0 10px",
                }}
              >
                {item.q}
              </h3>
              <p
                style={{
                  fontSize: isMobile ? 14 : 15,
                  color: BRAND.bodyText,
                  lineHeight: 1.65,
                  margin: 0,
                }}
              >
                {item.a}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ========== BOTTOM CTA ========== */}
      <section
        style={{
          background: BRAND.cream,
          textAlign: "center",
          padding: isMobile
            ? "48px 20px"
            : "72px clamp(20px, 4vw, 56px)",
        }}
      >
        <h2
          style={{
            fontFamily: SERIF_STACK,
            fontSize: isMobile ? 26 : "clamp(30px, 3.6vw, 42px)",
            fontWeight: 400,
            color: BRAND.charcoal,
            lineHeight: 1.2,
            margin: "0 auto 24px",
            maxWidth: 640,
            letterSpacing: -0.3,
          }}
        >
          Ready to see what your headshot could look like?
        </h2>
        <Pill onClick={onStart} variant="primary" size="lg">
          Generate 6 Headshots $2.99
        </Pill>
        <div
          style={{
            marginTop: 12,
            fontSize: 13,
            color: BRAND.subText,
            letterSpacing: 0.3,
          }}
        >
          Money-back guarantee · 5 minutes
        </div>
      </section>

      {/* ========== FOOTER ========== */}
      <footer
        style={{
          background: BRAND.charcoal,
          color: "rgba(255,255,255,0.7)",
          padding: "clamp(32px, 5vw, 56px) clamp(16px, 4vw, 56px)",
          textAlign: "center",
          fontSize: 13,
        }}
      >
        <div style={{ marginBottom: 12 }}>
          <span style={{ color: BRAND.white, fontFamily: SERIF_STACK, fontSize: 18 }}>
            Gener
            <span style={{ fontStyle: "italic", color: BRAND.gold, fontWeight: 600 }}>
              AI
            </span>
            tion <span style={{ fontWeight: 500 }}>Headshots</span>
          </span>
        </div>
        <p style={{ margin: 0, opacity: 0.6 }}>
          Made by Kristina Sherk · KristinaSherk.com
        </p>
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
  // Any photo that uploaded successfully counts toward the 5-minimum.
  // Face-size validation was removed 2026-05-18 per Kristi — customer can
  // upload shots of any size; we trust them to pick decent reference photos.
  const usableCount = photos.filter((p) => p.status === "done").length;
  const hasError = photos.some((p) => p.status === "error");
  const enoughPhotos = usableCount >= 5;
  const canContinue = enoughPhotos && uploadingCount === 0;

  let ctaLabel: string;
  if (uploadingCount > 0) {
    ctaLabel = `Uploading ${uploadingCount}…`;
  } else if (!enoughPhotos) {
    const needed = 5 - usableCount;
    ctaLabel = `Upload ${needed} more to continue`;
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
          Upload a minimum of 5 photos.
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
        5 to 8 photos works best. Faces clearly visible, varied angles and expressions.
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
// Order: Corporate first (default selection on screen mount) so the studio
// background color swatches are visible without an extra click. Creative,
// Executive, Urban follow in the original order. Realtor is queued as a
// "coming soon" placeholder — clicking it is a no-op. Healthcare attire is
// already shipped (under Attire), but a Healthcare *Background* category
// will be added here when its prompt-engineering is ready.
//
// silhouette = color of the head-and-shoulders foreground overlay rendered
// on top of each swatch. The overlay communicates "this is what your
// background will look like (the person is just the foreground subject)"
// at a glance. Each silhouette is a darker variant of its swatch color,
// EXCEPT Executive — its swatch is already near-black, so the silhouette
// is LIGHTER than the bg to remain visible.
type StyleVisual = "creative" | "corporate" | "executive" | "urban" | "healthcare" | "realtor";
type StyleEntry = {
  id: string;
  name: string;
  swatch: string;
  silhouette: string;
  visual: StyleVisual;
  comingSoon?: boolean;
};
const STYLES: readonly StyleEntry[] = [
  { id: "corporate",  name: "Corporate",         swatch: "#D3D1C7", silhouette: "#6C6B66", visual: "corporate" },
  { id: "creative",   name: "Creative Natural",  swatch: "#7A8A5C", silhouette: "#3D452E", visual: "creative" },
  { id: "executive",  name: "Executive",         swatch: "#2A2A28", silhouette: "#6C6B66", visual: "executive" },
  { id: "urban",      name: "Urban Industrial",  swatch: "#6F614F", silhouette: "#3D362A", visual: "urban" },
  { id: "healthcare", name: "Healthcare",        swatch: "#BCCDCB", silhouette: "#4A6868", visual: "healthcare" },
  { id: "realtor",    name: "Realtor",           swatch: "#C8B68E", silhouette: "#7A6A4A", visual: "realtor", comingSoon: true },
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
  { id: "medical", label: "🩺 Healthcare" },
  { id: "keep", label: "Keep my outfit" },
] as const;

// "natural" was removed from the UI on 2026-05-22 — Kristi found it
// redundant with "golden" / "studio." The server-side BLOCK_5_LIGHTING.natural
// entry in api/generate.ts is intentionally left in place as dead code so
// that any in-flight session with lighting: "natural" still validates and
// renders (back-compat for stale tabs). Remove the server block in a future
// cleanup once Kristi is sure no one's mid-flight on the old chip.
const LIGHTING = [
  { id: "studio", label: "Studio clean" },
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
  style: "corporate" | "creative" | "executive" | "urban" | "healthcare";
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
  // Optional preselection driven by entry context. When a customer arrives
  // via /healthcare (or future vertical landers), App passes the relevant
  // defaults so the screen pre-checks the correct cards rather than the
  // generic "corporate" default. Pass null/undefined for the generic flow.
  // Added 2026-05-27 alongside the Specialty nav dropdown.
  defaultStyle?: string;
  defaultAttire?: string;
};

const StyleScreen = ({
  onGenerate,
  onBack,
  defaultStyle,
  defaultAttire,
}: StyleScreenProps) => {
  // Default to "corporate" so the background-color swatches appear on screen
  // mount without an extra click (2026-05-22). The studio background picker
  // only renders when style === "corporate", so pre-selecting it surfaces
  // Kristi's customer's most likely first step.
  //
  // If an entry-specialty default was passed (e.g. healthcare-vertical user),
  // honor it instead so the customer lands on the right preselection.
  const [style, setStyle] = useState<string | null>(defaultStyle ?? "corporate");
  const [background, setBackground] = useState<string>("lightgrey");
  const [attire, setAttire] = useState<string | null>(defaultAttire ?? null);
  const [lighting, setLighting] = useState<string | null>(null);
  // Skin tier is hardcoded to "realistic" for initial generation (Path B
  // 2026-05-15). The UI picker that used to set this on the Style screen
  // was removed — the customer picks their retouch tier AFTER seeing
  // initial-generation results, on the new RetouchScreen. Kept as a const
  // (not state) so the rest of the file doesn't need to be rewritten:
  // it still flows through to /api/generate, which still routes it
  // through the existing tier conditional (which now always takes the
  // Realistic branch). Behavior of initial generation is unchanged from
  // pre-Path-B Realistic customers.
  const skin: "realistic" | "polished" | "glam" = "realistic";

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
      <SectionLabel>Background</SectionLabel>
      {/* Horizontal scroll row (2026-05-22) — single row of fixed-width
          cards that the user swipes to see more. Keeps vertical real estate
          constant no matter how many background categories we add. The
          negative margins on left/right pull the scroll area out to the
          edge of the parent's padding so the last card can scroll fully
          into view on mobile, then re-add padding on the inner scroll
          container so the first card still aligns with the left text. */}
      <div
        style={{
          marginLeft: -32,
          marginRight: -32,
          overflowX: "auto",
          paddingBottom: 4,
          scrollbarWidth: "thin",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 5,
            paddingLeft: 32,
            paddingRight: 32,
            width: "max-content",
          }}
        >
        {STYLES.map((s) => {
          const selected = style === s.id;
          const disabled = s.comingSoon === true;
          return (
            <div
              key={s.id}
              onClick={disabled ? undefined : () => setStyle(s.id)}
              style={{
                // Fixed-width cards in the horizontal scroll row. 56px lines
                // up roughly 5 fully-visible cards on a 360px mobile viewport
                // (296px content after 32px parent padding). On 380px+
                // viewports, additional cards become visible.
                flex: "0 0 56px",
                background: C.white,
                borderRadius: 6,
                padding: 4,
                border: `1.5px solid ${selected ? C.dark : C.border}`,
                cursor: disabled ? "default" : "pointer",
                transition: "border-color 0.15s",
                opacity: disabled ? 0.78 : 1,
              }}
            >
              <div
                style={{
                  aspectRatio: "1",
                  background: s.swatch,
                  borderRadius: 4,
                  position: "relative",
                  overflow: "hidden",
                  marginBottom: 4,
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

                {/* Healthcare — clean clinical-light treatment. Cool teal-
                    grey base with a subtle bright wash from upper-center
                    evoking diffused medical-office light. Placeholder
                    visual only — final treatment dials in when the
                    healthcare-background prompts are ready. */}
                {s.visual === "healthcare" && (
                  <>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background:
                          "linear-gradient(180deg, rgba(220,232,232,0.55) 0%, rgba(140,168,168,0.40) 100%)",
                      }}
                    />
                    {/* Soft clinical-light wash from upper center */}
                    <div
                      style={{
                        position: "absolute",
                        top: "5%",
                        left: "20%",
                        width: "60%",
                        height: "50%",
                        background:
                          "radial-gradient(circle, rgba(255,255,255,0.32) 0%, transparent 70%)",
                        filter: "blur(5px)",
                      }}
                    />
                  </>
                )}

                {/* Realtor — warm beige base evoking suburban/residential
                    interior (staged living room, neutral wall, warm window
                    light). Placeholder visual only — final treatment can
                    differentiate further once the prompt-engineering for
                    realtor backgrounds is dialed in. */}
                {s.visual === "realtor" && (
                  <>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background:
                          "linear-gradient(180deg, rgba(232,210,170,0.45) 0%, rgba(150,120,85,0.45) 100%)",
                      }}
                    />
                  </>
                )}

                {/* Head-and-shoulders silhouette overlay (added 2026-05-22).
                    Renders ON TOP of all per-style visuals so the viewer
                    immediately reads "this is the background — a person
                    will be in front of it." Silhouette color is per-style
                    (darker than the swatch — except Executive, which uses
                    a LIGHTER silhouette to remain visible on near-black). */}
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="xMidYMid meet"
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    pointerEvents: "none",
                  }}
                  aria-hidden="true"
                >
                  {/* Head */}
                  <circle cx="50" cy="38" r="16" fill={s.silhouette} />
                  {/* Neck + shoulders + chest (single path, sweeps from
                      bottom-left up to a narrow neck and back down to
                      bottom-right, producing a classic profile bust shape). */}
                  <path
                    d="M 16 100 C 20 76, 38 64, 50 64 C 62 64, 80 76, 84 100 Z"
                    fill={s.silhouette}
                  />
                </svg>

                {/* Coming Soon overlay — covers the swatch with a dark
                    scrim + centered text. Click is already blocked at the
                    card-level onClick, but pointerEvents:none here ensures
                    the overlay never traps stray clicks either. */}
                {s.comingSoon && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "rgba(0,0,0,0.55)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      pointerEvents: "none",
                    }}
                  >
                    <span
                      style={{
                        color: "#FFFFFF",
                        fontSize: 11,
                        fontWeight: 500,
                        letterSpacing: 0.6,
                        textTransform: "uppercase",
                        textAlign: "center",
                        padding: "0 4px",
                        lineHeight: 1.15,
                      }}
                    >
                      Coming<br />soon
                    </span>
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, fontWeight: 500, color: C.dark, lineHeight: 1.2, textAlign: "center" }}>
                {s.name}
              </div>
            </div>
          );
        })}
        </div>
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

      {/* Skin tier picker REMOVED 2026-05-15 (Path B launch). The choice
          between Realistic / Polished / Glam now happens AFTER the initial
          generation, on the new "Customize your Retouch Level" screen
          between Grid and Checkout. That way the customer SEES their
          initial-generation result first, then decides how much polishing
          to apply per photo. Initial generation always runs with skin =
          "realistic" (the existing Realistic prompt path is unchanged). */}

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

  // Tap-to-preview state. While the rest of the 6 are still generating,
  // the user can tap any finished thumbnail to see it at a much larger size
  // in a fullscreen lightbox. The lightbox uses a background-image <div>
  // (not an <img>) so iOS/Android long-press save is still blocked, but the
  // user gets to actually inspect each result while waiting. Set to null
  // when no lightbox is open.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

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

  // Screen Wake Lock API (added 2026-05-27). Actively keeps the phone
  // screen awake while generation is in flight, so a customer who sets
  // their phone down doesn't get their browser tab suspended by the OS
  // mid-batch. Supported in Chrome/Edge on most platforms and Safari
  // iOS 16.4+; older browsers (incl. older iOS Safari) fall through the
  // catch and rely on the first cycling tip ("Don't let your phone go
  // to sleep") as the fallback signal.
  //
  // Visibilitychange handler re-acquires the lock when the tab becomes
  // visible again — iOS quietly releases the lock when the user
  // backgrounds the tab even momentarily.
  useEffect(() => {
    if (errorMessage || allDone) return;
    if (typeof navigator === "undefined") return;

    // Local type alias — lib.dom.d.ts ships WakeLockSentinel in newer
    // TS but we keep this loose to avoid build-config dependency.
    type WakeLockHandle = { release: () => Promise<void> };
    let wakeLock: WakeLockHandle | null = null;

    const acquireWakeLock = async () => {
      try {
        const nav = navigator as unknown as {
          wakeLock?: {
            request: (type: "screen") => Promise<WakeLockHandle>;
          };
        };
        if (!nav.wakeLock) return; // unsupported — fall back to tip
        wakeLock = await nav.wakeLock.request("screen");
      } catch {
        // Permission denied / not visible / etc. — silent fallback.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !wakeLock) {
        void acquireWakeLock();
      }
    };

    void acquireWakeLock();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (wakeLock) {
        void wakeLock.release().catch(() => {});
        wakeLock = null;
      }
    };
  }, [errorMessage, allDone]);

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

      {/* 5-step journey checklist — same source of truth as the
          intro modal and the header dot indicator. Shows what the user
          has already completed and what's still to come while they
          wait for generation. Hidden on error state (the user has a
          different mental task — recovering — so the journey context
          isn't useful). Step 3 is the current step here because we're
          loading the photos they're about to pick from. */}
      {!errorMessage && <GenerationStepsList currentStep={3} />}

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

      {/* Thumbnails appear here as each one finishes.
          ANTI-THEFT (2026-05-14): two-layer protection.
          1) Rendered as <div background-image> not <img> so iOS/Android
             long-press save sheet is suppressed. onContextMenu blocks
             desktop right-click save. WebkitTouchCallout/UserSelect: none
             as belt-and-suspenders.
          2) Watermark overlay on every pre-purchase render — thumbnails,
             preview lightbox, grid — so even a screenshot is defaced.
             The watermark only disappears after checkout when the server
             regenerates clean 2K files. */}
      {readyImages.length > 0 && (
        <>
          {/* Inline hint so the user discovers the tap-to-preview affordance.
              Kept short and low-key so it doesn't compete with the progress
              indicator and tip rotator above. */}
          <div
            style={{
              marginTop: 32,
              marginBottom: 12,
              fontSize: 12,
              color: C.mediumGrey,
              textAlign: "center",
              letterSpacing: 0.2,
            }}
          >
            Tap any photo to preview it while the rest finish.
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 12,
            }}
          >
            {Array.from({ length: totalCount }, (_, i) => {
              const src = readyImages[i];
              const tappable = !!src;
              return (
                <div
                  key={i}
                  onClick={tappable ? () => setPreviewIndex(i) : undefined}
                  style={{
                    position: "relative",
                    aspectRatio: "4/5",
                    background: C.lightGrey,
                    borderRadius: 8,
                    overflow: "hidden",
                    border: `1px solid ${C.border}`,
                    cursor: tappable ? "zoom-in" : "default",
                  }}
                >
                  {src ? (
                    <>
                      <div
                        role="img"
                        aria-label={`Headshot ${i + 1}`}
                        onContextMenu={(e) => e.preventDefault()}
                        style={{
                          width: "100%",
                          height: "100%",
                          backgroundImage: `url(${src})`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                          backgroundRepeat: "no-repeat",
                          WebkitTouchCallout: "none",
                          WebkitUserSelect: "none",
                          userSelect: "none",
                        }}
                      />
                      {/* Watermark overlay — defeats screenshot theft
                          since long-press save is already blocked. Matches
                          the grid-screen watermark pattern. */}
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
                      {/* Subtle magnify icon in the corner so the
                          tap-to-preview affordance is also visible at the
                          tile level, not only in the hint text above. */}
                      <div
                        style={{
                          position: "absolute",
                          bottom: 6,
                          right: 6,
                          background: "rgba(0,0,0,0.45)",
                          color: "#fff",
                          width: 22,
                          height: 22,
                          borderRadius: 4,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          pointerEvents: "none",
                        }}
                      >
                        <Maximize2 size={12} />
                      </div>
                    </>
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
        </>
      )}

      {/* Tap-to-preview lightbox. Renders the selected loading-screen
          thumbnail at a much larger size so the user can actually inspect
          the result while the remaining slots finish. Uses background-image
          on a <div> (not <img>) so the long-press save sheet is still
          blocked even at full size, and onContextMenu blocks desktop
          right-click save. Tapping the backdrop OR the X closes it. */}
      {previewIndex !== null && readyImages[previewIndex] && (
        <div
          onClick={() => setPreviewIndex(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.92)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            cursor: "zoom-out",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "relative",
              width: "min(90vw, 70vh)",
              aspectRatio: "4/5",
            }}
          >
            <div
              role="img"
              aria-label={`Headshot ${previewIndex + 1} preview`}
              onContextMenu={(e) => e.preventDefault()}
              style={{
                width: "100%",
                height: "100%",
                backgroundImage: `url(${readyImages[previewIndex]})`,
                backgroundSize: "contain",
                backgroundPosition: "center",
                backgroundRepeat: "no-repeat",
                borderRadius: 12,
                WebkitTouchCallout: "none",
                WebkitUserSelect: "none",
                userSelect: "none",
                cursor: "default",
              }}
            />
            {/* Watermark overlay scaled up for the lightbox so screenshots
                of the larger preview are still defaced. Three diagonal bands
                instead of two since the lightbox is roughly 4× the height
                of a thumbnail — keeps watermark density visually consistent. */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                overflow: "hidden",
                borderRadius: 12,
              }}
            >
              {[25, 50, 75].map((topPercent, row) => (
                <div
                  key={row}
                  style={{
                    position: "absolute",
                    top: `${topPercent}%`,
                    left: "50%",
                    transform: "translate(-50%, -50%) rotate(-30deg)",
                    fontSize: 22,
                    color: "rgba(255,255,255,0.45)",
                    textShadow: "0 1px 3px rgba(0,0,0,0.5)",
                    letterSpacing: 4,
                    whiteSpace: "nowrap",
                    fontWeight: 400,
                  }}
                >
                  WATERMARK · WATERMARK · WATERMARK
                </div>
              ))}
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setPreviewIndex(null);
            }}
            aria-label="Close preview"
            style={{
              position: "absolute",
              top: 20,
              right: 20,
              background: "rgba(255,255,255,0.15)",
              border: "none",
              color: "#fff",
              width: 40,
              height: 40,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <X size={20} />
          </button>
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
  // Called when the user clicks "Check out" — passes the cart's URLs forward
  // to the retouch + checkout flow. Cart is URL-keyed, not index-keyed, so a
  // pick from a prior style/regen round is preserved even after Generate
  // wiped the grid.
  onDeliver: (selectedUrls: string[]) => void;
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
  // CART (Phase 1, 2026-06-03). URLs the user has added. Lifted to App so
  // it survives unmount-on-back-to-style — the whole point of the cart is
  // persistence across regenerations. URL-keyed (not slot-index-keyed) so
  // picks from different style choices coexist. + icon when URL isn't in
  // cart; check when it is.
  cart: string[];
  onAddToCart: (url: string) => void;
  onRemoveFromCart: (url: string) => void;
  maxCartSize: number;
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
  cart,
  onAddToCart,
  onRemoveFromCart,
  maxCartSize,
}: GridScreenProps) => {
  // Cart is App-level URLs (Phase 1, 2026-06-03 revised) — lifted out of
  // GridScreen's useState so it survives the user backing out to the Style
  // screen and re-generating. URL-keyed so a pick from a prior style
  // choice is preserved when the user changes their look and generates
  // fresh. Toggle dispatches to the App handlers below.
  // Always render 6 slots. If generation returned fewer than 6 (some failed),
  // the missing slots render as empty placeholders — better than blanking the
  // whole grid, and it's clear to the user how many images actually arrived.
  const photos = Array.from({ length: 6 }, (_, i) => i);
  // Set for fast .has() lookup. cart prop is an array (preserves add order
  // for the future cart strip), so we narrow to a set per render.
  const cartSet = new Set(cart);
  const cartIsFull = cart.length >= maxCartSize;

  const toggle = (i: number) => {
    const src = images[i];
    if (!src) return; // empty / failed slot — nothing to add
    if (cartSet.has(src)) onRemoveFromCart(src);
    else if (!cartIsFull) onAddToCart(src);
    // If cart is full and the URL isn't in it, the tap is intentionally a
    // no-op — the visible "Cart full" badge above the grid tells the user
    // they need to remove one before adding another.
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
            Tap the <Plus size={13} strokeWidth={2.4} style={{ display: "inline", verticalAlign: "middle", marginBottom: 2 }} /> on any photo to add it to your cart. Saved picks stay safe when you regenerate.
          </p>
        </div>
        {/* Cart status pill (Phase 1, 2026-06-03). Lives in the upper right
            of the page header so it stays visible as the user scrolls the
            grid. Counter increments when a + is tapped. When full (6/6),
            the pill flips to a gold "Cart full" state to make clear the +
            buttons are now inert. Future: the pill will become a clickable
            drawer that shows thumbnails of the cart contents (Phase 5/6). */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            borderRadius: 999,
            background: cartIsFull ? "#C9A961" : C.dark,
            color: C.white,
            fontSize: 13,
            fontWeight: 500,
            letterSpacing: 0.2,
            boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
          }}
          aria-live="polite"
          aria-label={`Cart: ${cart.length} of ${maxCartSize} saved`}
        >
          <ShoppingBag size={15} />
          {cartIsFull ? `Cart full · ${cart.length} / ${maxCartSize}` : `Cart · ${cart.length} / ${maxCartSize}`}
        </div>
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          color: C.mediumGrey,
          textAlign: "right",
        }}
      >
        Regenerations used: {regenCount} / {maxRegens}
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

      {/* CART STRIP (Phase 1, 2026-06-03). Renders horizontally above the
          main grid whenever the cart has 1+ items. Each thumbnail shows
          a small × in the top-right so the user can drop a pick without
          having to find it in the main grid (which they often can't —
          the saved photo may be from a prior generation round and no
          longer appear among the current 6). Empty cart hides this strip
          entirely so it doesn't clutter the first-time view. */}
      {cart.length > 0 && (
        <div
          style={{
            marginTop: 18,
            padding: "14px 14px 12px",
            borderRadius: 10,
            background: "#F7F3EA",
            border: "1px solid #E8DBC1",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              color: "#8A7A4B",
              marginBottom: 10,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <ShoppingBag size={13} />
            Your cart · {cart.length} / {maxCartSize}
          </div>
          <div
            style={{
              display: "flex",
              gap: 10,
              overflowX: "auto",
              paddingBottom: 2,
            }}
          >
            {cart.map((url, i) => (
              <div
                key={url}
                style={{
                  position: "relative",
                  width: 72,
                  height: 90,
                  borderRadius: 6,
                  overflow: "hidden",
                  flexShrink: 0,
                  backgroundImage: `url(${url})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  backgroundColor: C.lightGrey,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
                }}
                aria-label={`Cart item ${i + 1}`}
                onContextMenu={(e) => e.preventDefault()}
              >
                {/* Remove button — small dark circle with × in top-right
                    corner of each thumbnail. Generous tap target despite
                    the small visual size. */}
                <button
                  onClick={() => onRemoveFromCart(url)}
                  aria-label={`Remove cart item ${i + 1}`}
                  title="Remove from cart"
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    width: 22,
                    height: 22,
                    border: "none",
                    borderRadius: "50%",
                    background: "rgba(0,0,0,0.78)",
                    color: C.white,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                  }}
                >
                  <X size={13} strokeWidth={2.5} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

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
          const src = images[i]; // may be undefined if this slot failed to generate
          const picked = !!src && cartSet.has(src);
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
            // Cart preservation (Phase 1 revision, 2026-06-03): we
            // INTENTIONALLY do NOT remove the cart URL when the slot
            // regenerates. The Blob URL for the old image is still valid —
            // it lives in Vercel Blob and delivery can fetch it regardless
            // of which slot it appeared in. So a single-slot regen now lets
            // the customer "lock in" the prior image (via cart) AND get a
            // fresh option in the same slot, doubling their effective pick
            // pool. The user's prior pick stays visible in the cart strip
            // above the grid. Per Kristi 2026-06-03.
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
                  {/* ANTI-THEFT (2026-05-14): rendered as <div
                      background-image> not <img>. On iOS/Android, long-pressing
                      an <img> opens a "Save Image" sheet that grabs the
                      underlying full-res data URI — bypassing the DOM watermark
                      overlay below (which is a separate sibling element, not
                      baked into the pixels). <div> with background-image does
                      NOT trigger that save menu. onContextMenu blocks the
                      desktop right-click "Save image as…" menu too. */}
                  <div
                    role="img"
                    aria-label={`Headshot variation ${i + 1}`}
                    onContextMenu={(e) => e.preventDefault()}
                    style={{
                      width: "100%",
                      height: "100%",
                      backgroundImage: `url(${src})`,
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                      backgroundRepeat: "no-repeat",
                      WebkitTouchCallout: "none",
                      WebkitUserSelect: "none",
                      userSelect: "none",
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
                  Unselected = white circle with a + sign (clear "add to cart"
                  affordance). Selected = filled dark circle with checkmark.
                  When the cart is full AND this slot isn't in it, the + is
                  dimmed so the user understands the tap won't do anything
                  until they remove one. */}
              {src && (
                <div
                  style={{
                    position: "absolute",
                    top: 10,
                    right: 10,
                    background: picked
                      ? C.dark
                      : cartIsFull
                      ? "rgba(255, 255, 255, 0.4)"
                      : "rgba(255, 255, 255, 0.92)",
                    color: picked ? C.white : C.dark,
                    border: picked ? "none" : "1.5px solid rgba(255, 255, 255, 0.95)",
                    boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                    borderRadius: "50%",
                    width: 30,
                    height: 30,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "background 0.15s, transform 0.15s",
                    opacity: !picked && cartIsFull ? 0.55 : 1,
                  }}
                >
                  {picked ? <Check size={17} /> : <Plus size={17} strokeWidth={2.4} />}
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
            <ShoppingBag size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 6, marginBottom: 2 }} />
            {cart.length} in your cart
          </div>
          <div style={{ fontSize: 11, color: C.mediumGrey, marginTop: 4 }}>
            Enter your email on the next screen, then download your clean 2K files.
          </div>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Button
            onClick={() => onDeliver(cart)}
            disabled={cart.length === 0}
          >
            Check out
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

// -------------------- Retouch tier picker --------------------
//
// New step in the Path B flow (2026-05-15): sits between the Grid screen
// (where the customer picked their favorites) and the Checkout screen.
//
// Customer Journey at this stage:
//   1. Customer hits "Customize your Retouch Level" from Grid.
//   2. Intro popup explains the three tiers (Realistic / Polished / Glam).
//   3. RetouchScreen: a thumbnail of each picked photo with three radio
//      circles next to it. Customer ticks one tier per photo. Default
//      is "polished" — the middle option, framed as the sensible default
//      "make it nice" choice; customer can downshift to Realistic for
//      zero retouching or upshift to Glam for editorial Vogue treatment.
//   4. "Process & Continue" button → Checkout screen ($11.99 × N).
//   5. After Stripe success, /api/deliver runs the per-tier retouching
//      pass with Gemini Pro before sending the email.
//
// Mobile-first: thumbnails stack vertically on narrow viewports so the
// radio circles are easy to tap without zooming. Per-photo "row" layout
// (image on the left, tier picker on the right) flips to "image on top,
// tier picker stacked below" on viewports under 500px.

// Glow Up Deluxe tier model (2026-05-18). Replaces the prior 3-tier
// (Realistic/Polished/Glam) picker. Now a customer picks per photo:
//   basic  — Realistic only, $9.99
//   deluxe — All 3 versions (Realistic + Polished + Glam), $14.99
// The underlying Polished/Glam retouching still happens server-side for
// Deluxe photos — the customer just doesn't have to commit to one tier
// before purchase.
export type RetouchTier = "basic" | "deluxe";

// Per-tier copy used in both the intro popup AND inline on the
// RetouchScreen — single source of truth so they don't drift.
const RETOUCH_TIER_DESCRIPTIONS: {
  tier: RetouchTier;
  label: string;
  price: string;
  description: string;
}[] = [
  {
    tier: "basic",
    label: "Basic",
    price: "$9.99",
    description: "Realistic version only — what you see is what you get.",
  },
  {
    tier: "deluxe",
    label: "Glow Up Deluxe Bundle",
    price: "$14.99",
    description:
      "Get smoother skin + magazine-style polish — just $5 more for 3 retouched versions.",
  },
];

// Mid-loading popup (2026-05-18). Fires once per session shortly after
// the customer reaches the loading screen and the 6 generations are
// in flight. Tells them what's coming next — the retouch step —
// so they understand the "realistic skin on purpose" output they're
// about to see and don't panic-leave the page thinking it's broken.
//
// Smaller / lighter-weight than IntroRetouchModal because the customer
// is mid-wait and we don't want to interrupt the flow heavily.
type LoadingRetouchPreviewModalProps = {
  onDismiss: () => void;
};

const LoadingRetouchPreviewModal = ({
  onDismiss,
}: LoadingRetouchPreviewModalProps) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Heads up — your retouch choice is coming next"
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0, 0, 0, 0.78)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 20,
      zIndex: 1000,
      ...font,
    }}
  >
    <div
      style={{
        background: C.white,
        borderRadius: 12,
        padding: "28px 24px",
        maxWidth: 460,
        width: "100%",
      }}
    >
      {/* Title: 🛑 Don't Self-Judge! 🛑 — stop emojis flank the title to
          interrupt the customer's "am I really this wrinkly?" reaction
          BEFORE they read the body. Per Kristi 2026-05-22 after recurring
          women-customer complaints about realistic-skin output. */}
      <h2
        style={{
          fontSize: 22,
          fontWeight: 500,
          color: C.dark,
          margin: "0 0 16px",
          lineHeight: 1.3,
          textAlign: "center",
        }}
      >
        🛑 Don't Self-Judge! 🛑
      </h2>
      <p
        style={{
          fontSize: 14,
          color: C.dark,
          margin: "0 0 14px",
          lineHeight: 1.55,
        }}
      >
        This step intentionally creates headshots with hyper realistic
        skin and all the wrinkles intact so these headshots actually look
        like REAL people. By design, this app generates realistic skin
        texture in this step.
      </p>
      <p
        style={{
          fontSize: 14,
          color: C.dark,
          margin: "0 0 22px",
          lineHeight: 1.55,
        }}
      >
        The NEXT step, is where you get to ADD RETOUCHING. So sit tight
        and pick the ones that actually look like you now, they will get
        a glow up in the next step. 💋
      </p>
      <button
        onClick={onDismiss}
        style={{
          width: "100%",
          padding: "13px 22px",
          background: C.dark,
          color: C.buttonText,
          border: "none",
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 500,
          cursor: "pointer",
          ...font,
        }}
      >
        Got it
      </button>
    </div>
  </div>
);

// Intro popup that fires once when the customer reaches the Retouch
// screen. Explains the three tier options so the radio choice on the
// screen is meaningful.
type IntroRetouchModalProps = {
  onDismiss: () => void;
};

const IntroRetouchModal = ({ onDismiss }: IntroRetouchModalProps) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-label="What's coming next: your retouch level options"
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0, 0, 0, 0.85)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 20,
      zIndex: 1000,
      ...font,
    }}
  >
    <div
      style={{
        background: C.white,
        borderRadius: 12,
        padding: "26px 22px",
        maxWidth: 520,
        width: "100%",
        maxHeight: "92vh",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: 1.5,
          color: C.mediumGrey,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        Next step
      </div>
      <h2
        style={{
          fontSize: 22,
          fontWeight: 500,
          color: C.dark,
          margin: "0 0 14px",
          lineHeight: 1.25,
        }}
      >
        Retouch your Delivered Headshots:
      </h2>

      {RETOUCH_TIER_DESCRIPTIONS.map((t, i) => (
        <div
          key={t.tier}
          style={{
            paddingTop: 14,
            paddingBottom: 14,
            borderBottom:
              i < RETOUCH_TIER_DESCRIPTIONS.length - 1
                ? `1px solid ${C.border}`
                : "none",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 4,
            }}
          >
            <div
              style={{
                fontSize: 15,
                fontWeight: 500,
                color: C.dark,
              }}
            >
              {t.label}
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: C.dark,
              }}
            >
              {t.price}
            </div>
          </div>
          <div
            style={{
              fontSize: 13,
              color: C.mediumGrey,
              lineHeight: 1.5,
            }}
          >
            {t.description}
          </div>
        </div>
      ))}

      <button
        onClick={onDismiss}
        style={{
          width: "100%",
          padding: "13px 22px",
          background: C.dark,
          color: C.buttonText,
          border: "none",
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 500,
          cursor: "pointer",
          marginTop: 18,
          ...font,
        }}
      >
        Got it — let me pick
      </button>
    </div>
  </div>
);

// The retouch screen itself.
type RetouchScreenProps = {
  // URLs of the images the customer added to their cart on the grid screen.
  // These are the photos they're going to pay for and retouch. Cart may hold
  // images from multiple generation rounds; URL is the only stable handle.
  selectedUrls: string[];
  // Current tier choice per URL. Populated in App-level state and passed
  // down with a setter. Default "basic" — the cheaper option, safest for
  // an unconfirmed customer choice.
  retouchTiers: Record<string, RetouchTier>;
  setRetouchTiers: React.Dispatch<
    React.SetStateAction<Record<string, RetouchTier>>
  >;
  onContinue: () => void;
  onBack: () => void;
};

const RetouchScreen = ({
  selectedUrls,
  retouchTiers,
  setRetouchTiers,
  onContinue,
  onBack,
}: RetouchScreenProps) => {
  // Defensive: if no photos somehow made it here, hand the user back to
  // the grid so they can pick favorites again rather than locking them
  // on an empty screen.
  if (selectedUrls.length === 0) {
    return (
      <div
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "48px 20px",
          textAlign: "center",
          ...font,
        }}
      >
        <p style={{ color: C.mediumGrey, fontSize: 14 }}>
          You haven't picked any photos yet.
        </p>
        <Button onClick={onBack} full>
          Back to picks
        </Button>
      </div>
    );
  }

  const setTier = (url: string, tier: RetouchTier) => {
    setRetouchTiers((prev) => ({ ...prev, [url]: tier }));
  };

  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "32px 20px 80px",
        ...font,
      }}
    >
      <button
        onClick={onBack}
        style={{
          background: "transparent",
          border: "none",
          color: C.mediumGrey,
          fontSize: 13,
          cursor: "pointer",
          padding: 0,
          marginBottom: 16,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <ArrowLeft size={14} />
        Back to picks
      </button>

      <h1
        style={{
          fontSize: 24,
          fontWeight: 500,
          color: C.dark,
          margin: "0 0 14px",
          lineHeight: 1.2,
          letterSpacing: -0.3,
        }}
      >
        Retouch your Delivered Headshots:
      </h1>

      {/* Explainer card. Mirrors the intro modal copy so customers who
          dismissed the modal still see the two-tier explanation inline. */}
      <div
        style={{
          background: C.lightGrey,
          borderRadius: 8,
          padding: "12px 14px",
          margin: "0 0 22px",
        }}
      >
        <p style={{ fontSize: 13, color: C.dark, margin: "0 0 6px", lineHeight: 1.5 }}>
          <span style={{ fontWeight: 500 }}>Basic ($9.99):</span> Realistic version only.
        </p>
        <p style={{ fontSize: 13, color: C.dark, margin: 0, lineHeight: 1.5 }}>
          <span style={{ fontWeight: 500 }}>Glow Up Deluxe ($14.99):</span> Smoother skin + magazine-style polish — just $5 more for 3 retouched versions.
        </p>
      </div>

      {/* Per-photo rows. On desktop the thumbnail sits on the left and
          the tier picker on the right. On narrow viewports (≤500px) the
          tier picker stacks below the thumbnail so the radio circles
          remain large and easy to tap. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {selectedUrls.map((url, position) => {
          // Default to "basic" — the cheaper option, safest for cost and
          // the most conservative customer assumption.
          const currentTier = retouchTiers[url] ?? "basic";
          return (
            <div
              key={url}
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
                padding: 14,
                background: C.white,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                alignItems: "flex-start",
              }}
            >
              {/* Thumbnail. Uses background-image div, matching the
                  anti-save-protection pattern from the grid screen. */}
              <div
                style={{
                  width: 110,
                  aspectRatio: "4/5",
                  borderRadius: 8,
                  overflow: "hidden",
                  position: "relative",
                  flexShrink: 0,
                  backgroundImage: `url(${url})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  backgroundColor: C.lightGrey,
                }}
                onContextMenu={(e) => e.preventDefault()}
                aria-label={`Headshot ${position + 1}`}
                role="img"
              >
                {/* Watermark — same diagonal pattern as the grid. */}
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
                        fontSize: 9,
                        color: "rgba(255,255,255,0.55)",
                        textShadow: "0 1px 2px rgba(0,0,0,0.4)",
                        letterSpacing: 1.5,
                        whiteSpace: "nowrap",
                        fontWeight: 400,
                      }}
                    >
                      WATERMARK · WATERMARK
                    </div>
                  ))}
                </div>
              </div>

              {/* Tier radio picker. Minimum width keeps it readable but
                  the flex-wrap on the parent stacks it below the thumb
                  on phone widths. */}
              <div style={{ flex: 1, minWidth: 200 }}>
                {RETOUCH_TIER_DESCRIPTIONS.map((t) => {
                  const selected = currentTier === t.tier;
                  return (
                    <label
                      key={t.tier}
                      onClick={() => setTier(url, t.tier)}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                        padding: "8px 0",
                        cursor: "pointer",
                      }}
                    >
                      {/* Custom radio circle — bigger tap target than
                          the native input on mobile, and visually
                          consistent with the brand palette. */}
                      <div
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: "50%",
                          border: `2px solid ${selected ? C.dark : C.lightGrey}`,
                          background: selected ? C.dark : "transparent",
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          marginTop: 1,
                          transition: "border-color 0.15s, background 0.15s",
                        }}
                      >
                        {selected && (
                          <div
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: C.white,
                            }}
                          />
                        )}
                      </div>
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "baseline",
                          gap: 8,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: selected ? 500 : 400,
                            color: C.dark,
                          }}
                        >
                          {t.label}
                        </div>
                        <div
                          style={{
                            fontSize: 13,
                            color: selected ? C.dark : C.mediumGrey,
                            fontWeight: selected ? 500 : 400,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {t.price}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* CTA at the bottom. The total math runs in the parent's
          handleAdvanceToCheckout; we deliberately don't show a running
          total here per Kristi 2026-05-18 — simpler screen, math is
          finalized at the Stripe page. */}
      <div style={{ marginTop: 28 }}>
        <Button onClick={onContinue} full>
          Continue to checkout
        </Button>
      </div>
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
  // Retouch tier chosen on the RetouchScreen, one entry per selectedImages
  // index (same order). Forwarded to /api/deliver so the server can run the
  // appropriate Pro retouching pass per photo before sending the email.
  // "realistic" = no retouching; "polished" / "glam" = Pro retouch.
  retouchTiers: RetouchTier[];
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
  retouchTiers,
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
  // Full name (added 2026-05-22). Required field. Kristi needs the name on
  // file so she can track customers down by name if a delivery issue or
  // support request comes in — email alone isn't always enough (people forget
  // which address they used). Captured here, threaded through pending_delivery
  // stash + /api/deliver payload, and surfaced in the usage-alert email.
  const [customerName, setCustomerName] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.sessionStorage.getItem("customer_name") ?? "";
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
  // Name is required and must contain at least one non-whitespace character.
  // Trim before comparing so " " or "    " doesn't pass.
  const nameLooksValid = customerName.trim().length >= 2;

  // --- Phase 2 pricing math (simplified 2026-05-14) ---
  // Pricing model: $2.99 to try (entry fee — pays for app access), then a
  // flat $11.99 per photo. No credit applied on first photo. History: the
  // original model gave a $2.99 credit on first photo, but the credit_used
  // tracking lived in sessionStorage, which resets per tab — so customers
  // who came back in a new session could re-claim the credit indefinitely.
  // Switched to a flat-price model on 2026-05-14 (a) to eliminate that bug
  // surface, (b) to simplify the pricing copy, and (c) to capture full
  // revenue on multi-photo customers who span multiple sessions. Paired
  // with a 48-hour TTL on the entry unlock — see PAYWALL_UNLOCK_TTL_MS.
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
  const isPromoUnlock = unlockSource === "promo";

  // Glow Up Deluxe pricing (2026-05-18). Mixed totals supported per
  // photo — see retouchTiers prop.
  const PRICE_BASIC = 9.99;
  const PRICE_DELUXE = 14.99;
  const basicCount = retouchTiers.filter((t) => t === "basic").length;
  const deluxeCount = retouchTiers.filter((t) => t === "deluxe").length;
  const subtotal = PRICE_BASIC * basicCount + PRICE_DELUXE * deluxeCount;
  const totalOwed = subtotal;
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  const submit = async () => {
    if (!emailLooksValid || !nameLooksValid || processing) return;
    // Persist name to sessionStorage so a page refresh during the Stripe
    // round-trip doesn't drop it. Same pattern email already uses.
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem("customer_name", customerName.trim());
      } catch {
        // sessionStorage write may fail in private browsing — non-fatal.
      }
    }
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
            customerName: customerName.trim(),
            photoUrls: uploadedUrls,
            referencePhotoUrls,
            style: selections.style,
            attire: selections.attire,
            lighting: selections.lighting,
            background: selections.background,
            skin: selections.skin,
            // Per-photo retouch tier — drives the Pro retouching pass
            // /api/deliver runs server-side before sending email.
            // Same order as uploadedUrls (i.e., index N in retouchTiers
            // describes the tier for the photo at uploadedUrls[N]).
            retouchTiers,
            // Server flips metadata.unlock_consumed=true on this Stripe
            // session so the unlock can't be reused for another batch.
            // Pulled at call time from localStorage; for promo users
            // this is undefined and the server skips the metadata write.
            ...readUnlockRequestFields(),
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
        // Full name (added 2026-05-22). Same reason as retouchTiers: the
        // Stripe redirect blows React state away, and we need the name on
        // the return trip so /api/deliver can include it on Kristi's
        // usage-alert email.
        customerName: customerName.trim(),
        uploadedUrls,
        referencePhotoUrls,
        selections,
        // Stash the retouch tier per photo too — the Stripe redirect
        // wipes React state, so without this the post-payment handler
        // wouldn't know which tier the customer picked for each photo.
        retouchTiers,
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
            // Glow Up Deluxe pricing (2026-05-18): server computes the
            // mixed total from the tier array. Length = photo count.
            retouchTiers,
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
          pay nothing. Paid users see subtotal + total owed. Credit line was
          removed 2026-05-14 in the flat-price-per-photo simplification. */}
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
              {basicCount > 0 && (
                <>
                  {basicCount} basic × $9.99
                </>
              )}
              {basicCount > 0 && deluxeCount > 0 && <span> + </span>}
              {deluxeCount > 0 && (
                <>
                  {deluxeCount} Glow Up Deluxe × $14.99
                </>
              )}
            </span>
            <span>{fmt(subtotal)}</span>
          </div>
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
          Full name
        </label>
        <input
          type="text"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          placeholder="Your name"
          disabled={processing}
          autoComplete="name"
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
      </div>

      <div style={{ marginTop: 20 }}>
        <label style={{ fontSize: 13, color: C.mediumGrey, fontWeight: 500 }}>
          Email
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@email.com"
          disabled={processing}
          autoComplete="email"
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
        <Button onClick={submit} disabled={!emailLooksValid || !nameLooksValid || processing} full>
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
    ? (["corporate", "creative", "executive", "urban", "healthcare"] as const).filter(
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
        // Paywall fields — even bonus previews count against the
        // session's 4h window. Customer paid, customer gets the bonus.
        ...readUnlockRequestFields(),
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
    healthcare: "Healthcare",
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
        <div style={{ fontSize: 15, fontWeight: 500, color: C.dark, marginBottom: 6 }}>
          Loved your photos? Try a totally different look.
        </div>
        <div style={{ fontSize: 13, color: C.mediumGrey, lineHeight: 1.6, marginBottom: 16 }}>
          Generate 6 brand-new headshots in a different style — corporate
          to creative, indoor to outdoor, whatever direction you want.
          Your uploaded reference photos are still saved, so you'll skip
          straight to the style picker — no re-uploading. Just $2.99 to
          start a fresh session, then $9.99 per Basic keeper or $14.99 for
          the Glow Up Deluxe Bundle — smoother skin + magazine-style polish
          across 3 retouched versions ($5 more than Basic).
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button onClick={onNewStyle}>Try a different style</Button>
          <Button variant="ghost" onClick={onHome}>
            I'm done — back to home
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

// -------------------- Back-button warning --------------------
//
// Added 2026-05-27 after the 2026-05-26 night Stripe audit showed
// a probable session-loss event: a customer paid the $2.99 entry
// fee then hit 12 sequential /api/generate 402 errors over 90s.
// The most plausible cause is a browser-back navigation wiping
// the unlock state. This modal fires when the customer is on a
// post-generation screen (grid / retouch / checkout) AND hits
// the browser back button — blocks the silent transition and
// asks them to confirm so they don't accidentally throw away
// their generated headshots and have to pay again.

type BackWarningModalProps = {
  onStay: () => void;
  onLeave: () => void;
};

const BackWarningModal = ({ onStay, onLeave }: BackWarningModalProps) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Going back will lose your headshots"
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(44, 44, 42, 0.55)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1100,
      padding: 24,
      ...font,
    }}
  >
    <div
      style={{
        background: C.white,
        borderRadius: 8,
        padding: 32,
        maxWidth: 460,
        width: "100%",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 500, color: C.dark }}>
        Hang on — going back will lose your headshots
      </div>
      <div
        style={{
          fontSize: 14,
          color: C.mediumGrey,
          marginTop: 12,
          lineHeight: 1.6,
        }}
      >
        Your generated headshots and any retouch choices will be cleared if
        you go back. You'd need to start a new session ($2.99) and generate
        a fresh batch.
      </div>
      <div
        style={{
          display: "flex",
          gap: 10,
          marginTop: 24,
          flexWrap: "wrap",
        }}
      >
        <Button onClick={onStay}>Stay on this page</Button>
        <Button variant="ghost" onClick={onLeave}>
          Go back anyway
        </Button>
      </div>
    </div>
  </div>
);

// -------------------- Post-checkout delivering interstitial --------------------
//
// Added 2026-05-27 to fix the "home page flash" customers saw after
// completing photo checkout. Stripe redirects back to "/?photo_paid=1&..."
// which means React mounts fresh on the landing screen for the 30–90s
// while /api/verify-checkout + /api/deliver run. The photo_paid useEffect
// now sets `screen` to "delivering" immediately on mount, displaying
// this component so the customer sees a clear "preparing your headshots"
// message rather than the home page.
//
// Mirrors the LoadingScreen visual language (working pill + headline +
// reassurance copy) so the in-flow aesthetic stays consistent. No
// cycling tips or thumbnail grid — there's nothing to show yet, and
// the wait is shorter than the initial generation wait.

const DeliveringScreen = () => (
  <div
    style={{
      maxWidth: 560,
      margin: "0 auto",
      padding: "120px 32px",
      textAlign: "center",
      ...font,
    }}
  >
    {/* Local keyframes — matches the LoadingScreen pattern. The animation
        is defined inline in multiple components so each is self-contained. */}
    <style>{`
      @keyframes spin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }
    `}</style>

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
    </div>

    <h1
      style={{
        fontSize: 32,
        fontWeight: 500,
        color: C.dark,
        margin: 0,
        letterSpacing: -0.5,
        lineHeight: 1.2,
      }}
    >
      Hold tight — preparing your headshots
    </h1>

    <p
      style={{
        fontSize: 15,
        color: C.mediumGrey,
        marginTop: 16,
        lineHeight: 1.6,
      }}
    >
      Your payment came through. We're putting together your downloadable
      files now. This usually takes 1–2 minutes. Please don't close this
      tab — your headshots will appear here as soon as they're ready.
    </p>
  </div>
);

// -------------------- Root app --------------------

type Screen =
  | "landing"
  | "healthcare" // /healthcare vertical landing — reached via URL path, see App's
                 // pathname-on-mount + popstate effects below
  | "how-it-works" // /how-it-works dedicated explainer page — same 3-step section
                   // from the home page + a FAQ block below. Reached via the
                   // "How it works" nav link or by direct URL.
  | "gallery" // before/after gallery — accessible from landing nav
  | "upload"
  | "style"
  | "loading" // shown while /api/generate runs 6 times in parallel
  | "grid"
  // "retouch" (added 2026-05-15, Path B): customer picks a retouch tier
  // per picked photo (Realistic / Polished / Glam). Sits between grid
  // and checkout. The actual Pro retouching pass fires after payment
  // (in /api/deliver).
  | "retouch"
  | "checkout"
  // "delivering" (added 2026-05-27): post-Stripe-redirect interstitial
  // shown while /api/verify-checkout + /api/deliver run. Without this,
  // the customer briefly sees the home landing during the 30-90s wait
  // because React state resets on the redirect — looks like they got
  // dumped somewhere wrong. The photo_paid useEffect sets screen here
  // immediately on mount so the friendly hold-tight UI displays
  // throughout the async work.
  | "delivering"
  | "success";

const TOTAL_HEADSHOTS = 6;

export default function App() {
  const [screen, setScreen] = useState<Screen>("landing");

  // Back-button warning state (added 2026-05-27 after Stripe data showed
  // a customer paying entry fee then losing session). When the customer
  // is on a post-generation screen (grid / retouch / checkout) and hits
  // the browser back button, we intercept and show a warning modal so
  // they don't accidentally throw away their generated headshots and have
  // to pay $2.99 again. The ref is read inside the existing pathname-based
  // popstate handler so the two effects don't fight over the same event.
  const [showBackWarning, setShowBackWarning] = useState(false);
  const protectedScreenGuardActiveRef = useRef(false);

  // Entry-specialty context (added 2026-05-27). When a customer enters the
  // flow via a vertical landing page like /healthcare, this records which
  // vertical they came from so the Style screen can seed its defaults
  // accordingly (Healthcare entry → style="healthcare", attire="medical").
  // null = generic entry, no preselection. Reset to null when the customer
  // navigates back to the home landing so a subsequent generic session
  // doesn't accidentally inherit healthcare defaults.
  const [entrySpecialty, setEntrySpecialty] =
    useState<null | "healthcare" | "realtor">(null);

  // Clear any stale specialty context when the customer returns to the
  // generic home landing. Without this, a customer who finished a
  // healthcare-vertical session and clicked "back to home" would carry
  // the "healthcare" preselection into their next (generic) session.
  // Added 2026-05-27.
  useEffect(() => {
    if (screen === "landing" && entrySpecialty !== null) {
      setEntrySpecialty(null);
    }
  }, [screen, entrySpecialty]);

  // Cart auto-clear (Phase 1, 2026-06-03). Whenever the user lands on the
  // Upload screen, wipe the cart. The Upload screen is either the start of
  // a brand-new session (cart already empty, harmless no-op) or the user
  // backed out to change their source photos — in which case prior cart
  // entries reference images generated from photos that no longer apply
  // and should be cleared. Putting this in one effect avoids scattering
  // the same setCart(new Set()) call across every navigation path.
  useEffect(() => {
    if (screen === "upload") setCart([]);
  }, [screen]);

  // URL-path routing for vertical landing pages. The app is otherwise driven
  // by `screen` state (button clicks), but vertical landers like /healthcare
  // need to be reachable as real URLs for SEO. On initial mount we read
  // window.location.pathname and set the matching screen; we also listen for
  // popstate so browser back/forward works between / and /healthcare.
  // Vercel.json has a matching rewrite so direct visits to /healthcare serve
  // the SPA's index.html.
  useEffect(() => {
    const screenForPath = (path: string): Screen | null => {
      if (path === "/healthcare" || path === "/healthcare/") return "healthcare";
      if (path === "/how-it-works" || path === "/how-it-works/") return "how-it-works";
      if (path === "/" || path === "") return "landing";
      return null;
    };
    const initial = screenForPath(window.location.pathname);
    if (initial) setScreen(initial);
    const onPopState = () => {
      // When the customer is on a protected post-generation screen, the
      // back-warning guard owns this popstate event — defer to it so we
      // don't yank the customer to the landing screen behind the modal.
      if (protectedScreenGuardActiveRef.current) return;
      const next = screenForPath(window.location.pathname);
      if (next) setScreen(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Back-button guard for grid / retouch / checkout screens. When the
  // customer enters one of these screens, push a marker history entry
  // so the next browser-back press is intercepted. Show a warning modal
  // instead of silently losing their generated headshots and forcing a
  // re-pay. Customer 2 from the 2026-05-26 night log appears to have
  // hit something like this (12 paywall-rejected /api/generate calls
  // after entry payment) — surfacing the warning is the preventive
  // half; the recovery half (localStorage unlock survival) is roadmap
  // item #19.
  useEffect(() => {
    const isProtected =
      screen === "grid" || screen === "retouch" || screen === "checkout";
    if (!isProtected) {
      protectedScreenGuardActiveRef.current = false;
      return;
    }

    // Push a marker entry so the FIRST browser-back press lands on this
    // pathname (no visible URL change) and fires popstate — which we
    // intercept below.
    window.history.pushState({ guard: true }, "", window.location.pathname);
    protectedScreenGuardActiveRef.current = true;

    const onPopState = () => {
      if (!protectedScreenGuardActiveRef.current) return;
      // Surface the warning, then re-push the marker so the user visually
      // stays on the protected screen until they confirm or dismiss.
      setShowBackWarning(true);
      window.history.pushState({ guard: true }, "", window.location.pathname);
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      protectedScreenGuardActiveRef.current = false;
    };
  }, [screen]);

  // Handlers for the back-warning modal. "Go back anyway" tears down the
  // guard and routes the customer to the landing screen — the natural
  // place a back press from the grid would have taken them. We don't
  // aggressively clear progress state here; if they re-enter the flow
  // within their 2h unlock TTL their generated photos are still in
  // component state. (When the tab is closed, sessionStorage is lost
  // anyway — that's the lost-session-after-payment bug tracked
  // separately as roadmap item #19.)
  const handleConfirmLeaveProtectedScreen = () => {
    protectedScreenGuardActiveRef.current = false;
    setShowBackWarning(false);
    setScreen("landing");
  };
  const handleStayOnProtectedScreen = () => {
    setShowBackWarning(false);
  };

  // URLs of the images the user selected on the Grid screen — the cart's
  // contents at the moment they clicked "Check out". Passed to
  // CheckoutScreen and forwarded as photoUrls to /api/deliver.
  //
  // 2026-06-03: switched from index-based (number[]) to URL-based (string[])
  // so picks survive style changes / multi-round regenerations. The cart
  // lives independently of the current 6-slot grid and may contain images
  // from prior generation rounds.
  const [selectedImageUrls, setSelectedImageUrls] = useState<string[]>([]);

  // Retouch tier choice per selected image, keyed by the image's URL.
  // 2026-06-03: switched from index-keyed (Record<number, …>) to URL-keyed
  // for the same reason as selectedImageUrls — the cart may contain images
  // from multiple generation rounds, and indices aren't stable across rounds.
  // Defaults to "basic" when a photo is first added (cheaper option, safer
  // default for unconfirmed customer intent).
  const [retouchTiers, setRetouchTiers] = useState<
    Record<string, RetouchTier>
  >({});

  // Intro popup for the Retouch screen. Fires once per session right
  // before the customer reaches the RetouchScreen so they understand
  // what each tier means before they tick a radio circle.
  const [hasSeenRetouchIntro, setHasSeenRetouchIntro] = useState(false);
  const [showRetouchIntroModal, setShowRetouchIntroModal] = useState(false);

  // Mid-loading popup (2026-05-18). Fires once per session shortly after
  // the customer enters the loading screen — explains that realistic
  // skin is on purpose and they'll get retouching choices in the next
  // step. Prevents panic-leaves while waiting for the 6 generations.
  const [hasSeenLoadingRetouchPopup, setHasSeenLoadingRetouchPopup] =
    useState(false);
  const [showLoadingRetouchPopup, setShowLoadingRetouchPopup] =
    useState(false);
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
  // CART (Phase 1, 2026-06-03 — revised). Image URLs the user has added to
  // their cart. Stored as an ordered string[] (most-recently-added last so
  // we can render an "order of selection" feel later).
  //
  // URL-keyed, NOT slot-index-keyed, because the customer can change their
  // style/outfit/background and regenerate. Every Generate refreshes ALL 6
  // slots, but the cart contents persist because they reference uploaded
  // image URLs in Vercel Blob — those URLs stay valid even when the grid
  // refreshes. This lets a customer cherry-pick favorites from MULTIPLE
  // style rounds: suit/office → save 1, sweater/outdoor → save 2,
  // glasses/studio → save 3, check out with 6 from across the rounds.
  //
  // Capped at MAX_CART_SIZE (6) — matches what the customer pays for.
  //
  // Cleared in reset() (back to landing) and whenever the user goes back to
  // Upload (changing source photos invalidates prior picks).
  const MAX_CART_SIZE = 6;
  const [cart, setCart] = useState<string[]>([]);
  const addToCart = (url: string) => {
    setCart((prev) => {
      if (prev.includes(url)) return prev;
      if (prev.length >= MAX_CART_SIZE) return prev;
      return [...prev, url];
    });
  };
  const removeFromCart = (url: string) => {
    setCart((prev) => (prev.includes(url) ? prev.filter((u) => u !== url) : prev));
  };
  // Photographer's tips modal: shown the first time the user arrives at the
  // Upload screen in a given session. Resets when reset() fires so starting
  // over from Landing shows it again.
  const [hasSeenTips, setHasSeenTips] = useState(false);
  const [showTipsModal, setShowTipsModal] = useState(false);

  // Intro-steps modal state — same once-per-session pattern as the tips
  // modal above. Shows the 5-step roadmap (Upload → Pick style → Pick
  // favorites → Retouch → Download) so customers know what they're
  // signing up for before they begin. Fires BEFORE the photographer-tips
  // modal so the user sees the big picture first, then the upload
  // fundamentals second.
  const [hasSeenIntro, setHasSeenIntro] = useState(false);
  const [showIntroModal, setShowIntroModal] = useState(false);

  // Welcome-after-payment popup. Fires when /api/verify-checkout returns
  // paid:true with a fresh sessionId+unlockExpiresAt — i.e., the user
  // just finished the $2.99 Stripe Checkout and we want to confirm the
  // unlock + start the 2-hour countdown visibly.
  const [showWelcomePopup, setShowWelcomePopup] = useState(false);

  // 15-minute warning state. The triggering useEffect lives below the
  // unlockExpiresAt declaration (line ordering matters in TS strict
  // mode — can't reference a `let` before its declaration even from
  // a hook callback). Search for "thirty-min warning" to find the
  // useEffect that drives this.
  const [showThirtyMinWarning, setShowThirtyMinWarning] = useState(false);
  const [hasShownThirtyMinWarning, setHasShownThirtyMinWarning] = useState(
    false,
  );

  // --------- Paywall unlock state (2026-05-15: session-bound model) ---------
  //
  // Two ways to be unlocked:
  //   (a) Stripe path: user paid $2.99 via Stripe Checkout. localStorage
  //       holds the cs_xxx session ID + the server-provided expires_at.
  //       /api/generate verifies the session against Stripe metadata on
  //       every call. Unlock dies when:
  //         - 2 hours pass (server-stamped expires_at), OR
  //         - The user successfully downloads a photo (/api/deliver flips
  //           metadata.unlock_consumed to "true" on the Stripe session).
  //   (b) Promo path: user entered the friends-and-family code on landing.
  //       localStorage holds the validated code itself. /api/generate
  //       verifies via constant-time compare against PROMO_CODE env var.
  //       No expiry, no consumption — trusted users keep access.
  //
  // localStorage keys in use:
  //   paywall_unlocked        — "true" / absent. Quick presence flag.
  //   unlock_source           — "stripe" | "promo"
  //   stripe_session_id       — cs_xxx (only when source=stripe)
  //   unlock_expires_at       — epoch ms (only when source=stripe)
  //   promo_code              — code value (only when source=promo)
  //
  // Migration: legacy installations have paywall_unlocked=true but no
  // stripe_session_id. We treat those as locked-out so the server gate
  // can't be bypassed by stale localStorage. Those users will see the
  // paywall again on their next visit, which is the intended outcome —
  // they're the same population that was burning Gemini credit for free.
  const readUnlockFromStorage = (): boolean => {
    if (typeof window === "undefined") return false;
    try {
      if (window.localStorage.getItem("paywall_unlocked") !== "true") {
        return false;
      }
      const source = window.localStorage.getItem("unlock_source");
      if (source === "promo") {
        // Promo unlock just needs the code present — server re-verifies on
        // every /api/generate call so a stale or invalid code fails there.
        return !!window.localStorage.getItem("promo_code");
      }
      if (source === "stripe") {
        const sid = window.localStorage.getItem("stripe_session_id");
        if (!sid) {
          // Legacy unlock without session ID — clear and force re-pay.
          window.localStorage.removeItem("paywall_unlocked");
          window.localStorage.removeItem("unlock_source");
          window.localStorage.removeItem("paywall_unlocked_at");
          return false;
        }
        const exp = Number(
          window.localStorage.getItem("unlock_expires_at") ?? "0",
        );
        if (!Number.isFinite(exp) || exp <= Date.now()) {
          // Expired locally — clear everything so we don't keep showing
          // unlocked UI to a user the server will 402.
          window.localStorage.removeItem("paywall_unlocked");
          window.localStorage.removeItem("unlock_source");
          window.localStorage.removeItem("stripe_session_id");
          window.localStorage.removeItem("unlock_expires_at");
          return false;
        }
        return true;
      }
      // Unknown source — treat as locked.
      return false;
    } catch {
      // localStorage can throw in private browsing or strict-mode envs.
      return false;
    }
  };
  const [isUnlocked, setIsUnlocked] = useState<boolean>(() =>
    readUnlockFromStorage(),
  );

  // Live ticker for the welcome-popup countdown. Reads the expires_at
  // from localStorage at mount so the popup countdown is accurate even
  // after a page refresh. null when no stripe unlock is active.
  const [unlockExpiresAt, setUnlockExpiresAt] = useState<number | null>(
    () => {
      if (typeof window === "undefined") return null;
      try {
        const raw = window.localStorage.getItem("unlock_expires_at");
        const n = raw ? Number(raw) : NaN;
        return Number.isFinite(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    },
  );

  // thirty-min warning: poll every 15s for the first time remaining
  // crosses the 15-minute threshold, then fire the modal once and
  // stop polling. The hasShown flag prevents the modal from re-firing
  // if the user dismisses and the timer is still under threshold.
  useEffect(() => {
    if (!unlockExpiresAt || hasShownThirtyMinWarning) return;
    // 15 min remaining (down from 30 on 2026-05-15 when the total unlock
    // window dropped from 4h to 2h — 30 min on a 2h session fires too
    // early, halfway through their time). 15 min on a 2h window leaves
    // 12.5% of the session as the "wrap up" zone.
    const WARNING_THRESHOLD_MS = 15 * 60 * 1000;
    const id = setInterval(() => {
      const remaining = unlockExpiresAt - Date.now();
      if (remaining <= WARNING_THRESHOLD_MS && remaining > 0) {
        setShowThirtyMinWarning(true);
        setHasShownThirtyMinWarning(true);
        clearInterval(id);
      } else if (remaining <= 0) {
        // Window expired without the warning firing (user went idle
        // for 3h 30m+). Don't show "30 min left" when they have zero.
        clearInterval(id);
      }
    }, 15 * 1000);
    return () => clearInterval(id);
  }, [unlockExpiresAt, hasShownThirtyMinWarning]);

  // Mark unlocked via the Stripe path. Stores all three keys plus the
  // expires_at the server gave us. Same key write order as below for the
  // promo path; reads are tolerant of any order via readUnlockFromStorage.
  const markStripeUnlocked = (sessionId: string, expiresAt: number) => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("paywall_unlocked", "true");
        window.localStorage.setItem("unlock_source", "stripe");
        window.localStorage.setItem("stripe_session_id", sessionId);
        window.localStorage.setItem(
          "unlock_expires_at",
          String(expiresAt),
        );
      } catch {
        // localStorage failure (private browsing etc.) — unlock survives
        // for this tab via React state only.
      }
    }
    setUnlockExpiresAt(expiresAt);
    setIsUnlocked(true);
  };

  // Mark unlocked via promo. Saves the code so /api/generate can verify
  // it on every call (server enforces; client doesn't trust the flag).
  const markPromoUnlocked = (code: string) => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("paywall_unlocked", "true");
        window.localStorage.setItem("unlock_source", "promo");
        window.localStorage.setItem("promo_code", code);
      } catch {}
    }
    setIsUnlocked(true);
  };

  // Adapter for older call sites that pass just a "source" string. Stripe
  // callers should use markStripeUnlocked directly to provide sessionId +
  // expiresAt; the legacy markUnlocked("stripe") is kept here only for
  // back-compat against code paths that don't yet have those values
  // (currently just the unused Cash App Pay polling fallback).
  const markUnlocked = (source: "stripe" | "promo") => {
    if (source === "promo") {
      // No code available in this back-compat path — caller should use
      // markPromoUnlocked. Bail safely.
      return;
    }
    // Stripe back-compat: just flip the flag. Real callers will follow up
    // with markStripeUnlocked when they have the server's response in hand.
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("paywall_unlocked", "true");
        window.localStorage.setItem("unlock_source", "stripe");
      } catch {}
    }
    setIsUnlocked(true);
  };

  // Clear the unlock entirely (used after /api/deliver burns the
  // server-side metadata on a successful download). Forces the user
  // back to the paywall on their next attempt.
  const clearUnlock = () => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem("paywall_unlocked");
        window.localStorage.removeItem("unlock_source");
        window.localStorage.removeItem("stripe_session_id");
        window.localStorage.removeItem("unlock_expires_at");
        window.localStorage.removeItem("promo_code");
      } catch {}
    }
    setUnlockExpiresAt(null);
    setIsUnlocked(false);
  };

  // Note: the equivalent of getUnlockRequestFields() is defined at module
  // scope as readUnlockRequestFields() so DownloadScreen (a separate
  // component below) can call it too. All /api/generate and /api/deliver
  // callers in this file use that module-scope helper.

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
            // New 2026-05-15: server returns the session ID it stamped
            // metadata on, plus the 2-hour expiration. Both go into
            // localStorage via markStripeUnlocked so the rest of the
            // session can include sessionId on every /api/generate.
            sessionId?: string;
            unlockExpiresAt?: number;
          };

          if (data.customerEmail) lastEmail = data.customerEmail;

          if (data.paid) {
            if (data.sessionId && data.unlockExpiresAt) {
              markStripeUnlocked(data.sessionId, data.unlockExpiresAt);
              // Show the welcome popup with countdown timer.
              setShowWelcomePopup(true);
            } else {
              // Server didn't return the new fields (deploy lag or
              // metadata write failed). Fall back to the legacy flag —
              // user gets in, but /api/generate may 402 them if Stripe
              // metadata isn't there. Logged for diagnostics.
              console.warn(
                "verify-checkout missing sessionId/unlockExpiresAt — using legacy unlock fallback",
              );
              markUnlocked("stripe");
            }
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
            // Intro modal first ("Here's the 5 steps"), photographer-tips
            // modal cascades after the user dismisses it.
            setShowIntroModal(true);
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

    // Switch to the hold-tight interstitial IMMEDIATELY so the customer
    // doesn't see the home landing flash during the 30-90s of async
    // verify+deliver work below. Without this, React's screen-state
    // initializer ran on mount and put them on "landing" — they came
    // back from Stripe to the home page for a few seconds before the
    // success screen took over. (Added 2026-05-27 per Kristi.)
    setScreen("delivering");

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
          // Reset to landing so the customer isn't stuck on "delivering"
          // forever after we put them there a few lines up. (2026-05-27)
          setScreen("landing");
          return;
        }
      } catch (err) {
        console.error("verify-checkout (photo) failed:", err);
        setScreen("landing");
        return;
      }

      // Payment confirmed. (Note: the legacy `credit_used` sessionStorage
      // flag is no longer written here — the flat-price model removed
      // 2026-05-14 means every photo is $11.99 regardless of past purchases.)

      // Read the pending delivery payload stashed by CheckoutScreen.
      const stashRaw = window.sessionStorage.getItem("pending_delivery");
      if (!stashRaw) {
        console.error(
          "photo_paid return without pending_delivery in sessionStorage",
        );
        setScreen("landing");
        return;
      }
      window.sessionStorage.removeItem("pending_delivery");
      let stash: {
        email: string;
        // Full name (added 2026-05-22). Optional because in-flight pre-deploy
        // checkouts have stashes without this field — the deliver call below
        // falls back to "" and the server-side validator will reject those
        // with a clear message, prompting the customer to contact support.
        customerName?: string;
        uploadedUrls: string[];
        referencePhotoUrls: string[];
        selections: StyleSelections;
        // Per-photo retouch tier — index N here matches uploadedUrls[N].
        // Optional for back-compat with pre-Path-B stashes (any in-flight
        // checkout still using the old stash shape will default to
        // "polished" for every photo when this is undefined).
        retouchTiers?: RetouchTier[];
      };
      try {
        stash = JSON.parse(stashRaw);
      } catch {
        console.error("pending_delivery JSON parse failed");
        setScreen("landing");
        return;
      }

      // Call /api/deliver with the stashed data — same shape the CheckoutScreen
      // would have sent directly in the promo/unpaid path.
      try {
        // Resolve retouch tiers — use the stashed array if present;
        // fall back to "polished" for every photo if the stash predates
        // Path B (in-flight customers who paid before the deploy).
        const resolvedTiers: RetouchTier[] =
          Array.isArray(stash.retouchTiers) &&
          stash.retouchTiers.length === stash.uploadedUrls.length
            ? stash.retouchTiers
            : stash.uploadedUrls.map(() => "basic" as RetouchTier);
        const deliverResp = await fetch("/api/deliver", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: stash.email,
            // Customer name (added 2026-05-22). Falls back to empty string
            // for stashes that predate this field — server-side validation
            // will reject those with a clear error, prompting the customer
            // to contact Kristi (the legacy unlock path is rare anyway).
            customerName: (stash.customerName ?? "").trim(),
            photoUrls: stash.uploadedUrls,
            referencePhotoUrls: stash.referencePhotoUrls,
            style: stash.selections.style,
            attire: stash.selections.attire,
            lighting: stash.selections.lighting,
            background: stash.selections.background,
            skin: stash.selections.skin,
            retouchTiers: resolvedTiers,
            // Burn the entry unlock (Stripe metadata flip) when delivery
            // succeeds. Promo users have no sessionId; server skips them.
            ...readUnlockRequestFields(),
          }),
        });
        if (!deliverResp.ok) throw new Error(`HTTP ${deliverResp.status}`);
        const deliverData = (await deliverResp.json()) as {
          photoUrls: string[];
          shareGraphicUrls?: string[];
        };
        // Burn the local unlock state now that the server has marked the
        // Stripe session as consumed. Without this, the localStorage flag
        // would still say "unlocked" until the 4h TTL expired — fine for
        // security (server gate catches anyway, returns 402) but the UI
        // would falsely show the user as still in the try-it window.
        clearUnlock();
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
        // Drop them back to landing so they're not stuck on "delivering"
        // behind the alert. The alert above carries the action they need
        // to take (email Kristi). (2026-05-27)
        setScreen("landing");
      }
    })();
    // Run exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    setScreen("landing");
    setSelectedImageUrls([]);
    setRetouchTiers({});
    setHasSeenRetouchIntro(false);
    setShowRetouchIntroModal(false);
    setHasSeenLoadingRetouchPopup(false);
    setShowLoadingRetouchPopup(false);
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
    // Clear cart (Phase 1, 2026-06-03). Reset means new session, new source
    // photos — prior cart URLs no longer reference anything meaningful.
    setCart([]);
    setHasSeenTips(false);
    setShowTipsModal(false);
    setHasSeenIntro(false);
    setShowIntroModal(false);
  };

  // Landing → Upload. If the user has already unlocked (via Stripe or promo
  // code earlier in this session), go straight to Upload. Otherwise redirect
  // to Stripe Checkout for the $4.99 entry fee — on return, the mount-time
  // useEffect above catches ?paid=1&session_id=... and advances them here.
  const handleStart = async () => {
    if (isUnlocked) {
      setScreen("upload");
      // Show 5-step intro first; tips modal cascades after dismissal
      // (see handleDismissIntro). If both are already seen this session,
      // neither fires and the user lands on Upload directly.
      if (!hasSeenIntro) setShowIntroModal(true);
      else if (!hasSeenTips) setShowTipsModal(true);
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
  const handlePromoUnlock = (code: string) => {
    // Persist the validated promo code so /api/generate can re-verify it
    // server-side on every call. The server is the actual gate; this
    // storage just lets us survive page refreshes without re-prompting.
    markPromoUnlocked(code);
    setScreen("upload");
    if (!hasSeenIntro) setShowIntroModal(true);
    else if (!hasSeenTips) setShowTipsModal(true);
  };

  const handleDismissTips = () => {
    setShowTipsModal(false);
    setHasSeenTips(true);
  };

  // Intro modal dismissed → mark seen, then immediately fire the
  // photographer-tips modal so the two sit in a natural sequence
  // (big-picture roadmap first, fundamentals second). If the user has
  // already seen tips this session, just close.
  const handleDismissIntro = () => {
    setShowIntroModal(false);
    setHasSeenIntro(true);
    if (!hasSeenTips) setShowTipsModal(true);
  };

  // Retouch intro popup dismissed → mark seen so it doesn't re-fire
  // if the user navigates back and forward across the retouch screen.
  const handleDismissRetouchIntro = () => {
    setShowRetouchIntroModal(false);
    setHasSeenRetouchIntro(true);
  };

  // Fire the "you control the retouching" popup once readyCount hits 3
  // (halfway through the 6 generations). Earlier (2026-05-18) the trigger
  // was a flat 3-second timer, but Kristi found that fired before any
  // photos were visible, so the heads-up felt disconnected from what
  // was on screen. Triggering at 3-of-6 ready means the customer has
  // already seen real generated headshots — the popup explains the
  // visible "realistic skin on purpose" output and previews what's
  // coming next. Once dismissed it doesn't re-fire.
  useEffect(() => {
    if (screen !== "loading" || hasSeenLoadingRetouchPopup) return;
    if (readyCount >= 3) {
      setShowLoadingRetouchPopup(true);
      setHasSeenLoadingRetouchPopup(true);
    }
  }, [screen, hasSeenLoadingRetouchPopup, readyCount]);

  // Transition handler from Grid → Retouch (replaces the previous
  // Grid → Checkout direct jump). Pre-fills retouchTiers for any newly
  // selected URLs that don't have a tier yet — defaults to "basic"
  // per Glow Up Deluxe (2026-05-18): basic is the cheaper option and
  // the safest default so a customer who just clicks through doesn't
  // get auto-upsold to $14.99/photo.
  // 2026-06-03: takes URL list (was index list) so the cart can hold
  // picks from across multiple generation rounds.
  const handleAdvanceToRetouch = (selections: string[]) => {
    setSelectedImageUrls(selections);
    setRetouchTiers((prev) => {
      const next = { ...prev };
      for (const url of selections) {
        if (!(url in next)) next[url] = "basic";
      }
      return next;
    });
    setScreen("retouch");
    // Fire the intro popup once per session so the customer understands
    // what the radio choice on the retouch screen actually means.
    if (!hasSeenRetouchIntro) setShowRetouchIntroModal(true);
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
    if (!lastSelections || lastPhotoUrls.length < 5) {
      // Shouldn't happen — we only show the Grid after a successful generate,
      // which always sets these. Silent no-op safety net.
      // Min bumped from 3 → 5 on 2026-05-15 along with the server check.
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
          ...readUnlockRequestFields(),
        }),
      });
      if (response.status === 402) {
        clearUnlock();
        throw new Error(PAYWALL_EXPIRED_MESSAGE);
      }
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
    const usablePhotos = photos.filter(
      (p) => p.status === "done" && p.blobUrl,
    );
    const photoUrls = usablePhotos.map((p) => p.blobUrl as string);
    // Wide-angle flag: true if ANY usable reference photo was detected as
    // wide via EXIF. `null` (EXIF unreadable) and `false` (confirmed ≥40mm)
    // both count as "not wide" — the server will fall back to Block 1's
    // generic "if it appears wide-angle..." wording in those cases.
    const hasWideAngle = usablePhotos.some((p) => p.isWideAngle === true);

    if (photoUrls.length < 5) {
      setGenerationError(
        "We need at least 5 uploaded photos to generate. Go back and add more.",
      );
      setScreen("loading");
      return;
    }

    // Reset prior generation state in case the user regenerated.
    // Cart is independent (Phase 1, 2026-06-03 — revised): every Generate
    // refreshes ALL 6 slots so the user sees the new style choice across
    // the entire grid. The cart is URL-keyed, not slot-keyed, so saved
    // picks survive untouched even though the grid completely refreshes.
    // This lets a customer keep their best shot from the suit/office round,
    // change to sweater/outdoor, generate 6 more, and have BOTH live in
    // the cart.
    setGeneratedImages([]);
    setReadyCount(0);
    setGenerationError(null);
    setRegenCount(0);
    setRegeneratingSlots(new Set());
    setInitialBatchInFlight(new Set([0, 1, 2, 3, 4, 5]));
    // Persist selections + URLs so per-slot regeneration can reuse them
    // without asking the user to reselect anything.
    setLastSelections(selections);
    setLastPhotoUrls(photoUrls);
    setLastHasWideAngle(hasWideAngle);
    setScreen("loading");

    // Fire 6 staggered calls. Each gets a unique variationIndex (0-5) so
    // the backend picks a different "flavor" per photo. Staggering matters
    // here MORE than usual because gemini-3.1-flash-image-preview is a
    // Preview model with documented capacity issues — multiple Google AI
    // forum threads from 2026 confirm persistent 503 "Server Overloaded"
    // errors even on paid Tier 1 accounts (e.g. discuss.ai.google.dev/t/
    // persistent-503-server-overloaded-errors-on-gemini-3-1-flash-image-
    // preview-tier-1-paid-account/134665). Tighter stagger = more
    // concurrent pressure = more 503s.
    //
    // Stagger history:
    //   - 3s (initial): start times 0, 3, 6, 9, 12, 15s
    //   - 2s (2026-05-04): start times 0, 2, 4, 6, 8, 10s
    //   - 5s (2026-05-06, current): start times 0, 5, 10, 15, 20, 25s.
    //     Bumped because Kristi reported slot 6 consistently lagging
    //     ~3 minutes — exactly what the Google-side 503 pattern looks
    //     like when 6 parallel calls all hit at once. By the time slot 6
    //     fires at t=25s, slots 1-3 are typically done and worker pool
    //     pressure has dropped.
    //
    // Tradeoff: total batch time is ~25s longer at the start (slot 6
    // starts later) but slot 6 actually completes instead of timing out.
    // Net user-visible latency is similar or better because we no longer
    // wait through 2-3 minutes of failed retries.
    const STAGGER_MS = 5000;
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
            // Paywall enforcement (2026-05-15): server requires either a
            // valid Stripe session ID or the promo code on every call.
            ...readUnlockRequestFields(),
          }),
        });
        if (response.status === 402) {
          // Server rejected the unlock — either the 4h window expired
          // or the customer already downloaded (consumed). Clear local
          // unlock state so the UI stops showing them as unlocked, and
          // surface Kristi's standard friendly message.
          clearUnlock();
          throw new Error(PAYWALL_EXPIRED_MESSAGE);
        }
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
      {/* Old "Generation Studio / Selected (N)" navbar — hidden on landing
          and healthcare screens because LandingV2 + HealthcareScreen each
          have their own GenerAItion top nav. Showing both at once stacks
          two header bars and visually clashes, AND surfaces the old
          "Generation Studio" brand name on a public marketing page where
          we want only "GenerAItion Headshots" for brand-entity consistency
          (Google + AI search engines associate the domain with one brand
          string only). */}
      {screen !== "landing" && screen !== "healthcare" && (
        <Navbar
          cartCount={cart.length}
          onLogoClick={reset}
          currentStep={getStepFromScreen(screen)}
        />
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
          onNavigateHowItWorks={() => {
            // Sync URL + screen so direct refresh + bookmarks land on
            // /how-it-works. Mirrors the healthcare navigation pattern.
            if (window.location.pathname !== "/how-it-works") {
              window.history.pushState({}, "", "/how-it-works");
            }
            setScreen("how-it-works");
          }}
          onNavigateHealthcare={() => {
            // Sync URL + screen state. We don't set entrySpecialty here yet —
            // it's only set when the customer actually clicks "Start" on the
            // /healthcare page so backing out before starting doesn't leave
            // a stale preselection in state.
            if (window.location.pathname !== "/healthcare") {
              window.history.pushState({}, "", "/healthcare");
            }
            setScreen("healthcare");
          }}
        />
      )}
      {screen === "how-it-works" && (
        <HowItWorksScreen
          onStart={handleStart}
          onBackToHome={() => {
            setScreen("landing");
            if (window.location.pathname !== "/") {
              window.history.pushState({}, "", "/");
            }
          }}
        />
      )}
      {screen === "healthcare" && (
        <HealthcareScreen
          onPromoUnlock={handlePromoUnlock}
          onStart={() => {
            // CTA on /healthcare drops the visitor into the same upload flow
            // as the home page. URL stays at /healthcare while they're in
            // the flow — fine for now; can rewire later if attribution wants
            // a /healthcare/start path.
            //
            // Record the entry specialty so the Style screen lands with
            // Healthcare style + Medical attire pre-checked instead of the
            // generic "corporate" default. Added 2026-05-27.
            setEntrySpecialty("healthcare");
            handleStart();
          }}
          onBackToHome={() => {
            setScreen("landing");
            // Generic entry from home shouldn't inherit a leftover healthcare
            // preselection — clear the specialty when the customer returns
            // to the main landing page.
            setEntrySpecialty(null);
            // Sync the URL so browser back works and refreshing lands them
            // on the right page.
            if (window.location.pathname !== "/") {
              window.history.pushState({}, "", "/");
            }
          }}
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
          // Preselect Healthcare style + Medical attire if the customer
          // entered via /healthcare. Generic landing entries leave both
          // undefined so the screen falls back to its own defaults.
          defaultStyle={
            entrySpecialty === "healthcare" ? "healthcare" : undefined
          }
          defaultAttire={
            entrySpecialty === "healthcare" ? "medical" : undefined
          }
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
          onDeliver={handleAdvanceToRetouch}
          onBack={() => setScreen("style")}
          onRegenerateSlot={handleRegenerateSlot}
          regenError={regenError}
          regenCount={regenCount}
          maxRegens={MAX_SINGLE_REGENS}
          regeneratingSlots={regeneratingSlots}
          initialBatchInFlight={initialBatchInFlight}
          cart={cart}
          onAddToCart={addToCart}
          onRemoveFromCart={removeFromCart}
          maxCartSize={MAX_CART_SIZE}
        />
      )}
      {screen === "retouch" && (
        <RetouchScreen
          selectedUrls={selectedImageUrls}
          retouchTiers={retouchTiers}
          setRetouchTiers={setRetouchTiers}
          onContinue={() => setScreen("checkout")}
          onBack={() => setScreen("grid")}
        />
      )}
      {screen === "checkout" && lastSelections && (
        <CheckoutScreen
          selectedImages={selectedImageUrls}
          referencePhotoUrls={lastPhotoUrls}
          selections={lastSelections}
          retouchTiers={selectedImageUrls.map(
            (url) => retouchTiers[url] ?? "basic",
          )}
          onComplete={({ email: submittedEmail, photoUrls, shareGraphicUrls }) => {
            setEmail(submittedEmail);
            setDeliveredPhotoUrls(photoUrls);
            setDeliveredShareGraphicUrls(shareGraphicUrls ?? []);
            setScreen("success");
          }}
          onBack={() => setScreen("retouch")}
        />
      )}
      {/* Post-Stripe-redirect interstitial. Shown while /api/verify-checkout
          + /api/deliver finish in the background. Without this the customer
          briefly sees the home landing because React mounts fresh after the
          Stripe redirect. Added 2026-05-27. */}
      {screen === "delivering" && <DeliveringScreen />}
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
            setSelectedImageUrls([]);
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
      {/* Welcome popup with the 2-hour countdown — fires the moment a
          fresh $2.99 payment is confirmed by /api/verify-checkout. Higher
          z-index than the intro/tips modals so if multiple are in flight
          this one shows first (it carries the most important info: the
          customer's clock has started). */}
      {showWelcomePopup && unlockExpiresAt && (
        <WelcomeUnlockedModal
          expiresAt={unlockExpiresAt}
          onDismiss={() => setShowWelcomePopup(false)}
        />
      )}
      {/* 15-min warning. Lower z-index than the welcome popup since it
          should only ever fire 3.5h AFTER the welcome modal anyway, but
          we belt-and-suspender the stacking just in case. */}
      {showThirtyMinWarning && unlockExpiresAt && (
        <SessionTimeWarningModal
          expiresAt={unlockExpiresAt}
          onDismiss={() => setShowThirtyMinWarning(false)}
        />
      )}
      {/* Intro modal renders ABOVE the tips modal in the DOM so if both
          are ever simultaneously truthy (shouldn't happen — handleDismissIntro
          chains them, but defensive), the intro one wins visually since both
          use the same z-index. */}
      {showIntroModal && <IntroStepsModal onDismiss={handleDismissIntro} />}
      {/* Mid-loading "you control the retouching" popup. Fires once
          per session ~3 seconds after the customer enters the loading
          screen so they see one slot start generating before being
          interrupted. Tells them realistic skin is on purpose and
          retouching choices are coming next. */}
      {showLoadingRetouchPopup && (
        <LoadingRetouchPreviewModal
          onDismiss={() => setShowLoadingRetouchPopup(false)}
        />
      )}
      {/* Retouch tier intro popup — fires once per session when the customer
          reaches the Retouch screen. Explains what each of the 3 tiers does
          before they tick a radio. */}
      {showRetouchIntroModal && (
        <IntroRetouchModal onDismiss={handleDismissRetouchIntro} />
      )}
      {showTipsModal && <PhotographerTipsModal onDismiss={handleDismissTips} />}
      {/* Back-button warning. Rendered last so its z-index sits on top of
          any other modal (e.g. someone hits back while the retouch intro
          modal is up — the back-warning takes precedence). Only fires
          when the customer is on grid / retouch / checkout AND triggered
          a back navigation; the screen-guard useEffect handles that. */}
      {showBackWarning && (
        <BackWarningModal
          onStay={handleStayOnProtectedScreen}
          onLeave={handleConfirmLeaveProtectedScreen}
        />
      )}
    </div>
  );
}
