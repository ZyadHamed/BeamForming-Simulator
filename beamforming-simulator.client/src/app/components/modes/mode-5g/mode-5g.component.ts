// ══════════════════════════════════════════════════════════════════
//  Mode5gComponent
//  Interactive 2D 5G beamforming environment:
//    • Place base stations (towers) on canvas
//    • Add / remove mobile users
//    • Keyboard-controlled user movement
//    • Dynamic beam steering per user
//    • Element distribution among users
// ══════════════════════════════════════════════════════════════════

import {
  Component, OnInit, OnDestroy, ViewChild, ElementRef,
  ChangeDetectionStrategy, ChangeDetectorRef, HostListener,
} from '@angular/core';
import { CommonModule }  from '@angular/common';
import { FormsModule }   from '@angular/forms';

import { UserCountPipe }        from './user-count.pipe';
import { ProbeArrayComponent }  from '../../probe-array/probe-array.component';
import {
  ArrayConfig, makeDefaultArrayConfig,
  PREDEFINED_SCENARIOS,
} from '../../../models/beamforming.models';
import { InterferenceFieldComponent, ElementPosition } from '../../interference-field/interference-field.component';
interface Tower {
  id       : string;
  x        : number;
  y        : number;
  range    : number;
  array    : ArrayConfig;
  color    : string;
}

interface MobileUser {
  id       : string;
  x        : number;
  y        : number;
  vx       : number;
  vy       : number;
  connectedTowerId: string | null;
  color    : string;
  label    : string;
}

const TOWER_COLORS = ['#1a73e8','#34a853','#e8a82b','#ea4335','#9c27b0'];
const USER_COLORS  = ['#00bcd4','#ff5722','#4caf50','#9c27b0','#ff9800'];

