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
  private orographicBarriers: { points: { x: number, y: number }[], strength: number }[] = [];
  private mapCache: HTMLCanvasElement | null = null;
  private mapCacheDirty = true;
  private terrainFieldU: Float32Array = new Float32Array(0);
  private terrainFieldV: Float32Array = new Float32Array(0);
  private tfCols = 0;
  private tfRows = 0;
  private tfCellSize = 20;
  private isTouchDevice = false;

  // Real-world mountain range data: [lon, lat] polylines with relative strength
  // Strength represents barrier height/effectiveness (1.0 = Himalayas-class)
  private static readonly MOUNTAIN_DATA: { coords: number[][], strength: number }[] = [
    // HIMALAYAS - highest, strongest wind barrier on Earth
    { coords: [[72,37],[74,36],[76,35],[78,34],[80,32],[82,30],[84,29],[86,28],[88,27],[90,28],[92,27],[95,28],[97,27],[100,26]], strength: 1.0 },
    // KARAKORAM / HINDU KUSH
    { coords: [[67,36],[69,36],[71,37],[73,37],[75,36],[77,36]], strength: 0.85 },
    // WESTERN GHATS (India) - blocks SW monsoon
    { coords: [[73,21],[73.5,19],[74,17],[75,15],[75.5,13],[76,11],[77,9]], strength: 0.5 },
    // ANDES - longest continental mountain range
    { coords: [[-75,10],[-76,7],[-77,4],[-78,1],[-79,-2],[-78,-5],[-76,-10],[-72,-16],[-70,-20],[-70,-25],[-70,-30],[-71,-35],[-72,-40],[-73,-45],[-74,-50]], strength: 0.9 },
    // ROCKY MOUNTAINS
    { coords: [[-120,58],[-118,55],[-116,52],[-115,48],[-113,45],[-111,42],[-110,40],[-109,38],[-108,35],[-106,32],[-105,30]], strength: 0.75 },
    // ALPS
    { coords: [[5,46],[7,46.5],[8,47],[10,47],[12,47],[14,46.5],[16,46]], strength: 0.55 },
    // URAL MOUNTAINS - Europe/Asia divide
    { coords: [[58,50],[59,53],[60,56],[59,59],[58,62],[57,65],[56,68]], strength: 0.45 },
    // ATLAS MOUNTAINS (North Africa)
    { coords: [[-5,32],[-3,33],[-1,34],[1,34.5],[3,35],[5,36],[7,35],[9,35]], strength: 0.45 },
    // GREAT DIVIDING RANGE (Australia)
    { coords: [[149,-37],[150,-35],[151,-33],[152,-30],[151,-27],[150,-24],[149,-21],[148,-18],[146,-16]], strength: 0.4 },
    // SCANDINAVIAN MOUNTAINS
    { coords: [[5,59],[7,61],[9,63],[11,65],[13,67],[15,69],[17,70]], strength: 0.5 },
    // CAUCASUS
    { coords: [[37,43],[39,43],[41,42.5],[43,42],[45,42],[48,41]], strength: 0.55 },
    // APPALACHIANS
    { coords: [[-84,35],[-82,36],[-81,37],[-80,38],[-79,40],[-78,41],[-76,42],[-75,44]], strength: 0.35 },
    // TIAN SHAN (Central Asia)
    { coords: [[68,42],[71,42],[74,42],[77,43],[80,42]], strength: 0.7 },
    // ALTAI MOUNTAINS
    { coords: [[83,50],[85,49],[87,48],[89,48],[91,47]], strength: 0.5 },
    // ETHIOPIAN HIGHLANDS
    { coords: [[36,14],[37,12],[38,10],[39,8],[40,7]], strength: 0.45 },
    // DRAKENSBERG (South Africa)
    { coords: [[28,-29],[29,-30],[29.5,-31],[30,-32]], strength: 0.35 },
    // ZAGROS MOUNTAINS (Iran)
    { coords: [[46,37],[48,35],[50,33],[52,31],[54,29],[56,27]], strength: 0.55 },
    // SIERRA MADRE (Mexico)
    { coords: [[-107,28],[-106,26],[-105,24],[-104,22],[-103,20],[-102,18]], strength: 0.4 },
    // CARPATHIANS
    { coords: [[17,48],[19,49],[21,49],[23,48],[25,47],[26,46],[27,45]], strength: 0.4 },
    // KUNLUN MOUNTAINS
    { coords: [[74,36],[78,36],[82,36],[86,36],[90,36],[94,36]], strength: 0.7 },
  ];

  constructor(private ngZone: NgZone) {}

  ngAfterViewInit() {
    this.isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.fetchRealtimeWinds();
    this.windRefreshTimer = setInterval(() => this.fetchRealtimeWinds(), 15 * 60 * 1000);
    this.initCanvas();
    this.buildOrographicBarriers();
    this.buildContinentPaths();
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
    this.buildOrographicBarriers();
    if (this.rawPolygons.length > 0) {
      this.projectContinents();
    }
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

    // Sample pre-computed terrain deflection field (orographic + coastline)
    // O(1) lookup instead of per-particle segment iteration
    if (this.tfCols > 0 && this.tfRows > 0) {
      const gx = Math.max(0, Math.min(this.tfCols - 1.001, x / this.tfCellSize));
      const gy = Math.max(0, Math.min(this.tfRows - 1.001, y / this.tfCellSize));
      const ix = Math.floor(gx), iy = Math.floor(gy);
      const fx = gx - ix, fy = gy - iy;
      const ix1 = Math.min(ix + 1, this.tfCols - 1);
      const iy1 = Math.min(iy + 1, this.tfRows - 1);
      const i00 = iy * this.tfCols + ix, i10 = iy * this.tfCols + ix1;
      const i01 = iy1 * this.tfCols + ix, i11 = iy1 * this.tfCols + ix1;
      u += this.terrainFieldU[i00] * (1-fx)*(1-fy) + this.terrainFieldU[i10] * fx*(1-fy) + this.terrainFieldU[i01] * (1-fx)*fy + this.terrainFieldU[i11] * fx*fy;
      v += this.terrainFieldV[i00] * (1-fx)*(1-fy) + this.terrainFieldV[i10] * fx*(1-fy) + this.terrainFieldV[i01] * (1-fx)*fy + this.terrainFieldV[i11] * fx*fy;
    }

    // Turbulence: mesoscale eddies proportional to wind, with a floor for visual continuity
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

    // Draw dark continent silhouettes from cached offscreen canvas
    this.drawContinents();

    const t = performance.now() * 0.00005;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.color = p.baseColor;

      const fluid = this.getFluidVelocity(p.x, p.y, t);
      let targetVx = fluid.vx * 1.5;
      let targetVy = fluid.vy * 1.5;

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


    // Draw Cursor Reticle (desktop only)
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

  private lonLatToCanvas(lon: number, lat: number): { x: number, y: number } {
    const x = ((lon + 180) / 360) * this.width;
    const y = ((90 - lat) / 180) * this.height;
    return { x, y };
  }

  private rawPolygons: number[][][] = [];

  private async buildContinentPaths() {
    try {
      if (this.rawPolygons.length === 0) {
        const response = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json');
        const topo = await response.json();
        this.rawPolygons = this.decodeTopoJSON(topo);
      }
      this.projectContinents();
    } catch (e) {
      console.warn('[Elkwire] Failed to fetch coastline data, map feature unavailable.', e);
      this.continentPaths = [];
      this.deflectionPaths = [];
      this.mountainRanges = [];
    }
  }

  private projectContinents() {
    this.continentPaths = this.rawPolygons.map(poly =>
      poly.map(([lon, lat]) => this.lonLatToCanvas(lon, lat))
    );

    this.deflectionPaths = this.continentPaths.map(path => {
      if (path.length <= 20) return path;
      const step = Math.max(1, Math.floor(path.length / 40));
      const sampled: { x: number, y: number }[] = [];
      for (let i = 0; i < path.length; i += step) sampled.push(path[i]);
      return sampled;
    });

    this.mountainRanges = [];
    this.buildTerrainField();
    this.mapCacheDirty = true;
  }

  private buildTerrainField() {
    if (!this.width || !this.height) return;
    this.tfCols = Math.ceil(this.width / this.tfCellSize) + 1;
    this.tfRows = Math.ceil(this.height / this.tfCellSize) + 1;
    const len = this.tfCols * this.tfRows;
    this.terrainFieldU = new Float32Array(len);
    this.terrainFieldV = new Float32Array(len);
    
    for (let y = 0; y < this.tfRows; y++) {
      for (let x = 0; x < this.tfCols; x++) {
        const px = x * this.tfCellSize;
        const py = y * this.tfCellSize;
        let du = 0, dv = 0;

        // Coastline deflection
        let closestCoast = Infinity;
        let cx = 0, cy = 0;
        for (const path of this.deflectionPaths) {
          for (let i = 0; i < path.length - 1; i++) {
            const ax = path[i].x, ay = path[i].y;
            const bx = path[i + 1].x, by = path[i + 1].y;
            const abx = bx - ax, aby = by - ay;
            const apx = px - ax, apy = py - ay;
            const len2 = abx * abx + aby * aby;
            if (len2 === 0) continue;
            const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
            const nx = ax + t * abx, ny = ay + t * aby;
            const dx = px - nx, dy = py - ny;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < closestCoast && dist < 20) {
              closestCoast = dist;
              const dl = dist || 1;
              cx = dx / dl;
              cy = dy / dl;
            }
          }
        }
        if (closestCoast < 20) {
          const force = Math.pow((20 - closestCoast) / 20, 2) * 2;
          du += cx * force + (-cy) * force * 0.4;
          dv += cy * force + cx * force * 0.4;
        }

        // Orographic deflection
        let closestMtn = Infinity;
        let mx = 0, my = 0;
        let mStr = 0;
        for (const barrier of this.orographicBarriers) {
          for (let i = 0; i < barrier.points.length - 1; i++) {
            const ax = barrier.points[i].x, ay = barrier.points[i].y;
            const bx = barrier.points[i + 1].x, by = barrier.points[i + 1].y;
            const abx = bx - ax, aby = by - ay;
            const apx = px - ax, apy = py - ay;
            const len2 = abx * abx + aby * aby;
            if (len2 === 0) continue;
            const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
            const nx = ax + t * abx, ny = ay + t * aby;
            const dx = px - nx, dy = py - ny;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < closestMtn && dist < 30) {
              closestMtn = dist;
              const dl = dist || 1;
              mx = dx / dl;
              my = dy / dl;
              mStr = barrier.strength;
            }
          }
        }
        if (closestMtn < 30) {
          const proximity = (30 - closestMtn) / 30;
          const force = proximity * proximity * mStr * 3;
          du += mx * force * 0.6 + (-my) * force * 0.8;
          dv += my * force * 0.6 + mx * force * 0.8;
        }

        const idx = y * this.tfCols + x;
        this.terrainFieldU[idx] = du;
        this.terrainFieldV[idx] = dv;
      }
    }
  }

  private updateMapCache() {
    if (!this.mapCache) {
      this.mapCache = document.createElement('canvas');
    }
    this.mapCache.width = this.width;
    this.mapCache.height = this.height;
    const ctx = this.mapCache.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, this.width, this.height);

    for (const path of this.continentPaths) {
      if (path.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(2, 6, 12, 0.4)`;
      ctx.fill();
    }

    this.mapCacheDirty = false;
  }

  private drawContinents() {
    // Always draw the ultra-subtle dark continent silhouettes from cache
    if (this.mapCacheDirty) {
      this.updateMapCache();
    }
    if (this.mapCache) {
      this.ctx.drawImage(this.mapCache, 0, 0);
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

    const decodedArcs: number[][][] = rawArcs.map((arc: number[][]) => {
      let x = 0, y = 0;
      return arc.map((pt: number[]) => {
        x += pt[0];
        y += pt[1];
        return [x * sx + tx, y * sy + ty];
      });
    });

    const resolveArc = (idx: number): number[][] => {
      if (idx >= 0) return decodedArcs[idx];
      return [...decodedArcs[~idx]].reverse();
    };

    const stitchRing = (ring: number[]): number[][] => {
      const coords: number[][] = [];
      for (const idx of ring) {
        const arc = resolveArc(idx);
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

  private buildOrographicBarriers() {
    this.orographicBarriers = App.MOUNTAIN_DATA.map(m => ({
      points: m.coords.map(([lon, lat]) => this.lonLatToCanvas(lon, lat)),
      strength: m.strength
    }));
  }
}

