import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, NgZone, HostListener, inject } from '@angular/core';
import { Projection } from './geo/projection';
import { decodeLand, drawLandLayer, renderLandLayer, LandRings } from './geo/land';
import { FlowField } from './geo/flow-bake';
import { Terrain, decodeElevation } from './geo/terrain';
import { WindSampler, decodeWind } from './geo/wind';

interface Particle {
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  baseColor: string;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  standalone: true,
})
export class App implements AfterViewInit, OnDestroy {
  @ViewChild('canvasElement') canvasRef!: ElementRef<HTMLCanvasElement>;
  private ctx!: CanvasRenderingContext2D;
  private animationFrameId = 0;
  private particles: Particle[] = [];
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
  private lastFrameTime = 0;

  /** Mobile pan: 0.015 deg/frame on the old 180-deg-tall stretched map = 0.015/180 px per frame per px of height. */
  private static readonly PAN_PX_PER_FRAME_PER_PX_HEIGHT = 0.015 / 180;

  private ngZone = inject(NgZone);

  ngAfterViewInit() {
    this.isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.isMobileViewport = this.isTouchDevice && window.innerWidth < 900;
    this.initCanvas();
    this.loadLand();
    this.animateText();
    this.lastFrameTime = performance.now();
    if (new URLSearchParams(location.search).get('debug') === '1') this.mountDebug();
    // Wind and terrain load after first paint so they never delay the hero text.
    this.ngZone.runOutsideAngular(() => {
      setTimeout(() => this.loadFlowData(), 400);
      this.windRefreshTimer = setInterval(() => this.loadWind(), 3 * 60 * 60 * 1000);
    });
  }

  ngOnDestroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.windRefreshTimer) {
      clearInterval(this.windRefreshTimer);
    }
  }

  @HostListener('window:resize')
  onResize() {
    this.isMobileViewport = this.isTouchDevice && window.innerWidth < 900;
    this.initCanvas();
    this.rebuildLandLayer();
  }

  @HostListener('window:mousemove', ['$event'])
  onMouseMove(event: MouseEvent) {
    this.mouse.targetX = event.clientX;
    this.mouse.targetY = event.clientY;
    if (this.mouse.x === -1000) {
      this.mouse.x = this.mouse.targetX;
      this.mouse.y = this.mouse.targetY;
    }
  }



  @HostListener('window:mouseout')
  onMouseOut() {
    this.mouse.targetX = -1000;
    this.mouse.targetY = -1000;
  }

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
      centerLon: num('lon') ?? (this.isMobileViewport ? this.proj?.centerLon ?? 0 : 30),
      latN: num('latN'),
      latS: num('latS'),
    });
    this.flow = new FlowField(this.proj);
    if (this.windSampler) this.flow.bakeAll(this.windSampler, this.terrain);

    const dpr = window.devicePixelRatio || 1;
    canvas.width = this.width * dpr;
    canvas.height = this.height * dpr;
    this.ctx.scale(dpr, dpr);
    
    this.particles = [];
    const particleCount = Math.min(Math.floor((this.width * this.height) / 800), 2500);
    
    for (let i = 0; i < particleCount; i++) {
      const p = {} as Particle;
      this.resetParticle(p);
      p.life = Math.random() * p.maxLife;
      this.particles.push(p);
    }

    this.ctx.fillStyle = '#020408';
    this.ctx.fillRect(0, 0, this.width, this.height);

    this.ngZone.runOutsideAngular(() => {
      if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
      this.renderLoop();
    });
  }

  private resetParticle(p: Particle) {
    p.x = Math.random() * this.width;
    p.y = Math.random() * this.height;
    p.lastX = p.x;
    p.lastY = p.y;
    p.vx = 0;
    p.vy = 0;
    p.maxLife = Math.random() * 350 + 250;
    p.life = p.maxLife;
    const colors = [
      'rgba(10, 45, 75, 0.6)',   // Deep oceanic blue
      'rgba(30, 90, 120, 0.7)',  // Bathypelagic teal
      'rgba(60, 150, 190, 0.5)', // Hydrodynamic cyan
      'rgba(140, 200, 230, 0.3)' // Wake foam
    ];
    p.baseColor = colors[Math.floor(Math.random() * colors.length)];
    p.color = p.baseColor;
    p.size = Math.random() * 1.5 + 0.5;
  }

  private hash(x: number, y: number): number {
    const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;
    return h - Math.floor(h);
  }

  private noise(x: number, y: number): number {
    const iX = Math.floor(x);
    const iY = Math.floor(y);
    const fX = x - iX;
    const fY = y - iY;

    const u = fX * fX * (3.0 - 2.0 * fX);
    const v = fY * fY * (3.0 - 2.0 * fY);

    const a = this.hash(iX, iY);
    const b = this.hash(iX + 1, iY);
    const c = this.hash(iX, iY + 1);
    const d = this.hash(iX + 1, iY + 1);

    return a + u * (b - a) + v * (c - a) + u * v * (a - b - c + d);
  }
  
  private fbm(x: number, y: number): number {
    let value = 0;
    let amplitude = 0.5;
    for (let i = 0; i < 3; i++) {
      value += amplitude * this.noise(x, y);
      x *= 2.0;
      y *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }

  private getFluidVelocity(x: number, y: number, t: number): { vx: number, vy: number } {
    const scale = 0.0012;
    const sx = x * scale;
    const sy = y * scale;
    const eps = 0.01;

    const n1 = this.fbm(sx, sy + eps - t);
    const n2 = this.fbm(sx, sy - eps - t);
    const dPsi_dy = (n1 - n2) / (2 * eps);

    const n3 = this.fbm(sx + eps - t, sy);
    const n4 = this.fbm(sx - eps - t, sy);
    const dPsi_dx = (n3 - n4) / (2 * eps);

    let u = 0;
    let v = 0;

    if (this.flow) {
      this.flow.sample(x + this.proj.originX, y);
      u = this.flow.sx;
      v = this.flow.sy;
    }

    const windMag = Math.sqrt(u * u + v * v);
    const turbulenceScale = Math.max(0.6, windMag * 0.35);
    const curlVx = dPsi_dy * turbulenceScale;
    const curlVy = -dPsi_dx * turbulenceScale;

    return { vx: u + curlVx, vy: v + curlVy }; 
  }

  private renderLoop = () => {
    const now = performance.now();
    this.lastFrameTime = now;

    // Smooth cursor follow
    if (this.mouse.targetX !== -1000) {
      this.mouse.x += (this.mouse.targetX - this.mouse.x) * 0.15;
      this.mouse.y += (this.mouse.targetY - this.mouse.y) * 0.15;
    } else {
      this.mouse.x += (-1000 - this.mouse.x) * 0.1;
      this.mouse.y += (-1000 - this.mouse.y) * 0.1;
    }

    // Mobile: slowly pan viewport east→west (Earth rotation)
    if (this.isMobileViewport) {
      // Same on-screen pan speed as before (0.015 deg/frame of the old 180-deg-tall map).
      this.proj.panBy(App.PAN_PX_PER_FRAME_PER_PX_HEIGHT * this.height);
    }

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

    for (const p of this.particles) {
      p.color = p.baseColor;

      const fluid = this.getFluidVelocity(p.x, p.y, t);
      let targetVx = fluid.vx * 1.5;
      let targetVy = fluid.vy * 1.5;

      // Mouse interaction (desktop only)
      if (!this.isTouchDevice && this.mouse.x > -500) {
        const dx = p.x - this.mouse.x;
        const dy = p.y - this.mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const influence = 300;
        if (dist < influence) {
          const force = Math.pow((influence - dist) / influence, 2);
          targetVx += (dx / dist) * force * 5;
          targetVy += (dy / dist) * force * 5;
          targetVx += -(dy / dist) * force * 3;
          targetVy += (dx / dist) * force * 3;
        }
      }

      p.vx += (targetVx - p.vx) * 0.08;
      p.vy += (targetVy - p.vy) * 0.08;
      p.lastX = p.x;
      p.lastY = p.y;
      p.x += p.vx;
      p.y += p.vy;
      p.life--;

      // Mobile: shift particle screen coordinates to stay locked to the panning world
      if (this.isMobileViewport) {
        const panShiftPx = App.PAN_PX_PER_FRAME_PER_PX_HEIGHT * this.height;
        p.x -= panShiftPx;
        p.lastX -= panShiftPx;
        
        // wrap particles at horizontal edges for infinite scroll
        if (p.x < -20) { p.x += this.width + 40; p.lastX = p.x; }
        else if (p.x > this.width + 20) { p.x -= this.width + 40; p.lastX = p.x; }
      }

      if (p.life <= 0 || p.x < -50 || p.x > this.width + 50 || p.y < -50 || p.y > this.height + 50 || isNaN(p.x) || isNaN(p.y)) {
        this.resetParticle(p);
      } else {
        this.ctx.strokeStyle = p.color;
        this.ctx.lineWidth = p.size;
        this.ctx.beginPath();
        this.ctx.moveTo(p.lastX, p.lastY);
        this.ctx.lineTo(p.x, p.y);
        this.ctx.stroke();
      }
    }

    // Cursor reticle (desktop only)
    if (!this.isTouchDevice && this.mouse.x > -500) {
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
