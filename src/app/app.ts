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

  constructor(private ngZone: NgZone) {}

  ngAfterViewInit() {
    this.fetchRealtimeWinds();
    this.initCanvas();
    this.animateText();
  }

  ngOnDestroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
  }

  @HostListener('window:resize')
  onResize() {
    this.initCanvas();
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
      const lats = [];
      const lons = [];
      for(let lat = 90; lat >= -90; lat -= 15) {
        for(let lon = -180; lon <= 180; lon += 30) {
          lats.push(lat);
          lons.push(lon);
        }
      }
      
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&current=wind_speed_10m,wind_direction_10m`);
      const data = await response.json();
      
      if (Array.isArray(data) && data.length === this.gridRows * this.gridCols) {
        let index = 0;
        this.windGrid = [];
        for (let i = 0; i < this.gridRows; i++) {
          const row = [];
          for (let j = 0; j < this.gridCols; j++) {
            const pointData = data[index].current;
            if (pointData) {
              const speed = pointData.wind_speed_10m; // km/h
              const dir = pointData.wind_direction_10m; // degrees
              // meteorological direction: 0=N, 90=E, 180=S, 270=W
              // canvas axes: +x=East, +y=South
              const rad = dir * Math.PI / 180;
              const u = -Math.sin(rad) * (speed / 15);
              const v = Math.cos(rad) * (speed / 15);
              row.push({ u, v });
            } else {
              row.push({ u: 0, v: 0 });
            }
            index++;
          }
          this.windGrid.push(row);
        }
      }
    } catch (e) {
      console.warn('Could not fetch real-time winds, falling back to math model.', e);
    }
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
    const scale = 0.0012; // Macro oceanic scale
    const sx = x * scale;
    const sy = y * scale;
    const eps = 0.01;
    
    // Compute partial derivatives of the stream function for divergence-free flow (incompressible fluid)
    const n1 = this.fbm(sx, sy + eps - t);
    const n2 = this.fbm(sx, sy - eps - t);
    const dPsi_dy = (n1 - n2) / (2 * eps);

    const n3 = this.fbm(sx + eps - t, sy);
    const n4 = this.fbm(sx - eps - t, sy);
    const dPsi_dx = (n3 - n4) / (2 * eps);

    // Global Ocean Circulation & Atmospheric Model (Interpolated from Real-World Data)
    let u = 0; // Zonal (East-West)
    let v = 0; // Meridional (North-South)
    let multiplier = 1.0;

    if (this.windGrid.length === this.gridRows) {
      const normX = x / (this.width || 1);
      const normY = y / (this.height || 1);
      
      const gx = normX * (this.gridCols - 1);
      const gy = normY * (this.gridRows - 1);
      
      const ix = Math.max(0, Math.min(Math.floor(gx), this.gridCols - 1));
      const iy = Math.max(0, Math.min(Math.floor(gy), this.gridRows - 1));
      
      const fx = gx - Math.floor(gx);
      const fy = gy - Math.floor(gy);
      
      const ix1 = Math.min(ix + 1, this.gridCols - 1);
      const iy1 = Math.min(iy + 1, this.gridRows - 1);
      
      const tl = this.windGrid[iy][ix];
      const tr = this.windGrid[iy][ix1];
      const bl = this.windGrid[iy1][ix];
      const br = this.windGrid[iy1][ix1];
      
      const topU = tl.u * (1 - fx) + tr.u * fx;
      const topV = tl.v * (1 - fx) + tr.v * fx;
      const botU = bl.u * (1 - fx) + br.u * fx;
      const botV = bl.v * (1 - fx) + br.v * fx;
      
      u = topU * (1 - fy) + botU * fy;
      v = topV * (1 - fy) + botV * fy;
      
      // Calculate wind intensity multiplier to scale turbulence correctly
      multiplier = Math.max(0.2, Math.sqrt(u * u + v * v) / 1.5);
    } else {
      // Fallback model if data is unavailable
      const normalizedY = y / (this.height || 1); 
      const lat = (0.5 - normalizedY) * 180;
      const absLat = Math.abs(lat);
      const signLat = Math.sign(lat) || 1;

      if (absLat < 30) {
        const intensity = Math.cos(absLat * Math.PI / 60);
        u = -1.8 * intensity;
        v = 0.6 * intensity * signLat;
      } else if (absLat < 60) {
        const intensity = Math.sin((absLat - 30) * Math.PI / 30);
        u = 2.2 * intensity;
        v = -0.8 * intensity * signLat;
      } else {
        const intensity = Math.sin((absLat - 60) * Math.PI / 60);
        u = -1.2 * intensity;
        v = 0.4 * intensity * signLat;
      }
    }

    // Curl noise adds mathematically accurate turbulent eddies (Von Kármán streets / Ocean gyre shedding)
    const turbulence = 2.0 * multiplier;
    const curlVx = dPsi_dy * turbulence;
    const curlVy = -dPsi_dx * turbulence;

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
    this.ctx.fillStyle = 'rgba(0, 12, 24, 0.08)'; // Deep oceanic abyss, slightly transparent for streamlines
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Slower time evolution for realistic macroscopic fluid dynamics
    const t = performance.now() * 0.00005;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.color = p.baseColor; // Reset to base color
      
      const fluid = this.getFluidVelocity(p.x, p.y, t);
      
      // Speed of currents
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
          
          // Push outward radially
          targetVx += (dx / dist) * force * 5;
          targetVy += (dy / dist) * force * 5;
          
          // Swirl tangentially
          targetVx += -(dy / dist) * force * 3;
          targetVy += (dx / dist) * force * 3;
        }
      }

      // Smooth velocity interpolation for organic movement
      p.vx += (targetVx - p.vx) * 0.08;
      p.vy += (targetVy - p.vy) * 0.08;
      
      p.lastX = p.x;
      p.lastY = p.y;
      p.x += p.vx;
      p.y += p.vy;
      p.life--;

      // Respawn particles that die or go off-screen
      if (p.life <= 0 || p.x < -50 || p.x > this.width + 50 || p.y < -50 || p.y > this.height + 50 || isNaN(p.x) || isNaN(p.y)) {
        this.resetParticle(p);
      } else {
        // Draw streamline
        this.ctx.strokeStyle = p.color;
        this.ctx.lineWidth = p.size;
        this.ctx.beginPath();
        this.ctx.moveTo(p.lastX, p.lastY);
        this.ctx.lineTo(p.x, p.y);
        this.ctx.stroke();
      }
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
}
