// Global two-device link: one WebRTC data channel between two phones, shared by
// every game the way `sound.ts` shares one AudioContext. Games never touch
// RTCPeerConnection — they call `useNetGame()` with a reducer and get a state
// both devices agree on.
//
// There is no server. The site is static, so the two peers are introduced by
// HAND: the host produces an invite code, the guest turns it into a reply code,
// and the host pastes that back. Nothing about the pairing leaves the two
// devices — which is why the codes are shown as QR, meant to be scanned across
// the table rather than sent anywhere.
//
// That also sets the range. With no STUN server the browser only offers the
// addresses it can see itself, so the two devices must be on the same network.
// For a game you pair by holding two phones together that is the normal case,
// and it keeps the promise that no third party is involved. Adding a STUN URL
// below would reach across networks at the cost of telling that server your IP.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

const ICE_SERVERS: RTCIceServer[] = [];

// The invite code carries every ICE candidate the browser found, so we wait for
// gathering to finish rather than trickling them (there is no channel to
// trickle over). Browsers sometimes never report "complete" on a quiet network,
// hence the cap.
const GATHER_TIMEOUT = 2500;

// A pairing code is `<flag><base64url>`: "1" when the payload is deflated, "0"
// when this browser has no CompressionStream. Deflate takes a data-channel SDP
// from ~1.2kB to a few hundred bytes, which is what keeps it inside a QR a
// phone can actually read.
const CODE_RAW = "0";
const CODE_DEFLATED = "1";

export type NetPhase =
  | "idle" // no link, nothing in flight
  | "inviting" // host made an invite, waiting to be handed the reply
  | "joining" // guest made a reply, waiting for the channel to open
  | "connected" // data channel open, play
  | "closed" // the other device went away
  | "failed"; // pairing or connection error

export type NetRole = "host" | "guest";

type Envelope = { t: "state"; s: unknown } | { t: "intent"; i: unknown };

let pc: RTCPeerConnection | null = null;
let dc: RTCDataChannel | null = null;
let phase: NetPhase = "idle";
let role: NetRole | null = null;
let game: string | null = null;
let error: string | null = null;

const listeners = new Set<() => void>();
const inbox = new Set<(msg: Envelope) => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

function setPhase(next: NetPhase, why: string | null = null): void {
  phase = next;
  error = why;
  emit();
}

export function netPhase(): NetPhase {
  return phase;
}
export function netRole(): NetRole | null {
  return role;
}
export function netGame(): string | null {
  return game;
}
export function netError(): string | null {
  return error;
}
export function isNetSupported(): boolean {
  return typeof window !== "undefined" && "RTCPeerConnection" in window;
}

export function subscribeNet(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function onNetMessage(cb: (msg: Envelope) => void): () => void {
  inbox.add(cb);
  return () => inbox.delete(cb);
}

// ---- pairing codes ---------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function squeeze(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function encodeCode(payload: object): Promise<string> {
  const text = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === "undefined") {
    return CODE_RAW + toBase64Url(bytes);
  }
  const packed = await squeeze(
    new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw")),
  );
  return CODE_DEFLATED + toBase64Url(packed);
}

async function decodeCode(code: string): Promise<Record<string, string>> {
  const clean = code.trim().replace(/\s+/g, "");
  const flag = clean.slice(0, 1);
  const body = fromBase64Url(clean.slice(1));
  let bytes = body;
  if (flag === CODE_DEFLATED) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("unsupported");
    }
    bytes = await squeeze(
      new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
    );
  } else if (flag !== CODE_RAW) {
    throw new Error("malformed");
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ---- connection ------------------------------------------------------------

function gathered(conn: RTCPeerConnection): Promise<void> {
  if (conn.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      conn.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (conn.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, GATHER_TIMEOUT);
    conn.addEventListener("icegatheringstatechange", check);
  });
}

function wire(channel: RTCDataChannel): void {
  dc = channel;
  channel.onopen = () => setPhase("connected");
  channel.onclose = () => {
    if (phase === "connected") setPhase("closed");
  };
  channel.onmessage = (e) => {
    let msg: Envelope;
    try {
      msg = JSON.parse(e.data as string) as Envelope;
    } catch {
      return; // the other side is the only writer, but never trust a parse
    }
    for (const cb of inbox) cb(msg);
  };
}

function fresh(): RTCPeerConnection {
  teardown();
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  conn.onconnectionstatechange = () => {
    if (conn !== pc) return;
    if (conn.connectionState === "failed") {
      setPhase("failed", "connection");
    } else if (conn.connectionState === "disconnected") {
      if (phase === "connected") setPhase("closed");
    }
  };
  pc = conn;
  return conn;
}

function teardown(): void {
  dc?.close();
  pc?.close();
  dc = null;
  pc = null;
}

