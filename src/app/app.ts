import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  ViewChild,
  afterNextRender,
  inject,
} from '@angular/core';
import { FlowField } from './geo/flow-bake';
import { LandRings, decodeLand, drawLandLayer, renderLandLayer } from './geo/land';
import { Projection } from './geo/projection';
import { Terrain, decodeElevation } from './geo/terrain';
import { WindSampler, decodeWind } from './geo/wind';
import { CurlNoise } from './sim/noise';
import { ParticleSystem } from './sim/particles';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  standalone: true,
})
export class App {
  @ViewChild('canvasElement') canvasRef!: ElementRef<HTMLCanvasElement>;
  private ctx!: CanvasRenderingContext2D;
  private animationFrameId = 0;
  private particles!: ParticleSystem;
  private readonly noise = new CurlNoise();
  private mouse = { x: -1000, y: -1000, targetX: -1000, targetY: -1000 };
  private width = 0;
  private height = 0;
  private windRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private flow: FlowField | null = null;
  private windSampler: WindSampler | null = null;
  private terrain: Terrain | null = null;
  private lastBake = 0;
  private proj!: Projection;
  private landRings: LandRings = [];
  private landLayer: HTMLCanvasElement | null = null;
  private isTouchDevice = false;
  // Mobile viewport: show portion of world, slowly scroll
  private isMobileViewport = false;
  private reducedMotion = false;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private running = false;
  // Adaptive quality: a safety net that only acts when frames really miss the target.
  private adaptive = true;
  private frameEma = 0;
  private lastFrameAt = 0;
  private slowStreak = 0;
  private fastStreak = 0;

  /** Mobile pan: 0.015 deg/frame on the old 180-deg-tall stretched map = 0.015/180 px per frame per px of height. */
  private static readonly PAN_PX_PER_FRAME_PER_PX_HEIGHT = 0.015 / 180;

  private ngZone = inject(NgZone);
  private destroyRef = inject(DestroyRef);

  constructor() {
    // Runs in the browser only, after the first render: SSR never touches window/canvas.
    afterNextRender(() => this.init());
  }

  private init() {
    this.isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.isMobileViewport = this.isTouchDevice && window.innerWidth < 900;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const params = new URLSearchParams(location.search);
    this.adaptive = params.get('aq') !== '0';
    this.initCanvas();
    this.loadLand();
    this.animateText();
    if (params.get('debug') === '1') this.mountDebug();

    this.ngZone.runOutsideAngular(() => {
      // Input and layout events never trigger change detection and never block scrolling.
      const opts: AddEventListenerOptions = { passive: true };
      window.addEventListener('mousemove', this.onMouseMove, opts);
      window.addEventListener('mouseout', this.onMouseOut, opts);
      document.addEventListener('visibilitychange', this.onVisibility, opts);
      this.resizeObserver = new ResizeObserver(() => {
        if (Math.round(window.innerWidth) === this.width && Math.round(window.innerHeight) === this.height) return;
        // Debounced: the old frame simply stays CSS-scaled until the burst of resize events settles.
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => this.onResize(), 150);
      });
      this.resizeObserver.observe(this.canvasRef.nativeElement);

      // Wind and terrain load after first paint so they never delay the hero text.
      setTimeout(() => this.loadFlowData(), 400);
      this.windRefreshTimer = setInterval(() => this.loadWind(), 3 * 60 * 60 * 1000);
    });