@Component({
  selector       : 'app-mode-5g',
  standalone     : true,
  imports        : [CommonModule, FormsModule, ProbeArrayComponent, UserCountPipe, InterferenceFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl    : './mode-5g.component.html',
  styleUrls      : ['./mode-5g.component.css'],
})
export class Mode5gComponent implements OnInit, OnDestroy {

  @ViewChild('envCanvas', { static: true }) envCanvasRef!: ElementRef<HTMLCanvasElement>;

  towers      : Tower[]      = [];
  users       : MobileUser[] = [];
  selectedTowerId : string | null = null;
  selectedUserId  : string | null = null;
  placingMode : 'tower' | 'user' | null = null;
  showCoverage: boolean = true;
  showGlobalInterference : boolean = false;   

  private animId  : number = 0;
  private t       : number = 0;
  private keysHeld: Set<string> = new Set();


  constructor(
    private cdr    : ChangeDetectorRef,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────

  ngOnInit(): void {
    // Load preset
    const preset = PREDEFINED_SCENARIOS.find(s => s.mode === '5g');
    // Default: 2 towers, 3 users
    this.addDefaultSetup();
    this.startAnimation();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animId);
  }

  // ── Default setup ──────────────────────────────────────────────

  private addDefaultSetup(): void {
    setTimeout(() => {
      const canvas = this.envCanvasRef?.nativeElement;
      const W = canvas?.offsetWidth  || 600;
      const H = canvas?.offsetHeight || 400;

      this.towers = [
        this.makeTower(W * 0.25, H * 0.3, 0),
        this.makeTower(W * 0.72, H * 0.3, 1),
      ];

      this.users = [
        this.makeUser(W * 0.4, H * 0.6, 0),
        this.makeUser(W * 0.6, H * 0.55, 1),
        this.makeUser(W * 0.5, H * 0.75, 2),
      ];

      this.updateConnections();
      this.cdr.markForCheck();
    }, 100);
  }

  private makeTower(x: number, y: number, idx: number): Tower {
    const cfg = makeDefaultArrayConfig(8);
    cfg.elements.forEach((el, i) => {
      el.frequency = 28;
      el.intensity = 90;
    });
    return {
      id    : `tower-${Date.now()}-${idx}`,
      x, y,
      range : 180,
      array : cfg,
      color : TOWER_COLORS[idx % TOWER_COLORS.length],
    };
  }

  private makeUser(x: number, y: number, idx: number): MobileUser {
    return {
      id               : `user-${Date.now()}-${idx}`,
      x, y,
      vx               : 0,
      vy               : 0,
      connectedTowerId : null,
      color            : USER_COLORS[idx % USER_COLORS.length],
      label            : `UE${idx + 1}`,
    };
  }

  // ── Placement ─────────────────────────────────────────────────
get selectedTowerInterference(): ElementPosition[] {
  if (!this.selectedTower) return [];
  const tower = this.selectedTower;
  const n     = tower.array.elements.length;
  const d     = tower.array.elementSpacing * 2;
  // Position elements relative to tower position on canvas
  return tower.array.elements.map((el, i) => ({
    x     : tower.x + (i - (n - 1) / 2) * d,
    y     : tower.y,
    config: el,
  }));
}

  startPlacing(mode: 'tower' | 'user'): void {
    this.placingMode = mode;
    this.cdr.markForCheck();
  }

  onCanvasClick(ev: MouseEvent): void {
    if (!this.placingMode) {
      this.selectAtPoint(ev.offsetX, ev.offsetY);
      return;
    }
    const { offsetX: x, offsetY: y } = ev;
    if (this.placingMode === 'tower') {
      this.towers = [...this.towers, this.makeTower(x, y, this.towers.length)];
    } else {
      this.users = [...this.users, this.makeUser(x, y, this.users.length)];
    }
    this.placingMode = null;
    this.updateConnections();
    this.cdr.markForCheck();
  }

  private selectAtPoint(x: number, y: number): void {
    const hitTower = this.towers.find(t => Math.hypot(t.x - x, t.y - y) < 18);
    const hitUser  = this.users.find(u  => Math.hypot(u.x - x, u.y - y) < 12);
    this.selectedTowerId = hitTower?.id ?? null;
    this.selectedUserId  = hitUser?.id  ?? null;
    this.cdr.markForCheck();
  }

  // ── Remove ────────────────────────────────────────────────────

  removeTower(id: string): void {
    this.towers = this.towers.filter(t => t.id !== id);
    if (this.selectedTowerId === id) this.selectedTowerId = null;
    this.updateConnections();
    this.cdr.markForCheck();
  }

  removeUser(id: string): void {
    this.users = this.users.filter(u => u.id !== id);
    if (this.selectedUserId === id) this.selectedUserId = null;
    this.cdr.markForCheck();
  }

  // ── Keyboard movement ─────────────────────────────────────────

  @HostListener('window:keydown', ['$event'])
  onKeyDown(ev: KeyboardEvent): void {
    this.keysHeld.add(ev.key);
  }

  @HostListener('window:keyup', ['$event'])
  onKeyUp(ev: KeyboardEvent): void {
    this.keysHeld.delete(ev.key);
  }

  private moveSelectedUser(): void {
    if (!this.selectedUserId) return;
    const user = this.users.find(u => u.id === this.selectedUserId);
    if (!user) return;
    const spd = 2;
    if (this.keysHeld.has('ArrowLeft'))  user.x -= spd;
    if (this.keysHeld.has('ArrowRight')) user.x += spd;
    if (this.keysHeld.has('ArrowUp'))    user.y -= spd;
    if (this.keysHeld.has('ArrowDown'))  user.y += spd;
    this.updateConnections();
  }

  // ── Connection logic ──────────────────────────────────────────

  private updateConnections(): void {
    this.users.forEach(user => {
      const inRange = this.towers
        .filter(t => Math.hypot(t.x - user.x, t.y - user.y) <= t.range)
        .sort((a, b) => Math.hypot(a.x - user.x, a.y - user.y) - Math.hypot(b.x - user.x, b.y - user.y));

      const currentTower = this.towers.find(t => t.id === user.connectedTowerId);
      const stillInRange = currentTower && inRange.some(t => t.id === currentTower.id);

      if (!stillInRange) {
        user.connectedTowerId = inRange[0]?.id ?? null;
      }
    });
  }

  // ── Tower array config ────────────────────────────────────────

  get selectedTower(): Tower | null {
    return this.towers.find(t => t.id === this.selectedTowerId) ?? null;
  }

  onTowerArrayChange(cfg: ArrayConfig): void {
    if (!this.selectedTower) return;
    this.selectedTower.array = cfg;
    this.cdr.markForCheck();
  }

  // ── Animation loop ─────────────────────────────────────────────

  private startAnimation(): void {
    const loop = () => {
      this.t += 0.02;
      this.moveSelectedUser();
      this.drawEnvironment();
      this.animId = requestAnimationFrame(loop);
    };
    loop();
  }

  // ── Environment canvas ─────────────────────────────────────────

  private drawEnvironment(): void {
    const canvas = this.envCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width  = canvas.offsetWidth  || 600;
    const H = canvas.height = canvas.offsetHeight || 400;

    ctx.clearRect(0, 0, W, H);
    this.drawCityGrid(ctx, W, H);

    if (this.showCoverage) this.drawCoverage(ctx);

    this.drawBeams(ctx);
    if (this.showGlobalInterference) {
      this.drawGlobalInterference(ctx, W, H);
    }
    this.drawTowers(ctx);
    this.drawUsers(ctx);
  }

  private drawGlobalInterference(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  // Sample the field at reduced resolution and overlay as heatmap
  const step = 8;   // pixels between samples
  this.towers.forEach(tower => {
    const n = tower.array.elements.length;
    const d = tower.array.elementSpacing * 2;
    const elements = tower.array.elements
      .filter(el => el.enabled)
      .map((el, i) => ({
        x: tower.x + (i - (n - 1) / 2) * d,
        y: tower.y,
        config: el,
      }));

    for (let px = 0; px < W; px += step) {
      for (let py = 0; py < H; py += step) {
        let sumRe = 0, sumIm = 0;
        for (const ep of elements) {
          const dx   = px - ep.x;
          const dy   = py - ep.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
          const k    = (2 * Math.PI * ep.config.frequency * 1e6) / 3e8;
          const phaseRad = (ep.config.phaseShift * Math.PI) / 180;
          const delayRad = 2 * Math.PI * ep.config.frequency * 1e6 * ep.config.timeDelay * 1e-6;
          const amp  = (ep.config.intensity / 100) / dist;
          const phase = k * dist - this.t * 3 - phaseRad - delayRad;
          sumRe += amp * Math.cos(phase);
          sumIm += amp * Math.sin(phase);
        }
        const intensity = Math.min(Math.sqrt(sumRe * sumRe + sumIm * sumIm) * 30, 1);
        if (intensity > 0.05) {
          const [r, g, b] = tower.color.match(/\w\w/g)!.map(h => parseInt(h, 16));
          ctx.fillStyle = `rgba(${r},${g},${b},${intensity * 0.5})`;
          ctx.fillRect(px, py, step, step);
        }
      }
    }
  });
}

  private drawCityGrid(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    ctx.fillStyle = '#f0f4f0';
    ctx.fillRect(0, 0, W, H);

    // City blocks
    ctx.strokeStyle = 'rgba(180,200,180,0.6)';
    ctx.lineWidth   = 0.5;
    const gs = 40;
    for (let x = 0; x < W; x += gs) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += gs) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Building blocks (decorative)
    const blockPositions = [[1,1],[3,2],[5,1],[2,4],[6,3],[4,5],[7,2],[1,4]];
    ctx.fillStyle = 'rgba(160,180,160,0.3)';
    blockPositions.forEach(([bx, by]) => {
      ctx.fillRect(bx * gs + 4, by * gs + 4, gs - 8, gs - 8);
    });
  }

  private drawCoverage(ctx: CanvasRenderingContext2D): void {
    this.towers.forEach(tower => {
      const grad = ctx.createRadialGradient(tower.x, tower.y, 5, tower.x, tower.y, tower.range);
      grad.addColorStop(0, tower.color + '33');
      grad.addColorStop(1, tower.color + '08');
      ctx.beginPath();
      ctx.arc(tower.x, tower.y, tower.range, 0, Math.PI * 2);
      ctx.fillStyle   = grad;
      ctx.fill();
      ctx.strokeStyle = tower.color + '55';
      ctx.lineWidth   = 1;
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  private drawBeams(ctx: CanvasRenderingContext2D): void {
    // Per tower, per connected user → draw beam
    this.towers.forEach(tower => {
      const connectedUsers = this.users.filter(u => u.connectedTowerId === tower.id);

      connectedUsers.forEach((user, idx) => {
        const dx     = user.x - tower.x;
        const dy     = user.y - tower.y;
        const dist   = Math.hypot(dx, dy);
        const angle  = Math.atan2(dy, dx);
        const halfW  = Math.PI / Math.max(tower.array.numElements, 2) * 0.8;

        // Beam cone
        const grad = ctx.createRadialGradient(tower.x, tower.y, 0, tower.x, tower.y, dist);
        grad.addColorStop(0, user.color + 'aa');
        grad.addColorStop(1, user.color + '11');

        ctx.beginPath();
        ctx.moveTo(tower.x, tower.y);
        ctx.arc(tower.x, tower.y, dist, angle - halfW, angle + halfW);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Beam axis (animated)
        const dashOffset = (this.t * 20) % 20;
        ctx.beginPath();
        ctx.strokeStyle = user.color + 'cc';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -dashOffset;
        ctx.moveTo(tower.x, tower.y);
        ctx.lineTo(user.x, user.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;

        // Wave rings along beam
        for (let ring = 0; ring < 3; ring++) {
          const r = ((this.t * 40 + ring * 30) % dist);
          const rx = tower.x + (dx / dist) * r;
          const ry = tower.y + (dy / dist) * r;
          const alpha = 0.4 * (1 - r / dist);
          ctx.beginPath();
          ctx.arc(rx, ry, 5, 0, Math.PI * 2);
          ctx.strokeStyle = user.color + Math.round(alpha * 255).toString(16).padStart(2, '0');
          ctx.lineWidth   = 1;
          ctx.stroke();
        }
      });
    });
  }

  private drawTowers(ctx: CanvasRenderingContext2D): void {
    this.towers.forEach(tower => {
      const isSelected = tower.id === this.selectedTowerId;
      const pulse      = isSelected ? 1 + 0.15 * Math.sin(this.t * 6) : 1;

      // Tower base
      ctx.beginPath();
      ctx.arc(tower.x, tower.y, 14 * pulse, 0, Math.PI * 2);
      ctx.fillStyle   = tower.color + '22';
      ctx.fill();
      ctx.strokeStyle = tower.color;
      ctx.lineWidth   = isSelected ? 2.5 : 1.5;
      ctx.stroke();

      // Tower icon (antenna)
      ctx.beginPath();
      ctx.strokeStyle = tower.color;
      ctx.lineWidth   = 2;
      ctx.moveTo(tower.x, tower.y - 10);
      ctx.lineTo(tower.x, tower.y + 8);
      ctx.moveTo(tower.x - 7, tower.y - 4);
      ctx.lineTo(tower.x + 7, tower.y - 4);
      ctx.moveTo(tower.x - 5, tower.y - 8);
      ctx.lineTo(tower.x + 5, tower.y - 8);
      ctx.stroke();

      // Label
      ctx.fillStyle = tower.color;
      ctx.font      = 'bold 9px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`BS${this.towers.indexOf(tower) + 1}`, tower.x, tower.y + 22);

      const usersConnected = this.users.filter(u => u.connectedTowerId === tower.id).length;
      if (usersConnected > 0) {
        ctx.fillStyle = 'rgba(52,168,83,0.9)';
        ctx.font      = '8px IBM Plex Mono, monospace';
        ctx.fillText(`${usersConnected}UE`, tower.x, tower.y + 31);
      }
    });
  }

  private drawUsers(ctx: CanvasRenderingContext2D): void {
    this.users.forEach(user => {
      const isSelected = user.id === this.selectedUserId;
      const pulse      = isSelected ? 1 + 0.2 * Math.sin(this.t * 8) : 1;

      // User dot
      ctx.beginPath();
      ctx.arc(user.x, user.y, 7 * pulse, 0, Math.PI * 2);
      ctx.fillStyle   = user.color;
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth   = 2;
        ctx.stroke();
        // Movement hint
        ctx.strokeStyle = user.color + '66';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.arc(user.x, user.y, 14 * pulse, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Connection indicator
      if (user.connectedTowerId) {
        ctx.fillStyle = '#34a853';
        ctx.beginPath();
        ctx.arc(user.x + 6, user.y - 6, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Label
      ctx.fillStyle = user.color;
      ctx.font      = 'bold 9px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(user.label, user.x, user.y + 18);
    });
  }
}
