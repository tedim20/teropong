/**
 * Audio alert di WebKit (Tauri macOS): konteks dibuka pada interaksi pertama, dan nada hanya
 * dirender setelah konteks berstatus "running" (bukan dijadwalkan pada konteks suspended).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeParam { setValueAtTime() {} exponentialRampToValueAtTime() {} }
class FakeNode { frequency = new FakeParam(); gain = new FakeParam(); type = ''; buffer: any; connect() {} start() { FakeCtx.started++; } stop() {} }
class FakeCtx {
  static instances: FakeCtx[] = [];
  static started = 0;
  static allowResume = true;
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 0;
  destination = {};
  constructor() { FakeCtx.instances.push(this); }
  resume() { if (FakeCtx.allowResume) this.state = 'running'; return Promise.resolve(); }
  createOscillator() { return new FakeNode(); }
  createGain() { return new FakeNode(); }
  createBuffer() { return {}; }
  createBufferSource() { return new FakeNode(); }
}

const listeners = new Map<string, Function>();
(globalThis as any).window = {
  AudioContext: FakeCtx,
  addEventListener: (ev: string, fn: Function) => listeners.set(ev, fn),
  removeEventListener: (ev: string) => listeners.delete(ev),
};

const sound = await import('../src/lib/services/soundService');

test('pembuka audio terpasang pada pointerdown/keydown/touchstart dan dilepas setelah running', async () => {
  assert.ok(listeners.has('pointerdown') && listeners.has('keydown') && listeners.has('touchstart'));
  listeners.get('pointerdown')!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(FakeCtx.instances[0].state, 'running');
  assert.equal(listeners.size, 0);
});

test('chime dirender setelah konteks running', async () => {
  const before = FakeCtx.started;
  sound.playAlertChime();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(FakeCtx.started >= before + 2, 'dua oscillator chime harus dimulai');
});

test('chime dilewati tanpa error bila konteks tetap suspended (resume ditolak)', async () => {
  sound.__resetSoundServiceForTests();
  FakeCtx.allowResume = false;
  const before = FakeCtx.started;
  sound.playAlertChime();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(FakeCtx.started, before, 'tidak boleh menjadwalkan nada pada konteks suspended');
  FakeCtx.allowResume = true;
});
