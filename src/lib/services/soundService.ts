// Layanan Audio Sintetis Menggunakan Web Audio API untuk Trawangan Terminal
// Menghasilkan nada alert profesional tanpa dependensi file eksternal
//
// Catatan WebKit (Tauri macOS memakai WKWebView): AudioContext yang dibuat di luar interaksi
// pengguna (mis. saat alert terpicu dari timer) tetap "suspended" dan resume()-nya ditolak,
// sehingga chime diputar tanpa suara. Karena itu konteks audio "dibuka" sekali pada interaksi
// pertama (klik / tombol / sentuhan), dan setiap nada menunggu konteks berstatus "running".

type AudioContextLike = AudioContext;

let audioCtx: AudioContextLike | null = null;
let unlockInstalled = false;
const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

function getAudioContext(): AudioContextLike | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  return audioCtx;
}

/**
 * Memasang pembuka audio satu kali: pada interaksi pertama, konteks audio dibuat/dilanjutkan
 * dan satu sampel hening diputar agar WebKit mengizinkan audio berikutnya tanpa interaksi.
 */
export function installAudioUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return;
  }
  unlockInstalled = true;

  const removeListeners = () => {
    for (const ev of UNLOCK_EVENTS) {
      window.removeEventListener(ev, unlock, true);
    }
  };

  function unlock() {
    const ctx = getAudioContext();
    if (!ctx) {
      removeListeners();
      return;
    }
    const playSilentTick = () => {
      try {
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
      } catch {
        // abaikan: hanya pemancing izin audio
      }
    };
    const done = () => {
      playSilentTick();
      if (ctx.state === 'running') removeListeners();
    };
    if (ctx.state === 'running') {
      done();
      return;
    }
    Promise.resolve(ctx.resume())
      .then(done)
      .catch(() => {});
  }

  for (const ev of UNLOCK_EVENTS) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  }
}

/**
 * Menjalankan fungsi render nada hanya ketika konteks audio sudah "running".
 * Bila masih suspended, coba resume dulu; bila tetap ditolak, nada dilewati (tanpa error).
 */
function withRunningContext(render: (ctx: AudioContextLike) => void, label: string): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'running') {
      render(ctx);
      return;
    }
    Promise.resolve(ctx.resume())
      .then(() => {
        if (ctx.state === 'running') render(ctx);
      })
      .catch(() => {});
  } catch (err) {
    console.warn(`Gagal memainkan audio ${label}:`, err);
  }
}

function renderAlertChime(ctx: AudioContextLike): void {
  const now = ctx.currentTime;

  // Nada Pertama: A5 (880 Hz)
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(880, now);
  gain1.gain.setValueAtTime(0.001, now);
  gain1.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
  gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(now);
  osc1.stop(now + 0.46);

  // Nada Kedua: E6 (1318.5 Hz) - Chime kristal lanjutan dengan harmoni harmonik
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'triangle';
  osc2.frequency.setValueAtTime(1318.51, now + 0.08);
  gain2.gain.setValueAtTime(0.001, now + 0.08);
  gain2.gain.exponentialRampToValueAtTime(0.4, now + 0.1);
  gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(now + 0.08);
  osc2.stop(now + 0.71);
}

function renderSuccessPip(ctx: AudioContextLike): void {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(587.33, now); // D5
  osc.frequency.exponentialRampToValueAtTime(880, now + 0.08); // A5

  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.21);
}

/**
 * Mainkan nada chime kristal elegan saat Price Alert terpicu (A5 -> E6 chime)
 */
export function playAlertChime(): void {
  withRunningContext(renderAlertChime, 'alert chime');
}

/**
 * Mainkan nada konfirmasi lembut saat alert berhasil dibuat atau disimpan
 */
export function playSuccessPip(): void {
  withRunningContext(renderSuccessPip, 'success pip');
}

/**
 * Reset internal khusus pengujian.
 */
export function __resetSoundServiceForTests(): void {
  audioCtx = null;
  unlockInstalled = false;
}

// Pasang pembuka audio sedini mungkin di lingkungan browser/WebView.
if (typeof window !== 'undefined') {
  installAudioUnlock();
}
