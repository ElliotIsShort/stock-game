"use client";

import { getPrefs } from "./prefs";

/**
 * Tiny synthesised UI sounds (Web Audio, no audio files). Silent unless the
 * player turned sounds on in Preferences. Only call these from a user action
 * or right after one, so browsers allow the AudioContext to start.
 */
export type SoundKind = "buy" | "sell" | "react" | "success";

/** Note sequences: [frequency Hz, start offset s, duration s]. */
const SOUNDS: Record<SoundKind, { wave: OscillatorType; notes: [number, number, number][]; gain: number }> = {
  buy: { wave: "sine", gain: 0.12, notes: [[660, 0, 0.09], [990, 0.07, 0.14]] },
  sell: { wave: "sine", gain: 0.12, notes: [[660, 0, 0.09], [440, 0.07, 0.14]] },
  react: { wave: "triangle", gain: 0.1, notes: [[880, 0, 0.06]] },
  success: { wave: "triangle", gain: 0.1, notes: [[523, 0, 0.1], [659, 0.08, 0.1], [784, 0.16, 0.1], [1047, 0.24, 0.22]] },
};

let ctx: AudioContext | null = null;

export function playSound(kind: SoundKind): void {
  if (typeof window === "undefined" || !getPrefs().sound) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const { wave, notes, gain } = SOUNDS[kind];
    const t0 = ctx.currentTime;
    for (const [freq, at, dur] of notes) {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = wave;
      osc.frequency.value = freq;
      // Quick attack, exponential decay: no clicks.
      amp.gain.setValueAtTime(0.0001, t0 + at);
      amp.gain.exponentialRampToValueAtTime(gain, t0 + at + 0.01);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      osc.connect(amp).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.02);
    }
  } catch {
    // No Web Audio: stay silent.
  }
}
