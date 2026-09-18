import { useCallback, useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import {
  acceptInvite,
  createInvite,
  isNetSupported,
  linkInvite,
  netLeave,
  useNet,
} from "../net";
import { sfx } from "../sound";

// The hand-shake, shown by any game that wants a second device. The two codes
// are long, so the primary way across is a QR held up to the other phone's
// camera; the text box underneath is the fallback for browsers with no
// BarcodeDetector (Safari, mainly) and for pairing two tabs on a desktop.
//
// Host: Invite → show QR → scan the guest's reply → playing.
// Guest: Join → scan the host's QR → show the reply QR → playing.

type Step = "menu" | "invite" | "join" | "reply";

// Anything larger than this will not fit a QR a phone can read across a table,
// so we stop offering the picture and ask for copy/paste instead.
const QR_LIMIT = 1800;

function useScanner(onCode: (code: string) => void) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [scanning, setScanning] = useState(false);
  const [supported, setSupported] = useState(false);
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        "BarcodeDetector" in window &&
        !!navigator.mediaDevices?.getUserMedia,
    );
  }, []);

  const stop = useCallback(() => {
    stopRef.current();
    setScanning(false);
  }, []);

  const start = useCallback(async () => {
    setScanning(true);
    let stream: MediaStream | null = null;
    let raf = 0;
    let dead = false;
    stopRef.current = () => {
      dead = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      if (dead) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      const Detector = (
        window as unknown as {
          BarcodeDetector: new (o: { formats: string[] }) => {
            detect: (s: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
          };
        }
      ).BarcodeDetector;
      const detector = new Detector({ formats: ["qr_code"] });
      const tick = async () => {
        if (dead) return;
        try {
          const found = await detector.detect(video);
          if (found.length > 0 && found[0].rawValue) {
            stopRef.current();
            setScanning(false);
            onCode(found[0].rawValue);
            return;
          }
        } catch {
          // a dropped frame is not worth ending the scan over
        }
        raf = requestAnimationFrame(() => void tick());
      };
      void tick();
    } catch {
      stopRef.current();
      setScanning(false);
    }
  }, [onCode]);

  useEffect(() => () => stopRef.current(), []);
  return { videoRef, scanning, supported, start, stop };
}

function QrCode({ text }: { text: string }) {
  const [path, setPath] = useState<{ d: string; size: number } | null>(null);

  useEffect(() => {
    let live = true;
    if (text.length > QR_LIMIT) {
      setPath(null);
      return;
    }
    // Pulled in only when a code is actually on screen, so the encoder never
    // weighs on the games that don't pair.
    import("uqr")
      .then(({ encode }) => {
        if (!live) return;
        const qr = encode(text, { ecc: "L" });
        let d = "";
        for (let y = 0; y < qr.size; y++) {
          for (let x = 0; x < qr.size; x++) {
            if (qr.data[y][x]) d += `M${x} ${y}h1v1h-1z`;
          }
        }
        setPath({ d, size: qr.size });
      })
      .catch(() => live && setPath(null));
    return () => {
      live = false;
    };
  }, [text]);

  if (!path) {
    return (
      <p className="py-6 text-center text-sm text-neutral-400">
        <Trans
          id="net.qr.toobig"
          message="Too long for a QR code — use the text below."
        />
      </p>
    );
  }
  return (
    <svg
      viewBox={`-2 -2 ${path.size + 4} ${path.size + 4}`}
      className="mx-auto w-full max-w-[80vw] rounded-lg bg-white p-2 [image-rendering:pixelated]"
      shapeRendering="crispEdges"
      role="img"
      aria-label="Pairing code"
    >
      <path d={path.d} fill="#0a0a0a" />
    </svg>
  );
}