// Host step 1: make the invite the guest scans.
export async function createInvite(forGame: string): Promise<string> {
  if (!isNetSupported()) throw new Error("unsupported");
  const conn = fresh();
  role = "host";
  game = forGame;
  setPhase("inviting");
  wire(conn.createDataChannel("tv", { ordered: true }));
  await conn.setLocalDescription(await conn.createOffer());
  await gathered(conn);
  return encodeCode({ g: forGame, k: "o", s: conn.localDescription?.sdp ?? "" });
}

// Guest: turn the host's invite into the reply the host scans back.
export async function acceptInvite(
  forGame: string,
  code: string,
): Promise<string> {
  if (!isNetSupported()) throw new Error("unsupported");
  const payload = await decodeCode(code);
  if (payload.k !== "o") throw new Error("not-an-invite");
  if (payload.g !== forGame) throw new Error("wrong-game");
  const conn = fresh();
  role = "guest";
  game = forGame;
  setPhase("joining");
  conn.ondatachannel = (e) => wire(e.channel);
  await conn.setRemoteDescription({ type: "offer", sdp: payload.s });
  await conn.setLocalDescription(await conn.createAnswer());
  await gathered(conn);
  return encodeCode({ g: forGame, k: "a", s: conn.localDescription?.sdp ?? "" });
}

// Host step 2: take the guest's reply and the channel opens.
export async function linkInvite(code: string): Promise<void> {
  const payload = await decodeCode(code);
  if (payload.k !== "a") throw new Error("not-a-reply");
  if (payload.g !== game) throw new Error("wrong-game");
  if (!pc) throw new Error("no-invite");
  await pc.setRemoteDescription({ type: "answer", sdp: payload.s });
}

export function netSend(msg: Envelope): void {
  if (dc?.readyState !== "open") return;
  dc.send(JSON.stringify(msg));
}

export function netLeave(): void {
  teardown();
  role = null;
  game = null;
  setPhase("idle");
}

// ---- React ----------------------------------------------------------------

type NetView = {
  phase: NetPhase;
  role: NetRole | null;
  error: string | null;
};

let snapshot: NetView = { phase: "idle", role: null, error: null };
function readSnapshot(): NetView {
  // useSyncExternalStore compares by identity, so only build a new object when
  // something actually moved.
  if (
    snapshot.phase !== phase ||
    snapshot.role !== role ||
    snapshot.error !== error
  ) {
    snapshot = { phase, role, error };
  }
  return snapshot;
}
const SERVER_VIEW: NetView = { phase: "idle", role: null, error: null };

/** Live link status. Safe during prerender — reports `idle` on the server. */
export function useNet(): NetView {
  return useSyncExternalStore(subscribeNet, readSnapshot, () => SERVER_VIEW);
}

/**
 * A game state both devices agree on.
 *
 * The host is the referee: it owns the state, and it is the only side that ever
 * runs `reduce`. Either player calls `dispatch`; on the host that applies
 * straight away and broadcasts the result, on the guest it ships the intent
 * over and the new state comes back. So the two screens cannot drift, and a
 * game only has to supply one pure function.
 *
 * With no peer at all the host branch still runs, which is what makes a game
 * playable solo on one device before anyone pairs.
 */
export function useNetGame<S, I>(
  initial: S,
  reduce: (state: S, intent: I, from: NetRole) => S,
): {
  state: S;
  dispatch: (intent: I) => void;
  setState: (next: S) => void;
  isHost: boolean;
  net: NetView;
} {
  const net = useNet();
  const [state, setLocal] = useState<S>(initial);
  // The reducer closes over the game's own props, so keep the latest one rather
  // than the one captured when the subscription was made.
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;
  const stateRef = useRef(state);
  stateRef.current = state;
  const isHost = net.role !== "guest";

  const publish = useCallback((next: S) => {
    stateRef.current = next;
    setLocal(next);
    netSend({ t: "state", s: next });
  }, []);

  const dispatch = useCallback(
    (intent: I) => {
      if (netRole() === "guest") {
        netSend({ t: "intent", i: intent });
        return;
      }
      publish(reduceRef.current(stateRef.current, intent, "host"));
    },
    [publish],
  );

  useEffect(
    () =>
      onNetMessage((msg) => {
        if (msg.t === "state") {
          // Only the guest takes dictation; a host ignores anything claiming to
          // be state so two hosts can never fight over it.
          if (netRole() === "guest") {
            stateRef.current = msg.s as S;
            setLocal(msg.s as S);
          }
          return;
        }
        if (netRole() === "guest") return;
        const next = reduceRef.current(stateRef.current, msg.i as I, "guest");
        stateRef.current = next;
        setLocal(next);
        netSend({ t: "state", s: next });
      }),
    [],
  );

  // The guest's screen is blank until the host says something, so the host
  // pushes the current state the moment the channel opens.
  useEffect(() => {
    if (net.phase === "connected" && netRole() === "host") {
      netSend({ t: "state", s: stateRef.current });
    }
  }, [net.phase]);

  return { state, dispatch, setState: publish, isHost, net };
}