    this.destroyRef.onDestroy(() => {
      this.running = false;
      cancelAnimationFrame(this.animationFrameId);
      if (this.windRefreshTimer) clearInterval(this.windRefreshTimer);
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeObserver?.disconnect();
      window.removeEventListener('mousemove', this.onMouseMove);
      window.removeEventListener('mouseout', this.onMouseOut);
      document.removeEventListener('visibilitychange', this.onVisibility);
    });
  }

  private onResize() {
    this.isMobileViewport = this.isTouchDevice && window.innerWidth < 900;
    this.initCanvas();
    this.rebuildLandLayer();
  }

  private onMouseMove = (event: MouseEvent) => {
    this.mouse.targetX = event.clientX;
    this.mouse.targetY = event.clientY;
    if (this.mouse.x === -1000) {
      this.mouse.x = this.mouse.targetX;
      this.mouse.y = this.mouse.targetY;
    }
  };

  private onMouseOut = () => {
    this.mouse.targetX = -1000;
    this.mouse.targetY = -1000;
  };

  /** Stop the loop while the tab is hidden; resume without a time jump. */
  private onVisibility = () => {
    if (document.hidden) {
      this.running = false;
      cancelAnimationFrame(this.animationFrameId);
    } else if (!this.running) {
      this.lastFrameAt = 0;
      this.running = true;
      this.animationFrameId = requestAnimationFrame(this.renderLoop);
    }
  };

  /** ?debug=1: alignment overlay (lazy chunk, never part of the normal bundle). */
  private async mountDebug() {
    const { mountDebugOverlay } = await import('./geo/debug-overlay');
    await mountDebugOverlay({
      getProjection: () => this.proj,
      host: document.body,
      mainCanvas: this.canvasRef.nativeElement,
    });
  }

  private async loadFlowData() {
    await this.loadWind();
    try {
      const response = await fetch('/data/elevation.bin');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.terrain = await Terrain.build(decodeElevation(await response.arrayBuffer()));
      this.flow?.bakeAll(this.windSampler, this.terrain);
    } catch (e) {
      console.warn('[Elkwire] Terrain data unavailable, no orographic deflection.', e);
    }
  }

  /** Load NOAA GFS wind. On any failure the last good field stays; nothing is ever synthesised. */
  private async loadWind() {
    try {
      const response = await fetch('/data/wind.bin', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const sampler = new WindSampler(decodeWind(await response.arrayBuffer()));
      sampler.setTime(Date.now() / 1000);
      this.windSampler = sampler;
      this.lastBake = performance.now();
      this.flow?.bakeAll(this.windSampler, this.terrain);
    } catch (e) {
      console.warn('[Elkwire] Wind data unavailable, keeping the last good field.', e);
    }
  }

  private initCanvas() {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    // Desktop: static view centred on 30E. Mobile: starts at 0E and pans (see renderLoop).
    // ?debug=1&lon=..&latN=..&latS=.. override the framing so the antimeridian and poles can be inspected.
    const q = new URLSearchParams(location.search);
    const dbg = q.get('debug') === '1';
    const num = (k: string) => (dbg && q.has(k) ? Number(q.get(k)) : undefined);
    this.proj = new Projection({
      width: this.width,
      height: this.height,
      centerLon: num('lon') ?? (this.isMobileViewport ? (this.proj?.centerLon ?? 0) : 30),
      latN: num('latN'),
      latS: num('latS'),
    });
    this.flow = new FlowField(this.proj);
    if (this.windSampler) this.flow.bakeAll(this.windSampler, this.terrain);
    this.noise.resize(this.width, this.height);

    const dpr = window.devicePixelRatio || 1;
    canvas.width = this.width * dpr;
    canvas.height = this.height * dpr;
    this.ctx.scale(dpr, dpr);

    const particleCount = Math.min(Math.floor((this.width * this.height) / 800), 2500);
    this.particles = new ParticleSystem(particleCount, this.width, this.height, Math.random);
    this.slowStreak = 0;
    this.fastStreak = 0;

    this.ctx.fillStyle = '#020408';
    this.ctx.fillRect(0, 0, this.width, this.height);

    this.ngZone.runOutsideAngular(() => {
      if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
      this.running = true;
      this.lastFrameAt = 0;
      this.renderLoop();
    });
  }

  /**
   * Safety net, not a feature: the particle count only drops when frames sustainably miss the target
   * (60 fps desktop, 30 fps touch devices) and creeps back once there is plenty of headroom.
   * Disable with ?aq=0.
   */
  private adapt(frameMs: number) {
    if (!this.adaptive || frameMs > 250) return; // ignore tab-switch gaps
    this.frameEma = this.frameEma === 0 ? frameMs : this.frameEma * 0.95 + frameMs * 0.05;
    const target = this.isTouchDevice ? 1000 / 30 : 1000 / 60;
    const cap = this.particles.capacity;
    if (this.frameEma > target * 1.3) {
      this.fastStreak = 0;
      if (++this.slowStreak >= 120 && this.particles.active > cap * 0.4) {
        this.particles.setActive(Math.floor(this.particles.active - cap * 0.1));
        this.slowStreak = 0;
        console.info(`[Elkwire] adaptive quality: ${this.particles.active}/${cap} particles (frame ${this.frameEma.toFixed(1)} ms)`);
      }
    } else if (this.frameEma < target * 0.8) {
      this.slowStreak = 0;
      if (++this.fastStreak >= 600 && this.particles.active < cap) {
        this.particles.setActive(Math.ceil(this.particles.active + cap * 0.1));
        this.fastStreak = 0;
      }
    } else {
      this.slowStreak = 0;
      this.fastStreak = 0;
    }
  }

  private renderLoop = () => {
    if (!this.running) return;
    const now = performance.now();
    if (this.lastFrameAt) this.adapt(now - this.lastFrameAt);
    this.lastFrameAt = now;

    // Smooth cursor follow
    if (this.mouse.targetX !== -1000) {
      this.mouse.x += (this.mouse.targetX - this.mouse.x) * 0.15;
      this.mouse.y += (this.mouse.targetY - this.mouse.y) * 0.15;
    } else {
      this.mouse.x += (-1000 - this.mouse.x) * 0.1;
      this.mouse.y += (-1000 - this.mouse.y) * 0.1;
    }

    // Mobile: slowly pan viewport east→west (Earth rotation)
    // Same on-screen pan speed as before (0.015 deg/frame of the old 180-deg-tall map).
    const panPx = this.isMobileViewport ? App.PAN_PX_PER_FRAME_PER_PX_HEIGHT * this.height : 0;
    if (this.isMobileViewport) this.proj.panBy(panPx);

    // Re-blend the forecast frames against the real clock every 60 s (incremental, a few ms per frame).
    if (this.windSampler && now - this.lastBake > 60000) {
      this.lastBake = now;
      this.windSampler.setTime(Date.now() / 1000);
      this.flow?.begin(this.windSampler, this.terrain);
    }
    this.flow?.step(1.5);

    // Faint clear for fluid trail effect
    this.ctx.fillStyle = 'rgba(0, 12, 24, 0.08)';
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Draw continent silhouettes (cached world strip, blitted at the pan offset)
    if (this.landLayer) drawLandLayer(this.ctx, this.landLayer, this.proj);

    const t = now * 0.00005;
    this.noise.prepare(t);
    const mouseActive = !this.isTouchDevice && this.mouse.x > -500;
    this.particles.step({
      flow: this.flow,
      noise: this.noise,
      t,
      originX: this.proj.originX,
      mouseActive,
      mouseX: this.mouse.x,
      mouseY: this.mouse.y,
      mobile: this.isMobileViewport,
      panPx,
      speedScale: this.reducedMotion ? 0.25 : 1,
    });
    this.particles.draw(this.ctx);

    // Cursor reticle (desktop only)
    if (mouseActive) {
      this.ctx.strokeStyle = 'rgba(100, 160, 200, 0.2)';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(this.mouse.x - 15, this.mouse.y);
      this.ctx.lineTo(this.mouse.x + 15, this.mouse.y);
      this.ctx.moveTo(this.mouse.x, this.mouse.y - 15);
      this.ctx.lineTo(this.mouse.x, this.mouse.y + 15);
      this.ctx.stroke();
      this.ctx.beginPath();
      this.ctx.arc(this.mouse.x, this.mouse.y, 2, 0, Math.PI * 2);
      this.ctx.fillStyle = 'rgba(120, 180, 220, 0.6)';
      this.ctx.fill();
    }

    this.animationFrameId = requestAnimationFrame(this.renderLoop);
  };

  private async animateText() {
    if (this.reducedMotion) {
      // prefers-reduced-motion: show the text without animation (nobody else sees this branch).
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('.letter, .reveal-sub'))) el.style.opacity = '1';
      return;
    }
    const { animate, stagger, cubicBezier } = await import('motion');
    const easing = cubicBezier(0.16, 1, 0.3, 1);

    animate(
      '.letter',
      { opacity: [0, 1], filter: ['blur(16px)', 'blur(0px)'], scale: [1.1, 1] },
      { delay: stagger(0.12, { startDelay: 0.2 }), duration: 2.5, ease: easing }
    );

    animate(
      '.reveal-sub',
      { opacity: [0, 1], filter: ['blur(10px)', 'blur(0px)'], y: [20, 0] },
      { delay: 1.5, duration: 2, ease: easing }
    );
  }

  // --- MAP FEATURE ---

  private async loadLand() {
    try {
      const response = await fetch('/data/land.bin');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.landRings = decodeLand(await response.arrayBuffer());
      this.rebuildLandLayer();
    } catch (e) {
      console.warn('[Elkwire] Failed to load land data, map feature unavailable.', e);
    }
  }

  private rebuildLandLayer() {
    if (this.landRings.length === 0) return;
    this.landLayer ??= document.createElement('canvas');
    renderLandLayer(this.landRings, this.proj, this.landLayer);
  }
}
