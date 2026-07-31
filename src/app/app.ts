import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, NgZone, HostListener } from '@angular/core';

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
  private animationFrameId: number = 0;
  private particles: Particle[] = [];
  private mouse = { x: -1000, y: -1000, targetX: -1000, targetY: -1000 };
  private width = 0;
  private height = 0;
  private windGrid: { u: number, v: number }[][] = [];
  private gridCols = 13;
  private gridRows = 13;
  private keyBuffer = '';
  private mapVisible = false;
  private mapOpacity = 0;
  private continentPaths: { x: number, y: number }[][] = [];
  private mountainRanges: { x: number, y: number }[][] = [];
  private windRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private pressureGrid: number[][] = [];
  private dataReady = false;
  private deflectionPaths: { x: number, y: number }[][] = [];

  constructor(private ngZone: NgZone) {}

  ngAfterViewInit() {
    this.fetchRealtimeWinds();
    // Refresh wind data every 15 minutes (Open-Meteo updates every 15 min)
    this.windRefreshTimer = setInterval(() => this.fetchRealtimeWinds(), 15 * 60 * 1000);
    this.initCanvas();
    this.animateText();
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
    this.initCanvas();
    if (this.mapVisible) this.buildContinentPaths();
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

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    this.keyBuffer += event.key.toLowerCase();
    if (this.keyBuffer.length > 10) this.keyBuffer = this.keyBuffer.slice(-10);
    if (this.keyBuffer.endsWith('map')) {
      this.mapVisible = !this.mapVisible;
      this.keyBuffer = '';
      if (this.mapVisible) this.buildContinentPaths();
    }
  }

  @HostListener('window:mouseout')
  onMouseOut() {
    this.mouse.targetX = -1000;
    this.mouse.targetY = -1000;
  }

  private async fetchRealtimeWinds() {
    try {
      // Build a denser grid: every 10° lat × 15° lon = 19 rows × 25 cols = 475 points
      // Open-Meteo supports up to 1000 locations per request
      this.gridRows = 19;
      this.gridCols = 25;
      const lats: number[] = [];
      const lons: number[] = [];
      for (let lat = 90; lat >= -90; lat -= 10) {
        for (let lon = -180; lon <= 180; lon += 15) {
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
              const speed = pointData.wind_speed_10m ?? 0; // km/h
              const dir = pointData.wind_direction_10m ?? 0; // degrees (meteorological: direction wind blows FROM)
              const pressure = pointData.surface_pressure ?? 1013.25; // hPa

              // Meteorological convention: direction = where wind comes FROM
              // u_met = -S * sin(θ)  [positive = eastward, i.e. wind blowing TO the east]
              // v_met = -S * cos(θ)  [positive = northward]
              // Canvas: +x = east, +y = south, so vy_canvas = -v_met = S * cos(θ)
              const rad = dir * Math.PI / 180;
              const normalizedSpeed = speed / 20; // Normalize: ~20 km/h → magnitude 1.0
              const u = -Math.sin(rad) * normalizedSpeed;
              const v = Math.cos(rad) * normalizedSpeed;  // Flipped sign for canvas +y=south
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
        console.log(`[Elkwire] Real-time wind data loaded: ${this.gridRows}×${this.gridCols} grid (${data.length} stations)`);
      } else {
        console.warn('[Elkwire] Unexpected API response shape, using atmospheric model fallback.');
        this.buildFallbackGrid();
      }
    } catch (e) {
      console.warn('[Elkwire] Could not fetch real-time winds, using atmospheric model fallback.', e);
      this.buildFallbackGrid();
    }
  }

  /**
   * Physics-accurate atmospheric general circulation fallback.
   * Models the three-cell structure (Hadley, Ferrel, Polar) with:
   *   - Coriolis deflection (rightward NH, leftward SH)
   *   - Pressure gradient force (drives meridional flow)
   *   - Seasonal ITCZ shift based on current month
   *   - Jet stream intensification at cell boundaries (30° and 60°)
   */
  private buildFallbackGrid() {
    this.gridRows = 19;
    this.gridCols = 25;
    this.windGrid = [];
    this.pressureGrid = [];

    const month = new Date().getMonth(); // 0-11
    // ITCZ shifts ~10° north in NH summer (Jun-Aug), ~5° south in NH winter (Dec-Feb)
    const itczShift = 8 * Math.sin((month - 3) * Math.PI / 6); // Peaks in July at +8°

    for (let i = 0; i < this.gridRows; i++) {
      const windRow: { u: number, v: number }[] = [];
      const pressRow: number[] = [];
      const lat = 90 - i * 10; // 90°N to 90°S

      for (let j = 0; j < this.gridCols; j++) {
        // Effective latitude relative to ITCZ
        const effectiveLat = lat - itczShift;
        const absLat = Math.abs(effectiveLat);
        const hemisphere = effectiveLat >= 0 ? 1 : -1; // +1 for NH, -1 for SH

        let uZonal = 0;   // East-West (canvas: positive = eastward)
        let vMerid = 0;   // North-South (canvas: positive = southward)
        let pressure = 1013.25;

        if (absLat < 30) {
          // HADLEY CELL: Surface trade winds
          // Air flows equatorward, Coriolis deflects to west → NE trades (NH) / SE trades (SH)
          const cellProgress = absLat / 30; // 0 at equator, 1 at 30°
          const intensity = Math.sin(cellProgress * Math.PI); // Peak at 15°

          // Zonal: Easterly (negative u) due to Coriolis deflection
          // Coriolis increases with latitude: f = 2Ω sin(φ)
          const coriolisScale = Math.sin(absLat * Math.PI / 180);
          uZonal = -1.8 * intensity * (0.3 + 0.7 * coriolisScale);

          // Meridional: Equatorward convergence (+v in NH means southward = toward equator)
          vMerid = 0.5 * intensity * hemisphere; // +south in NH, -south in SH (both toward equator)

          // Near ITCZ (equator): convergence zone → low pressure, near-calm winds
          if (absLat < 5) {
            const itczDamping = absLat / 5;
            uZonal *= itczDamping;
            vMerid *= itczDamping;
          }

          // Pressure: Low at ITCZ (~1008), high at subtropical ridge (~1022)
          pressure = 1008 + 14 * cellProgress;
        } else if (absLat < 60) {
          // FERREL CELL: Surface westerlies
          // Air flows poleward, Coriolis deflects to east → SW winds (NH) / NW winds (SH)
          const cellProgress = (absLat - 30) / 30; // 0 at 30°, 1 at 60°
          const intensity = Math.sin(cellProgress * Math.PI); // Peak at 45°

          // Zonal: Westerly (positive u) — strongest mid-latitude winds
          // Jet stream enhancement near 30° and 60° cell boundaries
          const jetBoost30 = Math.exp(-Math.pow((absLat - 30) / 5, 2)) * 0.8;
          const jetBoost60 = Math.exp(-Math.pow((absLat - 60) / 5, 2)) * 0.6;
          uZonal = 2.5 * intensity + jetBoost30 + jetBoost60;

          // Meridional: Poleward flow (-v in NH means northward = poleward)
          vMerid = -0.6 * intensity * hemisphere;

          // Pressure: High at subtropical ridge (~1022), low at subpolar low (~1005)
          pressure = 1022 - 17 * cellProgress;
        } else {
          // POLAR CELL: Polar easterlies
          // Air flows equatorward, Coriolis deflects to west
          const cellProgress = (absLat - 60) / 30; // 0 at 60°, 1 at 90°
          const intensity = Math.sin(cellProgress * Math.PI * 0.8); // Weaker cell

          // Zonal: Easterly (negative u)
          uZonal = -1.0 * intensity;

          // Meridional: Equatorward
          vMerid = 0.4 * intensity * hemisphere;

          // Polar high pressure at pole
          pressure = 1005 + 15 * cellProgress;
        }

        // Convert meteorological u/v to canvas coordinates
        // Canvas: +x = east (same as met u), +y = south (opposite of met v → already handled above)
        windRow.push({ u: uZonal, v: vMerid });
        pressRow.push(pressure);
      }
      this.windGrid.push(windRow);
      this.pressureGrid.push(pressRow);
    }
    this.dataReady = true;
    console.log('[Elkwire] Atmospheric model fallback initialized (Hadley-Ferrel-Polar cells with Coriolis).');
  }

  private initCanvas() {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    
    // High DPI support for sharp rendering
    const dpr = window.devicePixelRatio || 1;
    canvas.width = this.width * dpr;
    canvas.height = this.height * dpr;
    this.ctx.scale(dpr, dpr);
    
    // Initialize particles
    this.particles = [];
    const particleCount = Math.min(Math.floor((this.width * this.height) / 800), 2500);
    
    for (let i = 0; i < particleCount; i++) {
      const p = {} as Particle;
      this.resetParticle(p);
      p.life = Math.random() * p.maxLife; // Stagger initial lives
      this.particles.push(p);
    }

    // Initial clear
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

    // Curl of stream function → divergence-free turbulent eddies
    const n1 = this.fbm(sx, sy + eps - t);
    const n2 = this.fbm(sx, sy - eps - t);
    const dPsi_dy = (n1 - n2) / (2 * eps);

    const n3 = this.fbm(sx + eps - t, sy);
    const n4 = this.fbm(sx - eps - t, sy);
    const dPsi_dx = (n3 - n4) / (2 * eps);

    // Bilinear interpolation of the wind grid (always populated: real data or physics fallback)
    let u = 0;
    let v = 0;

    if (this.dataReady && this.windGrid.length === this.gridRows) {
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

    // Turbulence: mesoscale eddies proportional to wind, with a floor for visual continuity
    // Floor of 0.6 ensures particles are always visible (doldrums, ITCZ calm zones)
    const windMag = Math.sqrt(u * u + v * v);
    const turbulenceScale = Math.max(0.6, windMag * 0.35);
    const curlVx = dPsi_dy * turbulenceScale;
    const curlVy = -dPsi_dx * turbulenceScale;

    return {
      vx: u + curlVx,
      vy: v + curlVy
    }; 
  }

  private renderLoop = () => {
    // Smooth cursor follow
    if (this.mouse.targetX !== -1000) {
      this.mouse.x += (this.mouse.targetX - this.mouse.x) * 0.15;
      this.mouse.y += (this.mouse.targetY - this.mouse.y) * 0.15;
    } else {
      this.mouse.x += (-1000 - this.mouse.x) * 0.1;
      this.mouse.y += (-1000 - this.mouse.y) * 0.1;
    }

    // Faint clear for fluid trail effect (the core of the current/wind look)
    this.ctx.fillStyle = 'rgba(0, 12, 24, 0.08)';
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Animate map opacity
    const targetOpacity = this.mapVisible ? 1 : 0;
    this.mapOpacity += (targetOpacity - this.mapOpacity) * 0.03;

    // Draw continent outlines UNDER particles when map is active
    if (this.mapOpacity > 0.01) {
      this.drawContinents();
    }

    const t = performance.now() * 0.00005;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.color = p.baseColor;
      
      const fluid = this.getFluidVelocity(p.x, p.y, t);
      let targetVx = fluid.vx * 1.5;
      let targetVy = fluid.vy * 1.5;

      // Deflect particles around continent edges when map is visible
      if (this.mapOpacity > 0.3) {
        const deflection = this.getContinentDeflection(p.x, p.y);
        if (deflection) {
          targetVx += deflection.vx * this.mapOpacity * 2.5;
          targetVy += deflection.vy * this.mapOpacity * 2.5;
          // Tint particles near land
          const colors = [
            'rgba(20, 70, 50, 0.6)',
            'rgba(35, 85, 65, 0.5)',
            'rgba(50, 100, 80, 0.4)',
          ];
          p.color = colors[Math.floor(Math.random() * colors.length)];
        }
      }

      // Mouse interaction (Sonar/Wake disruption)
      if (this.mouse.x > -500) {
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

    // Draw mountain glow OVER particles
    if (this.mapOpacity > 0.01) {
      this.drawMountainGlow();
    }

    // Draw Military/Sonar Cursor Reticle
    if (this.mouse.x > -500) {
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

  private lonLatToCanvas(lon: number, lat: number): { x: number, y: number } {
    const x = ((lon + 180) / 360) * this.width;
    const y = ((90 - lat) / 180) * this.height;
    return { x, y };
  }

  private async buildContinentPaths() {
    try {
      // Fetch real Natural Earth 110m land polygons (TopoJSON, ~20KB)
      const response = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json');
      const topo = await response.json();
      const polygons = this.decodeTopoJSON(topo);

      // Project all polygons to canvas coordinates
      this.continentPaths = polygons.map(poly =>
        poly.map(([lon, lat]) => this.lonLatToCanvas(lon, lat))
      );

      // Build downsampled version for deflection checks (performance)
      this.deflectionPaths = this.continentPaths.map(path => {
        if (path.length <= 20) return path;
        const step = Math.max(1, Math.floor(path.length / 40));
        const sampled: { x: number, y: number }[] = [];
        for (let i = 0; i < path.length; i += step) sampled.push(path[i]);
        return sampled;
      });

      // Build mountain ranges from TopoJSON 
      this.mountainRanges = [];
      console.log(`[Elkwire] Loaded ${this.continentPaths.length} coastline polygons from Natural Earth`);
    } catch (e) {
      console.warn('[Elkwire] Failed to fetch coastline data, map feature unavailable.', e);
      this.continentPaths = [];
      this.deflectionPaths = [];
      this.mountainRanges = [];
    }
  }

  /**
   * Decode TopoJSON land-110m format into arrays of [lon, lat] coordinate rings.
   * Handles delta-encoded arcs with quantization transform.
   */
  private decodeTopoJSON(topo: any): number[][][] {
    const rawArcs: number[][][] = topo.arcs;
    const transform = topo.transform;
    const sx = transform.scale[0], sy = transform.scale[1];
    const tx = transform.translate[0], ty = transform.translate[1];

    // Decode delta-encoded, quantized arcs → absolute [lon, lat]
    const decodedArcs: number[][][] = rawArcs.map((arc: number[][]) => {
      let x = 0, y = 0;
      return arc.map((pt: number[]) => {
        x += pt[0];
        y += pt[1];
        return [x * sx + tx, y * sy + ty];
      });
    });

    // Resolve arc index (negative = reversed)
    const resolveArc = (idx: number): number[][] => {
      if (idx >= 0) return decodedArcs[idx];
      return [...decodedArcs[~idx]].reverse();
    };

    // Stitch a ring of arc indices into a single coordinate array
    const stitchRing = (ring: number[]): number[][] => {
      const coords: number[][] = [];
      for (const idx of ring) {
        const arc = resolveArc(idx);
        // Skip first point of subsequent arcs (shared with previous arc's last point)
        for (let i = coords.length > 0 ? 1 : 0; i < arc.length; i++) {
          coords.push(arc[i]);
        }
      }
      return coords;
    };

    const polygons: number[][][] = [];
    const landObj = topo.objects.land;

    const processGeometry = (geom: any) => {
      if (geom.type === 'Polygon') {
        // Only use exterior ring (index 0), skip holes
        polygons.push(stitchRing(geom.arcs[0]));
      } else if (geom.type === 'MultiPolygon') {
        for (const polygon of geom.arcs) {
          polygons.push(stitchRing(polygon[0]));
        }
      } else if (geom.type === 'GeometryCollection') {
        for (const g of geom.geometries) processGeometry(g);
      }
    };

    processGeometry(landObj);
    return polygons;
  }

  private drawContinents() {
    const ctx = this.ctx;
    const alpha = this.mapOpacity;

    // Draw filled landmasses
    for (const path of this.continentPaths) {
      if (path.length < 3) continue;

      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(6, 24, 18, ${0.2 * alpha})`;
      ctx.fill();
    }

    // Draw coastline outlines with glow
    ctx.save();
    ctx.shadowColor = `rgba(40, 160, 120, ${0.25 * alpha})`;
    ctx.shadowBlur = 6;
    ctx.strokeStyle = `rgba(30, 110, 80, ${0.4 * alpha})`;
    ctx.lineWidth = 1;
    for (const path of this.continentPaths) {
      if (path.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();

    // Draw latitude/longitude grid
    ctx.strokeStyle = `rgba(20, 60, 80, ${0.05 * alpha})`;
    ctx.lineWidth = 0.5;
    for (let lat = -60; lat <= 75; lat += 15) {
      const p1 = this.lonLatToCanvas(-180, lat);
      const p2 = this.lonLatToCanvas(180, lat);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    for (let lon = -150; lon <= 180; lon += 30) {
      const p1 = this.lonLatToCanvas(lon, -80);
      const p2 = this.lonLatToCanvas(lon, 80);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }

  private drawMountainGlow() {
    // Mountains are now implicit in the coastline data fidelity
    // No separate mountain rendering needed
  }


  private getContinentDeflection(px: number, py: number): { vx: number, vy: number } | null {
    const threshold = 20;
    let closestDist = Infinity;
    let nx = 0, ny = 0;

    for (const path of this.deflectionPaths) {
      for (let i = 0; i < path.length - 1; i++) {
        const ax = path[i].x, ay = path[i].y;
        const bx = path[i + 1].x, by = path[i + 1].y;
        const abx = bx - ax, aby = by - ay;
        const apx = px - ax, apy = py - ay;
        const len2 = abx * abx + aby * aby;
        if (len2 === 0) continue;
        const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
        const cx = ax + t * abx, cy = ay + t * aby;
        const dx = px - cx, dy = py - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < closestDist && dist < threshold) {
          closestDist = dist;
          const len = dist || 1;
          nx = dx / len;
          ny = dy / len;
        }
      }
    }

    if (closestDist < threshold) {
      const force = Math.pow((threshold - closestDist) / threshold, 2) * 2;
      return { vx: nx * force + (-ny) * force * 0.4, vy: ny * force + nx * force * 0.4 };
    }
    return null;
  }
}