function CodeBox({
  text,
  onCopy,
}: {
  text: string;
  onCopy: (ok: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        readOnly
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 rounded-md bg-neutral-900 px-2 py-1.5 font-mono text-xs text-neutral-400 ring-1 ring-neutral-700"
      />
      <button
        type="button"
        onClick={() =>
          navigator.clipboard
            ?.writeText(text)
            .then(() => onCopy(true))
            .catch(() => onCopy(false))
        }
        className="shrink-0 rounded-md bg-neutral-800 px-3 py-1.5 text-sm font-medium hover:bg-neutral-700"
      >
        <Trans id="net.copy" message="Copy" />
      </button>
    </div>
  );
}

export function PairingPanel({ game }: { game: string }) {
  const net = useNet();
  const [step, setStep] = useState<Step>("menu");
  const [mine, setMine] = useState(""); // the code this device is showing
  const [typed, setTyped] = useState(""); // the code being pasted in
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The prerendered HTML has no `window` to ask, so assume the link is
  // available and correct it after mount — checking during render would make
  // the server and client disagree and blow up hydration.
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(isNetSupported()), []);

  const fail = (id: string) => setNote(id);

  const takeCode = useCallback(
    async (code: string) => {
      setBusy(true);
      setNote(null);
      try {
        if (step === "invite") {
          await linkInvite(code);
        } else {
          setMine(await acceptInvite(game, code));
          setStep("reply");
        }
        sfx.ui();
      } catch {
        fail(step === "invite" ? "net.err.reply" : "net.err.invite");
      } finally {
        setBusy(false);
        setTyped("");
      }
    },
    [game, step],
  );

  const scanner = useScanner((code) => void takeCode(code));

  const host = async () => {
    setBusy(true);
    setNote(null);
    try {
      setMine(await createInvite(game));
      setStep("invite");
      sfx.ui();
    } catch {
      fail("net.err.start");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    scanner.stop();
    netLeave();
    setStep("menu");
    setMine("");
    setTyped("");
    setNote(null);
  };

  if (!supported) {
    return (
      <p className="rounded-lg bg-neutral-900 px-4 py-3 text-center text-sm text-neutral-400">
        <Trans
          id="net.unsupported"
          message="This browser can't open a link between two devices."
        />
      </p>
    );
  }

  const showScanner = step === "invite" || step === "join";

  return (
    <div className="w-full rounded-xl bg-neutral-900/80 p-4 ring-1 ring-neutral-800">
      {step === "menu" && (
        <div className="space-y-3">
          <p className="text-center text-sm text-neutral-400">
            <Trans
              id="net.intro"
              message="Play against a friend on their own phone. One of you invites, the other scans."
            />
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void host()}
              className="flex-1 rounded-full bg-emerald-500 px-4 py-2.5 font-semibold text-neutral-900 hover:bg-emerald-400 disabled:opacity-50"
            >
              <Trans id="net.invite" message="Invite" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setStep("join");
                setNote(null);
              }}
              className="flex-1 rounded-full bg-neutral-800 px-4 py-2.5 font-semibold hover:bg-neutral-700 disabled:opacity-50"
            >
              <Trans id="net.join" message="Join" />
            </button>
          </div>
        </div>
      )}

      {(step === "invite" || step === "reply") && (
        <div className="space-y-3">
          <p className="text-center text-sm font-medium">
            {step === "invite" ? (
              <Trans
                id="net.show.invite"
                message="Let the other phone scan this, then scan their reply."
              />
            ) : (
              <Trans
                id="net.show.reply"
                message="Let the first phone scan this to finish."
              />
            )}
          </p>
          <QrCode text={mine} />
          <CodeBox
            text={mine}
            onCopy={(ok) => setNote(ok ? "net.copied" : "net.err.copy")}
          />
        </div>
      )}

      {showScanner && (
        <div className="mt-3 space-y-2 border-t border-neutral-800 pt-3">
          <p className="text-center text-sm font-medium">
            {step === "invite" ? (
              <Trans id="net.scan.reply" message="Scan their reply" />
            ) : (
              <Trans id="net.scan.invite" message="Scan their invite" />
            )}
          </p>
          {scanner.scanning && (
            <video
              ref={scanner.videoRef}
              playsInline
              muted
              className="mx-auto aspect-square w-full max-w-[80vw] rounded-lg object-cover ring-2 ring-emerald-500"
            />
          )}
          <div className="flex gap-2">
            {scanner.supported && (
              <button
                type="button"
                onClick={() =>
                  scanner.scanning ? scanner.stop() : void scanner.start()
                }
                className="flex-1 rounded-full bg-neutral-800 px-4 py-2 text-sm font-semibold hover:bg-neutral-700"
              >
                {scanner.scanning ? (
                  <Trans id="net.scan.stop" message="Stop camera" />
                ) : (
                  <Trans id="net.scan.start" message="Scan QR" />
                )}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="…"
              spellCheck={false}
              autoCapitalize="none"
              className="min-w-0 flex-1 rounded-md bg-neutral-900 px-2 py-1.5 font-mono text-xs ring-1 ring-neutral-700 placeholder:text-neutral-600"
            />
            <button
              type="button"
              disabled={busy || typed.trim().length === 0}
              onClick={() => void takeCode(typed)}
              className="shrink-0 rounded-md bg-neutral-800 px-3 py-1.5 text-sm font-medium hover:bg-neutral-700 disabled:opacity-40"
            >
              <Trans id="net.use" message="Use" />
            </button>
          </div>
        </div>
      )}

      {net.phase === "joining" && step === "reply" && (
        <p className="mt-3 text-center text-sm text-neutral-400">
          <Trans id="net.waiting" message="Waiting for the other phone…" />
        </p>
      )}

      {note && (
        <p className="mt-3 text-center text-sm text-amber-300">
          {note === "net.copied" && (
            <Trans id="net.copied" message="Copied." />
          )}
          {note === "net.err.copy" && (
            <Trans id="net.err.copy" message="Couldn't copy — select it by hand." />
          )}
          {note === "net.err.start" && (
            <Trans id="net.err.start" message="Couldn't create an invite." />
          )}
          {note === "net.err.invite" && (
            <Trans id="net.err.invite" message="That isn't a valid invite for this game." />
          )}
          {note === "net.err.reply" && (
            <Trans id="net.err.reply" message="That isn't a valid reply." />
          )}
        </p>
      )}

      {net.phase === "failed" && (
        <p className="mt-3 text-center text-sm text-rose-300">
          <Trans
            id="net.err.connect"
            message="Couldn't reach the other device. Both phones must be on the same Wi-Fi."
          />
        </p>
      )}

      {step !== "menu" && (
        <button
          type="button"
          onClick={reset}
          className="mt-3 w-full rounded-full px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200"
        >
          <Trans id="common.cancel" message="Cancel" />
        </button>
      )}
    </div>
  );
}
