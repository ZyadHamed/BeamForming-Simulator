// ══════════════════════════════════════════════════════════════════
//  Mode5gComponent
// ══════════════════════════════════════════════════════════════════

import {
  Component, OnInit, OnDestroy, ViewChild, ElementRef,
  ChangeDetectionStrategy, ChangeDetectorRef, HostListener, AfterViewInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { UserCountPipe } from './user-count.pipe';
import { ProbeArrayComponent } from '../../probe-array/probe-array.component';
import { ArrayConfig, makeDefaultArrayConfig } from '../../../models/beamforming.models';
import { InterferenceFieldComponent, ElementPosition } from '../../interference-field/interference-field.component';
import {
  BeamformingService, Tower5GRequest, User5GRequest,
  LinkQuality, NetworkStateResult, TowerBeamsResponse, SectorBeamData,
} from '../../../services/beamforming.service';

const PX_PER_METER = 10;

const SECTOR_BORESIGHTS: Record<string, number> = { Alpha: 0, Beta: 120, Gamma: -120 };
const SECTOR_COLORS: Record<string, string> = { Alpha: '#1a73e8', Beta: '#34a853', Gamma: '#e8a82b' };

const APODIZATION_OPTIONS = ['none', 'hanning', 'hamming', 'blackman', 'kaiser', 'tukey'] as const;
type ApodizationOption = typeof APODIZATION_OPTIONS[number];

interface Tower {
  id: string; x: number; y: number; range: number;
  array: ArrayConfig; color: string;
  sectorAngles: Record<string, number>;
  beamData: TowerBeamsResponse | null;
  apodization: ApodizationOption;
  snr: number;
}

interface MobileUser {
  id: string; x: number; y: number; vx: number; vy: number;
  connectedTowerId: string | null; color: string; label: string;
  snr_db: number; data_rate_mbps: number; sector_name: string; local_beam_angle: number;
}

const TOWER_COLORS = ['#1a73e8', '#34a853', '#e8a82b', '#ea4335', '#9c27b0'];
const USER_COLORS = ['#00bcd4', '#ff5722', '#4caf50', '#9c27b0', '#ff9800'];

@Component({
  selector: 'app-mode-5g', standalone: true,
  imports: [CommonModule, FormsModule, ProbeArrayComponent, UserCountPipe, InterferenceFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mode-5g.component.html',
  styleUrls: ['./mode-5g.component.css'],
})
export class Mode5gComponent implements OnInit, OnDestroy, AfterViewInit {

  @ViewChild('envCanvas', { static: true }) envCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('polarCanvas', { static: false }) polarCanvasRef!: ElementRef<HTMLCanvasElement>;

  towers: Tower[] = [];
  users: MobileUser[] = [];
  selectedTowerId: string | null = null;
  selectedUserId: string | null = null;
  placingMode: 'tower' | 'user' | null = null;
  showCoverage = true;
  showGlobalInterference = false;

  activeSectorTab = 'Alpha';
  readonly sectorNames = ['Alpha', 'Beta', 'Gamma'];
  readonly apodOptions = APODIZATION_OPTIONS;

  // drag
  private draggingTowerId: string | null = null;
  private dragOffsetX = 0; private dragOffsetY = 0;

  private animId = 0; private t = 0;
  private keysHeld: Set<string> = new Set();
  private towersInitialized = false;
  private framesSinceSync = 0;
  private readonly SYNC_EVERY_N_FRAMES = 3;

  constructor(private cdr: ChangeDetectorRef, private service: BeamformingService) { }

  // ── Lifecycle ──────────────────────────────────────────────────

  ngOnInit(): void { this.startAnimation(); }

  ngAfterViewInit(): void {
    requestAnimationFrame(() => {
      const canvas = this.envCanvasRef.nativeElement;
      const W = canvas.offsetWidth || 800, H = canvas.offsetHeight || 500;
      this.towers = [this.makeTower(W * 0.25, H * 0.35, 0), this.makeTower(W * 0.70, H * 0.35, 1)];
      this.users = [
        this.makeUser(W * 0.40, H * 0.65, 0), this.makeUser(W * 0.60, H * 0.60, 1), this.makeUser(W * 0.50, H * 0.78, 2),
      ];
      this.syncTowersToBackend();
      this.redrawPolar();
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void { cancelAnimationFrame(this.animId); }

  // ── Factory ────────────────────────────────────────────────────

  private makeTower(x: number, y: number, idx: number): Tower {
    const cfg = makeDefaultArrayConfig(8);
    cfg.elements.forEach(el => { el.frequency = 3500; el.intensity = 90; });
    return {
      id: `tower-${Date.now()}-${idx}`, x, y, range: 180, array: cfg,
      color: TOWER_COLORS[idx % TOWER_COLORS.length],
      sectorAngles: { Alpha: 0, Beta: 0, Gamma: 0 },
      beamData: null,
      apodization: 'hamming',
      snr: 100,
    };
  }

  private makeUser(x: number, y: number, idx: number): MobileUser {
    return {
      id: `user-${Date.now()}-${idx}`, x, y, vx: 0, vy: 0,
      connectedTowerId: null, color: USER_COLORS[idx % USER_COLORS.length],
      label: `UE${idx + 1}`, snr_db: 0, data_rate_mbps: 0, sector_name: '', local_beam_angle: 0,
    };
  }

  // ── Canvas mouse events ────────────────────────────────────────

  onCanvasMouseDown(ev: MouseEvent): void {
    const { offsetX: x, offsetY: y } = ev;
    const hitTower = this.towers.find(t => Math.hypot(t.x - x, t.y - y) < 18);
    if (hitTower && !this.placingMode) {
      this.draggingTowerId = hitTower.id;
      this.dragOffsetX = x - hitTower.x; this.dragOffsetY = y - hitTower.y;
      this.selectedTowerId = hitTower.id; this.selectedUserId = null;
      this.redrawPolar(); this.cdr.markForCheck(); return;
    }
    const hitUser = this.users.find(u => Math.hypot(u.x - x, u.y - y) < 12);
    if (hitUser) { this.selectedUserId = hitUser.id; this.selectedTowerId = null; this.cdr.markForCheck(); }
  }

  onCanvasMouseMove(ev: MouseEvent): void {
    if (!this.draggingTowerId) return;
    const tower = this.towers.find(t => t.id === this.draggingTowerId); if (!tower) return;
    tower.x = ev.offsetX - this.dragOffsetX;
    tower.y = ev.offsetY - this.dragOffsetY;
    this.framesSinceSync++;
    if (this.framesSinceSync >= this.SYNC_EVERY_N_FRAMES) {
      this.framesSinceSync = 0; this.towersInitialized = false; this.syncTowersToBackend();
    } else { this.updateConnectionsLocal(); }
  }

  onCanvasMouseUp(_ev: MouseEvent): void {
    if (!this.draggingTowerId) return;
    this.towersInitialized = false; this.syncTowersToBackend();
    this.draggingTowerId = null; this.cdr.markForCheck();
  }

  onCanvasMouseLeave(_ev: MouseEvent): void {
    if (!this.draggingTowerId) return;
    this.towersInitialized = false; this.syncTowersToBackend();
    this.draggingTowerId = null; this.cdr.markForCheck();
  }

  onCanvasClick(ev: MouseEvent): void {
    if (!this.placingMode) return;
    const { offsetX: x, offsetY: y } = ev;
    if (this.placingMode === 'tower') {
      this.towers = [...this.towers, this.makeTower(x, y, this.towers.length)];
      this.towersInitialized = false; this.syncTowersToBackend();
    } else {
      this.users = [...this.users, this.makeUser(x, y, this.users.length)];
      this.syncUsersToBackend();
    }
    this.placingMode = null; this.cdr.markForCheck();
  }

  get canvasCursor(): string {
    if (this.placingMode) return 'crosshair';
    if (this.draggingTowerId) return 'grabbing';
    return 'default';
  }

  // ── Coverage slider ────────────────────────────────────────────

  get selectedTowerRange(): number { return this.selectedTower?.range ?? 180; }
  set selectedTowerRange(val: number) {
    if (!this.selectedTower) return;
    this.selectedTower.range = +val;
    this.towersInitialized = false; this.syncTowersToBackend(); this.cdr.markForCheck();
  }

  // ── Apodization & SNR controls ─────────────────────────────────

  onApodizationChange(tower: Tower): void { this.pushTowerConfig(tower); }
  onSnrChange(tower: Tower): void { this.pushTowerConfig(tower); }

  private pushTowerConfig(tower: Tower): void {
    this.service.updateTowerConfig({
      tower_id: tower.id,
      apodization: tower.apodization,
      snr: tower.snr,
    }).subscribe({
      next: (res: TowerBeamsResponse) => {
        tower.beamData = res;
        // Sync array config display from backend response
        const alphaSector = res.sectors.find(s => s.name === 'Alpha');
        if (alphaSector) {
          tower.array.apodizationWindow = alphaSector.array_config.apodization as any;
          tower.array.snr = alphaSector.array_config.snr_db;
        }
        // FIX: re-sync users so the backend recomputes beam patterns with the
        // new apodization / SNR before we redraw the polar plot.
        if (this.towersInitialized && this.users.length > 0) {
          this.syncUsersToBackend();   // will call fetchBeamDataForTowers → redrawPolar
        } else {
          this.redrawPolar();
        }
        this.cdr.markForCheck();
      },
      error: err => {
        console.warn('Tower config update failed:', err);
        // Fallback: redraw with whatever data we already have (local computation)
        this.redrawPolar();
      },
    });
  }

  // ── Backend sync ───────────────────────────────────────────────

  private syncTowersToBackend(): void {
    const payload: Tower5GRequest[] = this.towers.map(t => ({
      tower_id: t.id, x_m: t.x / PX_PER_METER, y_m: t.y / PX_PER_METER,
      num_elements: t.array.numElements, element_spacing_mm: t.array.elementSpacing,
      max_coverage_radius_m: t.range / PX_PER_METER,
    }));
    this.service.initTowers(payload).subscribe({
      next: () => { this.towersInitialized = true; this.syncUsersToBackend(); },
      error: err => { console.warn('Tower init failed:', err); this.updateConnectionsLocal(); },
    });
  }

  private syncUsersToBackend(): void {
    if (!this.towersInitialized || !this.users.length) return;
    const payload: User5GRequest[] = this.users.map(u => ({
      user_id: u.id, x_m: u.x / PX_PER_METER, y_m: u.y / PX_PER_METER, allocated_frequency_mhz: 3500,
    }));
    this.service.updateUsers(payload).subscribe({
      next: r => this.applyNetworkResult(r),
      error: err => { console.warn('User sync failed:', err); this.updateConnectionsLocal(); },
    });
  }

  private applyNetworkResult(result: NetworkStateResult): void {
    this.users.forEach(u => { u.connectedTowerId = null; u.snr_db = 0; u.data_rate_mbps = 0; u.sector_name = ''; u.local_beam_angle = 0; });
    result.active_connections.forEach((link: LinkQuality) => {
      const user = this.users.find(u => u.id === link.user_id); if (!user) return;
      user.connectedTowerId = link.tower_id; user.snr_db = link.snr_db;
      user.data_rate_mbps = link.data_rate_mbps; user.sector_name = link.sector_name;
      user.local_beam_angle = link.local_beam_angle_deg;
    });

    // Update sectorAngles per tower
    const tsa = new Map<string, Map<string, number[]>>();
    result.active_connections.forEach((link: LinkQuality) => {
      if (!tsa.has(link.tower_id)) tsa.set(link.tower_id, new Map());
      const sm = tsa.get(link.tower_id)!;
      if (!sm.has(link.sector_name)) sm.set(link.sector_name, []);
      sm.get(link.sector_name)!.push(link.local_beam_angle_deg);
    });
    tsa.forEach((sectorMap, towerId) => {
      const tower = this.towers.find(t => t.id === towerId); if (!tower) return;
      sectorMap.forEach((angles, sn) => {
        tower.sectorAngles[sn] = angles.reduce((a, b) => a + b, 0) / angles.length;
      });
    });

    this.fetchBeamDataForTowers();
    this.cdr.markForCheck();
  }

  /** Fetches polar beam data from backend for all towers. */
  private fetchBeamDataForTowers(): void {
    this.towers.forEach(tower => {
      this.service.getTowerBeams(tower.id).subscribe({
        next: (res: TowerBeamsResponse) => {
          tower.beamData = res;
          res.sectors.forEach(s => { tower.sectorAngles[s.name] = s.steering_angle_deg; });
          if (tower.id === this.selectedTowerId) this.redrawPolar();
          this.cdr.markForCheck();
        },
        error: err => {
          console.warn('getTowerBeams failed, using local computation:', err);
          if (tower.id === this.selectedTowerId) this.redrawPolar();
        },
      });
    });
  }

  // ── Polar beam pattern ─────────────────────────────────────────

  redrawPolar(): void {
    setTimeout(() => {
      const canvas = this.polarCanvasRef?.nativeElement; if (!canvas) return;
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      const SIZE = canvas.width = canvas.height = 240;
      ctx.clearRect(0, 0, SIZE, SIZE);
      const cx = SIZE / 2, cy = SIZE / 2, R = SIZE / 2 - 22;
      const tower = this.selectedTower;

      // Grid
      ctx.strokeStyle = 'rgba(180,180,180,0.35)'; ctx.lineWidth = 0.5;
      [0.25, 0.5, 0.75, 1].forEach(f => { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); });
      for (let deg = 0; deg < 360; deg += 30) { const r = (deg * Math.PI) / 180; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.cos(r), cy + R * Math.sin(r)); ctx.stroke(); }
      ctx.fillStyle = '#999'; ctx.font = '7px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
      ['-10', '-20', '-30'].forEach((l, i) => ctx.fillText(`${l}dB`, cx + 4, cy - R * (0.75 - i * 0.25) - 2));
      [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([l, d]) => { const r = ((+d - 90) * Math.PI) / 180; ctx.fillText(String(l), cx + (R + 12) * Math.cos(r), cy + (R + 12) * Math.sin(r) + 3); });

      if (!tower) {
        ctx.fillStyle = '#aaa'; ctx.font = '11px IBM Plex Mono,monospace'; ctx.fillText('Select a tower', cx, cy); return;
      }

      // Draw each sector
      this.sectorNames.forEach(sn => {
        const bo = SECTOR_BORESIGHTS[sn] ?? 0;
        const col = SECTOR_COLORS[sn];
        const ia = sn === this.activeSectorTab;
        const steerDeg = tower.sectorAngles[sn] ?? 0;

        const backendSector = tower.beamData?.sectors.find(s => s.name === sn);

        // FIX: only use backend data if the pattern actually has signal
        // (max > -80 dB means it's not a flat noise floor returned by the old empty-users path)
        const hasValidBackendPattern = backendSector != null &&
          Math.max(...backendSector.beam_pattern_db) > -80;

        const pattern = hasValidBackendPattern
          ? this._backendPatternToNorm(
            backendSector!.scan_angles_deg,
            backendSector!.beam_pattern_db,
            bo,
            steerDeg,
          )
          : this._computePolarPatternLocal(tower.array.numElements, tower.array.elementSpacing, steerDeg, bo);

        ctx.beginPath(); ctx.strokeStyle = col + (ia ? 'ff' : '55'); ctx.lineWidth = ia ? 2 : 1;
        pattern.forEach(([angleDeg, ampNorm], i) => {
          const r = R * Math.max(0, ampNorm), rd = ((angleDeg - 90) * Math.PI) / 180;
          i === 0 ? ctx.moveTo(cx + r * Math.cos(rd), cy + r * Math.sin(rd))
            : ctx.lineTo(cx + r * Math.cos(rd), cy + r * Math.sin(rd));
        });
        ctx.closePath();
        if (ia) { ctx.fillStyle = col + '1e'; ctx.fill(); }
        ctx.stroke();

        // Steering arrow
        const ar = ((steerDeg + bo - 90) * Math.PI) / 180;
        ctx.beginPath(); ctx.strokeStyle = col + (ia ? 'dd' : '66'); ctx.lineWidth = ia ? 1.5 : 0.8; ctx.setLineDash([3, 3]);
        ctx.moveTo(cx, cy); ctx.lineTo(cx + R * 0.88 * Math.cos(ar), cy + R * 0.88 * Math.sin(ar)); ctx.stroke(); ctx.setLineDash([]);
      });

      // Legend
      this.sectorNames.forEach((n, i) => {
        ctx.fillStyle = SECTOR_COLORS[n]; ctx.font = '8px IBM Plex Mono,monospace'; ctx.textAlign = 'left';
        ctx.fillText(`${n}: θ=${(tower.sectorAngles[n] ?? 0).toFixed(1)}°`, 5, 11 + i * 12);
      });

      // Indicate data source
      ctx.fillStyle = '#bbb'; ctx.font = '7px IBM Plex Mono,monospace'; ctx.textAlign = 'right';
      ctx.fillText(tower.beamData ? '⬆ backend' : '⚙ local', SIZE - 4, SIZE - 4);
    });
  }

  /**
   * FIX: Convert backend dB pattern (–90…+90° relative to boresight) →
   * full 360° normalised [globalDeg, 0-1] array for the polar canvas.
   *
   * Previously the mapping ignored boresight & steering, so every sector
   * was drawn identically at 0–180°.  Now we rotate by (boresight + steering)
   * so each sector appears in its correct global direction.
   */
  private _backendPatternToNorm(
    scanDeg: number[],
    patternDb: number[],
    boresightDeg: number = 0,
    steeringDeg: number = 0,
  ): Array<[number, number]> {
    // Convert dB → linear and normalise to [0, 1]
    const linear = patternDb.map(db => Math.pow(10, db / 20));
    const maxVal = Math.max(...linear, 1e-10);
    const norm = linear.map(v => v / maxVal);

    // Global offset = sector boresight + current steering
    const globalOffset = boresightDeg + steeringDeg;

    const result: Array<[number, number]> = [];

    // Front hemisphere: scanDeg[i] is –90…+90 relative to sector face
    for (let i = 0; i < scanDeg.length; i++) {
      const globalDeg = ((scanDeg[i] + globalOffset) % 360 + 360) % 360;
      result.push([globalDeg, norm[i]]);
    }

    // Back hemisphere: mirror with strong attenuation (real back-lobe ≈ –20 dB)
    for (let i = 0; i < scanDeg.length; i++) {
      const backGlobalDeg = ((scanDeg[i] + globalOffset + 180) % 360 + 360) % 360;
      result.push([backGlobalDeg, norm[i] * 0.05]);
    }

    return result.sort((a, b) => a[0] - b[0]);
  }

  /** Local ULA computation fallback (no backend required) */
  private _computePolarPatternLocal(ne: number, sm: number, sd: number, bd: number): Array<[number, number]> {
    const lambda = 3e8 / 3.5e9, d = sm * 1e-3, sr = ((sd + bd) * Math.PI) / 180;
    const pts: Array<[number, number]> = []; let max = 0;
    for (let deg = 0; deg < 360; deg++) {
      const th = (deg * Math.PI) / 180; let re = 0, im = 0;
      for (let n = 0; n < ne; n++) {
        const pos = (n - (ne - 1) / 2) * d;
        const ph = (2 * Math.PI * pos / lambda) * (Math.sin(th) - Math.sin(sr));
        re += Math.cos(ph); im += Math.sin(ph);
      }
      const a = Math.sqrt(re * re + im * im); pts.push([deg, a]); if (a > max) max = a;
    }
    return pts.map(([deg, a]) => [deg, max > 0 ? a / max : 0]);
  }

  // ── Sector tab helpers ─────────────────────────────────────────

  selectSectorTab(name: string): void { this.activeSectorTab = name; this.redrawPolar(); this.cdr.markForCheck(); }

  get activeSectorData(): SectorBeamData | null {
    return this.selectedTower?.beamData?.sectors.find(s => s.name === this.activeSectorTab) ?? null;
  }

  get activeSectorParams(): { label: string; value: string; highlight?: boolean }[] {
    const tower = this.selectedTower; if (!tower) return [];
    const angle = tower.sectorAngles[this.activeSectorTab] ?? 0;
    const boresight = SECTOR_BORESIGHTS[this.activeSectorTab] ?? 0;
    const cfg = this.activeSectorData?.array_config;
    const ues = this.users.filter(u => u.connectedTowerId === tower.id && u.sector_name === this.activeSectorTab);
    return [
      { label: 'Sector', value: this.activeSectorTab },
      { label: 'Boresight', value: `${boresight}°` },
      { label: 'Steering Angle', value: `${angle.toFixed(2)}°`, highlight: true },
      { label: 'Global Pointing', value: `${(angle + boresight).toFixed(2)}°`, highlight: true },
      { label: 'Elements', value: `${cfg?.num_elements ?? tower.array.numElements}` },
      { label: 'Spacing', value: `${cfg?.element_spacing_mm ?? tower.array.elementSpacing} mm` },
      { label: 'Frequency', value: `${cfg?.frequency_mhz ?? 3500} MHz` },
      { label: 'Apodization', value: cfg?.apodization ?? tower.apodization },
      { label: 'SNR config', value: `${cfg?.snr_db ?? tower.snr} dB` },
      { label: 'Connected UEs', value: `${ues.length}` },
      { label: 'UE IDs', value: ues.map(u => u.label).join(', ') || '—' },
    ];
  }

  // ── Misc ───────────────────────────────────────────────────────

  get selectedTowerInterference(): ElementPosition[] {
    if (!this.selectedTower) return [];
    const t = this.selectedTower, n = t.array.elements.length, d = t.array.elementSpacing * 2;
    return t.array.elements.map((el, i) => ({ x: t.x + (i - (n - 1) / 2) * d, y: t.y, config: el }));
  }

  startPlacing(mode: 'tower' | 'user'): void { this.placingMode = mode; this.cdr.markForCheck(); }

  removeTower(id: string): void {
    this.towers = this.towers.filter(t => t.id !== id);
    if (this.selectedTowerId === id) this.selectedTowerId = null;
    this.towersInitialized = false; this.syncTowersToBackend(); this.cdr.markForCheck();
  }

  removeUser(id: string): void {
    this.users = this.users.filter(u => u.id !== id);
    if (this.selectedUserId === id) this.selectedUserId = null;
    this.syncUsersToBackend(); this.cdr.markForCheck();
  }

  @HostListener('window:keydown', ['$event']) onKeyDown(ev: KeyboardEvent) { this.keysHeld.add(ev.key); }
  @HostListener('window:keyup', ['$event']) onKeyUp(ev: KeyboardEvent) { this.keysHeld.delete(ev.key); }

  private moveSelectedUser(): void {
    if (!this.selectedUserId) return;
    const user = this.users.find(u => u.id === this.selectedUserId); if (!user) return;
    const spd = 2; let moved = false;
    if (this.keysHeld.has('ArrowLeft')) { user.x -= spd; moved = true; }
    if (this.keysHeld.has('ArrowRight')) { user.x += spd; moved = true; }
    if (this.keysHeld.has('ArrowUp')) { user.y -= spd; moved = true; }
    if (this.keysHeld.has('ArrowDown')) { user.y += spd; moved = true; }
    if (moved) {
      this.framesSinceSync++;
      if (this.framesSinceSync >= this.SYNC_EVERY_N_FRAMES) {
        this.framesSinceSync = 0; this.syncUsersToBackend();
      } else { this.updateConnectionsLocal(); }
    }
  }

  private updateConnectionsLocal(): void {
    this.users.forEach(user => {
      const inRange = this.towers
        .filter(t => Math.hypot(t.x - user.x, t.y - user.y) <= t.range)
        .sort((a, b) => Math.hypot(a.x - user.x, a.y - user.y) - Math.hypot(b.x - user.x, b.y - user.y));
      const cur = this.towers.find(t => t.id === user.connectedTowerId);
      if (!cur || !inRange.some(t => t.id === cur.id)) user.connectedTowerId = inRange[0]?.id ?? null;
    });
  }

  updateConnections(): void { if (this.towersInitialized) this.syncUsersToBackend(); else this.syncTowersToBackend(); }

  get selectedTower(): Tower | null { return this.towers.find(t => t.id === this.selectedTowerId) ?? null; }

  onTowerArrayChange(cfg: ArrayConfig): void {
    if (!this.selectedTower) return;
    this.selectedTower.array = cfg; this.towersInitialized = false; this.syncTowersToBackend(); this.cdr.markForCheck();
  }

  // ── Animation ─────────────────────────────────────────────────

  private startAnimation(): void {
    const loop = () => { this.t += 0.02; this.moveSelectedUser(); this.drawEnvironment(); this.animId = requestAnimationFrame(loop); };
    loop();
  }

  private drawEnvironment(): void {
    const canvas = this.envCanvasRef?.nativeElement; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const W = canvas.width = canvas.offsetWidth || 600, H = canvas.height = canvas.offsetHeight || 400;
    ctx.clearRect(0, 0, W, H); this.drawCityGrid(ctx, W, H);
    if (this.showCoverage) this.drawCoverage(ctx);
    this.drawBeams(ctx);
    if (this.showGlobalInterference) this.drawGlobalInterference(ctx, W, H);
    this.drawTowers(ctx); this.drawUsers(ctx);
  }

  private drawGlobalInterference(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const step = 8;
    this.towers.forEach(tower => {
      const n = tower.array.elements.length, d = tower.array.elementSpacing * 2;
      const elements = tower.array.elements.filter(el => el.enabled).map((el, i) => ({ x: tower.x + (i - (n - 1) / 2) * d, y: tower.y, config: el }));
      for (let px = 0; px < W; px += step) for (let py = 0; py < H; py += step) {
        let sr = 0, si = 0;
        for (const ep of elements) {
          const dx = px - ep.x, dy = py - ep.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
          const k = (2 * Math.PI * ep.config.frequency * 1e6) / 3e8;
          const pr = (ep.config.phaseShift * Math.PI) / 180;
          const dr = 2 * Math.PI * ep.config.frequency * 1e6 * ep.config.timeDelay * 1e-6;
          const amp = (ep.config.intensity / 100) / dist;
          const ph = k * dist - this.t * 3 - pr - dr;
          sr += amp * Math.cos(ph); si += amp * Math.sin(ph);
        }
        const intensity = Math.min(Math.sqrt(sr * sr + si * si) * 30, 1);
        if (intensity > 0.05) {
          const [r, g, b] = tower.color.match(/\w\w/g)!.map(h => parseInt(h, 16));
          ctx.fillStyle = `rgba(${r},${g},${b},${intensity * 0.5})`;
          ctx.fillRect(px, py, step, step);
        }
      }
    });
  }

  private drawCityGrid(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    ctx.fillStyle = '#f0f4f0'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(180,200,180,0.6)'; ctx.lineWidth = 0.5; const gs = 40;
    for (let x = 0; x < W; x += gs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += gs) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    [[1, 1], [3, 2], [5, 1], [2, 4], [6, 3], [4, 5], [7, 2], [1, 4]].forEach(([bx, by]) => {
      ctx.fillStyle = 'rgba(160,180,160,0.3)'; ctx.fillRect(bx * gs + 4, by * gs + 4, gs - 8, gs - 8);
    });
  }

  private drawCoverage(ctx: CanvasRenderingContext2D): void {
    this.towers.forEach(tower => {
      const grad = ctx.createRadialGradient(tower.x, tower.y, 5, tower.x, tower.y, tower.range);
      grad.addColorStop(0, tower.color + '33'); grad.addColorStop(1, tower.color + '08');
      ctx.beginPath(); ctx.arc(tower.x, tower.y, tower.range, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill();
      ctx.strokeStyle = tower.color + '55'; ctx.lineWidth = 1; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
    });
  }

  private drawBeams(ctx: CanvasRenderingContext2D): void {
    this.towers.forEach(tower => {
      this.users.filter(u => u.connectedTowerId === tower.id).forEach(user => {
        const dx = user.x - tower.x, dy = user.y - tower.y, dist = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx), halfW = Math.PI / Math.max(tower.array.numElements, 2) * 0.8;
        const snrA = user.snr_db > 0 ? Math.min(0.85, 0.3 + (user.snr_db / 60) * 0.55) : 0.4;
        const grad = ctx.createRadialGradient(tower.x, tower.y, 0, tower.x, tower.y, dist);
        grad.addColorStop(0, user.color + Math.round(snrA * 255).toString(16).padStart(2, '0'));
        grad.addColorStop(1, user.color + '11');
        ctx.beginPath(); ctx.moveTo(tower.x, tower.y); ctx.arc(tower.x, tower.y, dist, angle - halfW, angle + halfW);
        ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
        const dashOffset = (this.t * 20) % 20;
        ctx.beginPath(); ctx.strokeStyle = user.color + 'cc'; ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]); ctx.lineDashOffset = -dashOffset;
        ctx.moveTo(tower.x, tower.y); ctx.lineTo(user.x, user.y); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
        for (let ring = 0; ring < 3; ring++) {
          const r = ((this.t * 40 + ring * 30) % dist);
          const rx = tower.x + (dx / dist) * r, ry = tower.y + (dy / dist) * r;
          const alpha = 0.4 * (1 - r / dist);
          ctx.beginPath(); ctx.arc(rx, ry, 5, 0, Math.PI * 2);
          ctx.strokeStyle = user.color + Math.round(alpha * 255).toString(16).padStart(2, '0');
          ctx.lineWidth = 1; ctx.stroke();
        }
      });
    });
  }

  private drawTowers(ctx: CanvasRenderingContext2D): void {
    this.towers.forEach(tower => {
      const isSel = tower.id === this.selectedTowerId, isDrag = tower.id === this.draggingTowerId;
      const pulse = isSel ? 1 + 0.15 * Math.sin(this.t * 6) : 1;
      if (isDrag) { ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 12; }
      ctx.beginPath(); ctx.arc(tower.x, tower.y, 14 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = tower.color + '22'; ctx.fill();
      ctx.strokeStyle = tower.color; ctx.lineWidth = isSel || isDrag ? 2.5 : 1.5; ctx.stroke();
      ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
      ctx.beginPath(); ctx.strokeStyle = tower.color; ctx.lineWidth = 2;
      ctx.moveTo(tower.x, tower.y - 10); ctx.lineTo(tower.x, tower.y + 8);
      ctx.moveTo(tower.x - 7, tower.y - 4); ctx.lineTo(tower.x + 7, tower.y - 4);
      ctx.moveTo(tower.x - 5, tower.y - 8); ctx.lineTo(tower.x + 5, tower.y - 8); ctx.stroke();
      ctx.fillStyle = tower.color; ctx.font = 'bold 9px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
      ctx.fillText(`BS${this.towers.indexOf(tower) + 1}`, tower.x, tower.y + 22);
      const ueCount = this.users.filter(u => u.connectedTowerId === tower.id).length;
      if (ueCount > 0) { ctx.fillStyle = 'rgba(52,168,83,0.9)'; ctx.font = '8px IBM Plex Mono,monospace'; ctx.fillText(`${ueCount}UE`, tower.x, tower.y + 31); }
      this.sectorNames.forEach(name => {
        const bo = SECTOR_BORESIGHTS[name] ?? 0, st = tower.sectorAngles[name] ?? 0;
        const rad = ((bo + st - 90) * Math.PI) / 180;
        ctx.beginPath(); ctx.strokeStyle = SECTOR_COLORS[name] + (isSel ? 'dd' : '77');
        ctx.lineWidth = isSel ? 2 : 1;
        ctx.moveTo(tower.x, tower.y); ctx.lineTo(tower.x + 26 * Math.cos(rad), tower.y + 26 * Math.sin(rad)); ctx.stroke();
      });
      if (isSel) {
        let yOff = tower.y + 44;
        this.sectorNames.forEach(name => {
          ctx.fillStyle = SECTOR_COLORS[name]; ctx.font = '7px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
          ctx.fillText(`${name} θ=${(tower.sectorAngles[name] ?? 0).toFixed(1)}°`, tower.x, yOff); yOff += 10;
        });
      }
    });
  }

  private drawUsers(ctx: CanvasRenderingContext2D): void {
    this.users.forEach(user => {
      const isSel = user.id === this.selectedUserId, pulse = isSel ? 1 + 0.2 * Math.sin(this.t * 8) : 1;
      ctx.beginPath(); ctx.arc(user.x, user.y, 7 * pulse, 0, Math.PI * 2); ctx.fillStyle = user.color; ctx.fill();
      if (isSel) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.strokeStyle = user.color + '66'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(user.x, user.y, 14 * pulse, 0, Math.PI * 2); ctx.stroke();
      }
      if (user.connectedTowerId) { ctx.fillStyle = '#34a853'; ctx.beginPath(); ctx.arc(user.x + 6, user.y - 6, 3, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = user.color; ctx.font = 'bold 9px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
      ctx.fillText(user.label, user.x, user.y + 18);
      if (user.data_rate_mbps > 0) {
        ctx.fillStyle = '#333'; ctx.font = '7px IBM Plex Mono,monospace';
        ctx.fillText(`${user.data_rate_mbps.toFixed(0)} Mbps`, user.x, user.y + 28);
        ctx.fillText(`SNR ${user.snr_db.toFixed(1)} dB`, user.x, user.y + 37);
        if (user.sector_name) { ctx.fillStyle = SECTOR_COLORS[user.sector_name] ?? user.color; ctx.fillText(user.sector_name, user.x, user.y + 46); }
      }
    });
  }
}
