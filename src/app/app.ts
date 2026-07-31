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
    p.maxLife = Math.random() * 150 + 50;
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

    // Turbulence: scale to ~30% of wind magnitude so real patterns dominate visually
    // This models sub-grid mesoscale eddies while preserving the synoptic-scale flow
    const windMag = Math.sqrt(u * u + v * v);
    const turbulenceScale = Math.max(0.15, windMag * 0.3);
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

  private buildContinentPaths() {
    // Realistic continent outlines as lon/lat coordinate arrays
    const continents: number[][][] = [
      // North America
      [[-130,55],[-125,60],[-120,65],[-115,70],[-105,72],[-95,72],[-85,70],[-80,65],[-75,60],[-72,55],[-70,48],[-68,45],[-72,42],[-78,38],[-82,35],[-85,30],[-90,28],[-95,26],[-100,22],[-105,20],[-110,25],[-115,30],[-120,35],[-122,40],[-124,45],[-126,50],[-130,55]],
      // South America
      [[-80,10],[-75,12],[-70,12],[-65,10],[-60,5],[-55,3],[-50,0],[-47,-3],[-45,-8],[-42,-13],[-40,-18],[-42,-23],[-45,-25],[-48,-28],[-50,-30],[-52,-33],[-55,-35],[-58,-38],[-65,-42],[-68,-46],[-72,-50],[-75,-52],[-73,-48],[-72,-42],[-70,-38],[-70,-30],[-72,-25],[-75,-18],[-78,-12],[-80,-5],[-78,0],[-77,5],[-80,10]],
      // Europe
      [[-10,36],[-8,38],[-9,42],[-5,44],[-2,48],[0,50],[3,52],[5,54],[8,55],[10,57],[12,56],[15,55],[18,54],[20,55],[24,56],[28,58],[30,60],[32,62],[35,65],[30,68],[25,70],[20,70],[15,68],[10,65],[5,62],[2,58],[0,55],[-3,50],[-5,46],[-8,42],[-10,36]],
      // Africa
      [[-17,15],[-15,20],[-13,25],[-10,30],[-5,34],[0,36],[5,37],[10,37],[15,35],[20,33],[25,32],[30,32],[33,30],[35,28],[37,25],[40,20],[42,15],[45,12],[48,8],[50,5],[48,2],[45,-2],[42,-5],[40,-10],[38,-15],[36,-20],[34,-25],[32,-28],[30,-30],[28,-32],[26,-34],[25,-33],[22,-28],[18,-20],[15,-15],[12,-10],[10,-5],[8,0],[5,5],[2,8],[0,10],[-5,12],[-10,14],[-15,15],[-17,15]],
      // Asia
      [[30,32],[35,35],[40,38],[42,42],[45,45],[50,48],[55,50],[60,52],[65,55],[70,58],[75,60],[80,62],[85,65],[90,65],[95,62],[100,60],[105,55],[110,50],[115,45],[120,42],[125,40],[130,38],[135,35],[140,38],[142,42],[145,45],[140,50],[135,55],[130,58],[125,60],[120,62],[115,65],[110,68],[105,70],[100,72],[90,72],[80,70],[70,68],[65,65],[60,62],[55,58],[50,55],[45,50],[42,45],[40,42],[38,38],[35,35],[30,32]],
      // Australia
      [[115,-12],[118,-15],[120,-18],[122,-20],[125,-22],[128,-25],[130,-28],[132,-30],[135,-32],[138,-34],[142,-36],[145,-38],[148,-37],[150,-35],[152,-32],[153,-28],[150,-25],[148,-22],[146,-18],[145,-15],[142,-12],[140,-11],[138,-12],[135,-14],[132,-15],[130,-14],[128,-13],[125,-12],[122,-11],[120,-12],[118,-13],[115,-12]],
      // Greenland
      [[-55,60],[-50,62],[-45,65],[-42,68],[-40,72],[-38,75],[-40,78],[-45,80],[-50,82],[-55,80],[-58,78],[-60,75],[-58,72],[-55,68],[-52,65],[-55,60]],
      // Antarctica hint
      [[-180,-70],[-150,-72],[-120,-75],[-90,-78],[-60,-80],[-30,-78],[0,-75],[30,-72],[60,-70],[90,-72],[120,-75],[150,-78],[180,-78],[180,-70],[150,-72],[120,-70],[90,-68],[60,-65],[30,-68],[0,-70],[-30,-72],[-60,-75],[-90,-73],[-120,-70],[-150,-68],[-180,-70]]
    ];

    // Mountain ranges as lon/lat polylines
    const mountains: number[][][] = [
      // Rockies
      [[-120,55],[-118,50],[-115,45],[-112,40],[-110,35],[-108,32],[-105,28]],
      // Andes
      [[-72,-50],[-70,-45],[-70,-40],[-70,-35],[-72,-28],[-75,-20],[-78,-12],[-80,-5],[-78,2],[-75,8]],
      // Alps
      [[5,46],[8,47],[10,47],[12,47],[15,46],[18,45]],
      // Himalayas
      [[72,35],[76,34],[80,30],[85,28],[88,27],[92,28],[96,27],[100,25]],
      // Urals
      [[58,50],[60,53],[60,56],[59,59],[58,62],[57,65],[56,68]],
      // Atlas
      [[-5,32],[-2,34],[2,35],[5,36],[8,35]],
      // Great Dividing Range
      [[148,-37],[150,-34],[152,-30],[150,-25],[148,-20],[146,-16]]
    ];

    this.continentPaths = continents.map(c => c.map(p => this.lonLatToCanvas(p[0], p[1])));
    this.mountainRanges = mountains.map(m => m.map(p => this.lonLatToCanvas(p[0], p[1])));
  }

  private drawContinents() {
    const ctx = this.ctx;
    const alpha = this.mapOpacity;
    const t = performance.now() * 0.001;

    // Draw continent outlines
    for (const path of this.continentPaths) {
      if (path.length < 2) continue;

      // Subtle fill
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(8, 30, 22, ${0.15 * alpha})`;
      ctx.fill();

      // Glowing outline
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.closePath();
      ctx.strokeStyle = `rgba(30, 120, 90, ${0.35 * alpha})`;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = `rgba(40, 160, 120, ${0.3 * alpha})`;
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Draw latitude/longitude grid
    ctx.strokeStyle = `rgba(20, 60, 80, ${0.06 * alpha})`;
    ctx.lineWidth = 0.5;
    for (let lat = -60; lat <= 75; lat += 15) {
      const p1 = this.lonLatToCanvas(-180, lat);
      const p2 = this.lonLatToCanvas(180, lat);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    for (let lon = -180; lon <= 180; lon += 30) {
      const p1 = this.lonLatToCanvas(lon, -80);
      const p2 = this.lonLatToCanvas(lon, 80);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }

  private drawMountainGlow() {
    const ctx = this.ctx;
    const alpha = this.mapOpacity;
    const t = performance.now() * 0.0008;

    for (const range of this.mountainRanges) {
      if (range.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(range[0].x, range[0].y);
      for (let i = 1; i < range.length; i++) {
        const prev = range[i - 1];
        const curr = range[i];
        const cpx = (prev.x + curr.x) / 2;
        const cpy = (prev.y + curr.y) / 2 - 3 * Math.sin(t + i);
        ctx.quadraticCurveTo(prev.x, prev.y, cpx, cpy);
      }
      ctx.strokeStyle = `rgba(80, 140, 110, ${0.5 * alpha})`;
      ctx.lineWidth = 2;
      ctx.shadowColor = `rgba(100, 200, 150, ${0.4 * alpha})`;
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Peak markers
      for (let i = 0; i < range.length; i += 2) {
        const shimmer = 0.3 + 0.2 * Math.sin(t * 2 + i * 1.7);
        ctx.beginPath();
        ctx.arc(range[i].x, range[i].y, 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(120, 200, 160, ${shimmer * alpha})`;
        ctx.fill();
      }
    }
  }

  private getContinentDeflection(px: number, py: number): { vx: number, vy: number } | null {
    const threshold = 25;
    let closestDist = Infinity;
    let nx = 0, ny = 0;

    for (const path of this.continentPaths) {
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
      const force = Math.pow((threshold - closestDist) / threshold, 2) * 3;
      // Deflect tangentially + push away
      return { vx: nx * force + (-ny) * force * 0.5, vy: ny * force + nx * force * 0.5 };
    }
    return null;
  }
}
