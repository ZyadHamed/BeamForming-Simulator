import {
  Component,
  NgZone,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  AfterViewInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { BeamformingService } from '../../../services/beamforming.service';


interface DetectionData {
  snr_db: number;
  doppler_m_s: number;
  estimated_rcs: number;
  range_m: number;
  angle_deg: number;
}

interface RadarTarget {
  id: string;
  angle: number; // bearing degrees, 0 = North, clockwise
  range: number; // normalised 0–1 relative to maxRangeKm
  rcs: number; // m² — controls both visual size and radar cross-section
  label: string;
  lastDetection: DetectionData | null;
  trdLastDetection: DetectionData | null;
}

@Component({
  selector: 'app-mode-radar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mode-radar.component.html',
  styleUrls: ['./mode-radar.component.css'],
})
export class ModeRadarComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('bfCanvas', { static: true }) bfCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('trdCanvas', { static: true }) trdCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('patternCanvas', { static: true }) patternCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('envCanvas', { static: true }) envCanvasRef!: ElementRef<HTMLCanvasElement>;

  // ── Public state ─────────────────────────────────────────────────────────
  targets: RadarTarget[] = [];

  bfScanSpeedDegPerFrame: number = 1.2; // PA electronic steering speed
  readonly TRD_ROT_DEG_PER_FRAME = 0.5; // traditional — fixed mechanical rate

  scanRange: number = 1;
  sweepMode: 'sector' | 'full' = 'full';
  sectorMin: number = -60;
  sectorMax: number = 60;
  numElements: number = 12;
  elementSpacing: number = 15.0;
  steeringAngle: number = 0.0;
  apodization: string = 'hanning';
  snr: number = 60.0;
  frequencyGhz: number = 9.5;
  readonly apodizationOptions = ['none', 'hanning', 'hamming', 'blackman'];

  txPower: number = 70.0;
  prfHz: number = 1000.0;
  pulseWidthUs: number = 1.0;
  radarInfo: any = null;

  interferenceImage: string | null = null;
  interferenceSize: { cols: number; rows: number } | null = null;

  // ── Private state ─────────────────────────────────────────────────────────
  private animId: number = 0;
  private radarReady: boolean = false;
  private beamPattern: number[] = [];
  private anglesDeg: number[] = [];

  private bfScanAngle: number = 0;
  private bfScanDir: number = 1;

  private trdAngle: number = 0;

  readonly maxRangeKm = 100;

  private bfPaint!: HTMLCanvasElement;
  private bfPaintCtx!: CanvasRenderingContext2D;
  private trdPaint!: HTMLCanvasElement;
  private trdPaintCtx!: CanvasRenderingContext2D;

  // Track whether we are in the first scan cycle (suppress clear until full
  // rotation is complete to avoid blank canvas on startup).
  private trdFullRotDeg: number = 0;
  private bfFullRotDeg: number = 0;

  // ── Environment canvas drag / resize state ────────────────────────────────
  private envDragTarget: RadarTarget | null = null;
  private envResizeTarget: RadarTarget | null = null;
  private envResizeStartX: number = 0;
  private envResizeStartRcs: number = 0;

  // ── Computed properties ───────────────────────────────────────────────────
  get physicalBeamWidthDeg(): number {
    if (this.radarInfo?.hpbw_deg) return this.radarInfo.hpbw_deg;
    const lambda = (300_000.0 * 1e6) / (this.frequencyGhz * 1e9) / 1000.0;
    const N = Math.max(this.numElements, 1);
    const d = this.elementSpacing / 1000;
    const aperture = Math.max((N - 1) * d, d);
    return Math.min(90, Math.max(1, (((0.886 * lambda) / aperture) * 180) / Math.PI));
  }

  get rangeResolutionM(): number {
    return this.radarInfo?.range_resolution_m ?? 150 * this.pulseWidthUs;
  }

  get maxUnambRangeKm(): number {
    return this.radarInfo?.max_unambiguous_range_m != null
      ? this.radarInfo.max_unambiguous_range_m / 1000
      : 300_000.0 / (2 * this.prfHz) / 1e6;
  }

  get sideLobeLevel(): number {
    return this.radarInfo?.side_lobe_level ?? -13.5;
  }
  get arrayGainDb(): number {
    return this.radarInfo?.array_gain_db ?? 0;
  }
  get wavelengthM(): number {
    return this.radarInfo?.wavelength_m ?? 0;
  }
  get hpbwDeg(): number {
    return this.radarInfo?.hpbw_deg ?? this.physicalBeamWidthDeg;
  }

  isDetected(tgt: RadarTarget): boolean {
    return tgt.lastDetection !== null;
  }
  isTrdDetected(tgt: RadarTarget): boolean {
    return tgt.trdLastDetection !== null;
  }

  get liveDetectedCount(): number {
    return this.targets.filter((t) => this.isDetected(t)).length;
  }
  get trdLiveDetectedCount(): number {
    return this.targets.filter((t) => this.isTrdDetected(t)).length;
  }

  constructor(
    private beamSvc: BeamformingService,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.targets = [
      {
        id: 't1',
        angle: 35,
        range: 0.55,
        rcs: 5,
        label: 'TGT-A',
        lastDetection: null,
        trdLastDetection: null,
      },
      {
        id: 't2',
        angle: 120,
        range: 0.7,
        rcs: 3,
        label: 'TGT-B',
        lastDetection: null,
        trdLastDetection: null,
      },
      {
        id: 't3',
        angle: 220,
        range: 0.4,
        rcs: 8,
        label: 'TGT-C',
        lastDetection: null,
        trdLastDetection: null,
      },
    ];

    this.beamSvc.setupRadar(this.buildRadarSetupRequest()).subscribe({
      next: (res: any) => {
        this.radarReady = true;
        this.radarInfo = res;
        this.beamPattern = res.beam_pattern ?? [];
        this.interferenceImage = res.interference_image ?? null;
        this.interferenceSize = res.interference_cols
          ? { cols: res.interference_cols, rows: res.interference_rows }
          : null;
        this.anglesDeg = res.angles_deg ?? [];
        setTimeout(() => this.drawPatternCanvas(), 0);
        this.cdr.markForCheck();
      },
      error: (e) => console.warn('Radar setup failed:', e),
    });

    this.beamSvc.openScanSockets();

    this.beamSvc.bfScanResults$.subscribe((res) => {
      if (res?.sweep_data) this.paintBfCanvas(res.sweep_data);
      if (res?.detections?.length) {
        this.targets.forEach((tgt) => {
          const d = res.detections.find((x: any) => x.target_id === tgt.id);
          if (d) tgt.lastDetection = {
            snr_db: d.snr_db, doppler_m_s: d.doppler_m_s,
            estimated_rcs: d.estimated_rcs, range_m: d.range_m, angle_deg: d.angle_deg,
          };
        });
        this.zone.run(() => this.cdr.markForCheck());
      }
      
      if (res.interference_image) {
        this.interferenceImage = res.interference_image;
        this.interferenceSize  = res.interference_cols
          ? { cols: res.interference_cols, rows: res.interference_rows ?? 0 }
          : this.interferenceSize;
        this.cdr.markForCheck();
      }
      
      if (res.beam_pattern) {
        this.beamPattern = res.beam_pattern;
        this.anglesDeg   = res.angles_deg ?? this.anglesDeg;
        if (res.beam_angle != null || res.main_lobe_width != null || res.side_lobe_level != null) {
          this.radarInfo = {
            ...this.radarInfo,
            beam_angle     : res.beam_angle      ?? this.radarInfo?.beam_angle,
            main_lobe_width: res.main_lobe_width ?? this.radarInfo?.main_lobe_width,
            side_lobe_level: res.side_lobe_level ?? this.radarInfo?.side_lobe_level,
          };
        }
        this.drawPatternCanvas();
      }
    });

    this.beamSvc.trdScanResults$.subscribe((res) => {
      if (res?.sweep_data) this.paintTrdCanvas(res.sweep_data);
      if (res?.detections?.length) {
        this.targets.forEach((tgt) => {
          const d = res.detections.find((x: any) => x.target_id === tgt.id);
          if (d) tgt.trdLastDetection = {
            snr_db: d.snr_db, doppler_m_s: d.doppler_m_s,
            estimated_rcs: d.estimated_rcs, range_m: d.range_m, angle_deg: d.angle_deg,
          };
        });
        this.zone.run(() => this.cdr.markForCheck());
      }
    });
  }

  ngAfterViewInit(): void {
    const mkOffscreen = (ref: ElementRef<HTMLCanvasElement>) => {
      const c = document.createElement('canvas');
      const el = ref.nativeElement;
      c.width = el.offsetWidth || 360;
      c.height = el.offsetHeight || 360;
      return c;
    };

    this.bfPaint = mkOffscreen(this.bfCanvasRef);
    this.bfPaintCtx = this.bfPaint.getContext('2d')!;

    this.trdPaint = mkOffscreen(this.trdCanvasRef);
    this.trdPaintCtx = this.trdPaint.getContext('2d')!;

    this.initEnvCanvas();
    this.startAnimation();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animId);
    this.beamSvc.closeScanSockets();
  }

  trackById(_: number, tgt: RadarTarget): string {
    return tgt.id;
  }

  onHardwareChange(): void {
    this.beamSvc.setupRadar(this.buildRadarSetupRequest()).subscribe({
      next: (res: any) => {
        this.radarReady = true;
        this.radarInfo = res;
        this.beamPattern = res.beam_pattern ?? [];
        this.interferenceImage = res.interference_image ?? null;
        this.interferenceSize = res.interference_cols
          ? { cols: res.interference_cols, rows: res.interference_rows }
          : null;
        this.anglesDeg = res.angles_deg ?? [];
        setTimeout(() => this.drawPatternCanvas(), 0);

        if (this.bfPaintCtx)
          this.bfPaintCtx.clearRect(0, 0, this.bfPaint.width, this.bfPaint.height);
        this.cdr.markForCheck();
      },
      error: (e) => console.warn('Radar re-setup failed:', e),
    });
  }

  addTarget(): void {
    const idx = this.targets.length;
    this.targets.push({
      id: `t${Date.now()}`,
      angle: Math.random() * 360,
      range: 0.3 + Math.random() * 0.6,
      rcs: 5,
      label: `TGT-${String.fromCharCode(65 + (idx % 26))}`,
      lastDetection: null,
      trdLastDetection: null,
    });
    this.cdr.markForCheck();
  }

  removeTarget(id: string): void {
    this.targets = this.targets.filter((t) => t.id !== id);
    this.cdr.markForCheck();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  private buildRadarSetupRequest(): any {
    return {
      num_elements: this.numElements,
      element_spacing: this.elementSpacing,
      frequency_mhz: this.frequencyGhz * 1000,
      geometry: 'linear',
      curvature_radius: 0.0,
      steering_angle: this.bfScanAngle,
      focus_depth: 0.0,
      snr: this.snr,
      apodization: this.apodization,
      noise_floor_dbm: -100.0,
      clutter_floor_dbm: -200.0,
      clutter_range_exp: -20.0,
      cfar_guard_cells: 2,
      cfar_ref_cells: 8,
      cfar_pfa: 1e-4,
      pt_dbm: this.txPower,
      prf_hz: this.prfHz,
      pulse_width_us: this.pulseWidthUs,
      wave_speed: 300_000.0,
    };
  }

  private toTargetDTO(t: RadarTarget): any {
    const range_m = t.range * this.maxRangeKm * 1000;
    const angle_rad = (t.angle * Math.PI) / 180;
    return {
      target_id: t.id,
      x_m: range_m * Math.sin(angle_rad),
      y_m: range_m * Math.cos(angle_rad),
      velocity_m_s: 0,
      rcs_sqm: t.rcs, // directly drives radar return strength
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENVIRONMENT CANVAS
  // ─────────────────────────────────────────────────────────────────────────

  private initEnvCanvas(): void {
    const canvas = this.envCanvasRef?.nativeElement;
    if (!canvas) return;

    canvas.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      const { cx, cy, R } = this.envCanvasMetrics(canvas);
      const mx = e.offsetX,
        my = e.offsetY;

      if (e.button === 2) {
        // Right-click: remove nearest target within 20 px
        let nearest: RadarTarget | null = null;
        let nearDist = 20;
        this.targets.forEach((tgt) => {
          const [tx, ty] = this.targetCanvasXY(tgt, cx, cy, R);
          const d = Math.hypot(tx - mx, ty - my);
          if (d < nearDist) {
            nearDist = d;
            nearest = tgt;
          }
        });
        if (nearest) this.zone.run(() => this.removeTarget((nearest as RadarTarget).id));
        return;
      }

      if (e.button === 1) {
        // Middle-click: start resize (RCS) on nearest target
        let hit: RadarTarget | null = null;
        let hitDist = 24;
        this.targets.forEach((tgt) => {
          const [tx, ty] = this.targetCanvasXY(tgt, cx, cy, R);
          const d = Math.hypot(tx - mx, ty - my);
          if (d < hitDist) {
            hitDist = d;
            hit = tgt;
          }
        });
        if (hit) {
          this.envResizeTarget = hit;
          this.envResizeStartX = mx;
          this.envResizeStartRcs = (hit as RadarTarget).rcs;
        }
        return;
      }

      // Left-click: drag existing target, or add new one
      let hit: RadarTarget | null = null;
      let hitDist = 20;
      this.targets.forEach((tgt) => {
        const visualRadius = this.targetVisualRadius(tgt);
        const [tx, ty] = this.targetCanvasXY(tgt, cx, cy, R);
        const d = Math.hypot(tx - mx, ty - my);
        if (d < Math.max(hitDist, visualRadius + 4)) {
          hitDist = d;
          hit = tgt;
        }
      });

      if (hit) {
        this.envDragTarget = hit;
      } else {
        // Click on empty space → add new target at that position
        const dx = mx - cx,
          dy = my - cy;
        const r = Math.min(Math.hypot(dx, dy) / R, 1.0);
        const angleDeg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
        this.zone.run(() => {
          const idx = this.targets.length;
          this.targets.push({
            id: `t${Date.now()}`,
            angle: angleDeg,
            range: r,
            rcs: 5,
            label: `TGT-${String.fromCharCode(65 + (idx % 26))}`,
            lastDetection: null,
            trdLastDetection: null,
          });
          this.cdr.markForCheck();
        });
      }
    });

    canvas.addEventListener('mousemove', (e: MouseEvent) => {
      const { cx, cy, R } = this.envCanvasMetrics(canvas);

      if (this.envDragTarget) {
        const dx = e.offsetX - cx,
          dy = e.offsetY - cy;
        this.envDragTarget.range = Math.min(Math.hypot(dx, dy) / R, 1.0);
        this.envDragTarget.angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
        return;
      }

      if (this.envResizeTarget) {
        const delta = e.offsetX - this.envResizeStartX;
        const newRcs = Math.max(0.5, Math.min(100, this.envResizeStartRcs + delta * 0.3));
        this.envResizeTarget.rcs = Math.round(newRcs * 10) / 10;
      }
    });

    canvas.addEventListener('mouseup', () => {
      this.envDragTarget = null;
      this.envResizeTarget = null;
    });
    canvas.addEventListener('mouseleave', () => {
      this.envDragTarget = null;
      this.envResizeTarget = null;
    });
    canvas.addEventListener('contextmenu', (e: Event) => e.preventDefault());
  }

  private envCanvasMetrics(canvas: HTMLCanvasElement): { cx: number; cy: number; R: number } {
    const W = canvas.width || canvas.offsetWidth;
    const H = canvas.height || canvas.offsetHeight;
    return { cx: W / 2, cy: H / 2, R: Math.min(W, H) / 2 - 20 };
  }

  private targetCanvasXY(tgt: RadarTarget, cx: number, cy: number, R: number): [number, number] {
    const rad = ((tgt.angle - 90) * Math.PI) / 180;
    const dist = Math.min(tgt.range, 1.0) * R;
    return [cx + dist * Math.cos(rad), cy + dist * Math.sin(rad)];
  }

  private targetVisualRadius(tgt: RadarTarget): number {
    // radius = 4..18 px over rcs = 0.5..100 m²
    return 4 + Math.sqrt(Math.max(tgt.rcs, 0.5)) * 1.4;
  }

  private drawEnvCanvas(): void {
    const canvas = this.envCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 400);
    const H = (canvas.height = canvas.offsetHeight || 200);
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 20;

    // ── Background ──────────────────────────────────────────────────────────
    ctx.fillStyle = '#050a0f';
    ctx.fillRect(0, 0, W, H);

    // ── Cartesian Grid ──────────────────────────────────────────────────────
    // Spec: "Draw a clear Cartesian grid on the environment canvas."
    // Grid lines every 25 % of R in both X and Y from centre.
    ctx.save();
    ctx.strokeStyle = 'rgba(232,168,43,0.10)';
    ctx.lineWidth = 0.5;
    const gridStep = R / 4;
    for (let gx = cx - R; gx <= cx + R + 1; gx += gridStep) {
      ctx.beginPath();
      ctx.moveTo(gx, cy - R);
      ctx.lineTo(gx, cy + R);
      ctx.stroke();
    }
    for (let gy = cy - R; gy <= cy + R + 1; gy += gridStep) {
      ctx.beginPath();
      ctx.moveTo(cx - R, gy);
      ctx.lineTo(cx + R, gy);
      ctx.stroke();
    }

    // Axis cross (brighter)
    ctx.strokeStyle = 'rgba(232,168,43,0.30)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.stroke();

    // Range rings
    [0.25, 0.5, 0.75, 1.0].forEach((frac) => {
      const r = R * frac;
      const km = (frac * this.maxRangeKm * this.scanRange).toFixed(0);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(232,168,43,0.14)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.fillStyle = 'rgba(232,168,43,0.35)';
      ctx.font = '7px IBM Plex Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${km}km`, cx + r + 2, cy - 2);
    });

    // Cardinal labels
    const cardinals = [
      ['N', 0, -1],
      ['E', 1, 0],
      ['S', 0, 1],
      ['W', -1, 0],
    ] as const;
    ctx.fillStyle = 'rgba(232,168,43,0.5)';
    ctx.font = 'bold 8px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    cardinals.forEach(([lbl, dx, dy]) => {
      ctx.fillText(lbl, cx + dx * (R + 12), cy + dy * (R + 12) + 3);
    });
    ctx.restore();

    // ── Targets ─────────────────────────────────────────────────────────────
    this.targets.forEach((tgt) => {
      const [tx, ty] = this.targetCanvasXY(tgt, cx, cy, R);
      const isDragging = this.envDragTarget === tgt;
      const isResizing = this.envResizeTarget === tgt;
      const isDetected = this.isDetected(tgt) || this.isTrdDetected(tgt);
      const visR = this.targetVisualRadius(tgt);

      const baseColor = isDetected
        ? 'rgba(52,168,83'
        : isDragging
          ? 'rgba(255,200,50'
          : isResizing
            ? 'rgba(100,200,255'
            : 'rgba(232,168,43';

      // ── Body (size encodes RCS) ────────────────────────────────────────
      const grd = ctx.createRadialGradient(tx, ty, 0, tx, ty, visR);
      grd.addColorStop(0, `${baseColor},0.55)`);
      grd.addColorStop(0.6, `${baseColor},0.25)`);
      grd.addColorStop(1, `${baseColor},0.0)`);
      ctx.beginPath();
      ctx.arc(tx, ty, visR, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();

      // Outline
      ctx.beginPath();
      ctx.arc(tx, ty, visR, 0, Math.PI * 2);
      ctx.strokeStyle = `${baseColor},${isDragging || isResizing ? '1' : '0.85'})`;
      ctx.lineWidth = isDragging || isResizing ? 2 : 1.5;
      ctx.stroke();

      // Core dot
      ctx.beginPath();
      ctx.arc(tx, ty, 3, 0, Math.PI * 2);
      ctx.fillStyle = `${baseColor},1)`;
      ctx.fill();

      // Label
      ctx.fillStyle = `${baseColor},1)`;
      ctx.font = 'bold 9px IBM Plex Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(tgt.label, tx + visR + 3, ty - 3);

      // Metadata
      const km = (tgt.range * this.maxRangeKm * this.scanRange).toFixed(0);
      ctx.font = '7px IBM Plex Mono, monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(
        `${km}km  ${tgt.angle.toFixed(0)}°  ${tgt.rcs.toFixed(1)}m²`,
        tx + visR + 3,
        ty + 8,
      );
    });

    // Origin marker
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(232,168,43,0.7)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(232,168,43,0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = 'rgba(232,168,43,0.45)';
    ctx.font = 'bold 8px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('ENVIRONMENT', cx, H - 5);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ANIMATION LOOP
  // ─────────────────────────────────────────────────────────────────────────

  private startAnimation(): void {
    this.zone.runOutsideAngular(() => {
      const loop = () => {
        this.advanceBfScan();
        this.advanceTrdScan();

        if (this.radarReady) {
          this.beamSvc.sendBfScanSlice({
            start_angle   : this.bfScanAngle,
            end_angle     : this.bfScanAngle + this.bfScanSpeedDegPerFrame,
            num_lines     : 1,
            max_range_m   : this.scanRange * this.maxRangeKm * 1000,
            num_range_bins: 128,
            targets       : this.targets.map((t) => this.toTargetDTO(t)),
            radar_type    : 'phased_array',
          });

          this.beamSvc.sendTrdScanSlice({
            start_angle   : this.trdAngle,
            end_angle     : this.trdAngle + this.TRD_ROT_DEG_PER_FRAME,
            num_lines     : 1,
            max_range_m   : this.scanRange * this.maxRangeKm * 1000,
            num_range_bins: 128,
            targets       : this.targets.map((t) => this.toTargetDTO(t)),
            radar_type    : 'traditional',
          });
        }

        this.drawEnvCanvas();
        this.drawBeamformingCanvas();
        this.drawTraditionalCanvas();

        this.animId = requestAnimationFrame(loop);
      };
      loop();
    });
  }

  private advanceBfScan(): void {
    if (this.sweepMode === 'full') {
      this.bfScanAngle = (this.bfScanAngle + this.bfScanSpeedDegPerFrame) % 360;
      this.bfFullRotDeg += this.bfScanSpeedDegPerFrame;
    } else {
      this.bfScanAngle += this.bfScanSpeedDegPerFrame * this.bfScanDir;
      if (this.bfScanAngle >= this.sectorMax) {
        this.bfScanAngle = this.sectorMax;
        this.bfScanDir = -1;
      }
      if (this.bfScanAngle <= this.sectorMin) {
        this.bfScanAngle = this.sectorMin;
        this.bfScanDir = 1;
      }
      this.bfFullRotDeg += this.bfScanSpeedDegPerFrame;
    }

    if (this.bfFullRotDeg >= 360) {
    this.bfFullRotDeg = 0;
    this.bfPaintCtx.clearRect(0, 0, this.bfPaint.width, this.bfPaint.height);
    this.targets.forEach((t) => (t.lastDetection = null));
    }
  }

  private advanceTrdScan(): void {
    this.trdAngle = (this.trdAngle + this.TRD_ROT_DEG_PER_FRAME) % 360;
    this.trdFullRotDeg += this.TRD_ROT_DEG_PER_FRAME;

    if (this.trdFullRotDeg >= 360) {
    this.trdFullRotDeg = 0;
    this.trdPaintCtx.clearRect(0, 0, this.trdPaint.width, this.trdPaint.height);
    this.targets.forEach((t) => (t.trdLastDetection = null));
    }
  }
 
  // ─────────────────────────────────────────────────────────────────────────
  // RENDERING
  // ─────────────────────────────────────────────────────────────────────────

  private paintBfCanvas(sweep_data: any[]): void {
    if (!this.bfPaintCtx) return;
    const W = this.bfPaint.width;
    const H = this.bfPaint.height;
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;
    const halfRad = ((this.physicalBeamWidthDeg / 2) * Math.PI) / 180;

    this.bfPaintCtx.globalCompositeOperation = 'source-over';

    sweep_data.forEach((line: any) => {
      const sweepRad = ((line.angle_deg - 90) * Math.PI) / 180;
      const bins = line.range_bins as number[];
      const numBins = bins.length;

      for (let i = 0; i < numBins; i++) {
        const intensity = bins[i];
        if (intensity < 0.02) continue;

        const r0 = (i / numBins) * R;
        const r1 = ((i + 1) / numBins) * R;

        this.bfPaintCtx.beginPath();
        this.bfPaintCtx.arc(cx, cy, r1, sweepRad - halfRad, sweepRad + halfRad);
        this.bfPaintCtx.arc(cx, cy, r0, sweepRad + halfRad, sweepRad - halfRad, true);
        this.bfPaintCtx.closePath();

        // Gradient: dark-blue → cyan → white
        const t = Math.min(intensity, 1);
        const r = Math.floor(t > 0.5 ? (t - 0.5) * 2 * 255 : 0);
        const g = Math.floor(t < 0.5 ? t * 2 * 200 : 200 + (t - 0.5) * 2 * 55);
        const b = Math.floor(t < 0.5 ? 160 + t * 2 * 95 : 255);
        this.bfPaintCtx.fillStyle = `rgba(${r},${g},${b},${0.3 + t * 0.65})`;
        this.bfPaintCtx.fill();
      }
    });
  }

  private paintTrdCanvas(sweep_data: any[]): void {
    if (!this.trdPaintCtx) return;
    const W = this.trdPaint.width;
    const H = this.trdPaint.height;
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;
    const halfRad = ((this.physicalBeamWidthDeg / 2) * Math.PI) / 180;

    this.trdPaintCtx.globalCompositeOperation = 'source-over';

    sweep_data.forEach((line: any) => {
      const sweepRad = ((line.angle_deg - 90) * Math.PI) / 180;
      const bins = line.range_bins as number[];
      const numBins = bins.length;

      for (let i = 0; i < numBins; i++) {
        const intensity = bins[i];
        if (intensity < 0.02) continue;

        const r0 = (i / numBins) * R;
        const r1 = ((i + 1) / numBins) * R;

        this.trdPaintCtx.beginPath();
        this.trdPaintCtx.arc(cx, cy, r1, sweepRad - halfRad, sweepRad + halfRad);
        this.trdPaintCtx.arc(cx, cy, r0, sweepRad + halfRad, sweepRad - halfRad, true);
        this.trdPaintCtx.closePath();

        const t = Math.min(intensity, 1);
        const r = Math.floor(t > 0.5 ? (t - 0.5) * 2 * 220 : 0);
        const g = Math.floor(60 + t * 195);
        const b = Math.floor(t > 0.6 ? (t - 0.6) * 2.5 * 200 : 0);
        this.trdPaintCtx.fillStyle = `rgba(${r},${g},${b},${0.25 + t * 0.7})`;
        this.trdPaintCtx.fill();
      }
    });
  }

  private drawBeamformingCanvas(): void {
    const canvas = this.bfCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 360);
    const H = (canvas.height = canvas.offsetHeight || 360);
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;

    if (this.bfPaint.width !== W || this.bfPaint.height !== H) {
      this.bfPaint.width = W;
      this.bfPaint.height = H;
    }

    ctx.fillStyle = '#04080f';
    ctx.fillRect(0, 0, W, H);

    this.drawBfGrid(ctx, cx, cy, R);
    ctx.drawImage(this.bfPaint, 0, 0);

    // Thin beam cursor — current electronic steering direction only
    const steerRad = ((this.bfScanAngle - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(steerRad), cy + R * Math.sin(steerRad));
    ctx.strokeStyle = 'rgba(26,115,232,0.40)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (this.radarInfo) this.drawRadarHUD(ctx, W, H);
  }

  private drawRadarHUD(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const ri = this.radarInfo;
    const lines = [
      `Fc: ${(ri.carrier_freq_hz / 1e9).toFixed(2)} GHz`,
      `λ:  ${(ri.wavelength_m * 100).toFixed(1)} cm`,
      `G:  ${ri.array_gain_db?.toFixed(1)} dB`,
      `HPBW: ${ri.hpbw_deg?.toFixed(1)}°`,
      `ΔR: ${ri.range_resolution_m?.toFixed(0)} m`,
      `Ru: ${(ri.max_unambiguous_range_m / 1000).toFixed(0)} km`,
    ];
    ctx.font = '8px IBM Plex Mono, monospace';
    ctx.textAlign = 'left';
    lines.forEach((line, i) => {
      const x = 6,
        y = 14 + i * 11;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - 2, y - 9, 94, 11);
      ctx.fillStyle = 'rgba(26,115,232,0.85)';
      ctx.fillText(line, x, y);
    });
  }

  private drawTraditionalCanvas(): void {
    const canvas = this.trdCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 360);
    const H = (canvas.height = canvas.offsetHeight || 360);
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;

    if (this.trdPaint.width !== W || this.trdPaint.height !== H) {
      this.trdPaint.width = W;
      this.trdPaint.height = H;
    }

    ctx.fillStyle = '#040b04';
    ctx.fillRect(0, 0, W, H);

    this.drawTrdGrid(ctx, cx, cy, R);
    ctx.drawImage(this.trdPaint, 0, 0);

    const angleRad = ((this.trdAngle - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad), cy + R * Math.sin(angleRad));
    ctx.strokeStyle = 'rgba(52,168,83,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawBfGrid(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    ctx.save();
    ctx.lineWidth = 1;

    [0.25, 0.5, 0.75, 1.0].forEach((frac) => {
      const r = R * frac;
      const km = (frac * this.scanRange * this.maxRangeKm).toFixed(0);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(26,115,232,0.10)';
      ctx.stroke();
      ctx.fillStyle = 'rgba(26,115,232,0.38)';
      ctx.font = '7px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${km}km`, cx + r * Math.cos(-Math.PI / 5), cy + r * Math.sin(-Math.PI / 5));
    });

    // 8 bearing spokes
    for (let a = 0; a < 360; a += 45) {
      const rad = ((a - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + R * Math.cos(rad), cy + R * Math.sin(rad));
      ctx.strokeStyle = 'rgba(26,115,232,0.07)';
      ctx.stroke();
    }

    // Cardinal labels
    ['N', 'E', 'S', 'W'].forEach((lbl, i) => {
      const a = ((i * 90 - 90) * Math.PI) / 180;
      const lx = cx + (R + 10) * Math.cos(a);
      const ly = cy + (R + 10) * Math.sin(a);
      ctx.fillStyle = 'rgba(26,115,232,0.5)';
      ctx.font = 'bold 8px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(lbl, lx, ly + 3);
    });
    ctx.restore();
  }

  private drawTrdGrid(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    ctx.save();
    ctx.lineWidth = 1;

    [0.25, 0.5, 0.75, 1.0].forEach((frac) => {
      const r = R * frac;
      const km = (frac * this.scanRange * this.maxRangeKm).toFixed(0);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(52,168,83,0.10)';
      ctx.stroke();
      const lx = cx + r * Math.cos(-Math.PI / 5);
      const ly = cy + r * Math.sin(-Math.PI / 5);
      ctx.fillStyle = 'rgba(52,168,83,0.38)';
      ctx.font = '7px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${km}km`, lx, ly);
    });

    ['N', 'E', 'S', 'W'].forEach((lbl, i) => {
      const a = ((i * 90 - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a));
      ctx.strokeStyle = 'rgba(52,168,83,0.07)';
      ctx.stroke();
      ctx.fillStyle = 'rgba(52,168,83,0.5)';
      ctx.font = 'bold 8px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(lbl, cx + (R + 10) * Math.cos(a), cy + (R + 10) * Math.sin(a) + 3);
    });
    ctx.restore();
  }

  private drawPatternCanvas(): void {
    const canvasEl = this.patternCanvasRef?.nativeElement;
    if (!canvasEl || !this.beamPattern.length) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const W = (canvasEl.width = canvasEl.offsetWidth || 400);
    const H = (canvasEl.height = canvasEl.offsetHeight || 400);
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H * 0.62;
    const radius = Math.min(W, cy) - 20;

    const DB_FLOOR = -40;
    const norm = this.beamPattern.map((db) =>
      Math.max(0, Math.min(1, (Math.max(db, DB_FLOOR) - DB_FLOOR) / -DB_FLOOR)),
    );

    // Grid rings
    [10, 20, 30, 40].forEach((dbDown) => {
      const r = radius * (1 - dbDown / 40);
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI, 0);
      ctx.strokeStyle = `rgba(26,115,232,${0.08 + ((40 - dbDown) / 40) * 0.12})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(26,115,232,0.45)';
      ctx.font = '8px IBM Plex Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`-${dbDown}`, cx + r + 2, cy - 2);
    });

    // Spokes
    [-90, -60, -45, -30, -15, 0, 15, 30, 45, 60, 90].forEach((a) => {
      const rad = ((a - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + radius * Math.cos(rad), cy + radius * Math.sin(rad));
      ctx.strokeStyle = 'rgba(26,115,232,0.07)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(26,115,232,0.55)';
      ctx.font = '8px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(
        `${a}°`,
        cx + (radius + 14) * Math.cos(rad),
        cy + (radius + 14) * Math.sin(rad) + 3,
      );
    });

    const drawPath = () => {
      ctx.beginPath();
      let first = true;
      this.anglesDeg.forEach((angle, i) => {
        const r = norm[i] * radius;
        const rad = ((angle - 90) * Math.PI) / 180;
        const px = cx + r * Math.cos(rad);
        const py = cy + r * Math.sin(rad);
        if (first) {
          ctx.moveTo(px, py);
          first = false;
        } else ctx.lineTo(px, py);
      });
      ctx.closePath();
    };

    drawPath();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, 'rgba(26,115,232,0.45)');
    grad.addColorStop(1, 'rgba(26,115,232,0.05)');
    ctx.fillStyle = grad;
    ctx.fill();

    drawPath();
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth = 1.8;
    ctx.shadowColor = '#1a73e8';
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Live steering marker (reads bfScanAngle, not stale steeringAngle)
    const beamAngle = this.radarInfo?.beam_angle ?? this.bfScanAngle;
    const steerRad = ((beamAngle - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + radius * Math.cos(steerRad), cy + radius * Math.sin(steerRad));
    ctx.strokeStyle = 'rgba(255,100,80,0.8)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
