import { useEffect, useSyncExternalStore } from "react";
import {
  installAudioUnlock,
  isMuted,
  subscribeMuted,
  toggleMuted,
} from "../sound";

// Global mute control, shown in the top bar on every page. Reflects the shared
// (persisted) mute state and arms the audio-unlock on mount.
export function SoundToggle() {
  const muted = useSyncExternalStore(subscribeMuted, isMuted, () => false);

  useEffect(() => {
    installAudioUnlock();
  }, []);

  return (
    <button
      type="button"
      onClick={() => toggleMuted()}
      aria-label={muted ? "Unmute" : "Mute"}
      aria-pressed={muted}
      className="text-base leading-none opacity-70 transition-opacity hover:opacity-100"
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}
