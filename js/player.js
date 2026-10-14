// Audio-Engine: ein <audio>-Element, Fortschritt speichern, exakt wiederherstellen.

import { trackUrl, coverUrl } from './api.js';
import { store } from './store.js';

const SAVE_EVERY_MS = 4000;

class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.item = null;
    this.index = 0;
    this.pendingSeek = null; // Zielposition, solange das Audio noch nicht bereit ist
    this.lastSave = 0;
    this.sleep = null; // { until: ms } | { endOfTrack: true }
    this.sleepTimer = null;
    this.error = null;
    this.loading = false;
    this.finished = false;

    const a = this.audio;
    a.addEventListener('loadedmetadata', () => this.applyPendingSeek());
    a.addEventListener('canplay', () => { this.loading = false; this.applyPendingSeek(); this.emit(); });
    a.addEventListener('waiting', () => { this.loading = true; this.emit(); });
    a.addEventListener('playing', () => { this.loading = false; this.error = null; this.emit(); });
    a.addEventListener('seeked', () => { this.confirmSeek(); this.save(true); });
    a.addEventListener('timeupdate', () => {
      this.confirmSeek();
      if (Date.now() - this.lastSave > SAVE_EVERY_MS) this.save();
      this.updatePositionState();
      this.emit('time');
    });
    a.addEventListener('play', () => { this.applyRate(); this.emit(); });
    a.addEventListener('pause', () => { this.save(true); this.emit(); });
    a.addEventListener('ended', () => this.onEnded());
    a.addEventListener('error', () => {
      this.loading = false;
      this.error = 'Diese Datei lässt sich nicht abspielen.';
      this.emit();
    });

    // Beim Schließen/Wechseln der Seite sofort sichern.
    const flush = () => this.save(true);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

    this.setupMediaSession();
  }

  emit(kind = 'change') {
    this.dispatchEvent(new Event(kind));
  }

  get track() {
    return this.item?.tracks[this.index] || null;
  }

  get playing() {
    return !this.audio.paused && !this.audio.ended;
  }

  get currentTime() {
    return this.pendingSeek ?? this.audio.currentTime ?? 0;
  }

  get duration() {
    const d = this.audio.duration;
    return Number.isFinite(d) && d > 0 ? d : this.track?.duration || 0;
  }

  // Titel laden. `time` = Startposition in Sekunden innerhalb der Spur.
  load(item, index = 0, time = 0, autoplay = true) {
    if (!item?.tracks?.length) return;
    this.save(true);
    index = Math.max(0, Math.min(index, item.tracks.length - 1));
    const sameTrack = this.item?.id === item.id && this.index === index && this.audio.src;
    this.item = item;
    this.index = index;
    this.error = null;
    this.finished = false;

    if (!sameTrack) {
      this.audio.src = trackUrl(item.id, item.tracks[index].name);
      this.loading = autoplay;
    }
    this.pendingSeek = time > 0 ? time : null;
    if (sameTrack) this.applyPendingSeek();
    this.applyRate();
    this.updateMediaMetadata();
    if (autoplay) this.play();
    this.save(true);
    this.emit();
    this.emit('track');
  }

  // Dort weitermachen, wo dieser Titel zuletzt gestoppt wurde.
  resume(item, autoplay = true) {
    const p = store.progress(item.id);
    if (!p || p.removed) return this.load(item, 0, 0, autoplay);
    let idx = item.tracks.findIndex((t) => t.name === p.trackName);
    if (idx < 0) idx = Math.min(p.track || 0, item.tracks.length - 1);
    const time = p.finished ? 0 : p.time || 0;
    this.load(item, p.finished ? 0 : idx, time, autoplay);
  }

  play() {
    if (!this.item) return;
    if (this.finished) return this.load(this.item, 0, 0, true);
    const p = this.audio.play();
    if (p?.catch) p.catch((err) => {
      if (err.name !== 'AbortError') { this.loading = false; this.emit(); }
    });
  }

  pause() { this.audio.pause(); }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    t = Math.max(0, Math.min(t, (this.duration || Infinity) - 0.5));
    if (this.audio.readyState >= 1 && this.pendingSeek == null) {
      this.audio.currentTime = t;
    } else {
      this.pendingSeek = t;
      this.applyPendingSeek();
    }
    this.save(true);
    this.emit('time');
  }

  skip(sec) {
    const t = this.currentTime + sec;
    if (t < 0 && this.index > 0 && sec < 0) return this.seek(0);
    this.seek(t);
  }

  next() {
    if (!this.item) return;
    if (this.index < this.item.tracks.length - 1) this.load(this.item, this.index + 1, 0, true);
  }

  prev() {
    if (!this.item) return;
    if (this.currentTime > 5 || this.index === 0) return this.seek(0);
    this.load(this.item, this.index - 1, 0, true);
  }

  setRate(r) {
    store.setSetting('rate', r);
    this.applyRate();
    this.emit();
  }

  get rate() { return store.get().settings.rate || 1; }

  applyRate() {
    this.audio.defaultPlaybackRate = this.rate;
    this.audio.playbackRate = this.rate;
  }

  applyPendingSeek() {
    if (this.pendingSeek == null || this.audio.readyState < 1) return;
    try { this.audio.currentTime = this.pendingSeek; } catch { /* noch nicht bereit */ }
  }

  confirmSeek() {
    if (this.pendingSeek == null) return;
    if (Math.abs(this.audio.currentTime - this.pendingSeek) < 1.5) this.pendingSeek = null;
  }

  onEnded() {
    const { item, index } = this;
    if (!item) return;
    store.markTrackDone(item.id, item.tracks[index].name);
    if (this.sleep?.endOfTrack) {
      this.clearSleep();
      if (index < item.tracks.length - 1) this.load(item, index + 1, 0, false);
      return;
    }
    if (index < item.tracks.length - 1) {
      this.load(item, index + 1, 0, true);
    } else {
      this.finished = true;
      this.save(true);
      this.emit();
    }
  }

  snapshot() {
    const { item, index } = this;
    const before = item.tracks.slice(0, index).reduce((s, t) => s + (t.duration || 0), 0);
    const total = item.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    const time = this.currentTime;
    return {
      title: item.title,
      creator: item.creator,
      track: index,
      trackName: item.tracks[index].name,
      trackTitle: item.tracks[index].title,
      trackCount: item.tracks.length,
      time,
      duration: this.duration,
      bookPos: before + time,
      bookLen: total,
    };
  }

  save(force = false) {
    if (!this.item || !this.track) return;
    // Während eine Wiederherstellung läuft, nicht mit 0 überschreiben.
    if (this.pendingSeek != null && this.audio.readyState >= 1 && !force) return;
    this.lastSave = Date.now();
    store.saveProgress(this.item.id, { ...this.snapshot(), finished: this.finished, removed: false });
  }

  // Schlaf-Timer: Minuten oder 'track' (Ende des Kapitels). null = aus.
  setSleep(value) {
    this.clearSleep();
    if (value === 'track') this.sleep = { endOfTrack: true };
    else if (value) {
      this.sleep = { until: Date.now() + value * 60000 };
      this.sleepTimer = setInterval(() => {
        if (Date.now() >= this.sleep.until) { this.pause(); this.clearSleep(); }
        this.emit();
      }, 1000);
    }
    this.emit();
  }

  clearSleep() {
    clearInterval(this.sleepTimer);
    this.sleepTimer = null;
    this.sleep = null;
    this.emit();
  }

  setupMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const h = {
      play: () => this.play(),
      pause: () => this.pause(),
      seekbackward: (d) => this.skip(-(d.seekOffset || 15)),
      seekforward: (d) => this.skip(d.seekOffset || 30),
      previoustrack: () => this.prev(),
      nexttrack: () => this.next(),
      seekto: (d) => this.seek(d.seekTime),
    };
    for (const [k, fn] of Object.entries(h)) {
      try { ms.setActionHandler(k, fn); } catch { /* nicht unterstützt */ }
    }
  }

  updateMediaMetadata() {
    if (!navigator.mediaSession || !this.item || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.track.title,
      artist: this.item.creator,
      album: this.item.title,
      artwork: [{ src: this.item.cover || coverUrl(this.item.id), sizes: '512x512' }],
    });
  }

  updatePositionState() {
    const ms = navigator.mediaSession;
    if (!ms?.setPositionState || !this.duration) return;
    try {
      ms.setPositionState({ duration: this.duration, position: Math.min(this.currentTime, this.duration), playbackRate: this.audio.playbackRate || 1 });
    } catch { /* ignorieren */ }
  }
}

export const player = new Player();
