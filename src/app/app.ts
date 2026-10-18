import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, NgZone, HostListener, inject } from '@angular/core';
import { Projection } from './geo/projection';
import { decodeLand, drawLandLayer, renderLandLayer, LandRings } from './geo/land';

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
  private windGrid: { u: number, v: number }[][] = [];
  private gridCols = 13;
  private gridRows = 13;

  private windRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private pressureGrid: number[][] = [];
  private baseWindGrid: { u: number, v: number }[][] = []; // Reference for evolution
  private dataReady = false;
  private proj!: Projection;
  private landRings: LandRings = [];
  private landLayer: HTMLCanvasElement | null = null;
  private isTouchDevice = false;
  // Mobile viewport: show portion of world, slowly scroll
  private isMobileViewport = false;
  // Simulation evolution
  private lastApiCall = 0;
  private simElapsed = 0;
  private lastFrameTime = 0;

  /** Mobile pan: 0.015 deg/frame on the old 180-deg-tall stretched map = 0.015/180 px per frame per px of height. */
  private static readonly PAN_PX_PER_FRAME_PER_PX_HEIGHT = 0.015 / 180;

  private ngZone = inject(NgZone);

  ngAfterViewInit() {
    this.isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.isMobileViewport = this.isTouchDevice && window.innerWidth < 900;
    this.fetchRealtimeWinds();
    // API refresh: 2x per day instead of every 15min to avoid rate limits
    this.windRefreshTimer = setInterval(() => this.fetchRealtimeWinds(), 12 * 60 * 60 * 1000);
    this.initCanvas();
    this.loadLand();
    this.animateText();
    this.lastFrameTime = performance.now();
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

  private async fetchRealtimeWinds() {
    try {
      // Smaller grid: 7 rows × 13 cols = 91 points (avoids API rate limits)
      this.gridRows = 7;
      this.gridCols = 13;
      const lats: number[] = [];
      const lons: number[] = [];
      for (let lat = 75; lat >= -75; lat -= 25) {
        for (let lon = -180; lon <= 180; lon += 30) {
          lats.push(lat);
          lons.push(lon);
        }
      }

      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&current=wind_speed_10m,wind_direction_10m,surface_pressure`
      );
      const data = await response.json();

      if (Array.isArray(data) && data.length === this.gridRows * this.gridCols) {
        let index = 0;
        this.windGrid = [];
        this.pressureGrid = [];
        for (let i = 0; i < this.gridRows; i++) {
          const windRow: { u: number, v: number }[] = [];
          const pressRow: number[] = [];
          for (let j = 0; j < this.gridCols; j++) {
            const pointData = data[index]?.current;
            if (pointData) {
              const speed = pointData.wind_speed_10m ?? 0;
              const dir = pointData.wind_direction_10m ?? 0;
              const pressure = pointData.surface_pressure ?? 1013.25;
              const rad = dir * Math.PI / 180;
              const normalizedSpeed = speed / 20;
              const u = -Math.sin(rad) * normalizedSpeed;
              const v = Math.cos(rad) * normalizedSpeed;
              windRow.push({ u, v });
              pressRow.push(pressure);
            } else {
              windRow.push({ u: 0, v: 0 });
              pressRow.push(1013.25);
            }
            index++;
          }
          this.windGrid.push(windRow);
          this.pressureGrid.push(pressRow);
        }
        this.dataReady = true;
        this.baseWindGrid = this.windGrid.map(row => row.map(cell => ({ u: cell.u, v: cell.v })));
        console.log(`[Elkwire] Real-time wind data loaded: ${this.gridRows}×${this.gridCols} grid`);
      } else {
        console.warn('[Elkwire] Unexpected API response, using fallback.');
        this.buildFallbackGrid();
      }
    } catch (e) {
      console.warn('[Elkwire] API unavailable, using atmospheric model fallback.', e);
      this.buildFallbackGrid();
    }
  }

  /**
   * Physics-accurate atmospheric fallback with regional monsoon features.
   * 19×25 grid for high resolution.
   * Includes three-cell circulation + all major monsoon systems.
   */
  private buildFallbackGrid() {
    this.gridRows = 19;
    this.gridCols = 25;
    this.windGrid = [];
    this.pressureGrid = [];

    const month = new Date().getMonth();
    const itczShift = 8 * Math.sin((month - 3) * Math.PI / 6);
    const monsoonStrength = Math.max(0, Math.sin((month - 4) * Math.PI / 5));
    const winterMonsoon = Math.max(0, Math.sin((month - 10) * Math.PI / 4));

    for (let i = 0; i < this.gridRows; i++) {
      const windRow: { u: number, v: number }[] = [];
      const pressRow: number[] = [];
      const lat = 90 - i * 10;

      for (let j = 0; j < this.gridCols; j++) {
        const lon = -180 + j * 15;
        const effectiveLat = lat - itczShift;
        const absLat = Math.abs(effectiveLat);
        const hemisphere = effectiveLat >= 0 ? 1 : -1;

        let uZonal = 0;
        let vMerid = 0;
        let pressure = 1013.25;

        // === BASE: Three-cell circulation ===
        if (absLat < 30) {
          const cellProgress = absLat / 30;
          const intensity = Math.sin(cellProgress * Math.PI);
          const coriolisScale = Math.sin(absLat * Math.PI / 180);
          uZonal = -1.8 * intensity * (0.3 + 0.7 * coriolisScale);
          vMerid = 0.5 * intensity * hemisphere;
          if (absLat < 5) { uZonal *= absLat / 5; vMerid *= absLat / 5; }
          pressure = 1008 + 14 * cellProgress;
        } else if (absLat < 60) {
          const cellProgress = (absLat - 30) / 30;
          const intensity = Math.sin(cellProgress * Math.PI);
          uZonal = 2.5 * intensity + Math.exp(-Math.pow((absLat - 30) / 5, 2)) * 0.8 + Math.exp(-Math.pow((absLat - 60) / 5, 2)) * 0.6;
          vMerid = -0.6 * intensity * hemisphere;
          pressure = 1022 - 17 * cellProgress;
        } else {
          const cellProgress = (absLat - 60) / 30;
          const intensity = Math.sin(cellProgress * Math.PI * 0.8);
          uZonal = -1.0 * intensity;
          vMerid = 0.4 * intensity * hemisphere;
          pressure = 1005 + 15 * cellProgress;
        }

        // === INDIAN SW MONSOON (Jun-Sep): Arabian Sea → Kerala/Western Ghats ===
        if (lat >= -5 && lat <= 30 && lon >= 40 && lon <= 100 && monsoonStrength > 0) {
          const latF = Math.sin(Math.max(0, Math.min(1, (lat + 5) / 30)) * Math.PI);
          const lonF = Math.exp(-Math.pow((lon - 70) / 25, 2));
          const s = monsoonStrength * latF * lonF;
          uZonal += 2.5 * s;   // Strong westerly
          vMerid += -1.5 * s;  // Strong northward
          pressure -= 8 * s;
        }

        // === SOMALI JET (Jun-Sep): Cross-equatorial low-level jet ===
        if (lat >= -5 && lat <= 15 && lon >= 40 && lon <= 55 && monsoonStrength > 0) {
          const s = monsoonStrength * Math.exp(-Math.pow((lon - 48) / 6, 2));
          uZonal += 1.5 * s;
          vMerid += -2.0 * s;
        }

        // === EAST ASIAN MONSOON (Jun-Aug) ===
        if (lat >= 10 && lat <= 40 && lon >= 100 && lon <= 140 && monsoonStrength > 0) {
          const latF = Math.sin(Math.max(0, Math.min(1, (lat - 10) / 30)) * Math.PI);
          const lonF = Math.exp(-Math.pow((lon - 120) / 15, 2));
          const s = monsoonStrength * 0.7 * latF * lonF;
          uZonal += 1.0 * s;
          vMerid += -1.2 * s;
        }

        // === WEST AFRICAN MONSOON (Jun-Sep) ===
        if (lat >= 0 && lat <= 20 && lon >= -20 && lon <= 20 && monsoonStrength > 0) {
          const latF = Math.sin(Math.max(0, Math.min(1, lat / 20)) * Math.PI);
          const lonF = Math.exp(-Math.pow(lon / 15, 2));
          const s = monsoonStrength * 0.6 * latF * lonF;
          uZonal += 1.2 * s;
          vMerid += -0.8 * s;
        }

        // === WINTER NE MONSOON (Dec-Feb) over India ===
        if (lat >= 0 && lat <= 30 && lon >= 60 && lon <= 100 && winterMonsoon > 0) {
          const latF = Math.sin(Math.max(0, Math.min(1, lat / 30)) * Math.PI);
          const lonF = Math.exp(-Math.pow((lon - 80) / 15, 2));
          const s = winterMonsoon * 0.8 * latF * lonF;
          uZonal -= 1.5 * s;
          vMerid += 1.0 * s;
        }

        // === SUBTROPICAL HIGHS (clockwise NH, counter-clockwise SH) ===
        // Azores/Bermuda High
        if (lat >= 15 && lat <= 45 && lon >= -70 && lon <= 0) {
          const dL = (lat - 32) / 15, dN = (lon - (-35)) / 20;
          const d2 = dL * dL + dN * dN;
          if (d2 < 1) { const s = (1 - d2) * 0.8; uZonal += dL * s * 1.5; vMerid += dN * s * 1.5; pressure += 6 * (1 - d2); }
        }
        // North Pacific High
        if (lat >= 20 && lat <= 45 && lon >= -170 && lon <= -120) {
          const dL = (lat - 35) / 15, dN = (lon - (-145)) / 20;
          const d2 = dL * dL + dN * dN;
          if (d2 < 1) { const s = (1 - d2) * 0.7; uZonal += dL * s * 1.3; vMerid += dN * s * 1.3; pressure += 5 * (1 - d2); }
        }
        // Mascarene High (drives Indian monsoon moisture)
        if (lat >= -40 && lat <= -15 && lon >= 40 && lon <= 90 && monsoonStrength > 0) {
          const dL = (lat + 30) / 12, dN = (lon - 65) / 20;
          const d2 = dL * dL + dN * dN;
          if (d2 < 1) { const s = (1 - d2) * monsoonStrength * 0.8; uZonal -= dL * s * 1.2; vMerid -= dN * s * 1.2; pressure += 4 * (1 - d2); }
        }

        // === MEDITERRANEAN ETESIAN WINDS (Jun-Sep) ===
        if (lat >= 30 && lat <= 42 && lon >= 15 && lon <= 35 && monsoonStrength > 0) {
          uZonal -= 0.8 * monsoonStrength * 0.5;
          vMerid += 0.6 * monsoonStrength * 0.5;
        }

        windRow.push({ u: uZonal, v: vMerid });
        pressRow.push(pressure);
      }
      this.windGrid.push(windRow);
      this.pressureGrid.push(pressRow);
    }
    this.dataReady = true;
    this.baseWindGrid = this.windGrid.map(row => row.map(cell => ({ u: cell.u, v: cell.v })));
    console.log('[Elkwire] Atmospheric model with monsoon circulation initialized.');
  }

  /**
   * Evolve the wind field between API calls using simplified atmospheric dynamics.
   * Pressure systems drift, diurnal thermal cycle modulates monsoon, winds re-derived.
   */
  private evolveWindField() {
    if (!this.dataReady || this.windGrid.length === 0) return;

    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    // Diurnal factor: subtle modulation (±8%)
    const diurnalFactor = 0.92 + 0.08 * Math.sin((hour - 6) * Math.PI / 12);
    // Pressure drift: mid-latitude systems move east
    const driftLon = 0.3;

    // Use base wind as reference to prevent compounding
    const ref = this.baseWindGrid.length > 0 ? this.baseWindGrid : this.windGrid;
    const newGrid: { u: number, v: number }[][] = [];

    for (let i = 0; i < this.gridRows; i++) {
      const windRow: { u: number, v: number }[] = [];
      const lat = 90 - i * (180 / (this.gridRows - 1));

      for (let j = 0; j < this.gridCols; j++) {
        const latFactor = Math.abs(lat) > 25 ? 1.0 : 0.2;
        const srcJ = j - Math.round(driftLon / (360 / this.gridCols) * latFactor);
        const wrappedJ = ((srcJ % this.gridCols) + this.gridCols) % this.gridCols;

        const baseWind = ref[i][wrappedJ];
        let u = baseWind.u * diurnalFactor;
        let v = baseWind.v * diurnalFactor;

        // Cap wind magnitude to prevent runaway
        const mag = Math.sqrt(u * u + v * v);
        if (mag > 4.0) {
          u *= 4.0 / mag;
          v *= 4.0 / mag;
        }

        windRow.push({ u, v });
      }
      newGrid.push(windRow);
    }

    this.windGrid = newGrid;
  }

  private initCanvas() {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    
    // Desktop: static view centred on 30E. Mobile: starts at 0E and pans (see renderLoop).
    this.proj = new Projection({
      width: this.width,
      height: this.height,
      centerLon: this.isMobileViewport ? this.proj?.centerLon ?? 0 : 30,
    });

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

    if (this.dataReady && this.windGrid.length === this.gridRows) {
      // Convert canvas position to normalized grid position
      // On mobile: canvas x maps to viewport longitude range
      // On desktop: canvas x maps to full 360° range
      const normX = Math.max(0, Math.min(1, x / (this.width || 1)));
      const normY = Math.max(0, Math.min(1, y / (this.height || 1)));

      const gx = normX * (this.gridCols - 1);
      const gy = normY * (this.gridRows - 1);
      const ix = Math.max(0, Math.min(Math.floor(gx), this.gridCols - 2));
      const iy = Math.max(0, Math.min(Math.floor(gy), this.gridRows - 2));
      const fx = gx - ix;
      const fy = gy - iy;

      const tl = this.windGrid[iy][ix];
      const tr = this.windGrid[iy][ix + 1];
      const bl = this.windGrid[iy + 1][ix];
      const br = this.windGrid[iy + 1][ix + 1];

      u = tl.u * (1 - fx) * (1 - fy) + tr.u * fx * (1 - fy) + bl.u * (1 - fx) * fy + br.u * fx * fy;
      v = tl.v * (1 - fx) * (1 - fy) + tr.v * fx * (1 - fy) + bl.v * (1 - fx) * fy + br.v * fx * fy;
    }

    const windMag = Math.sqrt(u * u + v * v);
    const turbulenceScale = Math.max(0.6, windMag * 0.35);
    const curlVx = dPsi_dy * turbulenceScale;
    const curlVy = -dPsi_dx * turbulenceScale;

    return { vx: u + curlVx, vy: v + curlVy }; 
  }

  private renderLoop = () => {
    const now = performance.now();
    const dt = Math.min(now - this.lastFrameTime, 50); // Cap at 50ms to prevent spiral
    this.lastFrameTime = now;
    this.simElapsed += dt;

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

    // Evolve wind simulation every 60 seconds
    if (this.simElapsed > 60000) {
      this.simElapsed = 0;
      this.evolveWindField();
    }

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
